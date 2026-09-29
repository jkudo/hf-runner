import { BrowserWindow } from 'electron'
import type { BootProgress } from '@shared/types'
import { getLang, L } from '@shared/i18n'

// preload も React も使わない自己完結の HTML。data: URL で読むので exe 起動直後に表示できる
// 表示言語は作成時点のもの (起動時に設定から決めた後で作る)
const html = () => `<!doctype html>
<html lang="${getLang()}"><head><meta charset="utf-8"><title>HF Runner</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f1216; color: #e6e9ee; overflow: hidden; user-select: none;
    font-family: 'Segoe UI', 'Yu Gothic UI', 'Meiryo', 'Hiragino Sans', system-ui, sans-serif; }
  body { display: grid; place-items: center; border: 1px solid #2a313b; box-sizing: border-box; -webkit-app-region: drag; }
  .card { display: flex; flex-direction: column; align-items: center; gap: 14px; width: 260px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 20px; }
  .mark { background: #ffb000; color: #1a1400; border-radius: 8px; width: 32px; height: 32px; display: grid; place-items: center; font-size: 15px; }
  .bar { width: 100%; height: 6px; background: #2a313b; border-radius: 999px; overflow: hidden; }
  .fill { height: 100%; background: #ffb000; border-radius: 999px; transition: width 0.2s ease-out; }
  .fill.indeterminate { width: 40%; animation: slide 1.2s infinite ease-in-out; }
  .msg { font-size: 12px; color: #8b95a5; min-height: 1.4em; }
  @keyframes slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
</style></head>
<body>
  <div class="card">
    <div class="brand"><span class="mark">▶</span>HF Runner</div>
    <div class="bar"><div id="fill" class="fill indeterminate"></div></div>
    <div id="msg" class="msg">${L('起動しています…', 'Starting…')}</div>
  </div>
  <script>
    window.setProgress = (pct, msg) => {
      const f = document.getElementById('fill')
      f.classList.remove('indeterminate')
      f.style.width = Math.max(8, pct) + '%'
      document.getElementById('msg').textContent = msg
    }
  </script>
</body></html>`

/** exe 起動直後に出すスプラッシュウィンドウ。メインウィンドウの初期化が終わるまで表示する */
export class Splash {
  private win: BrowserWindow | null

  constructor() {
    this.win = new BrowserWindow({
      width: 380,
      height: 200,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // 描画前に白い枠が一瞬見えるのを避けるため、初回描画後に表示する(数十 ms)。
      // ランチャー (HF Runner.exe) はこの窓が見えてから閉じるので、切り替えの隙間も出ない
      show: false,
      title: 'HF Runner',
      backgroundColor: '#0f1216',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    this.win.setMenuBarVisibility(false)
    this.win.once('ready-to-show', () => this.win?.show())
    void this.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html())}`)
    this.win.on('closed', () => {
      this.win = null
    })
  }

  get alive(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  setProgress(p: BootProgress): void {
    if (!this.alive) return
    const pct = p.total > 0 ? (p.done / p.total) * 100 : 0
    void this.win!.webContents.executeJavaScript(`window.setProgress?.(${pct}, ${JSON.stringify(p.message)})`).catch(() => {})
  }

  close(): void {
    if (this.alive) this.win!.close()
    this.win = null
  }
}
