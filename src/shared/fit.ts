import type { FitResult, GpuDevice, HFGgufMeta, MemoryEstimate, ModelFormat, ModelHeaderInfo, Precision, SystemInfo } from './types'
import { bytesPerParam } from './config'
import { formatBytes } from './format'
import { L } from './i18n'
import { usableGpus } from './gpu'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

export interface EstimateInput {
  format?: ModelFormat
  /** ダウンロードサイズ(GGUF ではそのまま重みのメモリ量) */
  totalSize: number
  header?: ModelHeaderInfo | null
  hfMeta?: HFGgufMeta | null
  paramsB?: number | null
  paramCount?: number | null
  contextSize: number
  /** Transformers の読み込み精度 */
  precision?: Precision
}

function resolveParamCount(input: EstimateInput): number | null {
  if (input.header?.paramCount) return input.header.paramCount
  if (input.paramCount) return input.paramCount
  if (input.hfMeta?.total) return input.hfMeta.total
  if (input.paramsB) return input.paramsB * 1e9
  return null
}

/** Transformers で読み込んだときの重みのメモリ量 */
function transformersWeightBytes(input: EstimateInput, params: number): number {
  const precision = input.precision ?? 'auto'
  const h = input.header
  // bitsandbytes は埋め込み / 出力層を量子化しないので分けて数える
  const embed = h?.vocabSize && h.embeddingLength ? h.vocabSize * h.embeddingLength * (h.tieWordEmbeddings === false ? 2 : 1) : 0
  const body = Math.max(params - embed, 0)
  const stored = Math.min(bytesPerParam(h?.dtype), 2) // fp32 で保存されていても bf16 で読み込む
  switch (precision) {
    case '8bit':
      return embed * stored + body * 1.05
    case '4bit':
      return embed * stored + body * 0.56
    default:
      return params * stored
  }
}

/** モデル実行に必要なメモリ量(重み + KV キャッシュ + 作業領域)を見積もる */
export function estimateMemory(input: EstimateInput): MemoryEstimate {
  const { totalSize, header, hfMeta } = input
  const format = input.format ?? header?.format ?? 'gguf'
  if (format === 'diffusion') {
    // 画像生成: KV キャッシュは無く、重み + 潜在空間の作業領域 (512〜1024px で 1〜2GB 程度) が要る
    const overheadBytes = 1.5 * GiB + totalSize * 0.1
    return { weightsBytes: totalSize, kvCacheBytes: 0, overheadBytes, totalBytes: totalSize + overheadBytes, contextSize: 0, approximate: true }
  }
  const maxCtx = header?.contextLength ?? hfMeta?.context_length
  const contextSize = maxCtx ? Math.min(input.contextSize, maxCtx) : input.contextSize
  const params = resolveParamCount(input)

  let weightsBytes: number
  if (format === 'safetensors') {
    weightsBytes = transformersWeightBytes(input, params ?? totalSize / 2)
  } else {
    weightsBytes = totalSize
  }

  let kvPerToken: number | null = null
  if (header?.blockCount && header.headCountKv) {
    const headDim =
      header.keyLength ?? (header.embeddingLength && header.headCount ? header.embeddingLength / header.headCount : null)
    if (headDim) {
      const kLen = header.keyLength ?? headDim
      const vLen = header.valueLength ?? headDim
      // K/V それぞれ f16 (2 bytes) で保持する前提
      kvPerToken = header.blockCount * header.headCountKv * (kLen + vLen) * 2
    }
  }

  let approximate = false
  if (kvPerToken === null) {
    approximate = true
    const paramsB = (params ?? totalSize / 0.6) / 1e9 // 約 4.8bpw を仮定
    // 8B クラスで 128KB/token 程度、モデルサイズに対しておよそ 0.6 乗で増えると仮定
    kvPerToken = Math.min(640 * 1024, Math.max(8 * 1024, 128 * 1024 * Math.pow(Math.max(paramsB, 0.05) / 8, 0.6)))
  }

  const kvCacheBytes = contextSize * kvPerToken
  // Transformers は CUDA コンテキストや活性化のぶん llama.cpp より余裕が要る
  const overheadBytes = format === 'safetensors' ? 1 * GiB + weightsBytes * 0.1 : 256 * MiB + weightsBytes * 0.06
  return {
    weightsBytes,
    kvCacheBytes,
    overheadBytes,
    totalBytes: weightsBytes + kvCacheBytes + overheadBytes,
    contextSize,
    approximate: approximate || (format === 'safetensors' && !params),
    precision: format === 'safetensors' ? (input.precision ?? 'auto') : undefined,
  }
}

/**
 * システムのメモリ状況に対して、そのモデルがどのように動かせるかを判定する。
 * gpus はそのモデルを動かすエンジンが使う GPU (fitGpus。CPU 版なら空)。省略時は自動で選ぶ GPU (外付けがあれば外付けだけ)。
 * VRAM はその中で最大のもの
 */
export function judgeFit(estimate: MemoryEstimate, sys: SystemInfo | null, gpus?: GpuDevice[]): FitResult {
  if (!sys) {
    return { level: 'unknown', label: L('判定中…', 'Checking…'), detail: '', estimate }
  }
  const need = estimate.totalBytes
  const ram = sys.totalMemBytes
  const vram = (gpus ?? usableGpus(sys.gpus)).reduce((max, g) => Math.max(max, g.totalMiB * MiB), 0)
  const ramOk = need <= ram * 0.85
  const approx = estimate.approximate ? L('(概算)', ' (estimate)') : ''
  const needStr = L(`必要メモリ 約 ${formatBytes(need)}${approx}`, `Needs about ${formatBytes(need)}${approx}`)

  if (vram > 0 && need <= vram * 0.92) {
    return { level: 'gpu', label: L('GPU に全て載せて実行できます', 'Fits entirely on the GPU'), detail: `${needStr} / VRAM ${formatBytes(vram)}`, estimate }
  }
  if (vram > 0 && ramOk && estimate.weightsBytes * 0.4 + estimate.kvCacheBytes <= vram) {
    return {
      level: 'gpu-partial',
      label: L('一部を GPU に載せて実行(中速)', 'Partly on the GPU (medium speed)'),
      detail: `${needStr} / VRAM ${formatBytes(vram)} + RAM ${formatBytes(ram)}`,
      estimate,
    }
  }
  if (ramOk) {
    return {
      level: 'cpu',
      label: vram > 0 ? L('主に CPU/RAM で実行(低速)', 'Mostly on the CPU/RAM (slow)') : L('RAM に収まります', 'Fits in RAM'),
      detail: `${needStr} / RAM ${formatBytes(ram)}`,
      estimate,
    }
  }
  return {
    level: 'no',
    label: L('メモリ不足の可能性が高い', 'Likely not enough memory'),
    detail: `${needStr} / RAM ${formatBytes(ram)}${vram ? ` / VRAM ${formatBytes(vram)}` : ''}`,
    estimate,
  }
}

export { GiB, MiB }
