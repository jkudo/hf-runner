import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { shell } from 'electron'
import type { GeneratedImage, ImageCapabilities, ImageGenParams, ImageGenStatus } from '@shared/types'
import { sleep } from '@shared/async'
import { L } from '@shared/i18n'
import type { ServerManager } from './server'

/** sd-server のログに出るステップ進捗: "  |=====>     | 7/20 - 1.23s/it" */
const STEP_RE = /\|[=>\s]*\|\s*(\d+)\/(\d+)\s*-\s*([\d.]+)(s\/it|it\/s)/

interface JobJson {
  id: string
  status: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled'
  result?: { images?: Array<{ b64_json: string }> } | null
  error?: { code?: string; message?: string } | null
}

/**
 * 画像生成。起動中の sd-server (ServerManager が管理) に /sdcpp/v1/img_gen を投げてジョブをポーリングし、
 * ステップ進捗はサーバーのログ行から拾う。完了した PNG は imagesDir にパラメータの JSON と一緒に保存する
 */
export class ImageGenManager extends EventEmitter {
  private status: ImageGenStatus = { state: 'idle' }
  private current: { jobId: string; port: number } | null = null

  constructor(private readonly deps: { server: ServerManager; imagesDir: string }) {
    super()
    // ログ行からステップ進捗を取り出す
    deps.server.on('line', (line: string) => {
      if (this.status.state !== 'generating') return
      const m = STEP_RE.exec(line)
      if (!m) return
      const rate = Number(m[3])
      const secPerStep = m[4] === 's/it' ? rate : rate > 0 ? 1 / rate : undefined
      this.setStatus({ ...this.status, step: Number(m[1]), steps: Number(m[2]), secPerStep, elapsedMs: Date.now() - (this.status.startedAt ?? Date.now()) })
    })
  }

  getStatus(): ImageGenStatus {
    return { ...this.status }
  }

  /** 起動中の sd-server。画像生成モデルが起動していなければ null */
  private sdServer(): { port: number; modelName?: string } | null {
    const s = this.deps.server.getStatus()
    if (s.state !== 'running' || s.engine !== 'sdcpp' || !s.port) return null
    return { port: s.port, modelName: s.modelName }
  }

  private base(): { port: number; modelName?: string } {
    const sd = this.sdServer()
    if (!sd) throw new Error(L('画像生成モデルが起動していません。ライブラリから画像生成モデルを起動してください', 'No image generation model is loaded. Launch one from the Library'))
    return sd
  }

  async capabilities(): Promise<ImageCapabilities | null> {
    const sd = this.sdServer()
    if (!sd) return null
    const res = await fetch(`http://127.0.0.1:${sd.port}/sdcpp/v1/capabilities`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const c = (await res.json()) as {
      samplers?: string[]
      defaults_by_mode?: { img_gen?: { sample_params?: { sample_method?: string } } }
      limits?: { max_width?: number; max_height?: number }
    }
    return {
      samplers: c.samplers ?? [],
      defaultSampler: c.defaults_by_mode?.img_gen?.sample_params?.sample_method ?? 'euler_a',
      maxWidth: c.limits?.max_width ?? 2048,
      maxHeight: c.limits?.max_height ?? 2048,
    }
  }

  async generate(params: ImageGenParams): Promise<ImageGenStatus> {
    if (this.status.state === 'generating') throw new Error(L('別の画像を生成中です', 'Another image is being generated'))
    const { port, modelName } = this.base()
    // ランダムシードは自分で決めて記録する (同じ画像を再現できるように)
    const seed = params.seed >= 0 ? Math.floor(params.seed) : Math.floor(Math.random() * 2 ** 31)
    const used: ImageGenParams = { ...params, seed, width: snap8(params.width), height: snap8(params.height) }
    // 二重投入を防ぐため、リクエストを送る前に「生成中」にしておく (送信に失敗したら error に戻す)
    const startedAt = Date.now()
    this.setStatus({ state: 'generating', steps: used.steps, startedAt, elapsedMs: 0 })
    const body = {
      prompt: used.prompt,
      negative_prompt: used.negativePrompt,
      width: used.width,
      height: used.height,
      seed,
      batch_count: 1,
      output_format: 'png',
      sample_params: { sample_steps: used.steps, guidance: { txt_cfg: used.cfgScale }, ...(used.sampler ? { sample_method: used.sampler } : {}) },
    }
    let job: { id: string; poll_url?: string }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sdcpp/v1/img_gen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(L(`生成リクエストが拒否されました (HTTP ${res.status}): `, `The generation request was rejected (HTTP ${res.status}): `) + (await res.text()).slice(0, 300))
      job = (await res.json()) as { id: string; poll_url?: string }
    } catch (err) {
      this.setStatus({ state: 'error', error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - startedAt })
      throw err
    }
    this.current = { jobId: job.id, port }
    this.setStatus({ ...this.status, jobId: job.id })

    try {
      let j: JobJson
      // ステップ進捗が一度出た後に 30 分止まったら (GPU のハングなど) 諦める。CPU の大きな画像は 1 ステップ数分かかるので長めに。
      // 進捗行を出さないビルドや、最初のステップ前の長い準備 (テキストエンコーダー / VAE) では作動しない
      let lastStep = -1
      let lastStepAt = Date.now()
      while (true) {
        await sleep(500)
        const step = this.status.step ?? -1
        if (step !== lastStep) {
          lastStep = step
          lastStepAt = Date.now()
        } else if (lastStep >= 0 && Date.now() - lastStepAt > 30 * 60_000) {
          await this.cancel()
          throw new Error(L('生成が進まないため中止しました (30 分間ステップが進みませんでした)', 'Generation was stopped because it made no progress (no step completed in 30 minutes)'))
        }
        const r = await fetch(`http://127.0.0.1:${port}/sdcpp/v1/jobs/${job.id}`, { signal: AbortSignal.timeout(5000) })
        if (!r.ok) throw new Error(L(`ジョブの状態を取得できません (HTTP ${r.status})`, `Could not get the job status (HTTP ${r.status})`))
        j = (await r.json()) as JobJson
        if (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') break
      }
      if (j.status === 'cancelled') {
        this.setStatus({ state: 'cancelled', elapsedMs: Date.now() - startedAt })
        return this.getStatus()
      }
      if (j.status === 'failed' || !j.result?.images?.[0]) {
        throw new Error(j.error?.message ?? L('生成に失敗しました', 'Generation failed'))
      }
      const image = await this.save(j.result.images[0].b64_json, used, modelName, Date.now() - startedAt)
      this.setStatus({ state: 'done', jobId: job.id, steps: used.steps, step: used.steps, startedAt, elapsedMs: image.elapsedMs, result: image })
      return this.getStatus()
    } catch (err) {
      this.setStatus({ state: 'error', jobId: job.id, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - startedAt })
      throw err
    } finally {
      this.current = null
    }
  }

  async cancel(): Promise<void> {
    const c = this.current
    if (!c) return
    await fetch(`http://127.0.0.1:${c.port}/sdcpp/v1/jobs/${c.jobId}/cancel`, { method: 'POST' }).catch(() => {})
  }

  private async save(b64: string, params: ImageGenParams, modelName: string | undefined, elapsedMs: number): Promise<GeneratedImage> {
    await fsp.mkdir(this.deps.imagesDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    // 同じ秒に同じシードで 2 枚できたら (速いモデルで固定シード) 上書きせず連番を付ける
    let name = `${stamp}-${params.seed}.png`
    let file = path.join(this.deps.imagesDir, name)
    for (let n = 2; fs.existsSync(file); n++) {
      name = `${stamp}-${params.seed}-${n}.png`
      file = path.join(this.deps.imagesDir, name)
    }
    await fsp.writeFile(file, Buffer.from(b64, 'base64'))
    const image: GeneratedImage = { file, name, createdAt: new Date().toISOString(), params, modelName, elapsedMs }
    await fsp.writeFile(file.replace(/\.png$/, '.json'), JSON.stringify(image, null, 2))
    return image
  }

  /** 生成済み画像の一覧 (新しい順) */
  async list(): Promise<GeneratedImage[]> {
    const names = (await fsp.readdir(this.deps.imagesDir).catch(() => [] as string[])).filter((n) => n.endsWith('.png'))
    const out = await Promise.all(
      names.map(async (name): Promise<GeneratedImage | null> => {
        const file = path.join(this.deps.imagesDir, name)
        const meta = await fsp
          .readFile(file.replace(/\.png$/, '.json'), 'utf8')
          .then((t) => JSON.parse(t) as GeneratedImage)
          .catch(() => null)
        if (meta) return { ...meta, file, name }
        // 記録 (JSON) が無い画像はファイルの日時だけで一覧に載せる
        const st = await fsp.stat(file).catch(() => null)
        return st ? { file, name, createdAt: st.mtime.toISOString(), params: { prompt: '', negativePrompt: '', width: 0, height: 0, steps: 0, cfgScale: 0, seed: -1 } } : null
      }),
    )
    return out.filter((g): g is GeneratedImage => g !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async remove(file: string): Promise<void> {
    const abs = path.resolve(file)
    const root = path.resolve(this.deps.imagesDir)
    if (!abs.startsWith(root + path.sep)) throw new Error(L('画像フォルダの外のファイルは削除できません', 'Files outside the image folder cannot be deleted'))
    await fsp.rm(abs, { force: true })
    await fsp.rm(abs.replace(/\.png$/, '.json'), { force: true })
  }

  async openFolder(): Promise<void> {
    await fsp.mkdir(this.deps.imagesDir, { recursive: true })
    await shell.openPath(this.deps.imagesDir)
  }

  private setStatus(s: ImageGenStatus): void {
    this.status = s
    this.emit('status', this.getStatus())
  }
}

/** 拡散モデルは 8 の倍数 (潜在空間の 1 ピクセル = 8px) が前提 */
function snap8(n: number): number {
  return Math.max(64, Math.round(n / 8) * 8)
}
