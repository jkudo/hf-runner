import path from 'node:path'
import type { Backend, BackendOption, GpuDevice, ReleaseCheck, RuntimeInfo } from '@shared/types'
import { L } from '@shared/i18n'
import { isIntegratedGpu } from '@shared/gpu'
import * as rr from './release-runtime'
import { ReleaseRuntime, runCapture, type Release, type ReleaseAsset, type ReleaseSpec } from './release-runtime'

export { downloadToFile, extractArchive, findFile, platformKey, type Release, type ReleaseAsset } from './release-runtime'

// プラットフォーム/バックエンドごとの llama.cpp リリース資産名パターン
const RULES: ReleaseSpec<Backend>['rules'] = {
  'win32-x64': {
    cpu: { main: /^llama-b\d+-bin-win-cpu-x64\.zip$/ },
    vulkan: { main: /^llama-b\d+-bin-win-vulkan-x64\.zip$/ },
    cuda12: { main: /^llama-b\d+-bin-win-cuda-12\.\d+-x64\.zip$/, extra: /^cudart-llama-bin-win-cuda-12\.\d+-x64\.zip$/ },
    cuda13: { main: /^llama-b\d+-bin-win-cuda-13\.\d+-x64\.zip$/, extra: /^cudart-llama-bin-win-cuda-13\.\d+-x64\.zip$/ },
  },
  'win32-arm64': {
    cpu: { main: /^llama-b\d+-bin-win-cpu-arm64\.zip$/ },
    cuda13: { main: /^llama-b\d+-bin-win-cuda-13\.\d+-arm64\.zip$/, extra: /^cudart-llama-bin-win-cuda-13\.\d+-arm64\.zip$/ },
  },
  'linux-x64': {
    cpu: { main: /^llama-b\d+-bin-ubuntu-x64\.tar\.gz$/ },
    vulkan: { main: /^llama-b\d+-bin-ubuntu-vulkan-x64\.tar\.gz$/ },
    cuda12: { main: /^llama-b\d+-bin-ubuntu-cuda-12\.\d+-x64\.tar\.gz$/, extra: /^cudart-llama-b\d+-bin-ubuntu-cuda-12\.\d+-x64\.tar\.gz$/ },
    cuda13: { main: /^llama-b\d+-bin-ubuntu-cuda-13\.\d+-x64\.tar\.gz$/, extra: /^cudart-llama-b\d+-bin-ubuntu-cuda-13\.\d+-x64\.tar\.gz$/ },
  },
  'linux-arm64': {
    cpu: { main: /^llama-b\d+-bin-ubuntu-arm64\.tar\.gz$/ },
    vulkan: { main: /^llama-b\d+-bin-ubuntu-vulkan-arm64\.tar\.gz$/ },
    cuda13: { main: /^llama-b\d+-bin-ubuntu-cuda-13\.\d+-arm64\.tar\.gz$/, extra: /^cudart-llama-b\d+-bin-ubuntu-cuda-13\.\d+-arm64\.tar\.gz$/ },
  },
  'darwin-arm64': { metal: { main: /^llama-b\d+-bin-macos-arm64\.tar\.gz$/ } },
  'darwin-x64': { metal: { main: /^llama-b\d+-bin-macos-x64\.tar\.gz$/ } },
}

// 表示言語はその時点のものを使うため getter にする
const LABELS: Record<Backend, { label: string; description: string }> = {
  cpu: {
    get label() {
      return L('CPU のみ', 'CPU only')
    },
    get description() {
      return L('GPU を使いません。どの PC でも動きますが低速です', 'Does not use the GPU. Works on any PC but is slow')
    },
  },
  vulkan: {
    get label() {
      return L('Vulkan (GPU 汎用)', 'Vulkan (any GPU)')
    },
    get description() {
      return L('NVIDIA / AMD / Intel の GPU で動作します。まずはこれを推奨', 'Works with NVIDIA / AMD / Intel GPUs. Recommended to start with')
    },
  },
  cuda12: {
    label: 'CUDA 12 (NVIDIA)',
    get description() {
      return L('NVIDIA GPU 専用で最速。ドライバー 525 以降が必要。約 650MB', 'NVIDIA GPUs only, fastest. Requires driver 525 or later. About 650 MB')
    },
  },
  cuda13: {
    label: 'CUDA 13 (NVIDIA)',
    get description() {
      return L('NVIDIA GPU 専用。新しいドライバー(580 以降)が必要。約 580MB', 'NVIDIA GPUs only. Requires a recent driver (580 or later). About 580 MB')
    },
  },
  metal: {
    label: 'Metal (Apple)',
    get description() {
      return L('Apple Silicon / macOS 用', 'For Apple Silicon / macOS')
    },
  },
}

export function recommendedBackend(platform: string, arch: string): Backend {
  if (platform === 'darwin') return 'metal'
  if (arch === 'x64' && (platform === 'win32' || platform === 'linux')) return 'vulkan'
  return 'cpu'
}

/** "latest" はバイナリのないバージョンタグのことがあるため、ビルド番号タグ (bNNNN) だけを対象にする */
const LLAMA: ReleaseSpec<Backend> = {
  productLabel: 'llama.cpp',
  releasesUrl: 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15',
  exeName: 'llama-server',
  isBuildTag: (tag) => /^b\d+$/.test(tag),
  rules: RULES,
  labels: LABELS,
  recommend: recommendedBackend,
}

export const backendOptions = (platform: string, arch: string): BackendOption[] => rr.backendOptions(LLAMA, platform, arch)
export const selectAssets = (release: Release, backend: Backend, platform: string, arch: string): ReleaseAsset[] => rr.selectAssets(LLAMA, release, backend, platform, arch)
export const hasAssetsFor = (release: Release, backend: Backend, platform: string, arch: string): boolean => rr.hasAssetsFor(LLAMA, release, backend, platform, arch)
export const pickBinaryRelease = (releases: Release[], backend?: Backend, platform = process.platform, arch = process.arch): Release | null =>
  rr.pickRelease(LLAMA, releases, backend, platform, arch)

/** `llama-server --list-devices` の出力から GPU 一覧を取り出す */
export function parseDevices(output: string): GpuDevice[] {
  const re = /^\s*([A-Za-z0-9_]+):\s+(.+?)\s+\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/gm
  const out: GpuDevice[] = []
  for (const m of output.matchAll(re)) {
    out.push({ id: m[1], name: m[2], totalMiB: Number(m[3]), freeMiB: Number(m[4]) })
  }
  return out
}

/**
 * 外付け GPU と内蔵 GPU が両方あるとき、外付けだけを使うデバイス一覧 (--device に渡す)。
 * 全部に層を割り振ると、容量の大きく見える内蔵 GPU (共有メモリ) に多くが載って遅くなり、外付け側の確保に失敗することもある。
 * 片方しか無ければ null (llama.cpp の既定に任せる)。画面の判定 (usableGpus) と同じ規則
 */
export function discreteDevices(devices: GpuDevice[]): string[] | null {
  const discrete = devices.filter((d) => !isIntegratedGpu(d.name))
  return discrete.length > 0 && discrete.length < devices.length ? discrete.map((d) => d.id) : null
}

/**
 * -ngl に渡す値。設定の 99 (= 自動) は 'auto' にして、llama.cpp の --fit (空きメモリに合わせてレイヤー数を決める) に任せる。
 * 数値を明示すると --fit が働かず、VRAM に収まらないモデルは読み込みに失敗する。'auto' を知らない古いビルド (b7000 未満) には 99
 */
export function gpuLayersArg(ngl: number, tag?: string): string {
  if (ngl < 99) return String(ngl)
  const build = Number(/^b(\d+)$/.exec(tag ?? '')?.[1] ?? NaN)
  return Number.isFinite(build) && build < 7000 ? '99' : 'auto'
}

/** llama.cpp 公式リリースの取得・展開・バージョン管理 */
export class RuntimeManager extends ReleaseRuntime<Backend> {
  private devicesCache: { at: number; devices: GpuDevice[] } | null = null
  private devicesPending: Promise<GpuDevice[]> | null = null

  constructor(rootDir: string) {
    super(LLAMA, rootDir)
  }

  override getInfo(): Promise<RuntimeInfo> {
    return super.getInfo()
  }

  async checkUpdate(backend: Backend): Promise<ReleaseCheck> {
    const [release, info] = await Promise.all([this.latestInstallable(backend, true), this.getInfo()])
    return { latestTag: release.tag_name, currentTag: info.tag, updateAvailable: !info.installed || info.tag !== release.tag_name || info.backend !== backend }
  }

  protected override onInstalled(): void {
    this.devicesCache = null
  }

  async listDevices(): Promise<GpuDevice[]> {
    const info = await this.getInfo()
    if (!info.installed || !info.serverPath) return []
    if (this.devicesCache && Date.now() - this.devicesCache.at < 60_000) return this.devicesCache.devices
    // 起動直後は画面の検出と推論サーバーの起動が同時に問い合わせるので、実行中の問い合わせがあれば相乗りする
    this.devicesPending ??= this.queryDevices(info.serverPath, info.backend !== 'cpu').finally(() => {
      this.devicesPending = null
    })
    return this.devicesPending
  }

  private async queryDevices(serverPath: string, expectGpu: boolean): Promise<GpuDevice[]> {
    const list = () =>
      runCapture(serverPath, ['--list-devices'], path.dirname(serverPath), 20_000)
        .then(parseDevices)
        .catch(() => [] as GpuDevice[])
    // 初回はドライバーの初期化やセキュリティの検査で失敗・タイムアウトすることがあるので、GPU 版なら 1 回だけやり直す
    let devices = await list()
    if (devices.length === 0 && expectGpu) devices = await list()
    // 見つからなかった結果は覚えない (一時的な失敗で 1 分間「GPU なし」にならないように)
    if (devices.length > 0) this.devicesCache = { at: Date.now(), devices }
    return devices
  }
}
