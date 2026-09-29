import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fileSource, parseGgufHeader, remoteSource } from '../src/main/gguf'

const LOCAL =
  process.env.HFRUNNER_TEST_GGUF ??
  '/tmp/claude-1000/-home-dev-hfrunner/735cfa91-64fa-4bcd-9506-1312a67b8e3d/scratchpad/models/SmolLM2-135M-Instruct-Q4_K_M.gguf'

describe('parseGgufHeader (local file)', () => {
  it.skipIf(!existsSync(LOCAL))('reads architecture, hyper-params and counts parameters', async () => {
    const h = await parseGgufHeader(fileSource(LOCAL), { parseTensors: true })
    expect(h.architecture).toBe('llama')
    expect(h.blockCount).toBe(30)
    expect(h.headCountKv).toBeGreaterThan(0)
    expect(h.contextLength).toBe(8192)
    expect(h.fileTypeName).toBe('Q4_K_M')
    expect(h.paramCount).toBeGreaterThan(100e6)
    expect(h.paramCount).toBeLessThan(200e6)
    expect(h.hasChatTemplate).toBe(true)
    expect(h.truncated).toBe(false)
  })
})

describe('parseGgufHeader (remote via HTTP Range)', () => {
  it('reads the header without downloading the whole file', async () => {
    const url = 'https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf'
    const h = await parseGgufHeader(remoteSource(url), { stopAtTokenizer: true, parseTensors: false, maxBytes: 32 * 1024 * 1024 })
    expect(h.architecture).toBe('llama')
    expect(h.blockCount).toBe(30)
    expect(h.truncated).toBe(true)
  })
})
