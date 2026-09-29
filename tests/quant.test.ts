import { describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/i18n'
import {
  countSplitParts,
  groupGgufFiles,
  isDraftName,
  isForkOnlyQuantName,
  missingLayers,
  parseParamsB,
  parseQuantName,
  quantInfo,
  quantLabel,
  splitSuffix,
  standaloneBlock,
  stripSplitSuffix,
  UNKNOWN_QUANT,
} from '../src/shared/quant'

describe('language-neutral model names', () => {
  it('keeps names and unknown quant as data, and adds the localized text only for display', () => {
    const { entries } = groupGgufFiles([{ path: 'x/model-00001-of-00002.gguf', size: 1 }, { path: 'x/model-00002-of-00002.gguf', size: 1 }, { path: 'weird.gguf', size: 3 }])
    expect(entries.map((e) => [e.displayName, e.quant])).toEqual([
      ['weird', UNKNOWN_QUANT],
      ['model', UNKNOWN_QUANT],
    ])
    setLang('en')
    expect(splitSuffix(2)).toBe(' (2 parts)')
    expect(quantLabel(UNKNOWN_QUANT)).toBe('Unknown')
    setLang('ja')
    expect(splitSuffix(2)).toBe(' (2 分割)')
    expect(splitSuffix(1)).toBe('')
    expect(quantLabel('不明')).toBe('不明')
    expect(quantLabel('Q4_K_M')).toBe('Q4_K_M')
  })
  it('strips the split note that older versions saved into the display name', () => {
    expect(stripSplitSuffix('Qwen-F16 (3 分割)')).toBe('Qwen-F16')
    expect(stripSplitSuffix('Qwen-F16 (3 parts)')).toBe('Qwen-F16')
    expect(stripSplitSuffix('Qwen (preview)')).toBe('Qwen (preview)')
  })
})

describe('draft / partial models', () => {
  it('recognises speculative-decoding draft files by name', () => {
    expect(isDraftName('Qwen3.8-27B-Uncensored-draft-Q8_0')).toBe(true)
    expect(isDraftName('draft-Q4_0')).toBe(true)
    expect(isDraftName('Qwen3-1.7B-Q4_K_M')).toBe(false)
    expect(isDraftName('Draftsman-7B-Q4_K_M')).toBe(false)
    expect(groupGgufFiles([{ path: 'X-draft-Q8_0.gguf', size: 1 }, { path: 'X-Q8_0.gguf', size: 2 }]).entries.map((e) => [e.displayName, !!e.draft])).toEqual([
      ['X-Q8_0', false],
      ['X-draft-Q8_0', true],
    ])
  })
  it('detects files that hold only some of the layers (MTP draft: blk.64 out of 65)', () => {
    expect(missingLayers([64], 65)).toBe(64)
    expect(missingLayers([0, 1, 2], 3)).toBeUndefined()
    expect(missingLayers([], 65)).toBeUndefined()
    expect(missingLayers([0], undefined)).toBeUndefined()
    expect(standaloneBlock('anything', { missingLayers: 64, blockCount: 65 })).toMatch(/1 \/ 65/)
    expect(standaloneBlock('X-draft-Q8_0')).toMatch(/ドラフト/)
    expect(standaloneBlock('X-Q8_0')).toBeNull()
  })
  it('flags fork-only quantizations (PrismML Ternary Bonsai PTQ1_0 / PQ2_0, ggml type 143)', () => {
    expect(isForkOnlyQuantName('Huihui-Qwen3.8-27B-abliterated-Ternary-Bonsai-PTQ1_0')).toBe(true)
    expect(isForkOnlyQuantName('Huihui-Qwen3.8-27B-abliterated-Ternary-Bonsai-PQ2_0')).toBe(true)
    for (const n of ['X-Q4_K_M', 'X-IQ2_XXS', 'X-Q8_0', 'X-TQ1_0', 'X-Ternary-Bonsai-f16', 'X-UD-Q4_K_XL']) expect(isForkOnlyQuantName(n), n).toBe(false)
    expect(standaloneBlock('X-Q4_K_M', { unknownTensorType: 143 })).toMatch(/独自の量子化 \(ggml 型 143\)/)
    expect(standaloneBlock('X-Ternary-Bonsai-PTQ1_0')).toMatch(/フォーク版/)
  })
})

describe('parseQuantName', () => {
  it('extracts common quant names from file names', () => {
    expect(parseQuantName('qwen2.5-1.5b-instruct-q4_k_m.gguf')).toBe('Q4_K_M')
    expect(parseQuantName('SmolLM2-135M-Instruct-IQ3_M.gguf')).toBe('IQ3_M')
    expect(parseQuantName('Qwen3-30B-A3B-UD-Q4_K_XL.gguf')).toBe('Q4_K_XL')
    expect(parseQuantName('model-fp16.gguf')).toBe('F16')
    expect(parseQuantName('sub/dir/qwen2.5-7b-instruct-q8_0-00001-of-00002.gguf')).toBe('Q8_0')
    expect(parseQuantName('Llama-3.2-1B-Instruct-Q4_0_4_4.gguf')).toBe('Q4_0')
    expect(parseQuantName('gemma-3-4b-it-BF16.gguf')).toBe('BF16')
    expect(parseQuantName('random-model.gguf')).toBeNull()
  })
})

describe('quantInfo', () => {
  it('returns table entries and maps derived names to a base', () => {
    expect(quantInfo('Q4_K_M')?.bpw).toBeCloseTo(4.85)
    expect(quantInfo('Q4_K_M')!.rank).toBeLessThan(quantInfo('Q3_K_M')!.rank)
    const xl = quantInfo('Q4_K_XL')!
    expect(xl.label).toContain('XL')
    expect(xl.bpw).toBeGreaterThan(4.85)
    expect(quantInfo('Q7_Z')!.label).toBe('7bit')
    expect(quantInfo(null)).toBeNull()
  })
})

describe('parseParamsB', () => {
  it('parses billions / millions from names', () => {
    expect(parseParamsB('Qwen2.5-7B-Instruct')).toBe(7)
    expect(parseParamsB('Llama-3.2-1B-Instruct-Q4_K_M')).toBe(1)
    expect(parseParamsB('SmolLM2-135M-Instruct-Q4_K_M')).toBeCloseTo(0.135)
    expect(parseParamsB('Qwen3-30B-A3B-Instruct')).toBe(30)
    expect(parseParamsB('gemma-3-27b-it')).toBe(27)
    expect(parseParamsB('some-model-Q4_K_M')).toBeNull()
  })
})

describe('groupGgufFiles', () => {
  const files = [
    { path: 'README.md', size: 10 },
    { path: 'qwen2.5-7b-instruct-q4_k_m.gguf', size: 4_000 },
    { path: 'qwen2.5-7b-instruct-fp16-00001-of-00003.gguf', size: 5_000 },
    { path: 'qwen2.5-7b-instruct-fp16-00002-of-00003.gguf', size: 5_000 },
    { path: 'qwen2.5-7b-instruct-fp16-00003-of-00003.gguf', size: 4_000 },
    { path: 'qwen2.5-7b-instruct-q8_0-00001-of-00002.gguf', size: 3_000 }, // 2 つ目がない = 不完全
    { path: 'mmproj-model-f16.gguf', size: 500 },
  ]
  it('groups split files, drops incomplete splits, separates mmproj and sorts by size', () => {
    const { entries, mmproj } = groupGgufFiles(files, 'Qwen/Qwen2.5-7B-Instruct-GGUF')
    expect(entries.map((e) => e.quant)).toEqual(['F16', 'Q4_K_M'])
    const f16 = entries[0]
    expect(f16.isSplit).toBe(true)
    expect(f16.files).toHaveLength(3)
    expect(f16.files[0].path).toContain('00001-of-00003')
    expect(f16.totalSize).toBe(14_000)
    // 表示名は言語を含まない (サイドカーに保存し、推論サーバーのモデル名にも使うため)。分割の注記は表示時に付ける
    expect(f16.displayName).not.toMatch(/分割|parts/)
    expect(splitSuffix(f16.files.length)).toBe(' (3 分割)')
    expect(countSplitParts(f16.files.map((f) => f.path))).toBe(3)
    expect(f16.paramsB).toBe(7)
    expect(mmproj).toHaveLength(1)
    expect(mmproj[0].isMmproj).toBe(true)
  })
})
