import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { Backend, HFGgufMeta, ImageGenParams, ModelEntry, SdBackend, SearchOptions, ServerStartOptions, Settings, TorchBackend } from '@shared/types'
import { L } from '@shared/i18n'
import type { TranslationModelId } from '@shared/translation'
import type { ComponentManager } from './components'
import type { DownloadManager } from './downloads'
import type { HfClient } from './hf'
import type { ImageGenManager } from './imagegen'
import { generateApiKey, type LanServer } from './lan'
import type { LibraryManager } from './library'
import type { PythonRuntime } from './python'
import type { RuntimeManager } from './runtime'
import type { SdRuntimeManager } from './sdcpp'
import type { ServerManager } from './server'
import type { SettingsStore } from './settings'
import type { TranslationManager } from './translate'
import { backendOptions } from './runtime'
import { sdBackendOptions } from './sdcpp'
import { StatsSampler } from './stats'
import { getSystemInfo } from './system'

export interface IpcContext {
  getWindow: () => BrowserWindow | null
  settings: SettingsStore
  hf: HfClient
  downloads: DownloadManager
  runtime: RuntimeManager
  python: PythonRuntime
  sd: SdRuntimeManager
  images: ImageGenManager
  components: ComponentManager
  translation: TranslationManager
  server: ServerManager
  /** 翻訳モデル用の 2 つ目のサーバー */
  helper?: ServerManager
  library: LibraryManager
  /** サーバーモード (外部からのリクエストの入口) */
  lan: LanServer
  /** 設定が変わったとき (サーバーモード・トレイ常駐の反映) */
  onSettingsChanged: () => Promise<void>
}

export function registerIpc(ctx: IpcContext): void {
  const { getWindow, settings, hf, downloads, runtime, python, sd, images, components, translation, server, helper, library, lan, onSettingsChanged } = ctx
  const send = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  // 設定
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
    const before = settings.get()
    settings.update(patch)
    if (before.modelsDir !== settings.get().modelsDir) library.emit('change')
    await onSettingsChanged()
    // API キーの自動生成などで変わった後の値を返す
    return settings.get()
  })

  // サーバーモード
  ipcMain.handle('lan:status', () => lan.getStatus())
  ipcMain.handle('lan:regenerateKey', async () => {
    settings.update({ lanApiKey: generateApiKey() })
    await onSettingsChanged()
    return settings.get()
  })
  lan.on('status', (s) => send('lan:status', s))
  ipcMain.handle('settings:chooseModelsDir', async () => {
    const win = getWindow()
    const opts = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>, defaultPath: settings.get().modelsDir }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    settings.update({ modelsDir: r.filePaths[0] })
    library.emit('change')
    return r.filePaths[0]
  })

  // システム情報
  ipcMain.handle('system:info', () => getSystemInfo(runtime, python))
  const stats = new StatsSampler()
  ipcMain.handle('system:stats', () => stats.sample())

  // Hugging Face
  ipcMain.handle('hf:search', (_e, opts: SearchOptions) => hf.search(opts))
  ipcMain.handle('hf:modelInfo', (_e, repoId: string) => hf.modelInfo(repoId))
  ipcMain.handle('hf:files', (_e, repoId: string) => hf.listFiles(repoId))
  ipcMain.handle('hf:quantizedVariants', (_e, repoId: string) => hf.quantizedVariants(repoId))
  ipcMain.handle('hf:remoteHeader', async (_e, repoId: string, filePath: string) => {
    try {
      return await hf.remoteHeader(repoId, filePath)
    } catch {
      return null
    }
  })
  ipcMain.handle('hf:diffusionCheck', async (_e, repoId: string, filePath: string) => {
    try {
      return await hf.diffusionCheck(repoId, filePath)
    } catch {
      return null
    }
  })
  ipcMain.handle('hf:modelConfig', async (_e, repoId: string) => {
    try {
      return await hf.modelConfig(repoId)
    } catch {
      return null
    }
  })

  // ダウンロード
  ipcMain.handle('downloads:start', (_e, repoId: string, entry: ModelEntry, hfMeta: HFGgufMeta | null, mmproj?: ModelEntry | null) =>
    downloads.start(repoId, entry, hfMeta, mmproj ?? null),
  )
  ipcMain.handle('downloads:cancel', (_e, id: string) => downloads.cancel(id))
  ipcMain.handle('downloads:remove', (_e, id: string) => downloads.remove(id))
  ipcMain.handle('downloads:list', () => downloads.list())
  ipcMain.handle('downloads:resume', (_e, id: string) => downloads.resume(id))
  downloads.on('update', (jobs) => send('downloads:update', jobs))
  // 完了だけでなく中断・失敗でもライブラリを更新する (部品の「ダウンロード中」表示が残らないように)
  downloads.on('done', () => library.emit('change'))
  downloads.on('settled', () => library.emit('change'))

  // ライブラリ
  ipcMain.handle('library:list', () => library.list())
  ipcMain.handle('library:remove', async (_e, id: string) => {
    if (server.getStatus().modelId === id) await server.stop()
    // 翻訳用のサーバーが使っているモデルなら先に止める
    if (helper?.getStatus().modelId === id) await helper.stop()
    await library.remove(id)
  })
  ipcMain.handle('library:openFolder', (_e, id: string) => library.openFolder(id))
  library.on('change', () => send('library:change'))

  // ランタイム
  ipcMain.handle('runtime:info', () => runtime.getInfo())
  ipcMain.handle('runtime:backends', () => backendOptions(process.platform, process.arch))
  ipcMain.handle('runtime:install', async (_e, backend: Backend) => {
    // 翻訳用サーバーも同じ llama-server を使っているので両方止める (Windows は実行中の exe を消せない)
    await Promise.all([server.stop(), helper?.stop()])
    const info = await runtime.install(backend)
    settings.update({ backend })
    return info
  })
  ipcMain.handle('runtime:checkUpdate', (_e, backend?: Backend) => runtime.checkUpdate(backend ?? settings.get().backend))
  runtime.on('progress', (p) => send('runtime:progress', p))

  // Python エンジン (Transformers)
  ipcMain.handle('python:info', () => python.getInfo())
  ipcMain.handle('python:install', async (_e, backend: TorchBackend) => {
    if (server.getStatus().engine === 'transformers') await server.stop()
    const info = await python.install(backend)
    settings.update({ torchBackend: backend })
    return info
  })
  ipcMain.handle('python:remove', async () => {
    if (server.getStatus().engine === 'transformers') await server.stop()
    await python.remove()
  })
  python.on('progress', (p) => send('python:progress', p))

  // llama-server
  ipcMain.handle('server:start', async (_e, opts: ServerStartOptions) => {
    const model = await library.get(opts.modelId)
    if (!model) throw new Error(L('モデルが見つかりません。ライブラリを更新してください', 'Model not found. Refresh the library'))
    return server.start(model, opts)
  })
  ipcMain.handle('server:stop', () => server.stop())
  ipcMain.handle('server:status', () => server.getStatus())
  server.on('status', (s) => send('server:status', s))

  // 画像生成エンジン (stable-diffusion.cpp)
  ipcMain.handle('sd:info', () => sd.getInfo())
  ipcMain.handle('sd:backends', () => sdBackendOptions(process.platform, process.arch))
  ipcMain.handle('sd:install', async (_e, backend: SdBackend) => {
    if (server.getStatus().engine === 'sdcpp') await server.stop()
    const info = await sd.install(backend)
    settings.update({ sdBackend: backend })
    return info
  })
  sd.on('progress', (p) => send('sd:progress', p))

  // 画像生成
  ipcMain.handle('image:capabilities', () => images.capabilities())
  ipcMain.handle('image:generate', (_e, params: ImageGenParams) => images.generate(params))
  ipcMain.handle('image:cancel', () => images.cancel())
  ipcMain.handle('image:status', () => images.getStatus())
  ipcMain.handle('image:list', () => images.list())
  ipcMain.handle('image:remove', (_e, file: string) => images.remove(file))
  ipcMain.handle('image:openFolder', () => images.openFolder())
  images.on('status', (s) => send('image:status', s))

  // 画像生成モデルの部品
  ipcMain.handle('components:status', (_e, family: string) => components.status(family))
  ipcMain.handle('components:download', (_e, family: string) => components.download(family))

  // プロンプト翻訳
  ipcMain.handle('translate:status', () => translation.getStatus())
  ipcMain.handle('translate:setEnabled', (_e, on: boolean) => translation.setEnabled(on))
  ipcMain.handle('translate:setModel', (_e, id: TranslationModelId) => translation.setModel(id))
  ipcMain.handle('translate:run', (_e, text: string) => translation.translate(text))
  translation.on('status', (s) => send('translate:status', s))

  // 外部リンク
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
  })
}
