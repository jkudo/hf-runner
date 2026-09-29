import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  Backend,
  BackendOption,
  DownloadJob,
  EngineId,
  GpuDevice,
  ImageGenStatus,
  LibraryModel,
  ModelFormat,
  PythonProgress,
  PythonRuntimeInfo,
  RuntimeInfo,
  RuntimeProgress,
  SdBackend,
  SdBackendOption,
  SdRuntimeInfo,
  ServerStatus,
  Settings,
  SystemInfo,
  SystemStats,
  TorchBackend,
  TranslationStatus,
} from '@shared/types'
import { ENGINE_LABEL, TORCH_BACKENDS } from '@shared/engines'
import { formatBytes } from '@shared/format'
import { AUTO_GPU, fitGpus, isUnusedGpu } from '@shared/gpu'
import { L, resolveLang, setLang } from '@shared/i18n'
import { api, errMsg } from './api'
import { SearchPage } from './pages/SearchPage'
import { LibraryPage } from './pages/LibraryPage'
import { ChatPage } from './pages/ChatPage'
import { ImagePage } from './pages/ImagePage'
import { SettingsPage } from './pages/SettingsPage'
import { ProgressBar } from './components/ProgressBar'

export type Page = 'search' | 'library' | 'chat' | 'image' | 'settings'

interface Toast {
  id: number
  message: string
  kind: 'info' | 'error'
}

export interface AppState {
  page: Page
  setPage(p: Page): void
  settings: Settings | null
  updateSettings(patch: Partial<Settings>): Promise<void>
  sys: SystemInfo | null
  refreshSystem(): Promise<void>
  /** その形式のモデルを動かすエンジンが使う GPU (設定「使用する GPU」に従う。エンジンが CPU 版なら空)。メモリ判定に渡す */
  fitGpus(format: ModelFormat): GpuDevice[]
  runtime: RuntimeInfo | null
  runtimeProgress: RuntimeProgress | null
  backends: BackendOption[]
  installRuntime(b: Backend): Promise<void>
  python: PythonRuntimeInfo | null
  pythonProgress: PythonProgress | null
  installPython(b: TorchBackend): Promise<void>
  removePython(): Promise<void>
  /** 画像生成エンジン (stable-diffusion.cpp) */
  sd: SdRuntimeInfo | null
  sdProgress: RuntimeProgress | null
  sdBackends: SdBackendOption[]
  installSd(b: SdBackend): Promise<void>
  imageStatus: ImageGenStatus
  /** 画像生成用のプロンプト翻訳の状態 */
  translation: TranslationStatus | null
  server: ServerStatus
  downloads: DownloadJob[]
  library: LibraryModel[]
  refreshLibrary(): Promise<void>
  /** 別ページからモデル詳細を開く */
  openRepo(repoId: string): void
  pendingRepo: string | null
  clearPendingRepo(): void
  toast(message: string, kind?: 'info' | 'error'): void
}

const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('AppContext がありません')
  return v
}

export function App() {
  const [page, setPage] = useState<Page>('search')
  const [settings, setSettings] = useState<Settings | null>(null)
  // 表示言語。子の描画より先に決めておけば、各所の L() がこの言語で返す。切り替えると設定が変わって全体が再描画される
  // (作り直しはしないので、チャットの会話などの状態は消えない。文言を useMemo しているところは getLang() を依存に入れる)
  const lang = resolveLang(settings?.language, navigator.language)
  setLang(lang)
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [runtimeProgress, setRuntimeProgress] = useState<RuntimeProgress | null>(null)
  const [backends, setBackends] = useState<BackendOption[]>([])
  const [python, setPython] = useState<PythonRuntimeInfo | null>(null)
  const [pythonProgress, setPythonProgress] = useState<PythonProgress | null>(null)
  const [sd, setSd] = useState<SdRuntimeInfo | null>(null)
  const [sdProgress, setSdProgress] = useState<RuntimeProgress | null>(null)
  const [sdBackends, setSdBackends] = useState<SdBackendOption[]>([])
  const [imageStatus, setImageStatus] = useState<ImageGenStatus>({ state: 'idle' })
  const [translation, setTranslation] = useState<TranslationStatus | null>(null)
  const [server, setServer] = useState<ServerStatus>({ state: 'stopped', logTail: [] })
  const [downloads, setDownloads] = useState<DownloadJob[]>([])
  const [library, setLibrary] = useState<LibraryModel[]>([])
  const [pendingRepo, setPendingRepo] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastSeq = useRef(0)

  const toast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    const id = ++toastSeq.current
    setToasts((t) => [...t, { id, message, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 4500)
  }, [])

  const refreshSystem = useCallback(async () => {
    setSys(await api.system.info())
  }, [])
  const refreshLibrary = useCallback(async () => {
    setLibrary(await api.library.list())
  }, [])
  const refreshRuntime = useCallback(async () => {
    setRuntime(await api.runtime.info())
  }, [])
  const refreshPython = useCallback(async () => {
    setPython(await api.python.info())
  }, [])
  const refreshSd = useCallback(async () => {
    setSd(await api.sd.info())
  }, [])

  useEffect(() => {
    // 初期化の進み具合をスプラッシュウィンドウへ知らせる(設定 → ライブラリ の 2 段階)
    const BOOT_TOTAL = 2
    api.boot.progress({ done: 0, total: BOOT_TOTAL, message: L('設定を読み込んでいます…', 'Loading settings…') })
    void (async () => {
      const [s, r, b, py, st, dl, sdi, sdb, ist, tr] = await Promise.all([
        api.settings.get(),
        api.runtime.info(),
        api.runtime.backends(),
        api.python.info(),
        api.server.status(),
        api.downloads.list(),
        api.sd.info(),
        api.sd.backends(),
        api.image.status(),
        api.translate.status(),
      ])
      setSettings(s)
      setRuntime(r)
      setBackends(b)
      setPython(py)
      setServer(st)
      setDownloads(dl)
      setSd(sdi)
      setSdBackends(sdb)
      setImageStatus(ist)
      setTranslation(tr)
      // 設定を読んだので、次の描画を待たずにスプラッシュの文言も設定の言語にする
      setLang(resolveLang(s.language, navigator.language))
      api.boot.progress({ done: 1, total: BOOT_TOTAL, message: L('モデルライブラリを確認しています…', 'Checking the model library…') })
      // GPU 検出 (llama-server --list-devices) は初回やドライバー初期化で数秒〜20 秒かかることがあるので、
      // 画面の表示は待たせず後追いで反映する(サイドバーは取得できるまで「取得中」表示)
      refreshSystem().catch((e) => toast(errMsg(e), 'error'))
      await refreshLibrary()
    })()
      .catch((e) => toast(errMsg(e), 'error'))
      .finally(() => api.boot.done())

    const offs = [
      api.downloads.onUpdate(setDownloads),
      api.library.onChange(() => void refreshLibrary()),
      api.server.onStatus(setServer),
      api.runtime.onProgress((p) => {
        setRuntimeProgress(p)
        if (p.state === 'done') {
          void refreshRuntime().then(refreshSystem)
          toast(p.message)
        }
        if (p.state === 'error') toast(p.message, 'error')
      }),
      api.python.onProgress((p) => {
        setPythonProgress(p)
        if (p.state === 'done') {
          void refreshPython().then(refreshSystem)
          toast(p.message)
        }
        if (p.state === 'error') toast(p.message, 'error')
      }),
      api.sd.onProgress((p) => {
        setSdProgress(p)
        if (p.state === 'done') {
          void refreshSd()
          toast(p.message)
        }
        if (p.state === 'error') toast(p.message, 'error')
      }),
      api.image.onStatus(setImageStatus),
      api.translate.onStatus(setTranslation),
    ]
    return () => offs.forEach((off) => off())
  }, [refreshLibrary, refreshSystem, refreshRuntime, refreshPython, refreshSd, toast])

  // 使用率メーター。2 秒ごとに更新(取得中に重ならないようにし、ウィンドウが隠れている間は止める)
  useEffect(() => {
    let busy = false
    let stopped = false
    const tick = async () => {
      if (busy || document.hidden) return
      busy = true
      try {
        const s = await api.system.stats()
        if (!stopped) setStats(s)
      } catch {
        /* 取れないときは前回値のまま */
      } finally {
        busy = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 2000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await api.settings.set(patch))
    // 言語を変えたら、メインプロセスが作る表示 (バックエンドの説明など) を取り直す
    if (patch.language !== undefined) {
      const [b, sdb] = await Promise.all([api.runtime.backends(), api.sd.backends()])
      setBackends(b)
      setSdBackends(sdb)
    }
  }, [])

  const installRuntime = useCallback(async (b: Backend) => {
    setRuntimeProgress({ state: 'fetching', message: L('準備中…', 'Preparing…') })
    try {
      await api.runtime.install(b)
      setSettings(await api.settings.get())
    } catch (e) {
      setRuntimeProgress({ state: 'error', message: errMsg(e) })
      throw e
    }
  }, [])

  const installPython = useCallback(async (b: TorchBackend) => {
    setPythonProgress({ state: 'downloading', message: L('準備中…', 'Preparing…') })
    try {
      await api.python.install(b)
      setSettings(await api.settings.get())
    } catch (e) {
      setPythonProgress({ state: 'error', message: errMsg(e) })
      throw e
    }
  }, [])

  const removePython = useCallback(async () => {
    await api.python.remove()
    setPythonProgress(null)
    await refreshPython()
    await refreshSystem()
  }, [refreshPython, refreshSystem])

  const installSd = useCallback(async (b: SdBackend) => {
    setSdProgress({ state: 'fetching', message: L('準備中…', 'Preparing…') })
    try {
      await api.sd.install(b)
      setSettings(await api.settings.get())
    } catch (e) {
      setSdProgress({ state: 'error', message: errMsg(e) })
      throw e
    }
  }, [])

  const openRepo = useCallback((repoId: string) => {
    setPendingRepo(repoId)
    setPage('search')
  }, [])

  const gpuSelection = settings?.gpuSelection ?? AUTO_GPU
  const fitGpusFor = useCallback(
    (format: ModelFormat) => fitGpus(format, { llama: runtime, python, sd }, sys?.gpus ?? [], gpuSelection),
    [runtime, python, sd, sys, gpuSelection],
  )

  const state = useMemo<AppState>(
    () => ({
      page,
      setPage,
      settings,
      updateSettings,
      sys,
      refreshSystem,
      fitGpus: fitGpusFor,
      runtime,
      runtimeProgress,
      backends,
      installRuntime,
      python,
      pythonProgress,
      installPython,
      removePython,
      sd,
      sdProgress,
      sdBackends,
      installSd,
      imageStatus,
      translation,
      server,
      downloads,
      library,
      refreshLibrary,
      openRepo,
      pendingRepo,
      clearPendingRepo: () => setPendingRepo(null),
      toast,
    }),
    [page, settings, updateSettings, sys, refreshSystem, fitGpusFor, runtime, runtimeProgress, backends, installRuntime, python, pythonProgress, installPython, removePython, sd, sdProgress, sdBackends, installSd, imageStatus, translation, server, downloads, library, refreshLibrary, openRepo, pendingRepo, toast],
  )

  const activeDownloads = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued').length
  // ナビの状態ドット: 実行中なら緑、読み込み中なら黄。画像生成モデルは画像生成ページ側に出す
  const serverDot = server.state === 'running' ? 'ok' : server.state === 'starting' ? 'warn' : undefined
  const isSd = server.engine === 'sdcpp'

  return (
    <Ctx.Provider value={state}>
      <div className="app" lang={lang}>
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">▶</span>
            <span>HF Runner</span>
          </div>
          <nav>
            <NavButton page="search" label={L('モデルを探す', 'Find models')} icon="🔍" />
            <NavButton page="library" label={L('ライブラリ', 'Library')} icon="📦" badge={activeDownloads || undefined} />
            <NavButton page="chat" label={L('チャット', 'Chat')} icon="💬" dot={isSd ? undefined : serverDot} />
            <NavButton page="image" label={L('画像生成', 'Image generation')} icon="🎨" dot={isSd ? (imageStatus.state === 'generating' ? 'warn' : serverDot) : undefined} />
            <NavButton page="settings" label={L('設定', 'Settings')} icon="⚙️" />
          </nav>
          <div className="sidebar-footer">
            {stats && (
              <div className="meters">
                <Meter label="CPU" percent={stats.cpuPercent} />
                {stats.gpus.length === 0 && <Meter label="GPU" percent={null} title={L('GPU 使用率は NVIDIA (nvidia-smi) のみ対応', 'GPU usage is only available for NVIDIA (nvidia-smi)')} />}
                {stats.gpus.map((g) => {
                  // 複数枚あるときは GPU0 / GPU1 … と番号を付ける
                  const suffix = stats.gpus.length > 1 ? String(g.index) : ''
                  const vram = `${formatBytes(g.vramUsedMiB * 1024 * 1024, 1)} / ${formatBytes(g.vramTotalMiB * 1024 * 1024, 1)}`
                  return (
                    <Fragment key={g.index}>
                      <Meter label={`GPU${suffix}`} percent={g.percent} title={`${g.name} · VRAM ${vram}`} />
                      {g.vramTotalMiB > 0 && <Meter label={`VRAM${suffix}`} percent={(g.vramUsedMiB / g.vramTotalMiB) * 100} title={`${g.name} · ${vram}`} />}
                    </Fragment>
                  )
                })}
                <Meter label={L('メモリ', 'Memory')} percent={(stats.memUsedBytes / stats.memTotalBytes) * 100} title={`${formatBytes(stats.memUsedBytes, 1)} / ${formatBytes(stats.memTotalBytes, 1)}`} />
              </div>
            )}
            {!sys && <div className="sys-line muted">{L('ハードウェア情報を取得中…', 'Detecting hardware…')}</div>}
            {sys && (
              <>
                <div className="sys-line">
                  <span className="muted">RAM</span> {formatBytes(sys.totalMemBytes, 0)}
                </div>
                {sys.gpus.length > 0 ? (
                  // 推論に使う GPU だけを出す (外付けがあるときの内蔵 GPU や、設定で選んでいない GPU は出さない。設定の「この PC」には全部出す)
                  sys.gpus.filter((g) => !isUnusedGpu(g, sys.gpus, gpuSelection)).map((g) => (
                    <div className="sys-line" key={g.id} title={g.name}>
                      <span className="muted">GPU</span> {g.name.replace(/^NVIDIA |^AMD /, '')} · {formatBytes(g.totalMiB * 1024 * 1024, 0)}
                    </div>
                  ))
                ) : (
                  <div className="sys-line muted">GPU: {runtime?.installed || python?.installed ? L('検出なし', 'none detected') : L('未確認', 'not checked')}</div>
                )}
              </>
            )}
            <div className="sys-line muted" title={L('GGUF 用', 'For GGUF')}>
              {runtime?.installed ? `llama.cpp ${runtime.tag} · ${runtime.backend}` : L('llama.cpp 未インストール', 'llama.cpp not installed')}
            </div>
            <div className="sys-line muted" title={L('safetensors 用', 'For safetensors')}>
              {python?.installed ? `Python torch ${python.torchVersion?.split('+')[0]} · ${python.cuda ? 'CUDA' : 'CPU'}` : L('Python エンジン未インストール', 'Python engine not installed')}
            </div>
            <div className="sys-line muted" title={L('画像生成用', 'For image generation')}>
              {sd?.installed ? `stable-diffusion.cpp · ${sd.backend}` : L('画像生成エンジン未インストール', 'Image generation engine not installed')}
            </div>
          </div>
        </aside>
        <main className="content">
          {runtime && python && !runtime.installed && !python.installed && <SetupBanner />}
          <div className={page === 'search' ? 'page-host' : 'page-host hidden'}>
            <SearchPage />
          </div>
          <div className={page === 'library' ? 'page-host' : 'page-host hidden'}>
            <LibraryPage />
          </div>
          <div className={page === 'chat' ? 'page-host' : 'page-host hidden'}>
            <ChatPage />
          </div>
          <div className={page === 'image' ? 'page-host' : 'page-host hidden'}>
            <ImagePage />
          </div>
          <div className={page === 'settings' ? 'page-host' : 'page-host hidden'}>
            <SettingsPage />
          </div>
        </main>
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.message}
            </div>
          ))}
        </div>
      </div>
    </Ctx.Provider>
  )
}

/** サイドバーの使用率メーター。percent が null のときは値なし(取得不可 / 初回)として表示 */
function Meter({ label, percent, title }: { label: string; percent: number | null; title?: string }) {
  const p = percent === null ? null : Math.max(0, Math.min(100, percent))
  const level = p === null ? '' : p >= 90 ? 'bad' : p >= 70 ? 'warn' : ''
  return (
    <div className="meter" title={title}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar">
        <span className={`meter-fill ${level}`} style={{ width: `${p ?? 0}%` }} />
      </span>
      <span className="meter-value">{p === null ? '-' : `${Math.round(p)}%`}</span>
    </div>
  )
}

function NavButton({ page, label, icon, badge, dot }: { page: Page; label: string; icon: string; badge?: number; dot?: 'ok' | 'warn' }) {
  const app = useApp()
  return (
    <button className={`nav-btn ${app.page === page ? 'active' : ''}`} data-page={page} onClick={() => app.setPage(page)}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {badge !== undefined && <span className="nav-badge">{badge}</span>}
      {dot && <span className={`nav-dot ${dot}`} />}
    </button>
  )
}

/** どのエンジンも未インストールのときに表示する初回セットアップ案内。llama.cpp / Python のどちらを入れるかを選べる */
function SetupBanner() {
  const app = useApp()
  const [engine, setEngine] = useState<EngineId>('llamacpp')
  const [dismissed, setDismissed] = useState(false)
  const rec = app.backends.find((b) => b.recommended) ?? app.backends[0]
  const [backend, setBackend] = useState<Backend | null>(null)
  const [torchBackend, setTorchBackend] = useState<TorchBackend>('auto')
  const chosenBackend = backend ?? rec?.id ?? 'cpu'
  const torchOptions = TORCH_BACKENDS.filter((b) => !app.sys || b.platforms.includes(app.sys.platform))
  const rp = app.runtimeProgress
  const pp = app.pythonProgress
  const busyRuntime = !!rp && rp.state !== 'done' && rp.state !== 'error'
  const busyPython = !!pp && pp.state !== 'done' && pp.state !== 'error'
  const busy = busyRuntime || busyPython
  if (dismissed) return null

  const install = () => {
    const p = engine === 'llamacpp' ? app.installRuntime(chosenBackend) : app.installPython(torchBackend)
    p.catch(() => {})
  }
  return (
    <div className="banner">
      <div className="banner-main">
        <strong>{L('はじめに: 推論エンジンを選んでインストールしてください', 'Getting started: choose and install an inference engine')}</strong>
        <div className="muted small">
          {engine === 'llamacpp'
            ? L(
                'llama.cpp は GGUF(量子化済み)モデルを軽量に実行します。GPU の種類に合わせてバックエンドを選びます。',
                'llama.cpp runs GGUF (quantized) models efficiently. Choose the backend that matches your GPU. ',
              )
            : L(
                'Python / Transformers は GGUF に変換されていない元のモデル(safetensors)をそのまま実行します。専用の Python 環境を自動構築し、CUDA 版は約 3GB をダウンロードします。',
                'Python / Transformers runs original models (safetensors) that have not been converted to GGUF. It sets up a dedicated Python environment automatically; the CUDA version downloads about 3 GB. ',
              )}
          {L('もう一方のエンジンは、後から設定画面で追加できます。', 'You can add the other engine later in Settings.')}
        </div>
        {busyRuntime && rp && (
          <div className="banner-progress">
            <ProgressBar value={rp.doneBytes} max={rp.totalBytes} />
            <span className="small muted">{rp.message}</span>
          </div>
        )}
        {busyPython && pp && (
          <div className="banner-progress">
            <ProgressBar />
            <span className="small muted">
              {pp.message}
              {pp.log && <span className="muted"> · {pp.log}</span>}
            </span>
          </div>
        )}
      </div>
      <div className="banner-actions">
        <select value={engine} onChange={(e) => setEngine(e.target.value as EngineId)} disabled={busy}>
          <option value="llamacpp">
            {ENGINE_LABEL.llamacpp}
            {L('(GGUF 用)', ' (for GGUF)')}
          </option>
          <option value="transformers">
            {ENGINE_LABEL.transformers}
            {L('(safetensors 用)', ' (for safetensors)')}
          </option>
        </select>
        {engine === 'llamacpp' ? (
          <select value={chosenBackend} onChange={(e) => setBackend(e.target.value as Backend)} disabled={busy}>
            {app.backends.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
                {b.recommended ? L('(推奨)', ' (recommended)') : ''}
              </option>
            ))}
          </select>
        ) : (
          <select value={torchBackend} onChange={(e) => setTorchBackend(e.target.value as TorchBackend)} disabled={busy}>
            {torchOptions.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        )}
        <button className="primary" disabled={busy} onClick={install}>
          {busy ? L('インストール中…', 'Installing…') : L('インストール', 'Install')}
        </button>
        <button className="ghost" disabled={busy} onClick={() => setDismissed(true)} title={L('設定画面からいつでもインストールできます', 'You can install one any time from Settings')}>
          {L('あとで', 'Later')}
        </button>
      </div>
    </div>
  )
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}
