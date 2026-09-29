import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { GpuDevice, PythonInstallState, PythonProgress, PythonRuntimeInfo, TorchBackend } from '@shared/types'
import { L } from '@shared/i18n'
import { downloadToFile, extractArchive, findFile } from './runtime'

export const UV_DOWNLOAD_BASE = 'https://github.com/astral-sh/uv/releases/latest/download/'
const PYTHON_VERSION = '3.12'
// pillow は画像入力 (視覚言語モデル) の前処理に必要
const PACKAGES = ['transformers', 'accelerate', 'safetensors', 'sentencepiece', 'protobuf', 'tiktoken', 'pillow']

/** プラットフォームごとの uv 配布ファイル名 */
export function uvAssetName(platform: string, arch: string): string | null {
  const map: Record<string, string> = {
    'win32-x64': 'uv-x86_64-pc-windows-msvc.zip',
    'win32-arm64': 'uv-aarch64-pc-windows-msvc.zip',
    'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz',
    'linux-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz',
    'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
    'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz',
  }
  return map[`${platform}-${arch}`] ?? null
}

export interface ProbeResult {
  torch?: string
  transformers?: string
  cuda?: boolean
  devices?: GpuDevice[]
  bitsandbytes?: boolean
  error?: string
}

/**
 * Transformers 用の Python 環境。uv で管理版 Python と venv を作り、PyTorch / transformers を入れる。
 * 全て rootDir (userData/python) 配下に閉じ込め、システムの Python には触れない。
 */
export class PythonRuntime extends EventEmitter {
  private state: PythonInstallState = 'idle'

  constructor(
    private readonly rootDir: string,
    private readonly scriptsDir: string,
  ) {
    super()
  }

  get uvPath() {
    return path.join(this.rootDir, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
  }
  get venvDir() {
    return path.join(this.rootDir, 'venv')
  }
  get pythonPath() {
    return process.platform === 'win32' ? path.join(this.venvDir, 'Scripts', 'python.exe') : path.join(this.venvDir, 'bin', 'python')
  }
  private get infoPath() {
    return path.join(this.rootDir, 'info.json')
  }
  serverScript() {
    return path.join(this.scriptsDir, 'server.py')
  }

  env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: path.join(this.rootDir, 'pythons'),
      UV_CACHE_DIR: path.join(this.rootDir, 'cache'),
      UV_PYTHON_PREFERENCE: 'only-managed',
      UV_NO_CONFIG: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
    }
  }

  async getInfo(): Promise<PythonRuntimeInfo> {
    try {
      const info = JSON.parse(await fsp.readFile(this.infoPath, 'utf8')) as PythonRuntimeInfo
      // パスは保存値ではなく現在の rootDir から求める(フォルダごと移動されても追従する)
      if (fs.existsSync(this.pythonPath)) return { ...info, installed: true, dir: this.rootDir, pythonPath: this.pythonPath }
    } catch {
      /* 未インストール */
    }
    return { installed: false }
  }

  /**
   * フォルダごと移動された venv を直す。venv の python.exe は pyvenv.cfg の home で本体の Python を探すため、
   * そこが古い絶対パスのままだと起動できない。管理版 Python の現在地に書き換える
   */
  async repairVenv(): Promise<void> {
    const cfgPath = path.join(this.venvDir, 'pyvenv.cfg')
    let cfg: string
    try {
      cfg = await fsp.readFile(cfgPath, 'utf8')
    } catch {
      return
    }
    const m = /^home\s*=\s*(.+)$/m.exec(cfg)
    if (!m || fs.existsSync(m[1].trim())) return
    const home = await this.findManagedPythonHome()
    if (home) await fsp.writeFile(cfgPath, cfg.replace(m[0], `home = ${home}`))
  }

  /** uv が UV_PYTHON_INSTALL_DIR に入れた Python 本体の場所(pyvenv.cfg の home に書く値) */
  private async findManagedPythonHome(): Promise<string | null> {
    const root = path.join(this.rootDir, 'pythons')
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('cpython-')) continue
      const home = process.platform === 'win32' ? path.join(root, e.name) : path.join(root, e.name, 'bin')
      if (fs.existsSync(path.join(home, process.platform === 'win32' ? 'python.exe' : 'python3'))) return home
    }
    return null
  }

  async install(backend: TorchBackend): Promise<PythonRuntimeInfo> {
    const progress = (state: PythonInstallState, message: string) => {
      this.state = state
      this.emit('progress', { state, message } satisfies PythonProgress)
    }
    try {
      await fsp.mkdir(this.rootDir, { recursive: true })
      await fsp.rm(this.infoPath, { force: true })

      if (!fs.existsSync(this.uvPath)) {
        progress('downloading', L('uv (Python 環境マネージャー) をダウンロード中…', 'Downloading uv (Python environment manager)…'))
        const name = uvAssetName(process.platform, process.arch)
        if (!name) throw new Error(L(`このプラットフォーム (${process.platform}-${process.arch}) では Python エンジンを利用できません`, `The Python engine is not available on this platform (${process.platform}-${process.arch})`))
        const tmp = path.join(this.rootDir, 'tmp')
        await fsp.rm(tmp, { recursive: true, force: true })
        await fsp.mkdir(tmp, { recursive: true })
        const archive = path.join(tmp, name)
        await downloadToFile(UV_DOWNLOAD_BASE + name, archive, () => {})
        await extractArchive(archive, tmp)
        const found = await findFile(tmp, process.platform === 'win32' ? 'uv.exe' : 'uv')
        if (!found) throw new Error(L('uv の展開に失敗しました', 'Failed to extract uv'))
        await fsp.mkdir(path.dirname(this.uvPath), { recursive: true })
        await fsp.copyFile(found, this.uvPath)
        if (process.platform !== 'win32') await fsp.chmod(this.uvPath, 0o755)
        await fsp.rm(tmp, { recursive: true, force: true })
      }

      progress('python', L(`Python ${PYTHON_VERSION} を準備中…`, `Preparing Python ${PYTHON_VERSION}…`))
      await this.uv(['python', 'install', PYTHON_VERSION])

      progress('venv', L('仮想環境を作成中…', 'Creating virtual environment…'))
      await fsp.rm(this.venvDir, { recursive: true, force: true })
      // --relocatable: venv 内のスクリプトを相対パスにして、フォルダごと移動しても使えるようにする
      await this.uv(['venv', this.venvDir, '--python', PYTHON_VERSION, '--relocatable'])

      progress(
        'torch',
        backend === 'cpu'
          ? L('PyTorch (CPU 版) をダウンロード中…', 'Downloading PyTorch (CPU build)…')
          : L('PyTorch をダウンロード中(CUDA 版は約 3GB、数分かかります)…', 'Downloading PyTorch (the CUDA build is about 3 GB and takes a few minutes)…'),
      )
      // torchvision は視覚言語モデルの画像前処理 (transformers 5 の image processor) に必須。torch と同じバックエンドで入れる
      await this.uv(['pip', 'install', '--python', this.pythonPath, 'torch', 'torchvision', `--torch-backend=${backend}`])

      progress('packages', L('transformers 等をインストール中…', 'Installing transformers and other packages…'))
      await this.uv(['pip', 'install', '--python', this.pythonPath, ...PACKAGES])

      progress('probe', L('環境を確認中…', 'Checking the environment…'))
      let probe = await this.probe()
      if (!probe.torch) throw new Error(L(`PyTorch の読み込みに失敗しました: ${probe.error ?? '不明なエラー'}`, `Failed to load PyTorch: ${probe.error ?? 'unknown error'}`))
      if (!probe.transformers) throw new Error(L(`transformers の読み込みに失敗しました: ${probe.error ?? '不明なエラー'}`, `Failed to load transformers: ${probe.error ?? 'unknown error'}`))

      if (probe.cuda) {
        progress('packages', L('bitsandbytes (4bit / 8bit 読み込み用) をインストール中…', 'Installing bitsandbytes (for 4-bit / 8-bit loading)…'))
        await this.uv(['pip', 'install', '--python', this.pythonPath, 'bitsandbytes']).catch(() => {})
        probe = await this.probe()
      }

      const info: PythonRuntimeInfo = {
        installed: true,
        dir: this.rootDir,
        pythonPath: this.pythonPath,
        torchVersion: probe.torch,
        transformersVersion: probe.transformers,
        cuda: !!probe.cuda,
        backend,
        bitsandbytes: !!probe.bitsandbytes,
        devices: probe.devices ?? [],
        installedAt: new Date().toISOString(),
      }
      await fsp.writeFile(this.infoPath, JSON.stringify(info, null, 2))
      await fsp.rm(path.join(this.rootDir, 'cache'), { recursive: true, force: true })
      progress(
        'done',
        L(
          `Python エンジンを準備しました (torch ${probe.torch} / ${probe.cuda ? 'CUDA' : 'CPU'}, transformers ${probe.transformers})`,
          `Python engine is ready (torch ${probe.torch} / ${probe.cuda ? 'CUDA' : 'CPU'}, transformers ${probe.transformers})`,
        ),
      )
      return info
    } catch (err) {
      progress('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async remove(): Promise<void> {
    await fsp.rm(this.rootDir, { recursive: true, force: true })
  }

  async listDevices(): Promise<GpuDevice[]> {
    const info = await this.getInfo()
    return info.installed && info.cuda ? (info.devices ?? []) : []
  }

  /** probe.py を実行して torch / transformers / GPU の状態を JSON で受け取る */
  async probe(): Promise<ProbeResult> {
    await this.repairVenv()
    const out = await this.run(this.pythonPath, [path.join(this.scriptsDir, 'probe.py')], 180_000)
    const line = out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'))
    if (!line) throw new Error(L(`環境の確認に失敗しました:\n${out.slice(-800)}`, `Failed to check the environment:\n${out.slice(-800)}`))
    return JSON.parse(line) as ProbeResult
  }

  private uv(args: string[]): Promise<string> {
    return this.run(this.uvPath, args, 0)
  }

  /** コマンドを実行し、出力行を progress.log として流しつつ全出力を返す */
  private run(cmd: string, args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { env: this.env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let lastEmit = 0
      const onData = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        out += text
        if (out.length > 200_000) out = out.slice(-100_000)
        const line = text.trim().split(/\r?\n/).pop()?.trim()
        const now = Date.now()
        if (line && now - lastEmit > 200) {
          lastEmit = now
          this.emit('progress', { state: this.state, message: stateMessage(this.state), log: line.slice(0, 200) } satisfies PythonProgress)
        }
      }
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onData)
      const timer = timeout > 0 ? setTimeout(() => proc.kill(), timeout) : null
      proc.on('error', (e) => {
        if (timer) clearTimeout(timer)
        reject(new Error(L(`${path.basename(cmd)} を起動できません: ${e.message}`, `Could not start ${path.basename(cmd)}: ${e.message}`)))
      })
      proc.on('exit', (code) => {
        if (timer) clearTimeout(timer)
        if (code === 0) resolve(out)
        else
          reject(
            new Error(
              L(`${path.basename(cmd)} ${args.slice(0, 2).join(' ')} が失敗しました (code ${code})`, `${path.basename(cmd)} ${args.slice(0, 2).join(' ')} failed (code ${code})`) +
                `\n${out.trim().split(/\r?\n/).slice(-8).join('\n')}`,
            ),
          )
      })
    })
  }
}

function stateMessage(state: PythonInstallState): string {
  switch (state) {
    case 'downloading': return L('uv をダウンロード中…', 'Downloading uv…')
    case 'python': return L('Python を準備中…', 'Preparing Python…')
    case 'venv': return L('仮想環境を作成中…', 'Creating virtual environment…')
    case 'torch': return L('PyTorch をダウンロード中(数分かかります)…', 'Downloading PyTorch (takes a few minutes)…')
    case 'packages': return L('パッケージをインストール中…', 'Installing packages…')
    case 'probe': return L('環境を確認中…', 'Checking the environment…')
    default: return ''
  }
}
