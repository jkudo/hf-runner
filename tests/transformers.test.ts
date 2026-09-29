import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildTransformersEntry, selectTransformersFiles } from '../src/shared/quant'
import { bytesPerParam, headerFromConfig, parseHfConfig } from '../src/shared/config'
import { estimateMemory } from '../src/shared/fit'
import { uvAssetName } from '../src/main/python'
import { readSafetensorsHeader, readTransformersModel } from '../src/main/safetensors'

const GiB = 1024 ** 3
const ST_DIR = process.env.HFRUNNER_TEST_ST_DIR ?? '/tmp/claude-1000/-home-dev-hfrunner/735cfa91-64fa-4bcd-9506-1312a67b8e3d/scratchpad/models-st/HuggingFaceTB/SmolLM2-135M-Instruct'

// HuggingFaceTB/SmolLM2-135M-Instruct の実際のファイル一覧(サイズは適当)
const TREE = [
  '.gitattributes', 'README.md', 'all_results.json', 'config.json', 'eval_results.json', 'generation_config.json', 'merges.txt',
  'model.safetensors', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'train_results.json', 'trainer_state.json',
  'training_args.bin', 'vocab.json', 'onnx/model.onnx', 'runs/events.out.tfevents', 'original/consolidated.00.pth', 'model-q4.gguf',
].map((p) => ({ path: p, size: p.endsWith('.safetensors') ? 269_060_552 : 1000 }))

describe('selectTransformersFiles', () => {
  it('keeps weights, config and tokenizer files but drops training artifacts, sub-folders and other formats', () => {
    expect(selectTransformersFiles(TREE).map((f) => f.path).sort()).toEqual(
      ['config.json', 'generation_config.json', 'merges.txt', 'model.safetensors', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json'],
    )
  })
  it('builds a safetensors entry only when weights and config exist', () => {
    const entry = buildTransformersEntry(TREE, 'HuggingFaceTB/SmolLM2-135M-Instruct')
    expect(entry?.format).toBe('safetensors')
    expect(entry?.paramsB).toBeCloseTo(0.135)
    expect(entry?.isSplit).toBe(false)
    expect(entry?.totalSize).toBeGreaterThan(269_060_552)
    expect(buildTransformersEntry(TREE.filter((f) => !f.path.endsWith('.safetensors')), 'x/y')).toBeNull()
  })
})

describe('parseHfConfig / headerFromConfig', () => {
  const qwen = {
    architectures: ['Qwen2ForCausalLM'], hidden_size: 896, max_position_embeddings: 32768, model_type: 'qwen2', num_attention_heads: 14,
    num_hidden_layers: 24, num_key_value_heads: 2, tie_word_embeddings: true, torch_dtype: 'bfloat16', vocab_size: 151936,
  }
  it('extracts the fields needed for KV-cache estimation', () => {
    const cfg = parseHfConfig(qwen)
    expect(cfg.headDim).toBe(64)
    expect(cfg.numKeyValueHeads).toBe(2)
    expect(cfg.hasAutoMap).toBe(false)
    const h = headerFromConfig(cfg, 494_032_768, 'BF16')
    expect(h.format).toBe('safetensors')
    expect(h.blockCount).toBe(24)
    expect(h.contextLength).toBe(32768)
    expect(h.keyLength).toBe(64)
  })
  it('prefers text_config for multimodal models and detects auto_map', () => {
    const cfg = parseHfConfig({ model_type: 'gemma3', auto_map: { AutoModel: 'x' }, text_config: { num_hidden_layers: 34, num_attention_heads: 16, hidden_size: 2560, head_dim: 256 } })
    expect(cfg.numHiddenLayers).toBe(34)
    expect(cfg.headDim).toBe(256)
    expect(cfg.hasAutoMap).toBe(true)
  })
  it('maps dtypes to bytes', () => {
    expect(bytesPerParam('BF16')).toBe(2)
    expect(bytesPerParam('float32')).toBe(4)
    expect(bytesPerParam('F8_E4M3')).toBe(1)
  })
})

describe('estimateMemory (safetensors)', () => {
  const cfg = parseHfConfig({ model_type: 'llama', hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, vocab_size: 128256, max_position_embeddings: 131072, tie_word_embeddings: false })
  const params = 8.03e9
  const header = headerFromConfig(cfg, params, 'BF16')
  it('scales weights by precision', () => {
    const auto = estimateMemory({ format: 'safetensors', totalSize: 16 * GiB, header, paramCount: params, contextSize: 4096, precision: 'auto' })
    const q8 = estimateMemory({ format: 'safetensors', totalSize: 16 * GiB, header, paramCount: params, contextSize: 4096, precision: '8bit' })
    const q4 = estimateMemory({ format: 'safetensors', totalSize: 16 * GiB, header, paramCount: params, contextSize: 4096, precision: '4bit' })
    expect(auto.weightsBytes).toBeCloseTo(params * 2, -6)
    expect(q8.weightsBytes).toBeLessThan(auto.weightsBytes * 0.6)
    expect(q4.weightsBytes).toBeLessThan(q8.weightsBytes)
    expect(auto.kvCacheBytes).toBe(4096 * 32 * 8 * 256 * 2)
    expect(auto.approximate).toBe(false)
    expect(auto.overheadBytes).toBeGreaterThan(1 * GiB)
  })
})

describe('uvAssetName', () => {
  it('maps platforms to uv release archives', () => {
    expect(uvAssetName('win32', 'x64')).toBe('uv-x86_64-pc-windows-msvc.zip')
    expect(uvAssetName('linux', 'x64')).toBe('uv-x86_64-unknown-linux-gnu.tar.gz')
    expect(uvAssetName('darwin', 'arm64')).toBe('uv-aarch64-apple-darwin.tar.gz')
    expect(uvAssetName('sunos', 'x64')).toBeNull()
  })
})

describe('safetensors reader (local files)', () => {
  it.skipIf(!existsSync(ST_DIR))('reads the JSON header and sums tensor shapes', async () => {
    const h = await readSafetensorsHeader(`${ST_DIR}/model.safetensors`)
    expect(h.paramCount).toBe(134_515_008)
    expect(h.dtype).toBe('BF16')
    expect(h.tensorCount).toBe(272)
  })
  it.skipIf(!existsSync(ST_DIR))('combines config.json and weights into a header', async () => {
    const h = await readTransformersModel(ST_DIR)
    expect(h?.architecture).toBe('llama')
    expect(h?.blockCount).toBe(30)
    expect(h?.paramCount).toBe(134_515_008)
    expect(h?.hasChatTemplate).toBe(true)
  })
})
