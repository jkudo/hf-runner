import os from 'node:os'
import type { GpuDevice, SystemInfo } from '@shared/types'
import { mergeGpus } from '@shared/gpu'
import { numOrNull, queryNvidiaSmi } from './nvidia'
import type { PythonRuntime } from './python'
import type { RuntimeManager } from './runtime'

/**
 * RAM / CPU / GPU(VRAM)の情報を集める。
 * GPU は llama.cpp (--list-devices) と nvidia-smi の両方で調べてまとめる。llama.cpp だけに頼ると、CPU 版を入れている・
 * 問い合わせが一時的に失敗したときに GPU が消え、ビルドによって並ぶ GPU も変わる (Vulkan 版は内蔵 GPU も並べ、CUDA 版は NVIDIA だけ)
 */
export async function getSystemInfo(runtime: RuntimeManager, python: PythonRuntime): Promise<SystemInfo> {
  const cpus = os.cpus()
  const info = await runtime.getInfo()
  const [llama, smi] = await Promise.all([info.installed && info.backend !== 'cpu' ? runtime.listDevices() : Promise.resolve([]), nvidiaSmi()])
  let gpus = mergeGpus(llama, smi)
  let gpuSource: SystemInfo['gpuSource'] = llama.length ? 'runtime' : smi.length ? 'nvidia-smi' : 'none'
  if (!gpus.length) {
    // どちらでも見つからなくても Python (CUDA) 側で見えていればそれを使う
    const py = await python.listDevices().catch(() => [])
    if (py.length) {
      gpus = mergeGpus(py)
      gpuSource = 'python'
    }
  }
  return {
    platform: process.platform,
    arch: process.arch,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model?.trim() ?? '',
    gpus,
    gpuSource,
  }
}

async function nvidiaSmi(): Promise<GpuDevice[]> {
  const rows = await queryNvidiaSmi(['name', 'memory.total', 'memory.free'], 4000)
  if (!rows) return []
  const out: GpuDevice[] = []
  for (const [name, total, free] of rows) {
    if (name && total) out.push({ id: `GPU${out.length}`, name, totalMiB: numOrNull(total) ?? 0, freeMiB: numOrNull(free) ?? 0 })
  }
  return out
}
