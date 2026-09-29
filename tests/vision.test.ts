import { describe, expect, it } from 'vitest'
import { headerFromConfig, parseHfConfig } from '../src/shared/config'
import { groupGgufFiles } from '../src/shared/quant'

describe('vision detection', () => {
  it('flags config.json with vision_config as an image-input model', () => {
    const vl = parseHfConfig({
      model_type: 'qwen2_vl',
      architectures: ['Qwen2VLForConditionalGeneration'],
      vision_config: { depth: 32, hidden_size: 1280 },
      text_config: { num_hidden_layers: 28, hidden_size: 3584, num_attention_heads: 28, num_key_value_heads: 4 },
    })
    expect(vl.hasVision).toBe(true)
    expect(vl.numHiddenLayers).toBe(28)
    expect(headerFromConfig(vl).hasVision).toBe(true)

    const text = parseHfConfig({ model_type: 'qwen3', architectures: ['Qwen3ForCausalLM'], num_hidden_layers: 28 })
    expect(text.hasVision).toBe(false)
    expect(parseHfConfig({ vision_config: null }).hasVision).toBe(false)
  })

  it('separates mmproj files from model entries', () => {
    const { entries, mmproj } = groupGgufFiles([
      { path: 'gemma-3-4b-it-Q4_K_M.gguf', size: 2_500_000_000 },
      { path: 'mmproj-F16.gguf', size: 850_000_000 },
      { path: 'mmproj-BF16.gguf', size: 850_000_001 },
    ])
    expect(entries.map((e) => e.displayName)).toEqual(['gemma-3-4b-it-Q4_K_M'])
    expect(mmproj.map((m) => m.displayName).sort()).toEqual(['mmproj-BF16', 'mmproj-F16'])
    expect(mmproj.every((m) => m.isMmproj)).toBe(true)
  })
})
