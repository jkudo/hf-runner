import { app, Menu, nativeImage, Tray } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { LanStatus, ServerStatus } from '@shared/types'
import { L } from '@shared/i18n'

/** トレイのアイコン。パッケージ版は resources/icon.png (electron-builder の extraResources)、開発時は build/icon.png */
function iconPath(): string {
  const packaged = path.join(process.resourcesPath, 'icon.png')
  return app.isPackaged && fs.existsSync(packaged) ? packaged : path.join(app.getAppPath(), 'build', 'icon.png')
}

/**
 * タスクトレイ常駐。有効なときはウィンドウを閉じてもアプリを終了せず、推論サーバーとサーバーモードを動かし続ける。
 * メニューから画面を開く・モデルを解放する・終了する
 */
export class TrayManager {
  private tray: Tray | null = null
  private notified = false

  constructor(
    private readonly deps: {
      showWindow: () => void
      stopModel: () => void
      getServer: () => ServerStatus
      getLan: () => LanStatus
    },
  ) {}

  get enabled(): boolean {
    return this.tray !== null
  }

  apply(enabled: boolean): void {
    if (enabled && !this.tray) {
      const image = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 })
      this.tray = new Tray(image)
      this.tray.on('click', () => this.deps.showWindow())
      this.refresh()
    } else if (!enabled && this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }

  /** モデルやサーバーモードの状態が変わったらメニューとツールチップを作り直す */
  refresh(): void {
    if (!this.tray) return
    const s = this.deps.getServer()
    const lan = this.deps.getLan()
    const model =
      s.state === 'running'
        ? L(`実行中: ${s.modelName}`, `Running: ${s.modelName}`)
        : s.state === 'starting'
          ? L(`読み込み中: ${s.modelName}`, `Loading: ${s.modelName}`)
          : L('モデルは読み込まれていません', 'No model is loaded')
    const lanLine = lan.listening
      ? L('サーバーモード: ', 'Server mode: ') + (lan.urls[0] ?? L(`ポート ${lan.port}`, `port ${lan.port}`))
      : lan.enabled
        ? L('サーバーモード: 停止中', 'Server mode: stopped')
        : L('サーバーモード: 無効', 'Server mode: off')
    this.tray.setToolTip(`HF Runner\n${model}\n${lanLine}`)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: L('HF Runner を開く', 'Open HF Runner'), click: () => this.deps.showWindow() },
        { type: 'separator' },
        { label: model, enabled: false },
        { label: lanLine, enabled: false },
        { label: L('モデルを解放', 'Unload model'), enabled: s.state !== 'stopped', click: () => this.deps.stopModel() },
        { type: 'separator' },
        { label: L('終了', 'Quit'), click: () => app.quit() },
      ]),
    )
  }

  /** ウィンドウを閉じてトレイに入ったことを、最初の 1 回だけ知らせる */
  notifyHidden(): void {
    if (this.notified || !this.tray || process.platform !== 'win32') return
    this.notified = true
    this.tray.displayBalloon({ title: 'HF Runner', content: L(
        'タスクトレイで動作を続けています。終了するにはトレイのアイコンを右クリックして「終了」を選んでください。',
        'HF Runner keeps running in the system tray. To quit, right-click the tray icon and choose "Quit".',
      ),
    })
  }
}
