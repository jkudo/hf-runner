import type { EngineId, ModelFormat, Precision, SdBackend, TorchBackend } from './types'
import { L } from './i18n'

// 表示用の文言は参照時の言語で返すため getter にしている (モジュール読み込み時に L() を呼ぶと言語が固定される)

export const ENGINE_LABEL: Record<EngineId, string> = {
  llamacpp: 'llama.cpp',
  transformers: 'Transformers (Python)',
  sdcpp: 'stable-diffusion.cpp',
}

export const FORMAT_LABEL: Record<ModelFormat, string> = {
  gguf: 'GGUF',
  safetensors: 'safetensors',
  get diffusion() {
    return L('画像生成', 'Image generation')
  },
}

export function engineForFormat(format: ModelFormat): EngineId {
  if (format === 'gguf') return 'llamacpp'
  if (format === 'diffusion') return 'sdcpp'
  return 'transformers'
}

export const PRECISIONS: Array<{ id: Precision; label: string; note: string }> = [
  {
    id: 'auto',
    label: '16bit (bf16/fp16)',
    get note() {
      return L('元の精度。品質最優先', 'Original precision. Best quality')
    },
  },
  {
    id: '8bit',
    label: '8bit (bitsandbytes)',
    get note() {
      return L('メモリ約半分。NVIDIA GPU が必要', 'About half the memory. Requires an NVIDIA GPU')
    },
  },
  {
    id: '4bit',
    label: '4bit NF4 (bitsandbytes)',
    get note() {
      return L('メモリ約 1/4。NVIDIA GPU が必要。品質わずかに低下', 'About 1/4 the memory. Requires an NVIDIA GPU. Slight quality loss')
    },
  },
]

export const TORCH_BACKENDS: Array<{ id: TorchBackend; label: string; description: string; platforms: string[] }> = [
  {
    id: 'auto',
    get label() {
      return L('自動 (推奨)', 'Automatic (recommended)')
    },
    get description() {
      return L(
        'NVIDIA ドライバーを検出して合う CUDA 版 PyTorch を選びます。GPU が無ければ CPU 版',
        'Detects the NVIDIA driver and picks a matching CUDA build of PyTorch. Uses the CPU build if there is no GPU',
      )
    },
    platforms: ['win32', 'linux', 'darwin'],
  },
  {
    id: 'cpu',
    get label() {
      return L('CPU のみ', 'CPU only')
    },
    get description() {
      return L('GPU を使いません。約 300MB。大きなモデルは非常に低速', "Doesn't use the GPU. About 300MB. Very slow for large models")
    },
    platforms: ['win32', 'linux', 'darwin'],
  },
  {
    id: 'cu128',
    label: 'CUDA 12.8',
    get description() {
      return L('NVIDIA ドライバー 570 以降。約 3GB', 'NVIDIA driver 570 or later. About 3GB')
    },
    platforms: ['win32', 'linux'],
  },
  {
    id: 'cu126',
    label: 'CUDA 12.6',
    get description() {
      return L('NVIDIA ドライバー 560 以降。約 3GB', 'NVIDIA driver 560 or later. About 3GB')
    },
    platforms: ['win32', 'linux'],
  },
  {
    id: 'cu130',
    label: 'CUDA 13.0',
    get description() {
      return L('NVIDIA ドライバー 580 以降。約 3GB', 'NVIDIA driver 580 or later. About 3GB')
    },
    platforms: ['win32', 'linux'],
  },
]

export const SD_BACKEND_LABELS: Record<SdBackend, { label: string; description: string }> = {
  cpu: {
    get label() {
      return L('CPU のみ', 'CPU only')
    },
    get description() {
      return L('GPU を使いません。どの PC でも動きますが非常に低速 (512px で数分)', "Doesn't use the GPU. Works on any PC but is very slow (several minutes at 512px)")
    },
  },
  vulkan: {
    get label() {
      return L('Vulkan (GPU 汎用)', 'Vulkan (any GPU)')
    },
    get description() {
      return L('NVIDIA / AMD / Intel の GPU で動作します。まずはこれを推奨。約 30MB', 'Works with NVIDIA / AMD / Intel GPUs. Recommended to start with. About 30MB')
    },
  },
  cuda12: {
    label: 'CUDA 12 (NVIDIA)',
    get description() {
      return L('NVIDIA GPU 専用で最速。CUDA ランタイム込みで約 900MB', 'NVIDIA GPUs only; the fastest. About 900MB including the CUDA runtime')
    },
  },
  rocm: {
    label: 'ROCm (AMD)',
    get description() {
      return L('AMD GPU 専用。約 200MB', 'AMD GPUs only. About 200MB')
    },
  },
}

/** 画像サイズのプリセット (8 の倍数、SD1.5 は 512、SDXL は 1024 が基準) */
export const IMAGE_SIZE_PRESETS: Array<{ label: string; width: number; height: number }> = [
  { label: '512 × 512', width: 512, height: 512 },
  {
    get label() {
      return L('512 × 768 (縦)', '512 × 768 (portrait)')
    },
    width: 512,
    height: 768,
  },
  {
    get label() {
      return L('768 × 512 (横)', '768 × 512 (landscape)')
    },
    width: 768,
    height: 512,
  },
  { label: '768 × 768', width: 768, height: 768 },
  { label: '1024 × 1024', width: 1024, height: 1024 },
  {
    get label() {
      return L('832 × 1216 (縦)', '832 × 1216 (portrait)')
    },
    width: 832,
    height: 1216,
  },
  {
    get label() {
      return L('1216 × 832 (横)', '1216 × 832 (landscape)')
    },
    width: 1216,
    height: 832,
  },
]
