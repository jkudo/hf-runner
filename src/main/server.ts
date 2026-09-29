import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { EngineId, LibraryModel, LoadProgress, Precision, ServerStartOptions, ServerStatus, Settings } from '@shared/types'
import { COMPONENT_ROLE_LABEL, hasComponentCatalog } from '@shared/diffusion'
import { standaloneBlock } from '@shared/quant'
import { argValue, assertCommand, buildCommand, DEFAULT_COMMANDS, type CommandVars } from '@shared/command'
import { engineForFormat } from '@shared/engines'
import { AUTO_GPU, selectedIndex } from '@shared/gpu'
import { getLang, L } from '@shared/i18n'
import type { ComponentManager } from './components'
import type { PythonRuntime } from './python'
import { discreteDevices, gpuLayersArg, type RuntimeManager } from './runtime'
import type { SdRuntimeManager } from './sdcpp'
import { sleep } from '@shared/async'
const MB = 1024 * 1024

interface LaunchSpec {
  engine: EngineId
  /** 起動コマンドのひな形 (DEFAULT_COMMANDS / 設定の本文) の {…} に入れる値 */
  vars: CommandVars
  cwd: string
  env?: NodeJS.ProcessEnv
  buildInfo: string
  precision?: Precision
  /** 読み込み時間の履歴キー */
  historyKey: string
}

/** ログ行から読み込み段階を判定するルール。floor は到達した時点の進捗下限 */
interface PhaseRule {
  test: RegExp
  /** 表示用の段階名 (言語はその時点のもの) */
  phase: () => string
  floor: number
  /** マッチから実測の進捗 (0..1) を取り出す */
  reported?: (m: RegExpMatchArray) => number
}

const PHASES: Record<EngineId, PhaseRule[]> = {
  llamacpp: [
    { test: /load_model: loading model/, phase: () => L('モデルを読み込み中', 'Loading model'), floor: 0.05 },
    { test: /load_tensors: loading model tensors/, phase: () => L('テンソルを読み込み中', 'Loading tensors'), floor: 0.1 },
    { test: /load_model: initializing, n_slots|llama_context: constructing/, phase: () => L('コンテキストを初期化中', 'Initializing context'), floor: 0.9 },
    { test: /llama_server: model loaded/, phase: () => L('準備完了まであと少し', 'Almost ready'), floor: 0.97 },
  ],
  transformers: [
    { test: /\[hfrunner\] python .* (?:を読み込み中|loading torch)/, phase: () => L('Python / PyTorch を起動中', 'Starting Python / PyTorch'), floor: 0.02 },
    { test: /\[hfrunner\] torch /, phase: () => L('モデルの読み込みを準備中', 'Preparing to load model'), floor: 0.15 },
    { test: /Loading (?:weights|checkpoint shards):\s+(\d+)%/, phase: () => L('重みを読み込み中', 'Loading weights'), floor: 0.2, reported: (m) => 0.2 + (Number(m[1]) / 100) * 0.7 },
    { test: /\[hfrunner\] (?:読み込み完了|Loaded:)/, phase: () => L('準備完了まであと少し', 'Almost ready'), floor: 0.95 },
  ],
  sdcpp: [
    { test: /loading model from|load_from_file/, phase: () => L('モデルを読み込み中', 'Loading model'), floor: 0.05 },
    // テンソル読み込みの進捗バー: "  |#####      | 280/686 - 662MB/s"
    { test: /\|[#\s]*\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+\s*[KMG]B\/s/, phase: () => L('テンソルを読み込み中', 'Loading tensors'), floor: 0.1, reported: (m) => 0.1 + (Number(m[1]) / Math.max(1, Number(m[2]))) * 0.8 },
    { test: /loading tensors completed/, phase: () => L('GPU へ転送中', 'Transferring to GPU'), floor: 0.92 },
  ],
}

/** 推論サーバー(llama-server / server.py)の起動・監視・停止 */
export class ServerManager extends EventEmitter {
  private proc: ChildProcess | null = null
  private status: ServerStatus = { state: 'stopped', logTail: [] }
  private log: string[] = []
  private startToken = 0
  private emitTimer: NodeJS.Timeout | null = null
  private progressTimer: NodeJS.Timeout | null = null
  private loading: { startedAt: number; expectedMs: number; source: LoadProgress['source']; phase: string; floor: number; reported: number | null; engine: EngineId } | null = null
  private history: Record<string, number> | null = null
  /** 起動コマンド (ログの先頭行)。ログが流れても表示に残す */
  private commandLine = ''

  constructor(
    private readonly deps: {
      runtime: RuntimeManager
      python: PythonRuntime
      sd: SdRuntimeManager
      components?: ComponentManager
      getSettings: () => Settings
      historyPath: string
      /** 補助サーバー (翻訳モデルなど) 用。設定のポートにこの値を足した所から空きポートを探す */
      portOffset?: number
      /** 設定で編集した起動コマンドを使うか (メインの推論サーバーだけ。翻訳用の補助サーバーは常に既定のコマンド) */
      customCommand?: boolean
    },
  ) {
    super()
  }

  getStatus(): ServerStatus {
    const logTail = this.log.length > 120 ? [this.commandLine, '…', ...this.log.slice(-118)] : this.log.slice()
    return { ...this.status, logTail }
  }

  async start(model: LibraryModel, opts: ServerStartOptions): Promise<ServerStatus> {
    const settings = this.deps.getSettings()
    // 起動コマンドはひな形の {…} を置き換えて作る。設定で本文を編集していればそちらを使う。
    // 本文に問題があれば、動いているモデルを止める前に断る
    const engine = engineForFormat(model.format)
    const custom = this.deps.customCommand ? commandSetting(settings, engine).trim() : ''
    if (custom) assertCommand(custom, engine)
    await this.stop()
    // 起動準備 (ポート探索・ランタイム情報の取得) の間に stop() が呼ばれたら、子プロセスを作らずに引き返す
    const token = ++this.startToken
    const port = await findFreePort(settings.serverPort + (this.deps.portOffset ?? 0))
    const ctx = opts.contextSize ?? settings.contextSize
    const ngl = opts.gpuLayers ?? settings.gpuLayers
    const spec =
      engine === 'llamacpp' ? await this.llamaSpec(model, opts, port, ctx, ngl) : engine === 'sdcpp' ? await this.sdSpec(model, port) : await this.pythonSpec(model, opts, port, ctx)
    const modelPath = path.join(model.dir, model.mainFile)
    const { command, args } = buildCommand(custom || DEFAULT_COMMANDS[engine], engine, spec.vars)
    const shown = passedValues(engine, args, ctx, ngl)

    if (this.startToken !== token) return this.getStatus()
    this.commandLine = `$ ${path.basename(command)} ${args.map(quote).join(' ')}`
    this.log = [this.commandLine]
    // 設定の本文を使って失敗したときに添える案内
    const customHint = custom
      ? L(
          '\n設定で起動コマンドを編集しています。原因の場合は設定画面で見直すか「既定に戻す」を押してください。',
          '\nThe launch command has been edited in Settings. If that caused this, review it or click "Restore default" in Settings.',
        )
      : ''
    const proc = spawn(command, args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc = proc
    this.beginProgress(spec, model)
    this.setStatus({
      state: 'starting',
      engine: spec.engine,
      progress: this.currentProgress(),
      port,
      modelId: model.id,
      modelName: model.displayName,
      modelPath,
      pid: proc.pid,
      startedAt: Date.now(),
      contextSize: shown.contextSize,
      gpuLayers: shown.gpuLayers,
      precision: spec.precision,
      buildInfo: spec.buildInfo,
      vision: model.vision,
      logTail: [],
    })

    const onData = (chunk: Buffer) => {
      // tqdm などは \r で同じ行を更新するので、\r 区切りの最後の状態だけを採用する
      for (const raw of chunk.toString('utf8').split(/\r\n|\n/)) {
        const line = raw.split('\r').pop()?.trim()
        if (!line) continue
        this.pushLog(line)
        this.observeLine(line)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (err) => {
      if (this.proc === proc) {
        this.proc = null
        this.endProgress()
        this.setStatus({ ...this.status, state: 'error', progress: undefined, pid: undefined, error: L(`推論サーバーを起動できません: ${err.message}`, `Could not start the inference server: ${err.message}`) + customHint })
      }
    })
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return
      this.proc = null
      this.endProgress()
      const graceful = this.status.state === 'running' || code === 0 || signal !== null
      this.setStatus({
        ...this.status,
        state: graceful ? 'stopped' : 'error',
        progress: undefined,
        pid: undefined,
        error: graceful
          ? undefined
          : L(`推論サーバーが終了しました (code ${code})。`, `The inference server exited (code ${code}). `) +
            explainExit(this.log) +
            customHint +
            `\n${this.log.slice(-8).join('\n')}`,
      })
    })

    const deadline = Date.now() + 30 * 60_000
    while (Date.now() < deadline) {
      if (this.startToken !== token) return this.getStatus()
      if (this.proc !== proc) {
        const st = this.getStatus()
        throw new Error(st.error ?? L('推論サーバーが予期せず終了しました', 'The inference server exited unexpectedly'))
      }
      const health = await checkHealth(port, spec.engine)
      if (health === 'ok') {
        const elapsed = this.loading ? Date.now() - this.loading.startedAt : 0
        this.endProgress()
        await this.rememberLoadTime(spec.historyKey, elapsed)
        const vision = spec.engine === 'sdcpp' ? false : ((await fetchVision(port, spec.engine)) ?? model.vision)
        this.setStatus({ ...this.status, state: 'running', progress: undefined, vision })
        return this.getStatus()
      }
      if (health !== 'wait') {
        await this.stop()
        throw new Error(L(`モデルの読み込みに失敗しました: ${health}`, `Failed to load the model: ${health}`) + `\n${this.log.slice(-6).join('\n')}`)
      }
      await sleep(500)
    }
    await this.stop()
    throw new Error(L('モデルの読み込みがタイムアウトしました', 'Loading the model timed out'))
  }

  private async llamaSpec(model: LibraryModel, opts: ServerStartOptions, port: number, ctx: number, ngl: number): Promise<LaunchSpec> {
    const info = await this.deps.runtime.getInfo()
    if (!info.installed || !info.serverPath) {
      throw new Error(L('llama.cpp ランタイムが未インストールです。設定画面からインストールしてください', 'The llama.cpp runtime is not installed. Install it from Settings'))
    }
    const threads = opts.threads ?? this.deps.getSettings().threads
    const modelPath = path.join(model.dir, model.mainFile)
    const notStandalone = standaloneBlock(model.displayName, model.header)
    if (notStandalone) throw new Error(notStandalone)
    let device: string[] = []
    if (ngl === 0) {
      // CPU のみで動かすときは GPU デバイスも使わない (CUDA ビルドはコンテキスト確保だけで VRAM を数百 MB 使うため)
      device = ['--device', 'none']
    } else {
      // 設定で GPU を選んでいればその GPU だけ。自動なら、外付け GPU があるときは内蔵 GPU には載せない
      const list = await this.deps.runtime.listDevices().catch(() => [])
      const chosen = selectedIndex(list, this.deps.getSettings().gpuSelection ?? AUTO_GPU)
      const devices = chosen !== null ? [list[chosen].id] : discreteDevices(list)
      if (devices) device = ['--device', devices.join(',')]
    }
    return {
      engine: 'llamacpp',
      vars: {
        exe: info.serverPath,
        model: modelPath,
        port: String(port),
        ctx: String(ctx),
        ngl: gpuLayersArg(ngl, info.tag),
        name: model.displayName,
        threads: threads > 0 ? ['-t', String(threads)] : [],
        device,
        // 画像入力: mmproj (視覚エンコーダー) を渡すと /v1/chat/completions の image_url を受け付ける
        mmproj: model.mmprojFile ? ['--mmproj', path.join(model.dir, model.mmprojFile)] : [],
      },
      cwd: path.dirname(info.serverPath),
      buildInfo: `llama.cpp ${info.tag} / ${info.backend}`,
      historyKey: `llamacpp:${info.backend}:${model.id}:ngl${ngl}:ctx${ctx}`,
    }
  }

  /**
   * 画像生成: stable-diffusion.cpp の sd-server。
   * 1 ファイル完結型 (SD1.x / SDXL) は -m、部品分割型 (FLUX / Qwen-Image / SD3) は --diffusion-model + 部品 (VAE / テキストエンコーダー)
   */
  private async sdSpec(model: LibraryModel, port: number): Promise<LaunchSpec> {
    const info = await this.deps.sd.getInfo()
    if (!info.installed || !info.serverPath) {
      throw new Error(L('画像生成エンジン (stable-diffusion.cpp) が未インストールです。設定画面からインストールしてください', 'The image generation engine (stable-diffusion.cpp) is not installed. Install it from Settings'))
    }
    const modelPath = path.join(model.dir, model.mainFile)
    const d = model.header?.diffusion
    if (d?.unsupported) throw new Error(L(`${d.unsupported}。fp8 / bf16 の safetensors か GGUF 版を使ってください`, `${d.unsupported}. Use an fp8 / bf16 safetensors or GGUF version`))
    let modelFlag = '-m'
    const components: string[] = []
    const recommended: string[] = []
    if (d && !d.singleFile) {
      if (!hasComponentCatalog(d.family) || !this.deps.components) {
        throw new Error(
          L(
            `この系統 (${d.family}) は拡散モデル本体だけで、必要な部品 (テキストエンコーダー / VAE) の入手先が分からないため起動できません`,
            `This family (${d.family}) contains only the diffusion model, and HF Runner does not know where to get the required components (text encoder / VAE), so it cannot be launched`,
          ),
        )
      }
      const parts = this.deps.components.resolve(d.family)
      if (!parts) {
        const missing = this.deps.components
          .status(d.family)
          .filter((s) => !s.present)
          .map((s) => COMPONENT_ROLE_LABEL[s.role])
        throw new Error(
          L(
            `必要な部品が揃っていません: ${missing.join(', ')}。ライブラリの「部品を取得」で自動ダウンロードできます`,
            `Required components are missing: ${missing.join(', ')}. You can download them automatically with "Get components" in the Library`,
          ),
        )
      }
      // SD3 のチェックポイントは VAE 込みなので -m、それ以外は本体だけなので --diffusion-model
      if (d.family !== 'sd3') modelFlag = '--diffusion-model'
      for (const [role, file] of Object.entries(parts)) components.push(`--${role}`, file)
      // ドキュメント推奨: DiT 系は flash attention と euler、重みは RAM に置いて必要時に GPU へ (VRAM 節約)
      recommended.push('--diffusion-fa', '--sampling-method', 'euler', '--offload-to-cpu')
      if (d.family === 'qwen_image') recommended.push('--flow-shift', '3')
    }
    const threads = this.deps.getSettings().threads
    // CPU 版は CPU に固定。GPU 版は、設定で GPU を選んでいればその GPU に全部載せる (自動なら sd.cpp が外付け GPU を選ぶ)
    let backend: string[] = []
    if (info.backend === 'cpu' && process.platform !== 'darwin') {
      backend = ['--backend', 'cpu']
    } else {
      const selection = this.deps.getSettings().gpuSelection ?? AUTO_GPU
      if (selection !== AUTO_GPU) {
        const list = await this.deps.sd.listDevices()
        const chosen = selectedIndex(list, selection)
        if (chosen !== null) backend = ['--backend', list[chosen].id]
      }
    }
    return {
      engine: 'sdcpp',
      vars: {
        exe: info.serverPath,
        'model-flag': modelFlag,
        model: modelPath,
        components,
        recommended,
        port: String(port),
        backend,
        threads: threads > 0 ? ['-t', String(threads)] : [],
      },
      cwd: path.dirname(info.serverPath),
      buildInfo: `stable-diffusion.cpp ${info.tag} / ${info.backend}`,
      historyKey: `sdcpp:${info.backend}:${model.id}`,
    }
  }

  private async pythonSpec(model: LibraryModel, opts: ServerStartOptions, port: number, ctx: number): Promise<LaunchSpec> {
    const py = this.deps.python
    const info = await py.getInfo()
    if (!info.installed || !info.pythonPath) {
      throw new Error(L('Python エンジン (Transformers) が未インストールです。設定画面からインストールしてください', 'The Python engine (Transformers) is not installed. Install it from Settings'))
    }
    const precision = opts.precision ?? this.deps.getSettings().transformersPrecision
    if (precision !== 'auto' && !info.cuda) throw new Error(L('8bit / 4bit の読み込みには NVIDIA GPU (CUDA 版 PyTorch) が必要です', '8-bit / 4-bit loading requires an NVIDIA GPU (CUDA build of PyTorch)'))
    if (precision !== 'auto' && !info.bitsandbytes) throw new Error(L('bitsandbytes が入っていません。設定から Python エンジンを再インストールしてください', 'bitsandbytes is not installed. Reinstall the Python engine from Settings'))
    await py.repairVenv()
    const env: NodeJS.ProcessEnv = { ...py.env(), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', HFRUNNER_LANG: getLang() }
    // 設定で選んだ GPU が CUDA から見えていれば、その GPU だけを見せる (NVIDIA 以外を選んだときは既定のまま)
    const chosen = selectedIndex(info.devices ?? [], this.deps.getSettings().gpuSelection ?? AUTO_GPU)
    if (info.cuda && chosen !== null) env.CUDA_VISIBLE_DEVICES = String(chosen)
    return {
      engine: 'transformers',
      vars: {
        python: info.pythonPath,
        script: py.serverScript(),
        model: model.dir,
        port: String(port),
        ctx: String(ctx),
        precision,
        name: model.displayName,
        'trust-remote-code': opts.trustRemoteCode ? ['--trust-remote-code'] : [],
      },
      cwd: model.dir,
      env,
      buildInfo: `transformers ${info.transformersVersion ?? '?'} / torch ${info.torchVersion ?? '?'} (${info.cuda ? 'CUDA' : 'CPU'})`,
      precision,
      historyKey: `transformers:${info.cuda ? 'cuda' : 'cpu'}:${model.id}:${precision}`,
    }
  }

  async stop(): Promise<ServerStatus> {
    this.startToken++
    this.endProgress()
    const proc = this.proc
    if (!proc) {
      if (this.status.state !== 'stopped') this.setStatus({ state: 'stopped', logTail: [] })
      return this.getStatus()
    }
    this.proc = null
    await killProcess(proc)
    this.setStatus({ state: 'stopped', logTail: [] })
    return this.getStatus()
  }

  // ---- 読み込み進捗 ----

  private beginProgress(spec: LaunchSpec, model: LibraryModel): void {
    const remembered = this.loadHistory()[spec.historyKey]
    const expectedMs = remembered ?? heuristicLoadMs(spec.engine, model.totalSize)
    this.loading = {
      startedAt: Date.now(),
      expectedMs: Math.max(expectedMs, 500),
      source: remembered ? 'history' : 'heuristic',
      phase: L('起動中', 'Starting'),
      floor: 0,
      reported: null,
      engine: spec.engine,
    }
    this.progressTimer = setInterval(() => {
      if (this.status.state !== 'starting') return
      this.setStatus({ ...this.status, progress: this.currentProgress() })
    }, 400)
  }

  private endProgress(): void {
    if (this.progressTimer) clearInterval(this.progressTimer)
    this.progressTimer = null
    this.loading = null
  }

  private observeLine(line: string): void {
    const l = this.loading
    if (!l) return
    for (const rule of PHASES[l.engine]) {
      const m = rule.test.exec(line)
      if (!m) continue
      if (rule.reported) {
        l.reported = rule.reported(m)
        l.source = 'reported'
      }
      if (rule.floor >= l.floor) {
        l.floor = rule.floor
        l.phase = rule.phase()
      }
    }
  }

  private currentProgress(): LoadProgress | undefined {
    const l = this.loading
    if (!l) return undefined
    const elapsedMs = Date.now() - l.startedAt
    let fraction: number
    if (l.reported !== null) {
      fraction = Math.max(l.reported, l.floor)
    } else {
      // 期待時間に対して飽和曲線で進め、実際に完了するまでは 92% で止める
      const timeBased = 0.92 * (1 - Math.exp((-2 * elapsedMs) / l.expectedMs))
      fraction = Math.max(l.floor, Math.min(0.92, timeBased))
    }
    return { fraction: Math.min(fraction, 0.99), phase: l.phase, elapsedMs, expectedMs: l.expectedMs, source: l.source }
  }

  private loadHistory(): Record<string, number> {
    if (this.history) return this.history
    try {
      this.history = JSON.parse(fs.readFileSync(this.deps.historyPath, 'utf8')) as Record<string, number>
    } catch {
      this.history = {}
    }
    return this.history
  }

  private async rememberLoadTime(key: string, elapsedMs: number): Promise<void> {
    if (elapsedMs <= 0) return
    const h = this.loadHistory()
    // 2 回目以降は前回値となじませる(ディスクキャッシュの有無で振れるため)
    h[key] = h[key] ? Math.round(h[key] * 0.4 + elapsedMs * 0.6) : elapsedMs
    await fsp.writeFile(this.deps.historyPath, JSON.stringify(h, null, 2)).catch(() => {})
  }

  private pushLog(line: string): void {
    this.log.push(line)
    this.emit('line', line)
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500)
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('status', this.getStatus())
    }, 250)
  }

  private setStatus(s: ServerStatus): void {
    this.status = s
    this.emit('status', this.getStatus())
  }
}

/** 初回(履歴なし)の読み込み時間の目安 */
/** 推論サーバーが異常終了したときのログから、よくある原因を利用者向けの一文にする (分からなければ空) */
export function explainExit(log: string[]): string {
  const text = log.join('\n')
  if (/invalid ggml type/i.test(text)) return L(
      '\nこのファイルは公式の llama.cpp に無い独自の量子化 (フォーク版の llama.cpp 専用) のため読み込めません。同じリポジトリの Q4_K_M などを選んでください。',
      '\nThis file uses a custom quantization that official llama.cpp does not support (it is for a forked llama.cpp only), so it cannot be loaded. Choose Q4_K_M or similar from the same repository.',
    )
  if (/couldn't bind|address already in use|EADDRINUSE/i.test(text)) return L('\n起動の直前に、他のアプリが同じポートを使い始めました。もう一度起動してください。', '\nAnother app started using the same port just before launch. Please launch again.')
  if (/unknown model architecture/i.test(text)) return L(
      '\nこのモデルの構造 (アーキテクチャ) はインストール済みの llama.cpp が未対応です。設定画面で llama.cpp を更新すると動く場合があります。',
      '\nThe installed llama.cpp does not support this model architecture. Updating llama.cpp in Settings may make it work.',
    )
  return ''
}

function heuristicLoadMs(engine: EngineId, totalSize: number): number {
  if (engine === 'sdcpp') {
    // Vulkan / CUDA の初期化 + テンソル読み込み (約 1GB/s)
    return 4_000 + (totalSize / (1000 * MB)) * 1000
  }
  if (engine === 'transformers') {
    // torch / transformers の import に十数秒 + 重みの読み込み (約 400MB/s)
    return 12_000 + (totalSize / (400 * MB)) * 1000
  }
  // mmap で読みつつ GPU へ転送 (約 700MB/s) + 初期化
  return 1_500 + (totalSize / (700 * MB)) * 1000
}

const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s)

/**
 * 画面に出すコンテキスト長と GPU レイヤー数。起動コマンドを編集して -c / -ngl などを書き換えていても合うよう、実際に渡した引数から読む
 * (読めない・auto などのときは設定の値。コンテキスト長 0 はモデルの既定なので「不明」)
 */
export function passedValues(engine: EngineId, args: string[], ctx: number, ngl: number): { contextSize?: number; gpuLayers?: number } {
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined)
  const ctxFlags = engine === 'llamacpp' ? ['-c', '--ctx-size'] : engine === 'transformers' ? ['--max-context'] : []
  const passedCtx = num(argValue(args, ctxFlags))
  return {
    contextSize: passedCtx === undefined ? ctx : passedCtx > 0 ? passedCtx : undefined,
    gpuLayers: engine === 'llamacpp' ? (num(argValue(args, ['-ngl', '--gpu-layers', '--n-gpu-layers'])) ?? ngl) : undefined,
  }
}

/** 設定で編集したエンジンごとの起動コマンド (空なら既定) */
export function commandSetting(settings: Settings, engine: EngineId): string {
  return (engine === 'llamacpp' ? settings.llamaCommand : engine === 'sdcpp' ? settings.sdCommand : settings.pythonCommand) ?? ''
}

/** 'ok' | 'wait' | エラーメッセージ */
async function checkHealth(port: number, engine: EngineId): Promise<string> {
  // sd-server はモデルを読み込んでからリッスンし、/health は無いので capabilities が返れば準備完了
  const url = engine === 'sdcpp' ? `http://127.0.0.1:${port}/sdcpp/v1/capabilities` : `http://127.0.0.1:${port}/health`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    if (engine === 'sdcpp') return res.ok ? 'ok' : 'wait'
    const data = (await res.json().catch(() => ({}))) as { status?: string; error?: { message?: string } | string }
    if (res.ok && data.status === 'ok') return 'ok'
    if (res.status === 503) return 'wait'
    if (res.status >= 500) {
      const msg = typeof data.error === 'string' ? data.error : data.error?.message
      return msg ?? `HTTP ${res.status}`
    }
    return 'wait'
  } catch {
    return 'wait'
  }
}

/** 起動したサーバーが画像入力を受け付けるかを /props で確認する。llama-server は modalities.vision、server.py は vision */
async function fetchVision(port: number, engine: EngineId): Promise<boolean | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const data = (await res.json()) as { vision?: boolean; modalities?: { vision?: boolean } }
    const v = engine === 'llamacpp' ? data.modalities?.vision : data.vision
    return typeof v === 'boolean' ? v : null
  } catch {
    return null
  }
}

/** そのアドレスでポートを開けるか。IPv6 が無効な PC の "::" のように、アドレス自体が使えない場合は「空き」とみなす */
function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL'))
    srv.listen(port, host, () => srv.close(() => resolve(true)))
  })
}

/**
 * ポートが他のアプリに使われていないか。127.0.0.1 だけでなく全アドレス (0.0.0.0 / ::) でも確かめる。
 * Windows では他のアプリが 0.0.0.0:ポート で待ち受けていても 127.0.0.1:ポート を開けてしまい、
 * そのアプリ宛ての localhost の通信を推論サーバーが横取りしてしまうため
 */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '0.0.0.0', '::']) if (!(await canListen(port, host))) return false
  return true
}

/** start から順に空いているポートを探す (既定 18080 が使用中なら 18081, 18082 …) */
async function findFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 50; p++) if (await isPortFree(p)) return p
  throw new Error(
    L(
      `ポート ${start}〜${start + 49} がすべて他のアプリに使われています。設定画面の「ポート」を変更してください`,
      `Ports ${start}-${start + 49} are all in use by other apps. Change the "Port" in Settings`,
    ),
  )
}

async function killProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
  proc.kill()
  const timeout = sleep(5000).then(() => 'timeout' as const)
  if ((await Promise.race([exited, timeout])) === 'timeout') {
    proc.kill('SIGKILL')
    await Promise.race([exited, sleep(2000)])
  }
}
