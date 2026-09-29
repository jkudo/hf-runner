import { useEffect, useState } from 'react'
import type { LanStatus } from '@shared/types'
import { L, getLang } from '@shared/i18n'
import { api, errMsg } from '../api'
import { Section, useApp } from '../App'

/**
 * 設定画面の「サーバーモード」と「タスクトレイ常駐」。
 * サーバーモードは外部の PC・アプリから API を使えるようにする入口 (固定ポート + API キー) を有効にする
 */
export function ServerModeSettings() {
  const app = useApp()
  const s = app.settings
  const [lan, setLan] = useState<LanStatus | null>(null)
  const [showKey, setShowKey] = useState(false)
  // ポートは入力中の途中の番号で待ち受けを作り直さないよう、確定 (フォーカスを外す / Enter) で反映する
  const [portText, setPortText] = useState(String(s?.lanPort ?? 18000))

  useEffect(() => {
    void api.lan.status().then(setLan)
    return api.lan.onStatus(setLan)
  }, [])
  useEffect(() => setPortText(String(s?.lanPort ?? 18000)), [s?.lanPort])
  if (!s) return null

  const commitPort = () => {
    const n = Math.floor(Number(portText))
    if (n >= 1024 && n <= 65535 && n !== s.lanPort) void app.updateSettings({ lanPort: n })
    else setPortText(String(s.lanPort))
  }
  /** クリップボードにコピーし、done (コピーした旨の文言) をトーストで出す */
  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text)
      app.toast(done)
    } catch (e) {
      app.toast(errMsg(e), 'error')
    }
  }
  const regenerate = async () => {
    if (
      !window.confirm(
        L(
          'API キーを作り直します。今のキーを設定している機器やアプリからは接続できなくなります。よろしいですか?',
          'Regenerate the API key? Devices and apps using the current key will no longer be able to connect.',
        ),
      )
    )
      return
    await api.lan.regenerateKey()
    await app.updateSettings({})
  }
  const url = lan?.urls[0]
  const example = url
    ? `curl ${url}/chat/completions -H "Authorization: Bearer ${showKey ? s.lanApiKey : L('<API キー>', '<API key>')}" -H "Content-Type: application/json" -d "{\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"${L('こんにちは', 'Hello')}\\"}]}"`
    : ''
  const copyLabel = L('コピー', 'Copy')

  return (
    <Section title={L('サーバーモード (外部の PC・アプリから使う)', 'Server mode (use from other PCs and apps)')}>
      <div className="form-row">
        <div className="form-label">{L('サーバーモード', 'Server mode')}</div>
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={s.lanEnabled} onChange={(e) => void app.updateSettings({ lanEnabled: e.target.checked })} />
            {L(
              '同じネットワークの他の PC・スマートフォン・アプリから、起動中のモデルを使えるようにする',
              'Let other PCs, phones and apps on the same network use the running model',
            )}
          </label>
          <div className="muted small">
            {getLang() === 'en' ? (
              <>
                Exposes an OpenAI-compatible API (chat: <code>/v1/chat/completions</code>; for image generation models, the stable-diffusion.cpp API). Connecting requires the API key. The URL and key stay the same when you switch models.
              </>
            ) : (
              <>
                OpenAI 互換 API として公開します(チャット: <code>/v1/chat/completions</code>、画像生成モデルなら stable-diffusion.cpp の API)。接続には API キーが必要です。モデルを切り替えても URL とキーは変わりません。
              </>
            )}
          </div>
          {s.lanEnabled && (
            <div className="notice small">
              {L(
                '初めて有効にしたとき、Windows ファイアウォールの確認が表示されたら「プライベート ネットワーク」を許可してください。カフェなどの公共のネットワークでは有効にしないでください。',
                'When you first turn this on, if Windows Firewall asks, allow access on "Private networks". Do not turn this on when connected to public networks such as in a café.',
              )}
            </div>
          )}
        </div>
      </div>

      {s.lanEnabled && (
        <>
          <div className="form-row">
            <div className="form-label">{L('状態', 'Status')}</div>
            <div className="stack">
              {lan?.listening ? (
                <span className="small">
                  <span className="status-dot ok" /> {L(`待ち受け中 (ポート ${lan.port})`, `Listening (port ${lan.port})`)}
                  {app.server.state === 'running'
                    ? L(` · ${app.server.modelName} を公開中`, ` · Serving ${app.server.modelName}`)
                    : L(' · モデルが起動していません (起動すると使えます)', ' · No model is running (launch one to use it)')}
                </span>
              ) : (
                <span className="small err">{lan?.error ?? L('停止中', 'Stopped')}</span>
              )}
              {lan?.listening && lan.urls.length === 0 && (
                <span className="small warn-text">
                  {L(
                    'ネットワークに接続されていないため、他の機器から使える IP アドレスがありません。',
                    'Not connected to a network, so there is no IP address other devices can use.',
                  )}
                </span>
              )}
              {lan?.urls.map((u) => (
                <div key={u} className="row gap">
                  <code className="path">{u}</code>
                  <button className="ghost small" onClick={() => copy(u, L('URL をコピーしました', 'URL copied'))}>
                    {copyLabel}
                  </button>
                </div>
              ))}
              {lan?.lastAccess && (
                <span className="muted small">
                  {L(
                    `最終アクセス: ${new Date(lan.lastAccess.at).toLocaleString()} · ${lan.lastAccess.from} · ${lan.lastAccess.path} (計 ${lan.requests} 件)`,
                    `Last access: ${new Date(lan.lastAccess.at).toLocaleString()} · ${lan.lastAccess.from} · ${lan.lastAccess.path} (${lan.requests} requests in total)`,
                  )}
                </span>
              )}
            </div>
          </div>
          <div className="form-row">
            <div className="form-label">{L('API キー', 'API key')}</div>
            <div className="stack">
              <div className="row gap">
                <input type={showKey ? 'text' : 'password'} value={s.lanApiKey} readOnly className="mono" style={{ minWidth: 320 }} />
                <button className="ghost small" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? L('隠す', 'Hide') : L('表示', 'Show')}
                </button>
                <button className="ghost small" onClick={() => copy(s.lanApiKey, L('API キーをコピーしました', 'API key copied'))}>
                  {copyLabel}
                </button>
                <button className="ghost small" onClick={regenerate}>
                  {L('作り直す', 'Regenerate')}
                </button>
              </div>
              <div className="muted small">
                {getLang() === 'en' ? (
                  <>
                    Add <code>Authorization: Bearer &lt;API key&gt;</code> to requests. With the OpenAI SDK, set base_url to the URL above and api_key to this key.
                  </>
                ) : (
                  <>
                    リクエストに <code>Authorization: Bearer &lt;API キー&gt;</code> を付けてください。OpenAI の SDK なら base_url に上の URL、api_key にこのキーを指定します。
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="form-row">
            <div className="form-label">{L('ポート', 'Port')}</div>
            <div>
              <input type="number" min={1024} max={65535} value={portText} onChange={(e) => setPortText(e.target.value)} onBlur={commitPort} onKeyDown={(e) => e.key === 'Enter' && commitPort()} />
              <div className="muted small">
                {L(
                  '外部から接続する番号です(固定)。内部の推論サーバーのポートとは別です。',
                  'The fixed port that other devices connect to. It is separate from the internal inference server port.',
                )}
              </div>
            </div>
          </div>
          {example && (
            <div className="form-row">
              <div className="form-label">{L('接続例', 'Example')}</div>
              <div className="row gap">
                <code className="path small">{example}</code>
                <button className="ghost small" onClick={() => copy(example, L('接続例をコピーしました', 'Example copied'))}>
                  {copyLabel}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <div className="form-row">
        <div className="form-label">{L('タスクトレイに常駐', 'Keep running in the system tray')}</div>
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={s.trayEnabled} onChange={(e) => void app.updateSettings({ trayEnabled: e.target.checked })} />
            {L('ウィンドウを閉じても終了せず、タスクトレイで動作を続ける', 'Keep running in the system tray when the window is closed')}
          </label>
          <div className="muted small">
            {L(
              '起動中のモデルとサーバーモードがそのまま動き続けます。画面はトレイのアイコンをクリックで開き、終了はトレイのアイコンを右クリックして「終了」を選びます。',
              'The running model and server mode keep working. Click the tray icon to open the window; to quit, right-click the tray icon and choose "Quit".',
            )}
          </div>
        </div>
      </div>
    </Section>
  )
}
