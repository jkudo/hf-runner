import { EventEmitter } from 'node:events'
import type { LibraryModel, TranslationStatus } from '@shared/types'
import { downloadJobId } from '@shared/jobs'
import { L } from '@shared/i18n'
import { TRANSLATION_MODELS, translationModel, type TranslationModel, type TranslationModelId } from '@shared/translation'
import type { DownloadManager } from './downloads'
import type { HfClient } from './hf'
import type { LibraryManager } from './library'
import type { RuntimeManager } from './runtime'
import type { ServerManager } from './server'
import type { SettingsStore } from './settings'

const jobIdOf = (m: TranslationModel) => downloadJobId(m.repo, m.entryKey)

// 翻訳元は英語以外のどの言語でもよい (日本語・中国語・韓国語・欧州の言語など)。アプリは英語以外の文字を含むものだけを渡すが、
// 「英訳を確認」からは英語の文字だけの文も来るので、英語ならそのまま返させる (重み指定 (word:1.2) などを崩さないため)
const SYSTEM_PROMPT = [
  "You convert the user's text, which may be written in any language, into an English prompt for an image generation model (Stable Diffusion).",
  'Translate faithfully: keep every subject, attribute, count, color, composition and style word.',
  'If the text is already in English, return it unchanged.',
  'Output only the prompt as comma-separated descriptive phrases in English. No explanations, no quotes, no line breaks.',
].join(' ')

/**
 * 画像生成用のプロンプト翻訳。llama.cpp の 2 つ目のサーバー (helper) で翻訳モデル (設定で選ぶ。TRANSLATION_MODELS) を CPU 常駐させ、
 * 英語以外 (日本語・中国語・韓国語・欧州の言語など) のプロンプトを英語に変換する。モデルは有効化時・切り替え時に自動で取得する
 */
export class TranslationManager extends EventEmitter {
  /** 進行中の準備 (モデル取得 + サーバー起動)。無効化・モデルの切り替えで abort して取りやめる */
  private preparing: { promise: Promise<void>; abort: AbortController; jobId: string } | null = null
  /** 直近の準備で起動した翻訳モデルの ID (起動済みならこれで準備を省く) */
  private modelId: string | null = null
  private error: string | undefined

  constructor(
    private readonly deps: { hf: HfClient; library: LibraryManager; downloads: DownloadManager; helper: ServerManager; runtime: RuntimeManager; settings: SettingsStore },
  ) {
    super()
    // ダウンロードの進捗 (300 ms ごと) や翻訳サーバーのログのたびに getStatus() (ライブラリ走査を含む) を
    // 呼ばないよう、翻訳に関係する値が変わったときだけ、直列に 1 回ずつ計算して通知する
    let lastSig = ''
    let chain: Promise<void> = Promise.resolve()
    const bump = () => {
      const m = this.selected()
      const j = deps.downloads.list().find((x) => x.id === jobIdOf(m))
      const sig = `${m.id}|${deps.helper.getStatus().state}|${j?.status ?? ''}|${j?.doneBytes ?? 0}|${j?.error ?? ''}`
      if (sig === lastSig) return
      lastSig = sig
      chain = chain
        .then(() => this.getStatus())
        .then((s) => {
          this.emit('status', s)
        })
        .catch(() => {
          // 一時的な失敗なら次の変化で計算し直せるようにする
          lastSig = ''
        })
    }
    deps.downloads.on('update', bump)
    deps.helper.on('status', bump)
  }

  /** 設定で選んでいる翻訳モデル */
  private selected(): TranslationModel {
    return translationModel(this.deps.settings.get().translationModel)
  }

  private async findModel(m: TranslationModel): Promise<LibraryModel | undefined> {
    return (await this.deps.library.list()).find((x) => x.repoId === m.repo && x.entryKey === m.entryKey)
  }

  async getStatus(): Promise<TranslationStatus> {
    const m = this.selected()
    const available = (await this.deps.runtime.getInfo()).installed
    const job = this.deps.downloads.list().find((j) => j.id === jobIdOf(m))
    const downloading = job && (job.status === 'downloading' || job.status === 'queued')
    const model: TranslationStatus['model'] = downloading ? 'downloading' : (await this.findModel(m)) ? 'ready' : 'missing'
    return {
      available,
      enabled: this.deps.settings.get().promptTranslation,
      modelId: m.id,
      model,
      server: this.deps.helper.getStatus().state,
      progress: downloading ? { doneBytes: job.doneBytes, totalBytes: job.totalBytes } : undefined,
      error: this.error ?? (job?.status === 'error' ? job.error : undefined),
    }
  }

  async setEnabled(on: boolean): Promise<TranslationStatus> {
    this.deps.settings.update({ promptTranslation: on })
    this.error = undefined
    if (on) {
      await this.startPreparing()
    } else {
      this.cancelPreparing()
      await this.deps.helper.stop()
    }
    return this.emitStatus()
  }

  /** 翻訳モデルを切り替える。有効なら、前のモデルの準備を取りやめて新しいモデルを取得・起動する */
  async setModel(id: TranslationModelId): Promise<TranslationStatus> {
    if (!TRANSLATION_MODELS.some((m) => m.id === id)) throw new Error(L(`不明な翻訳モデルです: ${id}`, `Unknown translation model: ${id}`))
    if (this.deps.settings.get().translationModel !== id) {
      this.deps.settings.update({ translationModel: id })
      this.error = undefined
      this.cancelPreparing()
      await this.deps.helper.stop()
      this.modelId = null
      if (this.deps.settings.get().promptTranslation) await this.startPreparing()
    }
    return this.emitStatus()
  }

  private async emitStatus(): Promise<TranslationStatus> {
    const s = await this.getStatus()
    this.emit('status', s)
    return s
  }

  /** 取得と起動を裏で始める (失敗は status.error に出す) */
  private async startPreparing(): Promise<void> {
    if (!(await this.deps.runtime.getInfo()).installed) {
      this.error = L('llama.cpp ランタイムが未インストールです。設定画面からインストールしてください', 'The llama.cpp runtime is not installed. Install it from Settings')
      return
    }
    this.prepare().catch(() => {})
  }

  /**
   * 準備中なら取りやめる。モデルのダウンロードは自分が始めたもの (準備中) だけ止める
   * (同じモデルをユーザーが検索画面から落としている最中かもしれないので)
   */
  private cancelPreparing(): void {
    if (!this.preparing) return
    this.preparing.abort.abort()
    this.deps.downloads.cancel(this.preparing.jobId)
  }

  /** 選んでいるモデルが無ければダウンロードし、翻訳サーバーが動いていなければ起動する */
  prepare(): Promise<void> {
    // 取りやめ中の準備が残っていれば、それが終わってからやり直す (無効化 → すぐ有効化、モデルの切り替えの場合)
    if (this.preparing) return this.preparing.promise.catch(() => {}).then(() => this.prepare())
    const m = this.selected()
    const abort = new AbortController()
    const promise = this.doPrepare(m, abort.signal).finally(() => {
      this.preparing = null
    })
    this.preparing = { promise, abort, jobId: jobIdOf(m) }
    return promise
  }

  private async doPrepare(m: TranslationModel, signal: AbortSignal): Promise<void> {
    let changed = false
    try {
      let model = await this.findModel(m)
      if (!model) {
        model = await this.downloadModel(m, signal)
        changed = true
      }
      const st = this.deps.helper.getStatus()
      if (st.state === 'running' && st.modelId === model.id) {
        this.modelId = model.id
        return
      }
      if (signal.aborted) return
      // CPU 固定 (-ngl 0)、短いコンテキストで軽く動かす
      await this.deps.helper.start(model, { modelId: model.id, contextSize: 2048, gpuLayers: 0 })
      if (signal.aborted) return
      this.modelId = model.id
      this.error = undefined
      changed = true
    } catch (err) {
      if (signal.aborted) return // 無効化・切り替えによる取りやめはエラーにしない
      this.error = err instanceof Error ? err.message : String(err)
      changed = true
      throw err
    } finally {
      if (changed) await this.emitStatus()
    }
  }

  private async downloadModel(m: TranslationModel, signal: AbortSignal): Promise<LibraryModel> {
    const files = await this.deps.hf.listFiles(m.repo)
    const entry = files.entries.find((e) => e.key === m.entryKey)
    if (!entry) throw new Error(L(`${m.repo} に翻訳モデル (${m.entryKey}) が見つかりません`, `Translation model (${m.entryKey}) not found in ${m.repo}`))
    const info = await this.deps.hf.modelInfo(m.repo).catch(() => null)
    const job = this.deps.downloads.start(m.repo, entry, info?.gguf ?? null)
    const done = await this.deps.downloads.waitForJob(job.id, signal)
    if (done.status === 'cancelled') throw new Error(L('翻訳モデルのダウンロードが中断されました', 'The translation model download was cancelled'))
    if (done.status === 'error') throw new Error(L(`翻訳モデルのダウンロードに失敗しました: ${done.error ?? ''}`, `Failed to download the translation model: ${done.error ?? ''}`))
    const model = await this.findModel(m)
    if (!model) throw new Error(L('翻訳モデルをライブラリで見つけられません', 'The translation model was not found in the library'))
    return model
  }

  /** 英語以外の言語の文章を、画像生成向けの英語プロンプトにする */
  async translate(text: string): Promise<string> {
    if (!this.deps.settings.get().promptTranslation) throw new Error(L('プロンプトの翻訳が無効です', 'Prompt translation is disabled'))
    if (!text.trim()) return text
    // 翻訳サーバーが起動済みなら準備 (ライブラリ走査を含む) を省く
    const running = this.deps.helper.getStatus()
    if (!(running.state === 'running' && running.modelId === this.modelId)) await this.prepare()
    const st = this.deps.helper.getStatus()
    if (st.state !== 'running' || !st.port) throw new Error(L('翻訳サーバーが起動していません', 'The translation server is not running'))
    const res = await fetch(`http://127.0.0.1:${st.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
        max_tokens: 300,
        // Qwen3 の思考モードは翻訳には不要 (遅くなるだけ) なので切る (思考の無い Instruct-2507 では無視される)
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(L(`翻訳に失敗しました (HTTP ${res.status})`, `Translation failed (HTTP ${res.status})`))
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const out = (data.choices?.[0]?.message?.content ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .replace(/\s*\n+\s*/g, ', ')
      .trim()
    if (!out) throw new Error(L('翻訳結果が空でした', 'The translation result was empty'))
    return out
  }
}
