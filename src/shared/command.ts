import type { EngineId } from './types'
import { splitArgs } from './args'
import { L } from './i18n'

/**
 * 推論サーバーの起動コマンドのひな形。設定画面で本文を編集でき、起動のたびに {…} をモデルのパスやポートに置き換える。
 * 空白区切りで、"…" / '…' で囲むと空白を含む 1 つの引数になる (シェルは通さない)。
 * 1 語だけの {threads} などは「-t 8」のように 0 個以上の引数に展開する (不要なときは消える)
 */
export const DEFAULT_COMMANDS: Record<EngineId, string> = {
  llamacpp: '{exe} -m {model} --host 127.0.0.1 --port {port} -c {ctx} -ngl {ngl} --jinja -a {name} {threads} {device} {mmproj}',
  sdcpp: '{exe} {model-flag} {model} {components} {recommended} --listen-ip 127.0.0.1 --listen-port {port} --log-level info {backend} {threads}',
  transformers: '{python} {script} --model {model} --host 127.0.0.1 --port {port} --max-context {ctx} --precision {precision} --alias {name} {trust-remote-code}',
}

/** 差し込み項目の値。配列は 0 個以上の引数 (その項目だけの語として書いたとき) */
export type CommandVars = Record<string, string | string[]>

/** 設定画面に出す差し込み項目の説明 */
export const commandPlaceholders = (engine: EngineId): Array<{ key: string; desc: string }> => {
  const port = { key: 'port', desc: L('待ち受けポート (必須。アプリはこのポートで起動を確認します)', 'Listening port (required; the app checks this port to see that the server is up)') }
  const threads = { key: 'threads', desc: L('-t N (設定で CPU スレッド数を指定したときだけ)', '-t N (only when CPU threads are set in Settings)') }
  if (engine === 'llamacpp')
    return [
      { key: 'exe', desc: L('インストール済みの llama-server のパス', 'Path of the installed llama-server') },
      { key: 'model', desc: L('モデルファイル (.gguf) のパス', 'Path of the model file (.gguf)') },
      port,
      { key: 'ctx', desc: L('コンテキスト長', 'Context length') },
      { key: 'ngl', desc: L('GPU に載せるレイヤー数 (auto または数)', 'GPU layers (auto or a number)') },
      { key: 'name', desc: L('モデル名 (API の model 名)', 'Model name (the model name in the API)') },
      threads,
      { key: 'device', desc: L('--device … (使う GPU。「使用する GPU」で選んだ GPU、自動なら外付け GPU。CPU のみのときは none。内蔵 GPU しか無ければ無し)', '--device … (GPUs to use: the one chosen under "GPU to use", or the discrete GPUs when automatic; none for CPU only; omitted with only an integrated GPU)') },
      { key: 'mmproj', desc: L('--mmproj … (画像入力モデルのときだけ)', '--mmproj … (vision models only)') },
    ]
  if (engine === 'sdcpp')
    return [
      { key: 'exe', desc: L('インストール済みの sd-server のパス', 'Path of the installed sd-server') },
      { key: 'model-flag', desc: L('-m または --diffusion-model (モデルの種類で決まる)', '-m or --diffusion-model (depends on the model type)') },
      { key: 'model', desc: L('モデルファイルのパス', 'Path of the model file') },
      { key: 'components', desc: L('--vae … --clip_l … など (FLUX など部品分割型のときだけ)', '--vae …, --clip_l …, etc. (split models such as FLUX only)') },
      { key: 'recommended', desc: L('部品分割型の推奨オプション (--diffusion-fa --sampling-method euler --offload-to-cpu など)', 'Recommended options for split models (--diffusion-fa --sampling-method euler --offload-to-cpu, etc.)') },
      port,
      { key: 'backend', desc: L('--backend cpu (CPU 版のとき) / --backend Vulkan1 など (「使用する GPU」で GPU を選んだとき)', '--backend cpu (CPU build) / --backend Vulkan1 etc. (when a GPU is chosen under "GPU to use")') },
      threads,
    ]
  return [
    { key: 'python', desc: L('専用環境の python のパス', 'Path of python in the dedicated environment') },
    { key: 'script', desc: L('HF Runner の server.py のパス', "Path of HF Runner's server.py") },
    { key: 'model', desc: L('モデルのフォルダ', 'Model folder') },
    port,
    { key: 'ctx', desc: L('コンテキスト長', 'Context length') },
    { key: 'precision', desc: L('読み込み精度 (auto / 8bit / 4bit)', 'Load precision (auto / 8bit / 4bit)') },
    { key: 'name', desc: L('モデル名 (API の model 名)', 'Model name (the model name in the API)') },
    { key: 'trust-remote-code', desc: L('--trust-remote-code (リモートコードの実行を許可したときだけ)', '--trust-remote-code (only when remote code is allowed)') },
  ]
}

const PLACEHOLDER = /\{([a-z][a-z-]*)\}/g

/** 本文の問題 (起動できない・起動を確認できない) を返す。問題が無ければ空 */
export function commandProblems(template: string, engine: EngineId): string[] {
  const problems: string[] = []
  const tokens = splitArgs(template)
  if (tokens.length === 0) return [L('起動コマンドが空です', 'The launch command is empty')]
  if (tokens[0].startsWith('-')) problems.push(L('先頭には実行ファイル ({exe} など) を書いてください', 'Start with the executable ({exe}, etc.)'))
  if (!template.includes('{port}')) problems.push(L('{port} が必要です (アプリはこのポートで起動を確認します)', '{port} is required (the app checks this port to see that the server is up)'))
  const known = new Set(commandPlaceholders(engine).map((p) => p.key))
  const unknown = [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((k) => !known.has(k)))]
  if (unknown.length) problems.push(L(`不明な差し込み項目: ${unknown.map((k) => `{${k}}`).join(' ')}`, `Unknown placeholders: ${unknown.map((k) => `{${k}}`).join(' ')}`))
  return problems
}

/** 同じ内容 (引数の並びが同じ) なら true。既定と同じ本文は保存しない判定に使う */
export const sameCommand = (a: string, b: string) => JSON.stringify(splitArgs(a)) === JSON.stringify(splitArgs(b))

/** 本文に問題があれば例外 */
export function assertCommand(template: string, engine: EngineId): void {
  const problems = commandProblems(template, engine)
  if (problems.length) throw new Error(L(`設定の起動コマンドに問題があります: ${problems.join(' / ')}`, `The launch command in Settings has a problem: ${problems.join(' / ')}`))
}

/** 実際に渡す引数からオプションの値を読む。後に書いたものが優先で、--name=value の形にも対応する */
export function argValue(args: string[], names: string[]): string | undefined {
  let value: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const eq = a.indexOf('=')
    if (names.includes(a) && i + 1 < args.length) value = args[++i]
    else if (eq > 0 && a.startsWith('-') && names.includes(a.slice(0, eq))) value = a.slice(eq + 1)
  }
  return value
}

/** ひな形の {…} を置き換えて実行ファイルと引数にする。問題があれば例外 */
export function buildCommand(template: string, engine: EngineId, vars: CommandVars): { command: string; args: string[] } {
  assertCommand(template, engine)
  const out: string[] = []
  for (const token of splitArgs(template)) {
    const whole = /^\{([a-z][a-z-]*)\}$/.exec(token)
    const value = whole ? vars[whole[1]] : undefined
    if (Array.isArray(value)) {
      out.push(...value)
      continue
    }
    out.push(token.replace(PLACEHOLDER, (m, k: string) => {
      const v = vars[k]
      return v === undefined ? m : Array.isArray(v) ? v.join(' ') : v
    }))
  }
  const [command, ...args] = out
  return { command, args }
}
