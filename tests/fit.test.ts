import { describe, expect, it } from 'vitest'
import { estimateMemory, judgeFit } from '../src/shared/fit'
import type { ModelHeaderInfo, SystemInfo } from '../src/shared/types'

const GiB = 1024 ** 3
const header: ModelHeaderInfo = {
  format: 'gguf',
  version: 3, tensorCount: 0, kvCount: 0, architecture: 'llama', blockCount: 32, headCount: 32, headCountKv: 8,
  keyLength: 128, valueLength: 128, contextLength: 131072, hasChatTemplate: true, metadata: {}, truncated: false,
}
const sys = (ram: number, vram: number): SystemInfo => ({
  platform: 'win32', arch: 'x64', totalMemBytes: ram * GiB, freeMemBytes: ram * GiB, cpuCount: 8, cpuModel: 'x',
  gpus: vram ? [{ id: 'Vulkan0', name: 'GPU', totalMiB: vram * 1024, freeMiB: vram * 1024 }] : [], gpuSource: 'runtime',
})

describe('estimateMemory', () => {
  it('uses header hyper-params for the KV cache when available', () => {
    const est = estimateMemory({ totalSize: 4.9 * GiB, header, contextSize: 4096 })
    // 32 layers * 8 kv heads * (128+128) * 2 bytes = 128 KiB / token → 512 MiB @ 4096
    expect(est.kvCacheBytes).toBe(4096 * 131072)
    expect(est.approximate).toBe(false)
    expect(est.totalBytes).toBeGreaterThan(est.weightsBytes + est.kvCacheBytes)
  })
  it('falls back to a parameter-count heuristic without a header', () => {
    const est = estimateMemory({ totalSize: 4.9 * GiB, paramsB: 8, contextSize: 4096 })
    expect(est.approximate).toBe(true)
    expect(est.kvCacheBytes).toBeGreaterThan(100 * 1024 * 1024)
  })
  it('caps the context at the model maximum', () => {
    const est = estimateMemory({ totalSize: GiB, header: { ...header, contextLength: 2048 }, contextSize: 32768 })
    expect(est.contextSize).toBe(2048)
  })
})

describe('judgeFit', () => {
  const est = estimateMemory({ totalSize: 4.9 * GiB, header, contextSize: 4096 })
  it('fits fully on a big GPU', () => expect(judgeFit(est, sys(32, 12)).level).toBe('gpu'))
  it('partially offloads on a small GPU', () => expect(judgeFit(est, sys(32, 4)).level).toBe('gpu-partial'))
  it('runs on CPU without a GPU', () => expect(judgeFit(est, sys(16, 0)).level).toBe('cpu'))
  it('rejects when RAM is too small', () => expect(judgeFit(est, sys(4, 0)).level).toBe('no'))
  it('is unknown without system info', () => expect(judgeFit(est, null).level).toBe('unknown'))
})
