import type { GpuDevice, ModelFormat } from './types'

/** CPU 内蔵の GPU (メインメモリを共有する) の名前。ノート PC では外付け GPU と一緒に Vulkan0 / Vulkan1 として並ぶ */
const INTEGRATED_GPU = /Intel\(R\) (UHD|HD|Iris)|Intel.*\b(UHD|Iris|HD) Graphics|Radeon\(TM\) (Graphics|Vega)|AMD Radeon Graphics|Radeon \d{3}M|Microsoft Basic Render/i

export const isIntegratedGpu = (name: string) => INTEGRATED_GPU.test(name)

const NVIDIA_GPU = /NVIDIA|GeForce|Quadro|Tesla|RTX|GTX/i
export const isNvidiaGpu = (name: string) => NVIDIA_GPU.test(name)

/** 設定「使用する GPU」の既定。外付け GPU があれば外付けだけ、無ければ全部 */
export const AUTO_GPU = 'auto'

/** 同じ GPU かを名前で見るための正規化 ("Intel(R) UHD Graphics" と "Intel UHD Graphics" などの揺れを吸収) */
const nameKey = (name: string) =>
  name
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/**
 * GPU を見分けるキー (名前 + 同じ名前の中での順番)。エンジンやビルドで番号 (Vulkan1 / CUDA0 など) が変わっても同じ GPU を指せるので、
 * 設定「使用する GPU」にはこれを保存する
 */
export const gpuKey = (name: string, nth: number) => `${nameKey(name)}#${nth}`

/** 一覧の各 GPU にキーを付ける (同じ名前は並び順で #0, #1 …) */
export function withKeys<T extends { name: string }>(devices: T[]): Array<T & { key: string }> {
  const seen = new Map<string, number>()
  return devices.map((d) => {
    const k = nameKey(d.name)
    const nth = seen.get(k) ?? 0
    seen.set(k, nth + 1)
    return { ...d, key: gpuKey(d.name, nth) }
  })
}

/**
 * 検出元ごとの GPU 一覧 (llama.cpp の --list-devices、nvidia-smi など) を 1 つにまとめる。
 * 同じ名前の GPU は 1 つにし (同じ型番が複数枚あれば、多く見えている検出元の枚数に合わせる)、先に渡した検出元の情報を優先する。
 * 外付け GPU を先に並べ、内蔵 GPU には integrated を、全部にキーを付ける
 */
export function mergeGpus(...sources: GpuDevice[][]): GpuDevice[] {
  const out: GpuDevice[] = []
  for (const source of sources) {
    const seen = new Map<string, number>()
    for (const d of source) {
      const k = nameKey(d.name)
      const nth = (seen.get(k) ?? 0) + 1
      seen.set(k, nth)
      if (out.filter((o) => nameKey(o.name) === k).length < nth) out.push({ ...d, integrated: isIntegratedGpu(d.name) })
    }
  }
  // 外付けを先に (並びは安定させる)。キーは検出元の並び順で付ける (エンジンの番号の並びと揃える)
  const keyed = withKeys(out)
  return [...keyed.filter((g) => !g.integrated), ...keyed.filter((g) => g.integrated)]
}

/**
 * 推論に使う GPU。設定で GPU を選んでいればその GPU (見つからなければ自動)。
 * 自動なら、外付け GPU があれば外付けだけ (llama.cpp の起動でも --device で内蔵には載せない)、無ければ内蔵も含めた全部。
 * 内蔵 GPU の「VRAM」はメインメモリの共有分で、外付けより大きく見えることが多いので、判定に混ぜると「GPU に全て載る」と誤る
 */
export function usableGpus(gpus: GpuDevice[], selection: string = AUTO_GPU): GpuDevice[] {
  if (selection !== AUTO_GPU) {
    const chosen = gpus.find((g) => g.key === selection)
    if (chosen) return [chosen]
  }
  const discrete = gpus.filter((g) => !g.integrated)
  return discrete.length > 0 ? discrete : gpus
}

/** 推論に使わない GPU か (自動なら外付けがあるときの内蔵、手動なら選んだもの以外) */
export const isUnusedGpu = (g: GpuDevice, gpus: GpuDevice[], selection: string = AUTO_GPU) => !usableGpus(gpus, selection).some((u) => u.key === g.key)

/** 設定で選んだ GPU が、そのエンジンの一覧 (エンジンが数える順) の何番目か。見つからなければ null */
export function selectedIndex(devices: Array<{ name: string }>, selection: string): number | null {
  if (selection === AUTO_GPU) return null
  const i = withKeys(devices).findIndex((d) => d.key === selection)
  return i >= 0 ? i : null
}

/**
 * そのモデル形式を動かすエンジンがメモリ判定で使える GPU。インストール済みのエンジンが CPU 版なら空。
 * 未インストールなら、入れれば GPU を使える見込みで判定する。Python / Transformers は CUDA (NVIDIA GPU) だけを使う
 */
export function fitGpus(
  format: ModelFormat,
  engines: {
    llama?: { installed: boolean; backend?: string } | null
    python?: { installed: boolean; cuda?: boolean } | null
    sd?: { installed: boolean; backend?: string } | null
  },
  gpus: GpuDevice[],
  selection: string = AUTO_GPU,
): GpuDevice[] {
  const usable = usableGpus(gpus, selection)
  if (format === 'gguf') return engines.llama?.installed && engines.llama.backend === 'cpu' ? [] : usable
  if (format === 'diffusion') return engines.sd?.installed && engines.sd.backend === 'cpu' ? [] : usable
  if (engines.python?.installed && !engines.python.cuda) return []
  // 選んだ GPU が NVIDIA でなければ、Python は既定の CUDA デバイスを使う
  const nvidia = usable.filter((g) => isNvidiaGpu(g.name))
  return nvidia.length > 0 ? nvidia : usableGpus(gpus).filter((g) => isNvidiaGpu(g.name))
}
