import { describe, expect, it } from 'vitest'
import type { GpuDevice, SystemInfo } from '../src/shared/types'
import { AUTO_GPU, fitGpus, gpuKey, isUnusedGpu, mergeGpus, selectedIndex, usableGpus } from '../src/shared/gpu'
import { estimateMemory, judgeFit } from '../src/shared/fit'
import { parseSdDevices } from '../src/main/sdcpp'

const dev = (id: string, name: string, gib: number): GpuDevice => ({ id, name, totalMiB: gib * 1024, freeMiB: gib * 1024 })
// 実機 (i7-10875H + RTX 3060 Laptop) の Vulkan 版 llama.cpp と nvidia-smi の出力
const vulkan = [dev('Vulkan0', 'Intel(R) UHD Graphics', 11.9), dev('Vulkan1', 'NVIDIA GeForce RTX 3060 Laptop GPU', 5.85)]
const smi = [dev('GPU0', 'NVIDIA GeForce RTX 3060 Laptop GPU', 6)]
const cuda = [dev('CUDA0', 'NVIDIA GeForce RTX 3060 Laptop GPU', 6)]
const RTX = gpuKey('NVIDIA GeForce RTX 3060 Laptop GPU', 0)
const UHD = gpuKey('Intel(R) UHD Graphics', 0)

describe('mergeGpus', () => {
  it('merges the same GPU from several sources and lists the discrete GPU first', () => {
    const gpus = mergeGpus(vulkan, smi)
    expect(gpus.map((g) => [g.id, g.integrated, g.key])).toEqual([
      ['Vulkan1', false, RTX],
      ['Vulkan0', true, UHD],
    ])
  })
  it('shows the discrete GPU whichever llama.cpp build is installed (or none)', () => {
    for (const llama of [vulkan, cuda, []]) {
      expect(usableGpus(mergeGpus(llama, smi)).map((g) => g.name)).toEqual(['NVIDIA GeForce RTX 3060 Laptop GPU'])
    }
  })
  it('keeps several cards of the same model, with distinct keys', () => {
    const two = [dev('CUDA0', 'NVIDIA GeForce RTX 3090', 24), dev('CUDA1', 'NVIDIA GeForce RTX 3090', 24)]
    const merged = mergeGpus(two, [dev('GPU0', 'NVIDIA GeForce RTX 3090', 24), dev('GPU1', 'NVIDIA GeForce RTX 3090', 24)])
    expect(merged.map((g) => g.key)).toEqual([gpuKey('NVIDIA GeForce RTX 3090', 0), gpuKey('NVIDIA GeForce RTX 3090', 1)])
    expect(mergeGpus([], two)).toHaveLength(2)
  })
  it('treats "(R)" / "(TM)" and spacing differences as the same GPU', () => {
    expect(mergeGpus([dev('Vulkan0', 'Intel(R) UHD Graphics', 12)], [dev('X', 'Intel UHD  Graphics', 12)])).toHaveLength(1)
    expect(gpuKey('Intel(R) UHD Graphics', 0)).toBe(gpuKey('Intel UHD Graphics', 0))
  })
})

describe('usableGpus / isUnusedGpu (automatic)', () => {
  it('uses only discrete GPUs when there is one', () => {
    const gpus = mergeGpus(vulkan)
    expect(usableGpus(gpus).map((g) => g.id)).toEqual(['Vulkan1'])
    expect(gpus.filter((g) => isUnusedGpu(g, gpus)).map((g) => g.id)).toEqual(['Vulkan0'])
  })
  it('uses the integrated GPU when it is the only one', () => {
    const gpus = mergeGpus([dev('Vulkan0', 'AMD Radeon(TM) Graphics', 8)])
    expect(usableGpus(gpus).map((g) => g.id)).toEqual(['Vulkan0'])
    expect(isUnusedGpu(gpus[0], gpus)).toBe(false)
  })
})

describe('manual GPU selection', () => {
  const gpus = mergeGpus(vulkan, smi)
  it('uses only the selected GPU (even an integrated one)', () => {
    expect(usableGpus(gpus, UHD).map((g) => g.id)).toEqual(['Vulkan0'])
    expect(gpus.filter((g) => isUnusedGpu(g, gpus, UHD)).map((g) => g.id)).toEqual(['Vulkan1'])
  })
  it('falls back to automatic when the selected GPU is gone', () => {
    expect(usableGpus(gpus, gpuKey('NVIDIA GeForce RTX 4090', 0)).map((g) => g.id)).toEqual(['Vulkan1'])
  })
  it("maps the selection to each engine's own device numbering", () => {
    // llama.cpp Vulkan 版: Vulkan0 = Intel, Vulkan1 = RTX / CUDA 版: CUDA0 = RTX / sd.cpp: 同じく Vulkan の順
    expect(selectedIndex(vulkan, RTX)).toBe(1)
    expect(selectedIndex(cuda, RTX)).toBe(0)
    expect(selectedIndex(vulkan, UHD)).toBe(0)
    expect(selectedIndex(cuda, UHD)).toBeNull()
    expect(selectedIndex(vulkan, AUTO_GPU)).toBeNull()
  })
  it('parses sd-server --list-devices (names accepted by --backend, CPU excluded)', () => {
    const out = 'ggml_vulkan: Found 2 Vulkan devices:\nload_backend: loaded Vulkan backend\nVulkan0\tIntel(R) UHD Graphics\nVulkan1\tNVIDIA GeForce RTX 3060 Laptop GPU\nCPU\tIntel(R) Core(TM) i7-10875H CPU @ 2.30GHz\n'
    const list = parseSdDevices(out)
    expect(list).toEqual([
      { id: 'Vulkan0', name: 'Intel(R) UHD Graphics' },
      { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 3060 Laptop GPU' },
    ])
    expect(list[selectedIndex(list, RTX)!].id).toBe('Vulkan1')
  })
})

describe('judgeFit with an integrated GPU', () => {
  const sys: SystemInfo = { platform: 'win32', arch: 'x64', totalMemBytes: 24 * 1024 ** 3, freeMemBytes: 16 * 1024 ** 3, cpuCount: 16, cpuModel: 'x', gpus: mergeGpus(vulkan, smi), gpuSource: 'runtime' }
  // 約 8GB 必要なモデル: 内蔵 GPU の見かけの 11.9GB には収まるが、実際に使う RTX 3060 (6GB) には収まらない
  const est = estimateMemory({ format: 'gguf', totalSize: 7.5 * 1024 ** 3, header: null, hfMeta: null, paramsB: 13, contextSize: 2048 })
  it('judges by the discrete GPU, not the larger-looking shared memory of the integrated GPU', () => {
    expect(judgeFit(est, sys).level).not.toBe('gpu')
  })
  it('judges by the manually selected GPU', () => {
    expect(judgeFit(est, sys, usableGpus(sys.gpus, UHD)).level).toBe('gpu')
  })
  it('ignores the GPU when the engine for the format is a CPU build', () => {
    const small = estimateMemory({ format: 'gguf', totalSize: 1024 ** 3, header: null, hfMeta: null, paramsB: 1, contextSize: 2048 })
    expect(judgeFit(small, sys).level).toBe('gpu')
    expect(judgeFit(small, sys, []).level).toBe('cpu')
  })
})

describe('fitGpus', () => {
  const gpus = mergeGpus(vulkan)
  const ids = (list: GpuDevice[]) => list.map((g) => g.id)
  it('follows the installed build of each engine', () => {
    expect(fitGpus('gguf', { llama: { installed: true, backend: 'cpu' } }, gpus)).toEqual([])
    expect(ids(fitGpus('gguf', { llama: { installed: true, backend: 'vulkan' } }, gpus))).toEqual(['Vulkan1'])
    expect(fitGpus('diffusion', { sd: { installed: true, backend: 'cpu' } }, gpus)).toEqual([])
    expect(fitGpus('safetensors', { python: { installed: true, cuda: false } }, gpus)).toEqual([])
    expect(ids(fitGpus('safetensors', { python: { installed: true, cuda: true } }, gpus))).toEqual(['Vulkan1'])
  })
  it('assumes a GPU build for engines not installed yet (Transformers needs NVIDIA)', () => {
    expect(ids(fitGpus('gguf', {}, gpus))).toEqual(['Vulkan1'])
    expect(ids(fitGpus('safetensors', {}, gpus))).toEqual(['Vulkan1'])
    expect(fitGpus('safetensors', {}, mergeGpus([dev('Vulkan0', 'AMD Radeon RX 7600', 8)]))).toEqual([])
  })
  it('Transformers stays on the NVIDIA GPU when a non-NVIDIA GPU is selected', () => {
    expect(ids(fitGpus('gguf', {}, gpus, UHD))).toEqual(['Vulkan0'])
    expect(ids(fitGpus('safetensors', { python: { installed: true, cuda: true } }, gpus, UHD))).toEqual(['Vulkan1'])
  })
})
