import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backendOptions, discreteDevices, gpuLayersArg, parseDevices, pickBinaryRelease, recommendedBackend, RuntimeManager, selectAssets, type Release } from '../src/main/runtime'

const names = [
  'cudart-llama-b11218-bin-ubuntu-cuda-12.8-x64.tar.gz', 'cudart-llama-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-arm64.zip',
  'cudart-llama-bin-win-cuda-13.4-x64.zip', 'llama-b11218-bin-macos-arm64.tar.gz', 'llama-b11218-bin-macos-x64.tar.gz',
  'llama-b11218-bin-ubuntu-arm64.tar.gz', 'llama-b11218-bin-ubuntu-cuda-12.8-x64.tar.gz', 'llama-b11218-bin-ubuntu-vulkan-x64.tar.gz',
  'llama-b11218-bin-ubuntu-x64.tar.gz', 'llama-b11218-bin-win-cpu-arm64.zip', 'llama-b11218-bin-win-cpu-x64.zip',
  'llama-b11218-bin-win-cuda-12.4-x64.zip', 'llama-b11218-bin-win-cuda-13.4-arm64.zip', 'llama-b11218-bin-win-cuda-13.4-x64.zip',
  'llama-b11218-bin-win-rocm-10.0-x64.zip', 'llama-b11218-bin-win-sycl-x64.zip', 'llama-b11218-bin-win-vulkan-x64.zip', 'llama-b11218-ui.tar.gz',
]
const release: Release = {
  tag_name: 'b11218', prerelease: true, published_at: '',
  assets: names.map((n) => ({ name: n, browser_download_url: `https://example.com/${n}`, size: 1 })),
}

describe('selectAssets', () => {
  it('picks the Windows Vulkan zip', () => {
    expect(selectAssets(release, 'vulkan', 'win32', 'x64').map((a) => a.name)).toEqual(['llama-b11218-bin-win-vulkan-x64.zip'])
  })
  it('adds the cudart archive for CUDA builds', () => {
    expect(selectAssets(release, 'cuda12', 'win32', 'x64').map((a) => a.name)).toEqual(['llama-b11218-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip'])
    expect(selectAssets(release, 'cuda12', 'linux', 'x64').map((a) => a.name)).toEqual(['llama-b11218-bin-ubuntu-cuda-12.8-x64.tar.gz', 'cudart-llama-b11218-bin-ubuntu-cuda-12.8-x64.tar.gz'])
  })
  it('handles Linux / macOS', () => {
    expect(selectAssets(release, 'cpu', 'linux', 'x64')[0].name).toBe('llama-b11218-bin-ubuntu-x64.tar.gz')
    expect(selectAssets(release, 'metal', 'darwin', 'arm64')[0].name).toBe('llama-b11218-bin-macos-arm64.tar.gz')
  })
  it('rejects unsupported combinations', () => {
    expect(() => selectAssets(release, 'metal', 'win32', 'x64')).toThrow()
    expect(() => selectAssets(release, 'vulkan', 'win32', 'arm64')).toThrow()
  })
})

describe('release / backend helpers', () => {
  it('skips version tags without binaries', () => {
    const list: Release[] = [{ tag_name: 'v0.5.0', prerelease: false, published_at: '', assets: [] }, release]
    expect(pickBinaryRelease(list)?.tag_name).toBe('b11218')
  })
  it('skips a release whose assets are still being uploaded when a backend is requested', () => {
    // 公開直後のリリースは cudart だけ先に上がっていて本体 zip が無いことがある
    const partial: Release = {
      tag_name: 'b11229', prerelease: true, published_at: '',
      assets: ['cudart-llama-bin-win-cuda-13.4-x64.zip', 'llama-b11229-bin-macos-arm64.tar.gz'].map((n) => ({ name: n, browser_download_url: '', size: 1 })),
    }
    const list = [partial, release]
    expect(pickBinaryRelease(list)?.tag_name).toBe('b11229')
    expect(pickBinaryRelease(list, 'cuda13', 'win32', 'x64')?.tag_name).toBe('b11218')
    expect(pickBinaryRelease(list, 'metal', 'darwin', 'arm64')?.tag_name).toBe('b11229')
    expect(pickBinaryRelease([partial], 'vulkan', 'win32', 'x64')).toBeNull()
  })
  it('recommends Vulkan on Windows x64 and lists it first-class', () => {
    expect(recommendedBackend('win32', 'x64')).toBe('vulkan')
    expect(backendOptions('win32', 'x64').map((b) => b.id)).toEqual(['cpu', 'vulkan', 'cuda12', 'cuda13'])
    expect(backendOptions('win32', 'x64').find((b) => b.recommended)?.id).toBe('vulkan')
  })
})

describe('RuntimeManager.getInfo', () => {
  const dirs: string[] = []
  const makeRoot = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hfrunner-rt-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('resolves the server from the relative path so a moved folder still works', async () => {
    const root = makeRoot()
    const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    fs.mkdirSync(path.join(root, 'cpu-b11218'))
    fs.writeFileSync(path.join(root, 'cpu-b11218', exe), '')
    fs.writeFileSync(
      path.join(root, 'current.json'),
      JSON.stringify({ installed: true, backend: 'cpu', tag: 'b11218', serverPath: path.join('C:', 'old-location', exe), dir: 'C:\\old-location', serverRel: path.join('cpu-b11218', exe) }),
    )
    const info = await new RuntimeManager(root).getInfo()
    expect(info.installed).toBe(true)
    expect(info.serverPath).toBe(path.join(root, 'cpu-b11218', exe))
    expect(info.dir).toBe(path.join(root, 'cpu-b11218'))
    expect(info).not.toHaveProperty('serverRel')
  })

  it('reports not installed when the binary is missing', async () => {
    const root = makeRoot()
    fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ installed: true, serverRel: 'cpu-b11218/llama-server.exe' }))
    expect((await new RuntimeManager(root).getInfo()).installed).toBe(false)
    expect((await new RuntimeManager(path.join(root, 'nope')).getInfo()).installed).toBe(false)
  })
})

describe('parseDevices', () => {
  it('parses llama-server --list-devices output', () => {
    const out = `0.00.000.510 I srv  llama_server: initializing ...\nAvailable devices:\n  Vulkan0: NVIDIA GeForce RTX 4070 (12282 MiB, 11000 MiB free)\n  Vulkan1: Intel(R) UHD Graphics 770 (16000 MiB, 15000 MiB free)\n`
    expect(parseDevices(out)).toEqual([
      { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 4070', totalMiB: 12282, freeMiB: 11000 },
      { id: 'Vulkan1', name: 'Intel(R) UHD Graphics 770', totalMiB: 16000, freeMiB: 15000 },
    ])
    expect(parseDevices('Available devices:\n  (none)\n')).toEqual([])
  })
})

describe('GPU selection', () => {
  const dev = (id: string, name: string) => ({ id, name, totalMiB: 1, freeMiB: 1 })
  it('uses only the discrete GPU when an integrated one is also present (laptop: Intel UHD + RTX)', () => {
    expect(discreteDevices([dev('Vulkan0', 'Intel(R) UHD Graphics'), dev('Vulkan1', 'NVIDIA GeForce RTX 3060 Laptop GPU')])).toEqual(['Vulkan1'])
    expect(discreteDevices([dev('Vulkan0', 'AMD Radeon(TM) Graphics'), dev('Vulkan1', 'AMD Radeon RX 7600')])).toEqual(['Vulkan1'])
  })
  it('leaves the choice to llama.cpp when there is only one kind', () => {
    expect(discreteDevices([dev('CUDA0', 'NVIDIA GeForce RTX 3060 Laptop GPU')])).toBeNull()
    expect(discreteDevices([dev('Vulkan0', 'Intel(R) Iris(R) Xe Graphics')])).toBeNull()
    expect(discreteDevices([dev('Vulkan0', 'Intel(R) Arc(TM) A770 Graphics'), dev('Vulkan1', 'NVIDIA GeForce RTX 4090')])).toBeNull()
    expect(discreteDevices([])).toBeNull()
  })
  it('passes "auto" for the automatic layer setting so llama.cpp can fit the model into free memory', () => {
    expect(gpuLayersArg(99, 'b11242')).toBe('auto')
    expect(gpuLayersArg(24, 'b11242')).toBe('24')
    expect(gpuLayersArg(0, 'b11242')).toBe('0')
    expect(gpuLayersArg(99, 'b6500')).toBe('99')
    expect(gpuLayersArg(99)).toBe('auto')
  })
})
