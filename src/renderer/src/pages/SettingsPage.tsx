import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { Backend, EngineId, Precision, ReleaseCheck, RuntimeProgress, SdBackend, TorchBackend } from '@shared/types'
import { commandPlaceholders, commandProblems, DEFAULT_COMMANDS, sameCommand } from '@shared/command'
import { PRECISIONS, TORCH_BACKENDS } from '@shared/engines'
import { formatBytes } from '@shared/format'
import { AUTO_GPU, isNvidiaGpu, isUnusedGpu } from '@shared/gpu'
import { L, type LanguageSetting } from '@shared/i18n'
import { api, errMsg, openExternal } from '../api'
import { Section, useApp } from '../App'
import { ProgressBar } from '../components/ProgressBar'
import { ServerModeSettings } from '../components/ServerModeSettings'

const CTX_OPTIONS = [2048, 4096, 8192, 16384, 32768, 65536, 131072]

/** ランタイム (llama.cpp / stable-diffusion.cpp) のインストール進捗の行 */
function InstallProgressRow({ progress: p, installing }: { progress: RuntimeProgress; installing: boolean }) {
  return (
    <div className="form-row">
      <div className="form-label" />
      <div>
        {installing && <ProgressBar value={p.doneBytes} max={p.totalBytes} />}
        <div className={`small ${p.state === 'error' ? 'err' : 'muted'}`}>
          {p.message}
          {p.totalBytes ? ` (${formatBytes(p.doneBytes ?? 0)} / ${formatBytes(p.totalBytes)})` : ''}
        </div>
      </div>
    </div>
  )
}

/**
 * 推論エンジンの起動コマンドの本文。{model} などの差し込み項目は起動のたびに置き換わる。
 * 入力中は手元に持ち、フォーカスを外したら保存する。既定と同じ内容なら空 (= 既定) で保存し、アプリの更新で既定が変わっても追従させる
 */
function CommandRow({ engine, value, onSave, help }: { engine: EngineId; value: string; onSave: (v: string) => void; help?: ReactNode }) {
  const def = DEFAULT_COMMANDS[engine]
  const [text, setText] = useState(value || def)
  const [showVars, setShowVars] = useState(false)
  useEffect(() => setText(value || def), [value, def])
  const problems = commandProblems(text, engine)
  const commit = () => {
    const v = sameCommand(text, def) ? '' : text.trim()
    if (v !== value) onSave(v)
  }
  const restore = () => {
    setText(def)
    // 押した瞬間に欄のフォーカスが外れて編集中の本文が先に保存される (value はまだ古い) ので、条件を付けずに既定 (空) を保存する
    onSave('')
  }
  return (
    <div className="form-row">
      <div className="form-label">
        {L('起動コマンド', 'Launch command')}
        {value && <span className="tag warn">{L('編集済み', 'Edited')}</span>}
      </div>
      <div className="command-edit">
        <textarea className="mono" rows={3} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} onBlur={commit} />
        {problems.length > 0 && <div className="err small">{problems.join(' / ')}</div>}
        <div className="row gap">
          <button className="ghost small" onClick={restore} disabled={!value && sameCommand(text, def)}>
            {L('既定に戻す', 'Restore default')}
          </button>
          <button className="ghost small" onClick={() => setShowVars((v) => !v)}>
            {L('差し込み項目の一覧', 'Placeholders')} {showVars ? '▲' : '▼'}
          </button>
        </div>
        {showVars && (
          <div className="kv small command-vars">
            {commandPlaceholders(engine).map((p) => (
              <Fragment key={p.key}>
                <div className="mono">{`{${p.key}}`}</div>
                <div>{p.desc}</div>
              </Fragment>
            ))}
          </div>
        )}
        <div className="muted small">
          {L(
            '{…} は起動のたびにモデルのパスやポートなどに置き換わります。オプションの追加・削除・値の変更、実行ファイルの差し替えなど自由に編集でき、次にモデルを起動したときから有効です。空白を含む引数は "…" で囲みます。実際に実行したコマンドはライブラリの「サーバーログを表示」の先頭行で確認できます。',
            '{…} is replaced with the model path, port, etc. on each launch. You can freely add, remove or change options, or even swap the executable; changes take effect the next time a model is launched. Wrap arguments containing spaces in "…". The command actually run is the first line of "Show server log" in the Library.',
          )}
          {help}
        </div>
      </div>
    </div>
  )
}

/**
 * 設定「使用する GPU」。自動 (外付け GPU を優先) か、検出した GPU から 1 つを選ぶ。
 * GPU は名前で覚えるので、llama.cpp / stable-diffusion.cpp / Python でデバイスの番号が違っても同じ GPU を使う
 */
function GpuSelectRow() {
  const app = useApp()
  const gpus = app.sys?.gpus ?? []
  const selection = app.settings?.gpuSelection ?? AUTO_GPU
  const chosen = gpus.find((g) => g.key === selection)
  const missing = selection !== AUTO_GPU && !!app.sys && !chosen
  return (
    <div className="form-row">
      <div className="form-label">{L('使用する GPU', 'GPU to use')}</div>
      <div>
        <select value={selection} onChange={(e) => app.updateSettings({ gpuSelection: e.target.value })} disabled={!app.sys}>
          <option value={AUTO_GPU}>{L('自動 (外付け GPU を優先)', 'Automatic (prefer a discrete GPU)')}</option>
          {gpus.map((g) => (
            <option key={g.key} value={g.key}>
              {g.name} · {formatBytes(g.totalMiB * 1024 * 1024, 1)}
              {g.integrated ? L(' (内蔵)', ' (integrated)') : ''}
            </option>
          ))}
          {missing && <option value={selection}>{L('(見つからない GPU)', '(GPU not found)')}</option>}
        </select>
        <div className="muted small">
          {missing
            ? L('選んだ GPU が見つからないため、自動で選んでいます。', 'The selected GPU was not found, so one is chosen automatically. ')
            : ''}
          {L(
            'llama.cpp・stable-diffusion.cpp・Python (Transformers) で使う GPU です。次にモデルを起動したときから有効です。',
            'The GPU used by llama.cpp, stable-diffusion.cpp and Python (Transformers). Takes effect the next time a model is launched.',
          )}
          {chosen && !isNvidiaGpu(chosen.name)
            ? L(' Python (Transformers) は NVIDIA GPU しか使えないため、既定の GPU で動きます。', ' Python (Transformers) can only use NVIDIA GPUs, so it runs on its default GPU.')
            : ''}
        </div>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const app = useApp()
  const s = app.settings
  const [backend, setBackend] = useState<Backend | null>(null)
  const [check, setCheck] = useState<ReleaseCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [torchBackend, setTorchBackend] = useState<TorchBackend | null>(null)
  const [sdBackend, setSdBackend] = useState<SdBackend | null>(null)
  if (!s) return null

  const chosenSd = sdBackend ?? app.sd?.backend ?? s.sdBackend
  const sp = app.sdProgress
  const sdInstalling = sp && sp.state !== 'done' && sp.state !== 'error'

  const chosen = backend ?? app.runtime?.backend ?? s.backend
  const p = app.runtimeProgress
  const installing = p && p.state !== 'done' && p.state !== 'error'
  const install = async () => {
    try {
      await app.installRuntime(chosen)
      setCheck(null)
    } catch {
      /* トーストで表示済み */
    }
  }
  const checkUpdate = async () => {
    setChecking(true)
    try {
      setCheck(await api.runtime.checkUpdate(chosen))
    } catch (e) {
      app.toast(errMsg(e), 'error')
    } finally {
      setChecking(false)
    }
  }

  const py = app.python
  const pp = app.pythonProgress
  const pyInstalling = pp && pp.state !== 'done' && pp.state !== 'error'
  const chosenTorch = torchBackend ?? py?.backend ?? s.torchBackend
  const torchOptions = TORCH_BACKENDS.filter((b) => !app.sys || b.platforms.includes(app.sys.platform))
  const installPython = async () => {
    try {
      await app.installPython(chosenTorch)
    } catch {
      /* トーストで表示済み */
    }
  }
  const removePython = async () => {
    if (!window.confirm(L('Python エンジン(PyTorch を含む数 GB)を削除します。よろしいですか?', 'Delete the Python engine (several GB including PyTorch)?'))) return
    try {
      await app.removePython()
      app.toast(L('Python エンジンを削除しました', 'Python engine deleted'))
    } catch (e) {
      app.toast(errMsg(e), 'error')
    }
  }

  const notInstalled = L('未インストール', 'Not installed')
  const installLabel = (busy: boolean, installed: boolean | undefined) =>
    busy ? L('インストール中…', 'Installing…') : installed ? L('再インストール / 更新', 'Reinstall / update') : L('インストール', 'Install')
  const recommended = L('推奨', 'Recommended')

  return (
    <div className="page scroll">
      <Section title={L('表示言語', 'Language')}>
        <div className="form-row">
          <div className="form-label">{L('表示言語', 'Language')}</div>
          <div>
            <select value={s.language} onChange={(e) => app.updateSettings({ language: e.target.value as LanguageSetting })}>
              <option value="auto">{L('自動 (OS の言語)', 'Automatic (OS language)')}</option>
              <option value="ja">日本語</option>
              <option value="en">English</option>
            </select>
            <div className="muted small">{L('日本語以外の OS では英語になります。', 'Non-Japanese systems use English.')}</div>
          </div>
        </div>
      </Section>

      <Section title={L('推論エンジン 1: llama.cpp (GGUF 用)', 'Inference engine 1: llama.cpp (for GGUF)')}>
        <div className="form-row">
          <div className="form-label">{L('現在のバージョン', 'Current version')}</div>
          <div>
            {app.runtime?.installed ? (
              <>
                <strong>{app.runtime.tag}</strong> · {app.backends.find((b) => b.id === app.runtime?.backend)?.label ?? app.runtime.backend}
                <div className="muted small">{app.runtime.dir}</div>
              </>
            ) : (
              <span className="warn-text">{notInstalled}</span>
            )}
          </div>
        </div>
        <div className="form-row">
          <div className="form-label">{L('バックエンド', 'Backend')}</div>
          <div className="stack">
            {app.backends.map((b) => (
              <label key={b.id} className="radio">
                <input type="radio" name="backend" checked={chosen === b.id} onChange={() => setBackend(b.id)} disabled={!!installing} />
                <span>
                  <strong>{b.label}</strong>
                  {b.recommended && <span className="tag ok">{recommended}</span>}
                  <div className="muted small">{b.description}</div>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="form-row">
          <div className="form-label" />
          <div className="row gap">
            <button className="primary" onClick={install} disabled={!!installing}>
              {installLabel(!!installing, app.runtime?.installed)}
            </button>
            <button className="ghost" onClick={checkUpdate} disabled={checking || !!installing}>
              {checking ? L('確認中…', 'Checking…') : L('最新版を確認', 'Check for updates')}
            </button>
            {check && (
              <span className="small">
                {L('最新', 'Latest')}: <strong>{check.latestTag}</strong>
                {check.updateAvailable ? <span className="warn-text">{L(' (更新があります)', ' (update available)')}</span> : L(' (最新です)', ' (up to date)')}
              </span>
            )}
          </div>
        </div>
        {p && <InstallProgressRow progress={p} installing={!!installing} />}
        <CommandRow
          engine="llamacpp"
          value={s.llamaCommand}
          onSave={(v) => app.updateSettings({ llamaCommand: v })}
          help={
            <>
              {' '}
              <a className="link" onClick={() => openExternal('https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md')}>
                {L('オプション一覧 ↗', 'Option list ↗')}
              </a>
            </>
          }
        />
      </Section>

      <Section title={L('推論エンジン 2: Python / Transformers (safetensors 用)', 'Inference engine 2: Python / Transformers (for safetensors)')}>
        <p className="muted small">
          {L(
            'GGUF に変換されていない元のモデル(safetensors)をそのまま実行します。uv が管理する専用の Python 環境を作るので、PC に Python を入れる必要はなく、システムにも影響しません。CUDA 版は約 3GB をダウンロードします。',
            'Runs original models (safetensors) that have not been converted to GGUF. It creates a dedicated Python environment managed by uv, so you do not need Python installed and your system is not affected. The CUDA version downloads about 3 GB.',
          )}
        </p>
        <div className="form-row">
          <div className="form-label">{L('状態', 'Status')}</div>
          <div>
            {py?.installed ? (
              <>
                <strong>torch {py.torchVersion}</strong> · transformers {py.transformersVersion} · {py.cuda ? L('CUDA 有効', 'CUDA enabled') : L('CPU のみ', 'CPU only')}
                {py.cuda && ` · bitsandbytes ${py.bitsandbytes ? L('有効 (4bit/8bit 可)', 'enabled (4-bit/8-bit available)') : L('無効', 'disabled')}`}
                {py.devices && py.devices.length > 0 && <div className="small">{py.devices.map((d) => `${d.name} (${formatBytes(d.totalMiB * 1024 * 1024)})`).join(', ')}</div>}
                <div className="muted small">{py.dir}</div>
              </>
            ) : (
              <span className="warn-text">{notInstalled}</span>
            )}
          </div>
        </div>
        <div className="form-row">
          <div className="form-label">{L('PyTorch の種類', 'PyTorch build')}</div>
          <div className="stack">
            {torchOptions.map((b) => (
              <label key={b.id} className="radio">
                <input type="radio" name="torch" checked={chosenTorch === b.id} onChange={() => setTorchBackend(b.id)} disabled={!!pyInstalling} />
                <span>
                  <strong>{b.label}</strong>
                  <div className="muted small">{b.description}</div>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="form-row">
          <div className="form-label" />
          <div className="row gap">
            <button className="primary" onClick={installPython} disabled={!!pyInstalling}>
              {installLabel(!!pyInstalling, py?.installed)}
            </button>
            {py?.installed && (
              <button className="ghost" onClick={removePython} disabled={!!pyInstalling}>
                {L('削除', 'Delete')}
              </button>
            )}
          </div>
        </div>
        {pp && (
          <div className="form-row">
            <div className="form-label" />
            <div>
              {pyInstalling && <ProgressBar />}
              <div className={`small ${pp.state === 'error' ? 'err pre' : 'muted'}`}>{pp.message}</div>
              {pyInstalling && pp.log && <div className="small muted mono">{pp.log}</div>}
            </div>
          </div>
        )}
        <div className="form-row">
          <div className="form-label">{L('既定の読み込み精度', 'Default load precision')}</div>
          <div>
            <select value={s.transformersPrecision} onChange={(e) => app.updateSettings({ transformersPrecision: e.target.value as Precision })}>
              {PRECISIONS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <div className="muted small">{PRECISIONS.find((p) => p.id === s.transformersPrecision)?.note}</div>
          </div>
        </div>
        <CommandRow
          engine="transformers"
          value={s.pythonCommand}
          onSave={(v) => app.updateSettings({ pythonCommand: v })}
          help={L(
            ' server.py のその他のオプション: --device auto|cuda|cpu、--vision auto|on|off',
            ' Other server.py options: --device auto|cuda|cpu, --vision auto|on|off',
          )}
        />
      </Section>

      <Section title={L('推論エンジン 3: stable-diffusion.cpp (画像生成用)', 'Inference engine 3: stable-diffusion.cpp (for image generation)')}>
        <p className="muted small">
          {L(
            'Stable Diffusion 1.x / SDXL などの画像生成モデルを実行します。llama.cpp と同じく公式リリースのビルド済みバイナリを取得します。生成した画像は「画像生成」ページで確認できます。',
            'Runs image generation models such as Stable Diffusion 1.x / SDXL. Like llama.cpp, it downloads prebuilt binaries from the official releases. Generated images appear on the "Image generation" page.',
          )}
        </p>
        <div className="form-row">
          <div className="form-label">{L('現在のバージョン', 'Current version')}</div>
          <div>
            {app.sd?.installed ? (
              <>
                <strong>{app.sd.tag}</strong> · {app.sdBackends.find((b) => b.id === app.sd?.backend)?.label ?? app.sd.backend}
                <div className="muted small">{app.sd.dir}</div>
              </>
            ) : (
              <span className="warn-text">{notInstalled}</span>
            )}
          </div>
        </div>
        <div className="form-row">
          <div className="form-label">{L('バックエンド', 'Backend')}</div>
          <div className="stack">
            {app.sdBackends.map((b) => (
              <label key={b.id} className="radio">
                <input type="radio" name="sdbackend" checked={chosenSd === b.id} onChange={() => setSdBackend(b.id)} disabled={!!sdInstalling} />
                <span>
                  <strong>{b.label}</strong>
                  {b.recommended && <span className="tag ok">{recommended}</span>}
                  <div className="muted small">{b.description}</div>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="form-row">
          <div className="form-label" />
          <div className="row gap">
            <button className="primary" onClick={() => app.installSd(chosenSd).catch(() => {})} disabled={!!sdInstalling}>
              {installLabel(!!sdInstalling, app.sd?.installed)}
            </button>
          </div>
        </div>
        {sp && <InstallProgressRow progress={sp} installing={!!sdInstalling} />}
        <CommandRow
          engine="sdcpp"
          value={s.sdCommand}
          onSave={(v) => app.updateSettings({ sdCommand: v })}
          help={
            <>
              {' '}
              <a className="link" onClick={() => openExternal('https://github.com/leejet/stable-diffusion.cpp')}>
                {L('オプション一覧 ↗', 'Option list ↗')}
              </a>
            </>
          }
        />
      </Section>

      <Section title={L('実行設定', 'Runtime settings')}>
        <div className="form-row">
          <div className="form-label">{L('コンテキスト長', 'Context length')}</div>
          <div>
            <select value={s.contextSize} onChange={(e) => app.updateSettings({ contextSize: Number(e.target.value) })}>
              {CTX_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {L(`${c.toLocaleString()} トークン`, `${c.toLocaleString()} tokens`)}
                </option>
              ))}
            </select>
            <div className="muted small">
              {L('大きいほど長い会話を扱えますが、KV キャッシュ分のメモリを消費します。', 'Larger values allow longer conversations but use more memory for the KV cache.')}
            </div>
          </div>
        </div>
        <GpuSelectRow />
        <div className="form-row">
          <div className="form-label">{L('GPU に載せるレイヤー数 (llama.cpp)', 'GPU layers (llama.cpp)')}</div>
          <div>
            <select value={s.gpuLayers} onChange={(e) => app.updateSettings({ gpuLayers: Number(e.target.value) })}>
              <option value={99}>{L('自動 (空きメモリに合わせる)', 'Automatic (fit to free memory)')}</option>
              {[48, 40, 32, 24, 16, 8, 4].map((n) => (
                <option key={n} value={n}>
                  {L(`${n} レイヤー`, `${n} layers`)}
                </option>
              ))}
              <option value={0}>{L('0 (CPU のみ)', '0 (CPU only)')}</option>
            </select>
            <div className="muted small">
              {L(
                '「自動」は llama.cpp が GPU の空きメモリに収まる数を決めます(収まらない分は CPU)。載せる GPU は「使用する GPU」で選べます。',
                '"Automatic" lets llama.cpp choose how many layers fit in free GPU memory (the rest run on the CPU). Choose which GPU to use under "GPU to use".',
              )}
            </div>
          </div>
        </div>
        <div className="form-row">
          <div className="form-label">{L('CPU スレッド数 (llama.cpp)', 'CPU threads (llama.cpp)')}</div>
          <div>
            <input type="number" min={0} max={256} value={s.threads} onChange={(e) => app.updateSettings({ threads: Number(e.target.value) || 0 })} />
            <span className="muted small">
              {L(` 0 = 自動 (論理コア数: ${app.sys?.cpuCount ?? '-'})`, ` 0 = automatic (logical cores: ${app.sys?.cpuCount ?? '-'})`)}
            </span>
          </div>
        </div>
        <div className="form-row">
          <div className="form-label">{L('ローカルサーバーのポート', 'Local server port')}</div>
          <div>
            <input type="number" min={1024} max={65535} value={s.serverPort} onChange={(e) => app.updateSettings({ serverPort: Number(e.target.value) || 18080 })} />
            <div className="muted small">
              {L(
                '使用中なら自動で次の空きポートを使います。他のアプリから OpenAI 互換 API (http://127.0.0.1:ポート/v1) として利用できます。',
                'If the port is in use, the next free port is used automatically. Other apps can use it as an OpenAI-compatible API (http://127.0.0.1:port/v1).',
              )}
            </div>
          </div>
        </div>
      </Section>

      <ServerModeSettings />

      <Section title={L('保存先とアカウント', 'Storage and account')}>
        <div className="form-row">
          <div className="form-label">{L('モデルの保存先', 'Model location')}</div>
          <div className="row gap">
            <code className="path">{s.modelsDir}</code>
            <button onClick={() => api.settings.chooseModelsDir().then(() => app.updateSettings({}))}>{L('変更…', 'Change…')}</button>
          </div>
        </div>
        <div className="form-row">
          <div className="form-label">{L('ダウンロードの同時接続数', 'Download connections')}</div>
          <div>
            <input
              type="number"
              min={1}
              max={16}
              value={s.downloadConnections}
              onChange={(e) => app.updateSettings({ downloadConnections: Math.min(16, Math.max(1, Number(e.target.value) || 1)) })}
            />
            <div className="muted small">
              {L(
                '16MB 以上のファイルを範囲に分けて同時に取得します。回線が速いほど効果があり、1 接続あたりの速度で頭打ちになるのを避けられます。1 にすると従来どおり 1 接続です。',
                'Files of 16 MB or more are downloaded in parallel ranges. This helps most on fast connections by avoiding the per-connection speed cap. Set to 1 to use a single connection.',
              )}
            </div>
          </div>
        </div>
        <div className="form-row">
          <div className="form-label">{L('Hugging Face トークン', 'Hugging Face token')}</div>
          <div>
            <div className="row gap">
              <input
                type={showToken ? 'text' : 'password'}
                value={s.hfToken}
                onChange={(e) => app.updateSettings({ hfToken: e.target.value.trim() })}
                placeholder="hf_..."
                className="wide"
                spellCheck={false}
              />
              <button className="ghost" onClick={() => setShowToken((v) => !v)}>
                {showToken ? L('隠す', 'Hide') : L('表示', 'Show')}
              </button>
            </div>
            <div className="muted small">
              {L(
                'Llama や Gemma など利用規約への同意が必要なモデル(gated)をダウンロードする場合に必要です。',
                'Required to download gated models such as Llama or Gemma that need you to accept a license. ',
              )}
              <a className="link" onClick={() => openExternal('https://huggingface.co/settings/tokens')}>
                {L('トークンを作成 ↗', 'Create a token ↗')}
              </a>
              {L('(Read 権限で十分です)', ' (Read access is enough)')}
            </div>
          </div>
        </div>
      </Section>

      <Section
        title={L('この PC', 'This PC')}
        right={
          <button className="ghost" onClick={() => app.refreshSystem()}>
            {L('再検出', 'Detect again')}
          </button>
        }
      >
        {app.sys ? (
          <div className="kv">
            <div>OS</div>
            <div>
              {app.sys.platform} / {app.sys.arch}
            </div>
            <div>CPU</div>
            <div>
              {app.sys.cpuModel} {L(`(${app.sys.cpuCount} スレッド)`, `(${app.sys.cpuCount} threads)`)}
            </div>
            <div>{L('メモリ', 'Memory')}</div>
            <div>
              {formatBytes(app.sys.totalMemBytes)} {L(`(空き ${formatBytes(app.sys.freeMemBytes)})`, `(${formatBytes(app.sys.freeMemBytes)} free)`)}
            </div>
            <div>GPU</div>
            <div>
              {app.sys.gpus.length === 0 ? (
                <span className="muted">
                  {app.runtime?.installed || py?.installed
                    ? app.runtime?.backend === 'cpu' && !py?.cuda
                      ? L('CPU バックエンドのため GPU は使用しません', 'The GPU is not used with the CPU backend')
                      : L('検出されませんでした(ドライバー / バックエンドを確認)', 'Not detected (check the driver / backend)')
                    : L('エンジンのインストール後に検出します', 'Detected after an engine is installed')}
                </span>
              ) : (
                app.sys.gpus.map((g) => {
                  const selection = s.gpuSelection ?? AUTO_GPU
                  const unused = isUnusedGpu(g, app.sys?.gpus ?? [], selection)
                  return (
                    <div key={g.id} className={unused ? 'muted' : undefined}>
                      {g.name} · VRAM {formatBytes(g.totalMiB * 1024 * 1024)}{' '}
                      {L(`(空き ${formatBytes(g.freeMiB * 1024 * 1024)})`, `(${formatBytes(g.freeMiB * 1024 * 1024)} free)`)} <span className="muted small">[{g.id}]</span>
                      {unused && (
                        <div className="small">
                          {selection === AUTO_GPU
                            ? L(
                                '内蔵 GPU (メインメモリを共有)。外付け GPU があるため、推論とメモリの判定には使いません',
                                'Integrated GPU (shares main memory). Not used for inference or memory checks because a discrete GPU is present',
                              )
                            : L('「使用する GPU」で選んでいないため、推論とメモリの判定には使いません', 'Not used for inference or memory checks because it is not selected under "GPU to use"')}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        ) : (
          <div className="muted">{L('取得中…', 'Loading…')}</div>
        )}
      </Section>
    </div>
  )
}
