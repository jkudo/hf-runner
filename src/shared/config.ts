import type { HFModelConfig, ModelHeaderInfo } from './types'

type Raw = Record<string, unknown>

/** Hugging Face の config.json からメモリ見積もりに必要な値を取り出す */
export function parseHfConfig(raw: Raw): HFModelConfig {
  // マルチモーダルモデルは text_config 側にテキストモデルの設定が入っている
  const text = raw.text_config && typeof raw.text_config === 'object' ? (raw.text_config as Raw) : null
  const num = (k: string): number | undefined => {
    const v = text?.[k] ?? raw[k]
    return typeof v === 'number' ? v : undefined
  }
  const str = (k: string): string | undefined => {
    const v = text?.[k] ?? raw[k]
    return typeof v === 'string' ? v : undefined
  }
  const heads = num('num_attention_heads') ?? num('n_head')
  const hidden = num('hidden_size') ?? num('n_embd')
  return {
    modelType: str('model_type'),
    architectures: Array.isArray(raw.architectures) ? raw.architectures.filter((s): s is string => typeof s === 'string') : [],
    numHiddenLayers: num('num_hidden_layers') ?? num('n_layer') ?? num('num_layers'),
    numAttentionHeads: heads,
    numKeyValueHeads: num('num_key_value_heads') ?? heads,
    hiddenSize: hidden,
    headDim: num('head_dim') ?? (heads && hidden ? hidden / heads : undefined),
    maxPositionEmbeddings: num('max_position_embeddings') ?? num('n_positions'),
    vocabSize: num('vocab_size'),
    torchDtype: str('torch_dtype') ?? str('dtype'),
    hasAutoMap: !!raw.auto_map,
    tieWordEmbeddings: raw.tie_word_embeddings !== false,
    numExperts: num('num_experts') ?? num('num_local_experts') ?? num('n_routed_experts'),
    hasVision: !!raw.vision_config && typeof raw.vision_config === 'object',
  }
}

/** config.json の情報を GGUF ヘッダと同じ形にそろえる(メモリ見積もりを共通化するため) */
export function headerFromConfig(cfg: HFModelConfig, paramCount?: number, dtype?: string): ModelHeaderInfo {
  return {
    format: 'safetensors',
    version: 0,
    tensorCount: 0,
    kvCount: 0,
    architecture: cfg.modelType,
    name: cfg.architectures[0],
    paramCount,
    contextLength: cfg.maxPositionEmbeddings,
    blockCount: cfg.numHiddenLayers,
    embeddingLength: cfg.hiddenSize,
    headCount: cfg.numAttentionHeads,
    headCountKv: cfg.numKeyValueHeads,
    keyLength: cfg.headDim,
    valueLength: cfg.headDim,
    vocabSize: cfg.vocabSize,
    expertCount: cfg.numExperts,
    hasChatTemplate: false,
    metadata: {},
    truncated: false,
    dtype: dtype ?? cfg.torchDtype,
    hasAutoMap: cfg.hasAutoMap,
    tieWordEmbeddings: cfg.tieWordEmbeddings,
    hasVision: cfg.hasVision,
  }
}

/** "BF16" / "bfloat16" / "F32" などを 1 パラメータあたりのバイト数に */
export function bytesPerParam(dtype: string | undefined): number {
  const d = (dtype ?? '').toUpperCase()
  if (/F32|FLOAT32/.test(d)) return 4
  if (/F8|FP8|E4M3|E5M2|I8|INT8|U8/.test(d)) return 1
  if (/F64/.test(d)) return 8
  return 2
}
