// メイン / プリロード / レンダラで共有する型定義

import type { ComponentLicense, ComponentRole, DiffusionInfo } from './diffusion'
import type { LanguageSetting } from './i18n'
import type { TranslationModelId } from './translation'

export type Backend = 'cpu' | 'vulkan' | 'cuda12' | 'cuda13' | 'metal'
/** gguf / safetensors = 言語モデル (llama.cpp / Transformers)、diffusion = 画像生成モデル (stable-diffusion.cpp。ファイル自体は .safetensors か .gguf) */
export type ModelFormat = 'gguf' | 'safetensors' | 'diffusion'
export type EngineId = 'llamacpp' | 'transformers' | 'sdcpp'
/** stable-diffusion.cpp のビルド種別 */
export type SdBackend = 'cpu' | 'vulkan' | 'cuda12' | 'rocm'
export type Precision = 'auto' | '8bit' | '4bit'
export type TorchBackend = 'auto' | 'cpu' | 'cu126' | 'cu128' | 'cu130'

export interface Settings {
  modelsDir: string
  hfToken: string
  backend: Backend
  contextSize: number
  /** GPU に載せるレイヤー数。99 = 全レイヤー, 0 = CPU のみ */
  gpuLayers: number
  /** 0 = 自動 */
  threads: number
  serverPort: number
  systemPrompt: string
  temperature: number
  maxTokens: number
  /** Python エンジンの PyTorch バックエンド */
  torchBackend: TorchBackend
  /** Transformers で読み込む既定の精度 */
  transformersPrecision: Precision
  /** ダウンロードの同時接続数 (1 = 分割しない)。大きいファイルを範囲に分けて並列取得する */
  downloadConnections: number
  /** 画像生成エンジン (stable-diffusion.cpp) のビルド種別 */
  sdBackend: SdBackend
  /** 画像生成で英語以外のプロンプトを翻訳モデル (CPU) で英訳する */
  promptTranslation: boolean
  /** プロンプト翻訳に使うモデル (TRANSLATION_MODELS) */
  translationModel: TranslationModelId
  /** サーバーモード: 外部の PC・アプリから API を使えるようにする (LAN に公開) */
  lanEnabled: boolean
  /** サーバーモードの待ち受けポート (固定。内部の推論サーバーのポートとは別) */
  lanPort: number
  /** サーバーモードの API キー (有効化時に自動生成) */
  lanApiKey: string
  /** ウィンドウを閉じてもタスクトレイに常駐する */
  trayEnabled: boolean
  /** 表示言語。auto = OS の言語 (日本語以外は英語) */
  language: LanguageSetting
  /** 推論に使う GPU。'auto' = 外付け GPU を優先、それ以外は GPU のキー (gpuKey) */
  gpuSelection: string
  /** 推論サーバーの起動コマンドの本文 (エンジンごと。{model} などの差し込み項目入り。空なら既定の DEFAULT_COMMANDS) */
  llamaCommand: string
  sdCommand: string
  pythonCommand: string
}

/** サーバーモードの状態 */
export interface LanStatus {
  enabled: boolean
  /** 待ち受け中か */
  listening: boolean
  port: number
  /** 他の機器から使う URL (LAN 側の IP アドレスごと) */
  urls: string[]
  error?: string
  /** 起動してからの認証済みリクエスト数 */
  requests: number
  lastAccess?: { from: string; path: string; at: string }
}

export type Gated = false | 'auto' | 'manual'

export interface HFModelSummary {
  id: string
  author: string
  likes: number
  downloads: number
  tags: string[]
  pipelineTag?: string
  libraryName?: string
  createdAt?: string
  lastModified?: string
  trendingScore?: number
  gated: Gated
  hasGguf: boolean
  hasSafetensors: boolean
}

/** HF API がリポジトリ単位で返す GGUF メタデータ */
export interface HFGgufMeta {
  total?: number
  architecture?: string
  context_length?: number
  bos_token?: string
  eos_token?: string
  totalFileSize?: number
}

/** HF API がリポジトリ単位で返す safetensors メタデータ(パラメータ数と dtype) */
export interface HFSafetensorsMeta {
  total: number
  parameters: Record<string, number>
}

export interface HFModelInfo extends HFModelSummary {
  sha?: string
  gguf?: HFGgufMeta
  safetensors?: HFSafetensorsMeta
  modelType?: string
  architectures: string[]
  baseModels: string[]
  license?: string
  languages: string[]
}

/** config.json から取り出したメモリ見積もりに必要な情報 */
export interface HFModelConfig {
  modelType?: string
  architectures: string[]
  numHiddenLayers?: number
  numAttentionHeads?: number
  numKeyValueHeads?: number
  hiddenSize?: number
  headDim?: number
  maxPositionEmbeddings?: number
  vocabSize?: number
  torchDtype?: string
  hasAutoMap: boolean
  tieWordEmbeddings: boolean
  numExperts?: number
  /** vision_config を持つ = 画像入力(視覚言語モデル) */
  hasVision: boolean
}

export interface HFFile {
  path: string
  size: number
}

export interface QuantInfo {
  name: string
  /** 1 重みあたりの平均ビット数の目安 */
  bpw: number
  label: string
  note: string
  /** 品質順(0 が最高品質) */
  rank: number
}

/** 1 つの実行可能なモデル(GGUF なら 1 ファイル or 分割セット、safetensors ならリポジトリ一式) */
export interface ModelEntry {
  key: string
  displayName: string
  format: ModelFormat
  quant: string
  quantInfo: QuantInfo | null
  files: HFFile[]
  totalSize: number
  isMmproj: boolean
  isSplit: boolean
  /** 投機的デコード用のドラフトモデル (単体では実行できない) */
  draft?: boolean
  paramsB: number | null
  /** safetensors の保存 dtype (BF16 など) */
  dtype?: string
}

export interface RepoFilesResult {
  repoId: string
  /** GGUF エントリ */
  entries: ModelEntry[]
  mmproj: ModelEntry[]
  /** 画像生成モデルの候補 (ルート直下の大きな .safetensors / .gguf)。画像生成系リポジトリのときに使う */
  diffusionEntries: ModelEntry[]
  /** Transformers で実行する元の重み(safetensors)一式 */
  transformersEntry: ModelEntry | null
  otherFiles: HFFile[]
  hasGguf: boolean
  hasSafetensors: boolean
}

export interface ModelHeaderInfo {
  format: ModelFormat
  version: number
  tensorCount: number
  kvCount: number
  architecture?: string
  name?: string
  sizeLabel?: string
  fileType?: number
  fileTypeName?: string
  paramCount?: number
  contextLength?: number
  blockCount?: number
  embeddingLength?: number
  headCount?: number
  headCountKv?: number
  keyLength?: number
  valueLength?: number
  vocabSize?: number
  expertCount?: number
  hasChatTemplate: boolean
  metadata: Record<string, string | number | boolean>
  /** tokenizer 以降を読み飛ばした(リモート解析時)かどうか */
  truncated: boolean
  /** safetensors: 保存 dtype */
  dtype?: string
  /** safetensors: カスタムモデルコード (trust_remote_code) が必要か */
  hasAutoMap?: boolean
  tieWordEmbeddings?: boolean
  /** safetensors: 画像入力(vision_config あり) */
  hasVision?: boolean
  /** 先頭の数個のテンソル名 (拡散モデルの判定用) */
  tensorNames?: string[]
  /** block_count に対して欠けているレイヤー数。一部のレイヤーしか入っていないファイル (MTP のドラフトなど) は単体で実行できない */
  missingLayers?: number
  /** 公式の llama.cpp に無い ggml 型番号 (フォーク専用の量子化)。あれば公式の llama-server では読み込めない */
  unknownTensorType?: number
  /** 拡散モデル (画像生成) と判定されたときの系統。family = sd1 / sdxl / flux / qwen_image / unet …。singleFile = 1 ファイルで実行可 */
  diffusion?: DiffusionInfo
}

export interface MemoryEstimate {
  weightsBytes: number
  kvCacheBytes: number
  overheadBytes: number
  totalBytes: number
  contextSize: number
  /** ヘッダ情報が無く、パラメータ数から推定した場合 true */
  approximate: boolean
  precision?: Precision
}

export type FitLevel = 'gpu' | 'gpu-partial' | 'cpu' | 'no' | 'unknown'

export interface FitResult {
  level: FitLevel
  label: string
  detail: string
  estimate: MemoryEstimate
}

export interface GpuDevice {
  id: string
  name: string
  totalMiB: number
  freeMiB: number
  /** CPU 内蔵の GPU (メインメモリを共有)。外付け GPU があれば推論には使わない */
  integrated?: boolean
  /** エンジンをまたいで同じ GPU を指すキー (名前 + 同じ名前の中での順番)。設定「使用する GPU」に保存する */
  key?: string
}

export interface SystemInfo {
  platform: string
  arch: string
  totalMemBytes: number
  freeMemBytes: number
  cpuCount: number
  cpuModel: string
  gpus: GpuDevice[]
  gpuSource: 'runtime' | 'python' | 'nvidia-smi' | 'none'
}

/** 現在の使用率(サイドバーのメーター用)。cpuPercent は初回サンプルでは null */
export interface SystemStats {
  cpuPercent: number | null
  memUsedBytes: number
  memTotalBytes: number
  /** nvidia-smi が返した GPU ごとの使用率(nvidia-smi が使えない環境では空) */
  gpus: GpuStats[]
}

export interface GpuStats {
  index: number
  name: string
  /** nvidia-smi が使用率を返さない GPU では null */
  percent: number | null
  vramUsedMiB: number
  vramTotalMiB: number
}

export type DownloadStatus = 'queued' | 'downloading' | 'done' | 'error' | 'cancelled'

export interface DownloadFileProgress {
  path: string
  size: number
  done: number
}

export interface DownloadJob {
  id: string
  repoId: string
  entryKey: string
  /** 画像生成モデルの部品 (VAE / テキストエンコーダー) のジョブ。検索画面に対応する項目が無い */
  component?: boolean
  displayName: string
  format: ModelFormat
  quant: string
  files: DownloadFileProgress[]
  destDir: string
  totalBytes: number
  doneBytes: number
  speedBps: number
  status: DownloadStatus
  error?: string
  createdAt: number
  updatedAt: number
}

export interface LibraryModel {
  id: string
  repoId: string
  entryKey: string
  /** 表示名 (言語を含まない。推論サーバーのモデル名にも使う) */
  displayName: string
  /** 分割 GGUF のパーツ数 (分割でなければ無し)。表示時に splitSuffix で注記する */
  splitParts?: number
  format: ModelFormat
  quant: string
  dir: string
  mainFile: string
  files: string[]
  totalSize: number
  downloadedAt: string
  header: ModelHeaderInfo | null
  hfMeta: HFGgufMeta | null
  paramsB: number | null
  /** GGUF: 画像入力用の mmproj ファイル(dir からの相対パス) */
  mmprojFile?: string
  /** 画像生成 (部品分割型): 必要な部品の状態。1 ファイル完結型や部品カタログの無い系統では undefined */
  components?: ComponentStatus[]
  /** 画像を添付してチャットできるか(GGUF は mmproj あり、safetensors は vision_config あり) */
  vision: boolean
}

export type RuntimeInstallState = 'idle' | 'fetching' | 'downloading' | 'extracting' | 'done' | 'error'

export interface RuntimeInfo {
  installed: boolean
  backend?: Backend
  tag?: string
  serverPath?: string
  dir?: string
  installedAt?: string
}

export interface RuntimeProgress {
  state: RuntimeInstallState
  message: string
  doneBytes?: number
  totalBytes?: number
}

export interface BackendOption {
  id: Backend
  label: string
  description: string
  recommended: boolean
}

export interface ReleaseCheck {
  latestTag: string
  currentTag?: string
  updateAvailable: boolean
}

/** stable-diffusion.cpp ランタイム (画像生成) の状態。llama.cpp の RuntimeInfo と同じ形 */
export interface SdRuntimeInfo {
  installed: boolean
  backend?: SdBackend
  tag?: string
  serverPath?: string
  dir?: string
  installedAt?: string
}

export interface SdBackendOption {
  id: SdBackend
  label: string
  description: string
  recommended: boolean
}

/** 画像生成のパラメータ */
export interface ImageGenParams {
  prompt: string
  negativePrompt: string
  width: number
  height: number
  steps: number
  cfgScale: number
  /** -1 = ランダム (実際に使った値は結果に記録される) */
  seed: number
  sampler?: string
}

/** 生成済み画像 (images/ に PNG と同名の .json で保存) */
export interface GeneratedImage {
  /** 絶対パス */
  file: string
  name: string
  createdAt: string
  params: ImageGenParams
  modelName?: string
  elapsedMs?: number
}

export type ImageGenState = 'idle' | 'generating' | 'done' | 'error' | 'cancelled'

export interface ImageGenStatus {
  state: ImageGenState
  jobId?: string
  /** 現在のステップ (ログから)。まだ分からなければ undefined */
  step?: number
  steps?: number
  secPerStep?: number
  startedAt?: number
  elapsedMs?: number
  error?: string
  result?: GeneratedImage
}

/** 画像生成モデルの部品 (VAE / テキストエンコーダー) 1 つの状態 */
export interface ComponentStatus {
  role: ComponentRole
  /** 候補の表示名 (例: T5-XXL Q4_K_M (GGUF)) */
  label: string
  /** この部品を取得するダウンロードジョブの ID (進行中かはジョブ一覧で見る) */
  jobId: string
  /** 入手先のライセンス。restriction があれば商用利用などに制限がある */
  license: ComponentLicense
  /** 揃っているか */
  present: boolean
  /** 揃っているときの絶対パス */
  file?: string
  /** 取得元 (既定の候補、または揃っている候補) */
  repo: string
  path: string
  sizeBytes: number
  note?: string
}

/** プロンプト翻訳 (画像生成用) の状態 */
export interface TranslationStatus {
  /** llama.cpp ランタイムがインストールされていて使える状態か */
  available: boolean
  enabled: boolean
  /** 選んでいる翻訳モデル */
  modelId: TranslationModelId
  /** 選んでいる翻訳モデルの状態 */
  model: 'missing' | 'downloading' | 'ready'
  /** 翻訳用サーバーの状態 */
  server: ServerState
  progress?: { doneBytes: number; totalBytes: number }
  error?: string
}

/** sd-server の /sdcpp/v1/capabilities から取り出す、UI で使う情報 */
export interface ImageCapabilities {
  samplers: string[]
  defaultSampler: string
  maxWidth: number
  maxHeight: number
}

export type PythonInstallState = 'idle' | 'downloading' | 'python' | 'venv' | 'torch' | 'packages' | 'probe' | 'done' | 'error'

export interface PythonRuntimeInfo {
  installed: boolean
  dir?: string
  pythonPath?: string
  torchVersion?: string
  transformersVersion?: string
  cuda?: boolean
  backend?: TorchBackend
  bitsandbytes?: boolean
  devices?: GpuDevice[]
  installedAt?: string
}

export interface PythonProgress {
  state: PythonInstallState
  message: string
  /** 直近のコマンド出力行 */
  log?: string
}

export type ServerState = 'stopped' | 'starting' | 'running' | 'error'

/** モデル読み込みの進捗 */
export interface LoadProgress {
  /** 0..1 */
  fraction: number
  phase: string
  elapsedMs: number
  expectedMs: number
  /** reported = エンジンが報告した実測値 / history = 前回の読み込み時間から推定 / heuristic = ファイルサイズから推定 */
  source: 'reported' | 'history' | 'heuristic'
}

export interface ServerStatus {
  state: ServerState
  engine?: EngineId
  progress?: LoadProgress
  port?: number
  modelId?: string
  modelName?: string
  modelPath?: string
  pid?: number
  error?: string
  startedAt?: number
  contextSize?: number
  gpuLayers?: number
  precision?: Precision
  buildInfo?: string
  /** 画像入力を受け付けるか(起動後にサーバーの /props で確定) */
  vision?: boolean
  logTail: string[]
}

export interface ServerStartOptions {
  modelId: string
  contextSize?: number
  gpuLayers?: number
  threads?: number
  /** Transformers: 読み込み精度 */
  precision?: Precision
  /** Transformers: カスタムモデルコードの実行を許可する */
  trustRemoteCode?: boolean
}

export type SearchSort = 'downloads' | 'likes' | 'trendingScore' | 'lastModified' | 'createdAt'

/** 検索対象のモデルの種類 (HF の pipeline)。text-generation = テキスト生成、image-text-to-text = 画像入力、text-to-image = 画像生成 */
export type SearchPipeline = 'text-generation' | 'image-text-to-text' | 'text-to-image'

export interface SearchOptions {
  query: string
  ggufOnly: boolean
  /** 空なら種類で絞らない。複数なら種類ごとに検索して統合する */
  pipelines: SearchPipeline[]
  sort: SearchSort
  limit?: number
}

export type Unsubscribe = () => void

/** 起動時の初期化の進み具合。スプラッシュウィンドウに表示する */
export interface BootProgress {
  done: number
  total: number
  message: string
}

/** preload が window.api として公開する API */
export interface Api {
  boot: {
    /** 初期化の進捗をスプラッシュへ通知する */
    progress(p: BootProgress): void
    /** 初期化完了。スプラッシュを閉じてメインウィンドウを表示する */
    done(): void
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    chooseModelsDir(): Promise<string | null>
  }
  system: {
    info(): Promise<SystemInfo>
    stats(): Promise<SystemStats>
  }
  hf: {
    search(opts: SearchOptions): Promise<HFModelSummary[]>
    modelInfo(repoId: string): Promise<HFModelInfo>
    files(repoId: string): Promise<RepoFilesResult>
    quantizedVariants(repoId: string): Promise<HFModelSummary[]>
    remoteHeader(repoId: string, path: string): Promise<ModelHeaderInfo | null>
    modelConfig(repoId: string): Promise<HFModelConfig | null>
    /** ファイルが拡散モデル (画像生成) かをダウンロードせずに判定する */
    diffusionCheck(repoId: string, path: string): Promise<DiffusionInfo | null>
  }
  downloads: {
    /** mmproj を渡すと本体と一緒にダウンロードし、画像入力用として紐付ける (GGUF のみ) */
    start(repoId: string, entry: ModelEntry, hfMeta: HFGgufMeta | null, mmproj?: ModelEntry | null): Promise<DownloadJob>
    cancel(id: string): Promise<void>
    /** 中断 / 失敗したジョブを記録済みのエントリで再開する */
    resume(id: string): Promise<DownloadJob | null>
    remove(id: string): Promise<void>
    list(): Promise<DownloadJob[]>
    onUpdate(cb: (jobs: DownloadJob[]) => void): Unsubscribe
  }
  library: {
    list(): Promise<LibraryModel[]>
    remove(id: string): Promise<void>
    openFolder(id: string): Promise<void>
    onChange(cb: () => void): Unsubscribe
  }
  runtime: {
    info(): Promise<RuntimeInfo>
    backends(): Promise<BackendOption[]>
    install(backend: Backend): Promise<RuntimeInfo>
    /** backend 用のバイナリが揃っている最新リリースと現在のバージョンを比べる */
    checkUpdate(backend: Backend): Promise<ReleaseCheck>
    onProgress(cb: (p: RuntimeProgress) => void): Unsubscribe
  }
  python: {
    info(): Promise<PythonRuntimeInfo>
    install(backend: TorchBackend): Promise<PythonRuntimeInfo>
    remove(): Promise<void>
    onProgress(cb: (p: PythonProgress) => void): Unsubscribe
  }
  server: {
    start(opts: ServerStartOptions): Promise<ServerStatus>
    stop(): Promise<ServerStatus>
    status(): Promise<ServerStatus>
    onStatus(cb: (s: ServerStatus) => void): Unsubscribe
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  /** 画像生成エンジン (stable-diffusion.cpp) のランタイム */
  sd: {
    info(): Promise<SdRuntimeInfo>
    backends(): Promise<SdBackendOption[]>
    install(backend: SdBackend): Promise<SdRuntimeInfo>
    onProgress(cb: (p: RuntimeProgress) => void): Unsubscribe
  }
  /** 画像生成 (起動中のモデルが画像生成モデルのときに使える) */
  image: {
    capabilities(): Promise<ImageCapabilities | null>
    generate(params: ImageGenParams): Promise<ImageGenStatus>
    cancel(): Promise<void>
    status(): Promise<ImageGenStatus>
    list(): Promise<GeneratedImage[]>
    remove(file: string): Promise<void>
    openFolder(): Promise<void>
    onStatus(cb: (s: ImageGenStatus) => void): Unsubscribe
  }
  /** 画像生成モデルの部品 (VAE / テキストエンコーダー) の自動取得 */
  components: {
    /** 系統に必要な部品と、それぞれ揃っているか */
    status(family: string): Promise<ComponentStatus[]>
    /** 欠けている部品をダウンロードキューに入れる (既定の候補を使う)。ジョブ ID を返す */
    download(family: string): Promise<string[]>
  }
  /** 画像生成用の多言語→英語プロンプト翻訳 (llama.cpp + 翻訳モデルを CPU で常駐) */
  translate: {
    status(): Promise<TranslationStatus>
    /** 有効化するとモデルを取得して翻訳サーバーを起動する。無効化で停止 */
    setEnabled(on: boolean): Promise<TranslationStatus>
    /** 翻訳モデルを切り替える。有効なら新しいモデルを取得・起動し直す */
    setModel(id: TranslationModelId): Promise<TranslationStatus>
    run(text: string): Promise<string>
    onStatus(cb: (s: TranslationStatus) => void): Unsubscribe
  }
  /** サーバーモード (外部の PC・アプリから API を使う) */
  lan: {
    status(): Promise<LanStatus>
    /** API キーを作り直す (以前のキーは使えなくなる) */
    regenerateKey(): Promise<Settings>
    onStatus(cb: (s: LanStatus) => void): Unsubscribe
  }
}
