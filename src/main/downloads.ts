import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { DownloadFileProgress, DownloadJob, HFGgufMeta, ModelEntry, ModelFormat, Settings } from '@shared/types'
import { sleep } from '@shared/async'
import { L } from '@shared/i18n'
import { downloadJobId } from '@shared/jobs'
import { describeHttp, type HfClient } from './hf'

/** ダウンロード完了時にモデルの隣へ書き出すメタ情報 */
export interface Sidecar {
  repoId: string
  entryKey: string
  displayName: string
  format?: ModelFormat
  quant: string
  files: string[]
  totalSize: number
  downloadedAt: string
  hfMeta: HFGgufMeta | null
  paramsB: number | null
  /** GGUF: 一緒にダウンロードした画像入力用 mmproj のパス (files にも含まれる) */
  mmproj?: string
  /** 画像生成モデルの部品 (VAE / テキストエンコーダー)。ライブラリにはモデルとして出さない */
  component?: boolean
}

interface JobState {
  job: DownloadJob
  entry: ModelEntry
  mmproj: ModelEntry | null
  component: boolean
  hfMeta: HFGgufMeta | null
  controller: AbortController | null
  lastTickAt: number
  lastTickBytes: number
}

const safeName = (s: string) => s.replace(/[<>:"|?*\\/]/g, '_')

export function repoDir(modelsDir: string, repoId: string): string {
  const [owner, name = 'model'] = repoId.split('/')
  return path.join(modelsDir, safeName(owner), safeName(name))
}

export const sidecarName = (entryKey: string) => `${safeName(entryKey.replace(/\//g, '__'))}.hfrunner.json`

/** ダウンロードキュー。1 件ずつ順番に処理し、.part ファイルで中断・再開に対応する */
export class DownloadManager extends EventEmitter {
  private states = new Map<string, JobState>()
  private queue: string[] = []
  private active: string | null = null
  private emitTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: { hf: HfClient; getSettings: () => Settings }) {
    super()
  }

  list(): DownloadJob[] {
    return [...this.states.values()].map((s) => s.job).sort((a, b) => b.createdAt - a.createdAt)
  }

  start(repoId: string, entry: ModelEntry, hfMeta: HFGgufMeta | null, mmproj: ModelEntry | null = null, opts: { component?: boolean } = {}): DownloadJob {
    const id = downloadJobId(repoId, entry.key)
    const existing = this.states.get(id)
    // 保存先はその時点のモデルフォルダ (設定で変更されているかもしれない)
    const destDir = repoDir(this.deps.getSettings().modelsDir, repoId)
    if (existing) {
      const st = existing.job.status
      if (st === 'downloading' || st === 'queued') return existing.job
      // 完了済みでもファイルが消されていれば (ライブラリから削除など) 取り直す
      if (st === 'done' && existing.job.files.every((f) => fs.existsSync(resolveInside(destDir, f.path)))) return existing.job
      existing.job.status = 'queued'
      existing.job.error = undefined
      existing.job.destDir = destDir
      if (st === 'done') {
        existing.job.files.forEach((f) => (f.done = 0))
        existing.job.doneBytes = 0
      }
      this.enqueue(id)
      return existing.job
    }
    const files = [...entry.files, ...(mmproj?.files ?? [])]
    const job: DownloadJob = {
      id,
      repoId,
      entryKey: entry.key,
      ...(opts.component ? { component: true } : {}),
      displayName: entry.displayName,
      format: entry.format,
      quant: entry.quant,
      files: files.map((f) => ({ path: f.path, size: f.size, done: 0 })),
      destDir,
      totalBytes: files.reduce((a, f) => a + f.size, 0),
      doneBytes: 0,
      speedBps: 0,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.states.set(id, { job, entry, mmproj, component: !!opts.component, hfMeta, controller: null, lastTickAt: 0, lastTickBytes: 0 })
    this.enqueue(id)
    return job
  }

  /** 中断 / 失敗したジョブを、記録してあるエントリでもう一度キューに入れる (部品など、検索画面から再開できないジョブ用) */
  resume(id: string): DownloadJob | null {
    const s = this.states.get(id)
    if (!s) return null
    return this.start(s.job.repoId, s.entry, s.hfMeta, s.mmproj, { component: s.component })
  }

  /** ジョブが終わる (完了 / 失敗 / 中断) まで待つ。signal で待つのをやめられる */
  waitForJob(id: string, signal?: AbortSignal): Promise<DownloadJob> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const job = this.states.get(id)?.job
        if (!job) return reject(new Error(L('ダウンロードジョブが見つかりません', 'Download job not found')))
        if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
          cleanup()
          resolve(job)
        }
      }
      const onAbort = () => {
        cleanup()
        reject(new Error(L('中断されました', 'Aborted')))
      }
      const cleanup = () => {
        this.off('done', check)
        this.off('settled', check)
        signal?.removeEventListener('abort', onAbort)
      }
      this.on('done', check)
      this.on('settled', check)
      signal?.addEventListener('abort', onAbort)
      if (signal?.aborted) onAbort()
      else check()
    })
  }

  cancel(id: string): void {
    const s = this.states.get(id)
    // 進行中 (待機中を含む) のジョブだけが対象。完了・失敗・中断済みのものを「中断」に書き換えない
    if (!s || (s.job.status !== 'downloading' && s.job.status !== 'queued')) return
    if (s.controller) {
      s.controller.abort()
    } else {
      this.queue = this.queue.filter((q) => q !== id)
      s.job.status = 'cancelled'
    }
    this.scheduleEmit()
  }

  remove(id: string): void {
    const s = this.states.get(id)
    if (!s || s.job.status === 'downloading') return
    this.states.delete(id)
    this.queue = this.queue.filter((q) => q !== id)
    this.scheduleEmit()
  }

  private enqueue(id: string): void {
    if (!this.queue.includes(id)) this.queue.push(id)
    this.scheduleEmit()
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.active) return
    const id = this.queue.shift()
    if (!id) return
    const s = this.states.get(id)
    if (!s) return void this.pump()
    this.active = id
    try {
      await this.runJob(s)
    } finally {
      this.active = null
      this.scheduleEmit()
      void this.pump()
    }
  }

  private async runJob(s: JobState): Promise<void> {
    const { job } = s
    const controller = new AbortController()
    s.controller = controller
    job.status = 'downloading'
    job.error = undefined
    s.lastTickAt = Date.now()
    s.lastTickBytes = job.doneBytes
    try {
      await fsp.mkdir(job.destDir, { recursive: true })
      for (const file of job.files) {
        await this.downloadFile(s, file, controller.signal)
      }
      await this.writeSidecar(s)
      job.status = 'done'
      job.doneBytes = job.totalBytes
      job.speedBps = 0
      this.emit('done', job)
    } catch (err) {
      if (controller.signal.aborted) {
        job.status = 'cancelled'
      } else {
        job.status = 'error'
        job.error = err instanceof Error ? err.message : String(err)
      }
      job.speedBps = 0
      // ライブラリ側の「ダウンロード中」表示 (部品の状態など) を更新させる
      this.emit('settled', job)
    } finally {
      s.controller = null
      job.updatedAt = Date.now()
      this.scheduleEmit()
    }
  }

  private async downloadFile(s: JobState, file: DownloadFileProgress, signal: AbortSignal): Promise<void> {
    const { job } = s
    const finalPath = resolveInside(job.destDir, file.path)
    // 1 接続方式は .part に先頭から順に書く。分割方式は .spart を最終サイズで事前確保し .spart.json に範囲ごとの進捗を持つ。
    // 名前を分けることで、途中ファイルがどちらの方式のものか (中身をどう解釈するか) が迷わない
    const partPath = `${finalPath}.part`
    const spartPath = `${finalPath}.spart`
    const spartState = `${finalPath}.spart.json`
    await fsp.mkdir(path.dirname(finalPath), { recursive: true })

    const existing = await fsp.stat(finalPath).catch(() => null)
    if (existing && existing.size === file.size) {
      file.done = file.size
      this.tick(s)
      return
    }

    // 大きいファイルは範囲に分けて並列に取得する。分割方式の途中ファイルがあれば、接続数の設定が 1 に変わっていてもそれを引き継ぐ
    const connections = Math.min(16, Math.max(1, Math.floor(this.deps.getSettings().downloadConnections) || 1))
    if (fs.existsSync(spartState) || (connections > 1 && file.size >= SEGMENT_THRESHOLD)) {
      if (await this.downloadSegmented(s, file, finalPath, spartPath, spartState, connections, signal)) return
      // サーバーが Range に対応していない: 1 接続で最初から
    }
    await fsp.rm(spartPath, { force: true })
    await fsp.rm(spartState, { force: true })

    let offset = (await fsp.stat(partPath).catch(() => null))?.size ?? 0
    if (offset > file.size) {
      await fsp.rm(partPath, { force: true })
      offset = 0
    }

    if (offset < file.size) {
      const url = this.deps.hf.fileUrl(job.repoId, file.path)
      const headers = this.deps.hf.headers(offset > 0 ? { Range: `bytes=${offset}-` } : {})
      const res = await fetch(url, { headers, signal, redirect: 'follow' })
      if (res.status === 200 && offset > 0) {
        // Range 非対応: 最初からやり直す
        await fsp.rm(partPath, { force: true })
        offset = 0
      } else if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel()
        throw new Error(describeHttp(res.status))
      }
      if (!res.body) throw new Error(L('レスポンスが空です', 'The response is empty'))

      file.done = offset
      this.tick(s)
      const progress = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          file.done += chunk.length
          this.tick(s)
          cb(null, chunk)
        },
      })
      const out = fs.createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' })
      await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), progress, out, { signal })
    }

    const got = (await fsp.stat(partPath).catch(() => null))?.size ?? 0
    if (got !== file.size) {
      throw new Error(L(`ダウンロードしたサイズが一致しません (${got} / ${file.size} bytes)`, `Downloaded size does not match (${got} / ${file.size} bytes)`))
    }
    await fsp.rename(partPath, finalPath)
  }

  /**
   * 並列 Range ダウンロード。ファイルを connections 個の範囲に分け、事前確保した .spart の該当位置へ同時に書き込む。
   * 範囲ごとの進捗を .spart.json に保存し、中断後は範囲単位で続きから再開する。
   * サーバーが Range に対応していない (200 が返る) 場合は false を返し、呼び出し側が 1 接続に切り替える
   */
  private async downloadSegmented(
    s: JobState,
    file: DownloadFileProgress,
    finalPath: string,
    partPath: string,
    statePath: string,
    connections: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const { job } = s
    let state = await readPartState(statePath)
    if (!state || state.size !== file.size || !fs.existsSync(partPath)) {
      state = { size: file.size, segments: planSegments(file.size, connections) }
      await fsp.rm(partPath, { force: true })
    }
    const segments = state.segments
    // 状態ファイルは一時ファイルに書いてから置き換える (途中で落ちても壊れた JSON を残さない)。書き込みは直列化する
    let saving: Promise<void> = Promise.resolve()
    const save = () => {
      saving = saving.then(async () => {
        await fsp.writeFile(`${statePath}.tmp`, JSON.stringify(state))
        await fsp.rename(`${statePath}.tmp`, statePath)
      }).catch(() => {})
      return saving
    }
    if (!fs.existsSync(partPath)) {
      // NTFS は「まだ書かれていない位置」より先に書くと手前を同期的にゼロ埋めするため、
      // 後ろの範囲の最初の書き込みで数秒〜数分止まる。スパースファイルにしておくとゼロ埋めが起きない
      await (await fsp.open(partPath, 'w')).close()
      await setSparse(partPath, true)
    }
    const handle = await fsp.open(partPath, fs.constants.O_RDWR | fs.constants.O_CREAT)
    try {
      if ((await handle.stat()).size !== file.size) await handle.truncate(file.size)
    } catch (err) {
      await handle.close()
      throw err
    }

    // 1 つの範囲が失敗 / 外部から中断されたら、他の範囲も止める
    const inner = new AbortController()
    const onAbort = () => inner.abort()
    signal.addEventListener('abort', onAbort)
    // 事前確保の間に中断されていたら、リスナーは発火しないのでここで反映する
    if (signal.aborted) inner.abort()
    const sync = () => {
      file.done = segments.reduce((a, g) => a + g.done, 0)
      this.tick(s)
    }
    sync()
    let rangeUnsupported = false
    const url = this.deps.hf.fileUrl(job.repoId, file.path)

    const runSegment = async (seg: Segment) => {
      const total = seg.end - seg.start + 1
      let attempt = 0
      while (seg.done < total) {
        try {
          const res = await fetch(url, { headers: this.deps.hf.headers({ Range: `bytes=${seg.start + seg.done}-${seg.end}` }), signal: inner.signal, redirect: 'follow' })
          if (res.status === 200) {
            rangeUnsupported = true
            await res.body?.cancel()
            inner.abort()
            return
          }
          if (res.status !== 206) {
            await res.body?.cancel()
            throw new Error(describeHttp(res.status))
          }
          if (!res.body) throw new Error(L('レスポンスが空です', 'The response is empty'))
          const reader = res.body.getReader()
          // 受信チャンク (十数 KB) ごとに書くと書き込み回数が多すぎるので、WRITE_CHUNK までまとめて書く。
          // seg.done は書き込みが終わった分だけ進めるので、中断しても .part.json と実ファイルの整合は保たれる
          let pending: Uint8Array[] = []
          let pendingLen = 0
          const flush = async () => {
            if (pendingLen === 0) return
            const block = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen)
            await handle.write(block, 0, pendingLen, seg.start + seg.done)
            seg.done += pendingLen
            pending = []
            pendingLen = 0
            sync()
          }
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value.length === 0) continue
            // 要求した範囲より多く返された (Range を無視する中継など) ら、隣の範囲を上書きする前に止める
            if (seg.done + pendingLen + value.length > total) {
              await reader.cancel().catch(() => {})
              inner.abort() // 再試行しても同じなので、他の範囲ごと止める
              throw new Error(L('サーバーが要求した範囲より多くのデータを返しました', 'The server returned more data than the requested range'))
            }
            pending.push(value)
            pendingLen += value.length
            if (pendingLen >= WRITE_CHUNK) await flush()
          }
          await flush()
          if (seg.done < total) throw new Error(L('接続が途中で切れました', 'The connection was interrupted'))
        } catch (err) {
          // 中断ではないネットワークエラーは、取得済みの分を保持したまま少し待って再試行する
          if (inner.signal.aborted || ++attempt > 3) {
            inner.abort()
            throw err
          }
          await sleep(1000 * attempt)
        }
      }
    }

    const timer = setInterval(() => void save(), 1000)
    const results = await Promise.allSettled(segments.map(runSegment))
    clearInterval(timer)
    signal.removeEventListener('abort', onAbort)
    await handle.close()
    await save()
    await fsp.rm(`${statePath}.tmp`, { force: true })

    if (rangeUnsupported) return false
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failure) throw failure.reason
    if (segments.some((g) => g.done !== g.end - g.start + 1)) throw new Error(L('ダウンロードが完了していません', 'The download is incomplete'))
    const got = (await fsp.stat(partPath).catch(() => null))?.size ?? 0
    if (got !== file.size) throw new Error(L(`ダウンロードしたサイズが一致しません (${got} / ${file.size} bytes)`, `Downloaded size does not match (${got} / ${file.size} bytes)`))
    await setSparse(partPath, false) // 全域を書き終えたので通常のファイルに戻す
    await fsp.rename(partPath, finalPath)
    await fsp.rm(statePath, { force: true })
    return true
  }

  private async writeSidecar(s: JobState): Promise<void> {
    const { job, entry, mmproj, hfMeta, component } = s
    const data: Sidecar = {
      ...(component ? { component: true } : {}),
      repoId: job.repoId,
      entryKey: job.entryKey,
      displayName: job.displayName,
      format: entry.format,
      quant: job.quant,
      files: job.files.map((f) => f.path),
      totalSize: job.totalBytes,
      downloadedAt: new Date().toISOString(),
      hfMeta,
      paramsB: entry.paramsB,
      mmproj: mmproj?.files[0]?.path,
    }
    await fsp.writeFile(path.join(job.destDir, sidecarName(job.entryKey)), JSON.stringify(data, null, 2))
  }

  /** 進捗集計。速度は 0.5 秒ごとに更新 */
  private tick(s: JobState): void {
    const { job } = s
    job.doneBytes = job.files.reduce((a, f) => a + f.done, 0)
    const now = Date.now()
    const dt = now - s.lastTickAt
    if (dt >= 500) {
      const inst = ((job.doneBytes - s.lastTickBytes) / dt) * 1000
      job.speedBps = job.speedBps ? job.speedBps * 0.6 + inst * 0.4 : inst
      s.lastTickAt = now
      s.lastTickBytes = job.doneBytes
    }
    job.updatedAt = now
    this.scheduleEmit()
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('update', this.list())
    }, 300)
  }
}

const MB = 1024 * 1024
/** これ以上のファイルを並列 Range で取得する */
const SEGMENT_THRESHOLD = 16 * MB
/** 1 範囲の最小サイズ。小さく切りすぎるとリクエストのオーバーヘッドが勝つ */
const MIN_SEGMENT = 8 * MB
/** 並列取得時にまとめて書き込む単位 */
const WRITE_CHUNK = 1 * MB


/** 並列ダウンロードの 1 範囲 (end は含む) と取得済みバイト数 */
export interface Segment {
  start: number
  end: number
  done: number
}

interface PartState {
  size: number
  segments: Segment[]
}

/** ファイルを最大 connections 個の連続した範囲に分ける。各範囲は minSegment 以上 */
export function planSegments(size: number, connections: number, minSegment = MIN_SEGMENT): Segment[] {
  if (size <= 0) return []
  const n = Math.max(1, Math.min(connections, Math.floor(size / minSegment)))
  const base = Math.floor(size / n)
  const segments: Segment[] = []
  for (let i = 0, pos = 0; i < n; i++) {
    const len = i === n - 1 ? size - pos : base
    segments.push({ start: pos, end: pos + len - 1, done: 0 })
    pos += len
  }
  return segments
}

/**
 * Windows でファイルのスパース属性を設定 / 解除する (fsutil sparse setflag。管理者権限は不要)。
 * Linux / macOS はもともとスパースに書けるので何もしない。失敗しても致命的ではないので無視する
 */
function setSparse(filePath: string, on: boolean): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  return new Promise((resolve) => {
    execFile('fsutil', ['sparse', 'setflag', filePath, on ? '1' : '0'], { windowsHide: true, timeout: 10_000 }, () => resolve())
  })
}

async function readPartState(statePath: string): Promise<PartState | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(statePath, 'utf8')) as PartState
    if (typeof raw.size !== 'number' || !Array.isArray(raw.segments)) return null
    if (!raw.segments.every((g) => Number.isInteger(g.start) && Number.isInteger(g.end) && Number.isInteger(g.done) && g.done >= 0 && g.done <= g.end - g.start + 1)) return null
    return raw
  } catch {
    return null
  }
}

/** destDir の外へ抜けるパスを拒否する */
function resolveInside(destDir: string, rel: string): string {
  const abs = path.resolve(destDir, rel)
  const root = path.resolve(destDir)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(L(`不正なファイルパス: ${rel}`, `Invalid file path: ${rel}`))
  return abs
}
