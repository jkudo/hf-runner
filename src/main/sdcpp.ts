import type { SdBackend, SdBackendOption, SdRuntimeInfo } from '@shared/types'
import { SD_BACKEND_LABELS } from '@shared/engines'
import path from 'node:path'
import * as rr from './release-runtime'
import { ReleaseRuntime, runCapture, type Release, type ReleaseSpec } from './release-runtime'

// stable-diffusion.cpp のリリース資産名 (例: sd-master-3f8527a-bin-win-cuda12-x64.zip, cudart-sd-bin-win-cu12-x64.zip)
const RULES: ReleaseSpec<SdBackend>['rules'] = {
  'win32-x64': {
    cpu: { main: /^sd-master-[0-9a-f]+-bin-win-cpu-x64\.zip$/ },
    vulkan: { main: /^sd-master-[0-9a-f]+-bin-win-vulkan-x64\.zip$/ },
    cuda12: { main: /^sd-master-[0-9a-f]+-bin-win-cuda12-x64\.zip$/, extra: /^cudart-sd-bin-win-cu12-x64\.zip$/ },
    rocm: { main: /^sd-master-[0-9a-f]+-bin-win-rocm-[\d.]+-x64\.zip$/ },
  },
  'linux-x64': {
    cpu: { main: /^sd-master-[0-9a-f]+-bin-Linux-Ubuntu-[\d.]+-x86_64\.zip$/ },
    vulkan: { main: /^sd-master-[0-9a-f]+-bin-Linux-Ubuntu-[\d.]+-x86_64-vulkan\.zip$/ },
    rocm: { main: /^sd-master-[0-9a-f]+-bin-Linux-Ubuntu-[\d.]+-x86_64-rocm-[\d.]+\.zip$/ },
  },
  // macOS ビルドは Metal 込みなので cpu の名前で扱う
  'darwin-arm64': { cpu: { main: /^sd-master-[0-9a-f]+-bin-Darwin-macOS-[\d.]+-arm64\.zip$/ } },
}

export function recommendedSdBackend(platform: string, arch: string): SdBackend {
  if (arch === 'x64' && (platform === 'win32' || platform === 'linux')) return 'vulkan'
  return 'cpu'
}

/** タグは master-NNN-hash */
const SDCPP: ReleaseSpec<SdBackend> = {
  productLabel: 'stable-diffusion.cpp',
  releasesUrl: 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=10',
  exeName: 'sd-server',
  isBuildTag: (tag) => /^master-\d+-[0-9a-f]+$/.test(tag),
  rules: RULES,
  labels: SD_BACKEND_LABELS,
  recommend: recommendedSdBackend,
}

export const sdBackendOptions = (platform: string, arch: string): SdBackendOption[] => rr.backendOptions(SDCPP, platform, arch)
export const pickSdRelease = (releases: Release[], backend: SdBackend, platform = process.platform, arch = process.arch): Release | null =>
  rr.pickRelease(SDCPP, releases, backend, platform, arch)

/** stable-diffusion.cpp 公式リリースの取得・展開・バージョン管理 */
/** `sd-server --list-devices` の出力 ("Vulkan1<TAB>NVIDIA GeForce RTX 3060 Laptop GPU") から GPU を取り出す (CPU は除く)。名前は --backend に渡せる */
export function parseSdDevices(output: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = []
  for (const m of output.matchAll(/^([A-Za-z]+\d+)\t(.+?)\s*$/gm)) out.push({ id: m[1], name: m[2] })
  return out
}

export class SdRuntimeManager extends ReleaseRuntime<SdBackend> {
  constructor(rootDir: string) {
    super(SDCPP, rootDir)
  }

  override getInfo(): Promise<SdRuntimeInfo> {
    return super.getInfo()
  }

  /** sd-server から見える GPU。使う GPU を手動で選んだときだけ、起動の直前に問い合わせる */
  async listDevices(): Promise<Array<{ id: string; name: string }>> {
    const info = await this.getInfo()
    if (!info.installed || !info.serverPath || info.backend === 'cpu') return []
    const out = await runCapture(info.serverPath, ['--list-devices'], path.dirname(info.serverPath), 20_000).catch(() => '')
    return parseSdDevices(out)
  }
}
