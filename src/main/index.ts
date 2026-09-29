import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BootProgress } from '@shared/types'
import { getLang, L, resolveLang, setLang } from '@shared/i18n'
import { ComponentManager } from './components'
import { DownloadManager } from './downloads'
import { HfClient } from './hf'
import { ImageGenManager } from './imagegen'
import { registerIpc } from './ipc'
import { generateApiKey, LanServer } from './lan'
import { TrayManager } from './tray'
import { LibraryManager } from './library'
import { PythonRuntime } from './python'
import { RuntimeManager } from './runtime'
import { SdRuntimeManager } from './sdcpp'
import { ServerManager } from './server'
import { SettingsStore } from './settings'
import { Splash } from './splash'
import { TranslationManager } from './translate'
import { portableDataDir } from './portable'
import { setupE2E } from './debug'

// 保存先の決定。テスト用の環境変数 > ポータブル(zip 版: exe の隣の data/) > 通常の userData
const portableDir = process.env.HFRUNNER_USER_DATA ? null : portableDataDir()
const dataDir = process.env.HFRUNNER_USER_DATA || portableDir
if (dataDir) {
  app.setPath('userData', dataDir)
  app.setPath('sessionData', dataDir)
}

// 生成画像をレンダラーに見せるための独自プロトコル (hfimg://images/<ファイル名>)。images/ の中のファイルだけを配信する
protocol.registerSchemesAsPrivileged([{ scheme: 'hfimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

let mainWindow: BrowserWindow | null = null
let splash: Splash | null = null
let server: ServerManager | null = null
/** 翻訳モデル用の 2 つ目のサーバー (CPU 常駐) */
let helper: ServerManager | null = null
let lan: LanServer | null = null
let tray: TrayManager | null = null
let quitting = false

/** メインウィンドウを前面に出す (トレイから、二重起動時)。閉じられていれば作り直す */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** スプラッシュを閉じてメインウィンドウを出す(初期化完了時、または保険のタイムアウト時) */
function revealMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.show()
    mainWindow.focus()
  }
  splash?.close()
  splash = null
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'HF Runner',
    backgroundColor: '#0f1216',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // スプラッシュ表示中はレンダラーの初期化完了 (boot:done) を待つ(保険のタイムアウトはスプラッシュ側)
  win.once('ready-to-show', () => {
    if (!splash) win.show()
  })
  // 読み込み失敗やクラッシュでも閉じられるよう、メインウィンドウを出してスプラッシュを畳む
  win.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame && mainWindow === win) revealMainWindow()
  })
  win.webContents.on('render-process-gone', () => {
    if (mainWindow === win) revealMainWindow()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // トレイ常駐が有効なら、閉じるボタンではウィンドウを隠すだけにする (終了はトレイのメニューから)
  win.on('close', (e) => {
    if (quitting || !tray?.enabled) return
    e.preventDefault()
    win.hide()
    tray.notifyHidden()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  if (process.env.HFRUNNER_E2E_DIR) setupE2E(win, process.env.HFRUNNER_E2E_DIR)
  return win
}

// 二重起動なら何も作らずに終了する(ready 後にスプラッシュを出してしまわないよう、whenReady ごとガードする)
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(main)
}

function main(): void {
  // 表示言語はスプラッシュの文言より先に決める (設定の読み込みは同期で軽い)
  const settings = new SettingsStore(portableDir)
  setLang(resolveLang(settings.get().language, app.getLocale()))
  // 何より先にスプラッシュを出す。メインウィンドウは裏で初期化し、終わったら入れ替える
  splash = new Splash()
  ipcMain.on('boot:progress', (_e, p: BootProgress) => splash?.setProgress(p))
  ipcMain.on('boot:done', () => {
    splash?.setProgress({ done: 1, total: 1, message: L('準備完了', 'Ready') })
    setTimeout(revealMainWindow, 150)
  })
  // レンダラーから完了通知が来なくても(読み込み失敗が検知できないケース)20 秒で必ずメインウィンドウを出す
  setTimeout(() => {
    if (splash) revealMainWindow()
  }, 20_000)

  const getSettings = () => settings.get()
  const hf = new HfClient(() => settings.get().hfToken)
  const runtime = new RuntimeManager(join(app.getPath('userData'), 'runtime'))
  // server.py / probe.py はパッケージ時に resources/python へ同梱される
  const scriptsDir = app.isPackaged ? join(process.resourcesPath, 'python') : join(app.getAppPath(), 'resources', 'python')
  const python = new PythonRuntime(join(app.getPath('userData'), 'python'), scriptsDir)
  const downloads = new DownloadManager({ hf, getSettings })
  const components = new ComponentManager({ hf, downloads, getSettings })
  const library = new LibraryManager({ getSettings, components })
  // 画像生成エンジン (stable-diffusion.cpp) は llama.cpp と同じく userData 配下に取得する
  const sd = new SdRuntimeManager(join(app.getPath('userData'), 'sd-runtime'))
  server = new ServerManager({ runtime, python, sd, components, getSettings, historyPath: join(app.getPath('userData'), 'load-times.json'), customCommand: true })
  // 読み込み時間の記録は別ファイルにする (同じファイルを 2 つのキャッシュで上書きし合わないように)
  helper = new ServerManager({ runtime, python, sd, getSettings, historyPath: join(app.getPath('userData'), 'load-times-helper.json'), portOffset: 100 })
  const translation = new TranslationManager({ hf, library, downloads, helper, runtime, settings })
  const imagesDir = join(app.getPath('userData'), 'images')
  const images = new ImageGenManager({ server, imagesDir })
  protocol.handle('hfimg', (req) => {
    const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\/+/, ''))
    // フォルダをまたぐ名前は拒否する
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(join(imagesDir, name)).href)
  })

  // サーバーモード: 外部からのリクエストを、起動中の推論サーバー (メインの 1 つ) へ転送する
  const mainServer = server
  lan = new LanServer({
    getSettings,
    getTarget: () => {
      const s = mainServer.getStatus()
      return s.state === 'running' && s.port ? { port: s.port, modelName: s.modelName } : null
    },
  })
  tray = new TrayManager({
    showWindow: showMainWindow,
    stopModel: () => void mainServer.stop(),
    getServer: () => mainServer.getStatus(),
    getLan: () => lan!.getStatus(),
  })
  server.on('status', () => tray?.refresh())
  lan.on('status', () => tray?.refresh())
  // サーバーモード・トレイ常駐の設定を反映する (起動時と、設定が変わるたび)
  const applyServerMode = async () => {
    const s = settings.get()
    // 表示言語 (メインプロセスが作るエラーメッセージやトレイのメニューに使う)
    const prevLang = getLang()
    setLang(resolveLang(s.language, app.getLocale()))
    if (getLang() !== prevLang) {
      // 文言入りで覚えている判定結果を捨て、ライブラリを新しい言語で取り直させる
      hf.clearCaches()
      library.clearHeaderCache()
      library.emit('change')
    }
    // サーバーモードを有効にしたときに API キーが無ければ作る
    if (s.lanEnabled && !s.lanApiKey) settings.update({ lanApiKey: generateApiKey() })
    tray?.apply(settings.get().trayEnabled)
    tray?.refresh()
    await lan?.apply()
  }

  registerIpc({ getWindow: () => mainWindow, settings, hf, downloads, runtime, python, sd, images, components, translation, server, helper, library, lan, onSettingsChanged: applyServerMode })
  mainWindow = createWindow()
  void applyServerMode()

  app.on('second-instance', () => showMainWindow())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}

app.on('window-all-closed', () => {
  // トレイ常駐中は、ウィンドウが無くても動き続ける
  if (!tray?.enabled) app.quit()
})

// 終了時は llama-server (翻訳用も) とサーバーモードの待ち受けを確実に止める
app.on('before-quit', (e) => {
  if (quitting || !server) return
  quitting = true
  e.preventDefault()
  Promise.all([server.stop(), helper?.stop(), lan?.close()]).finally(() => app.quit())
})
