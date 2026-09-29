// 拡散モデル (画像生成) の判定と、系統ごとに必要な部品 (VAE / テキストエンコーダー) のカタログ。
// llama.cpp / Transformers ではなく stable-diffusion.cpp で扱う
// 表示用の文言 (ラベル・注記・ライセンスの制限) は参照時の言語で返すため getter にしている

import { L } from './i18n'

/** GGUF の general.architecture に入る拡散モデル系の名前 (ComfyUI-GGUF の変換で使われるもの) */
const ARCH_FAMILY: Record<string, string> = {
  sd1: 'sd1',
  sd2: 'sd2',
  sdxl: 'sdxl',
  sd3: 'sd3',
  flux: 'flux',
  flux2: 'flux2',
  chroma: 'flux',
  qwen_image: 'qwen_image',
  'qwen-image': 'qwen_image',
  qwen_image21: 'qwen_image_2.1',
  qwen_image_21: 'qwen_image_2.1',
  'qwen_image_2.1': 'qwen_image_2.1',
  'qwen-image-2.1': 'qwen_image_2.1',
  hyvid: 'hunyuan_video',
  hunyuan_video: 'hunyuan_video',
  wan: 'wan',
  wan2: 'wan',
  ltxv: 'ltx',
  ltx: 'ltx',
  lumina2: 'dit',
  hidream: 'dit',
  cosmos: 'dit',
  z_image: 'dit',
  pixart: 'dit',
  aura: 'dit',
  auraflow: 'dit',
}

/** 1 ファイルで完結する (テキストエンコーダーと VAE を含む) 系統。それ以外は部品が別に要る */
const SINGLE_FILE_FAMILIES = new Set(['sd1', 'sd2', 'sdxl'])

/** アーキテクチャ名だけでは 1 ファイル完結か判断できない (テンソル名まで読む必要がある) 系統か */
export const needsTensorCheck = (family: string) => SINGLE_FILE_FAMILIES.has(family)

export interface DiffusionInfo {
  /** 系統 (sd1 / sdxl / unet / flux / qwen_image / qwen_image_2.1 / qwen_image_2.1_pe_t2i / sd3 / dit …) */
  family: string
  /** 1 ファイルで実行できるか (false = テキストエンコーダー・VAE を別に用意する必要がある) */
  singleFile: boolean
  /** stable-diffusion.cpp で読めない形式のとき、その理由 (MLX 用の U32 パック、NVFP4 の U8 など) */
  unsupported?: string
}

/** stable-diffusion.cpp の safetensors ローダーが読める dtype (src/model_io/safetensors_io.cpp) */
const SDCPP_DTYPES = new Set(['F16', 'BF16', 'F32', 'F64', 'F8_E4M3', 'F8_E5M2', 'I8', 'I32', 'I64'])

/**
 * safetensors のテンソルが stable-diffusion.cpp で読めない dtype なら true。
 * ComfyUI の量子化メタデータ (.comfy_quant, U8) と活性化スケール (.scale_input) はローダーが読み飛ばすので対象外
 */
export function isUnsupportedSdcppTensor(key: string, dtype: string | undefined): boolean {
  if (!dtype || key.endsWith('.comfy_quant') || key.endsWith('.scale_input')) return false
  return !SDCPP_DTYPES.has(dtype)
}

/** 読めない dtype の説明。ファイル名から MLX / NVFP4 といった形式名を補う */
export function describeUnsupportedDtype(fileName: string, dtype: string): string {
  const kind = /mlx/i.test(fileName)
    ? L('Apple MLX 用の量子化', 'Apple MLX quantization')
    : /nvfp4|fp4/i.test(fileName)
      ? L('NVFP4 (TensorRT 用)', 'NVFP4 (for TensorRT)')
      : dtype === 'U32'
        ? L('パックされた量子化', 'Packed quantization')
        : `dtype ${dtype}`
  return L(`${kind} (${dtype}) は stable-diffusion.cpp では読めません`, `${kind} (${dtype}) can't be loaded by stable-diffusion.cpp`)
}

/**
 * GGUF のアーキテクチャ名とテンソル名 (完全名でも、先頭 3 階層のプレフィックスでも可) から拡散モデルかどうかを判定する。
 * UNet は model.diffusion_model.input_blocks、FLUX は double_blocks、Qwen-Image は transformer_blocks + time_text_embed で始まる
 */
export function detectDiffusion(arch: string | undefined, tensorNames: string[] = []): DiffusionInfo | null {
  const a = (arch ?? '').toLowerCase()
  const byArch = ARCH_FAMILY[a]
  if (byArch) {
    const byKeys = detectDiffusionByKeys(tensorNames)
    // テンソル名の方が細かく分かる場合 (arch=qwen_image でも中身が 2.1 など) はそちらを採る
    const family = byKeys && byKeys.family.startsWith(`${byArch}_`) ? byKeys.family : byArch
    // sd1 / sdxl でもテンソル名が分かっていればそれで判断する (ComfyUI-GGUF の変換は UNet 単体でもこの名前を書く)
    const singleFile = byKeys ? byKeys.singleFile : SINGLE_FILE_FAMILIES.has(byArch)
    return { family, singleFile }
  }
  return detectDiffusionByKeys(tensorNames)
}

/** safetensors のキー / GGUF のテンソル名だけから判定する (アーキテクチャ名が無い場合)。key はプレフィックスでも完全名でもよい */
export function detectDiffusionByKeys(keys: string[]): DiffusionInfo | null {
  const has = (prefix: string) => keys.some((k) => k === prefix || k.startsWith(`${prefix}.`))
  const anyOf = (...prefixes: string[]) => prefixes.some(has)
  // 拡散モデル本体の場所: 全部入りチェックポイントは model.diffusion_model.*、本体だけのファイルはルート直下
  const under = (name: string) => anyOf(name, `model.diffusion_model.${name}`, `diffusion_model.${name}`)

  let family: string | null = null
  if (under('double_blocks') || under('single_blocks')) family = 'flux'
  else if (under('joint_blocks')) family = 'sd3'
  else if (under('transformer_blocks') && under('modulation')) family = 'qwen_image_2.1'
  else if (under('transformer_blocks') && under('time_text_embed')) family = 'qwen_image'
  else if (under('input_blocks') || under('output_blocks')) family = 'unet'
  else if (under('transformer_blocks')) family = 'dit'
  else if (anyOf('model.diffusion_model', 'diffusion_model')) family = 'unet'
  if (!family) return null

  // 全部入り: VAE とテキストエンコーダーが同居している
  const hasVae = anyOf('first_stage_model', 'vae')
  const hasTextEncoder = anyOf('cond_stage_model', 'conditioner', 'text_encoders')
  const singleFile = hasVae && hasTextEncoder && anyOf('model.diffusion_model', 'diffusion_model')
  return { family, singleFile }
}

/** ファイル名でしか区別できない派生 (Qwen-Image 2.1 の PE-T2I / PE-I2I は専用のテキストエンコーダーを使う) */
export function refineFamilyByName(info: DiffusionInfo | null, fileName: string): DiffusionInfo | null {
  if (!info) return null
  if (info.family === 'qwen_image_2.1') {
    if (/pe[-_]i2i/i.test(fileName)) return { ...info, family: 'qwen_image_2.1_pe_i2i' }
    if (/pe[-_]t2i/i.test(fileName)) return { ...info, family: 'qwen_image_2.1_pe_t2i' }
  }
  return info
}

/** HF の pipeline が画像生成系か */
export function isImageGenPipeline(pipelineTag: string | undefined): boolean {
  return pipelineTag === 'text-to-image' || pipelineTag === 'image-to-image'
}

export const DIFFUSION_FAMILY_LABEL: Record<string, string> = {
  sd1: 'Stable Diffusion 1.x',
  sd2: 'Stable Diffusion 2.x',
  sdxl: 'SDXL',
  sd3: 'Stable Diffusion 3',
  flux: 'FLUX.1',
  flux2: 'FLUX.2',
  qwen_image: 'Qwen-Image',
  'qwen_image_2.1': 'Qwen-Image 2.1',
  'qwen_image_2.1_pe_t2i': 'Qwen-Image 2.1 PE-T2I',
  get 'qwen_image_2.1_pe_i2i'() {
    return L('Qwen-Image 2.1 PE-I2I (画像編集)', 'Qwen-Image 2.1 PE-I2I (image editing)')
  },
  unet: 'Stable Diffusion (UNet)',
  get dit() {
    return L('DiT 系', 'DiT family')
  },
  get hunyuan_video() {
    return L('HunyuanVideo (動画)', 'HunyuanVideo (video)')
  },
  get wan() {
    return L('Wan (動画)', 'Wan (video)')
  },
  get ltx() {
    return L('LTX (動画)', 'LTX (video)')
  },
}

// ---- 部品カタログ ----

export type ComponentRole = 'vae' | 'clip_l' | 'clip_g' | 't5xxl' | 'llm'

export const COMPONENT_ROLE_LABEL: Record<ComponentRole, string> = {
  vae: 'VAE',
  clip_l: 'CLIP-L',
  clip_g: 'CLIP-G',
  t5xxl: 'T5-XXL',
  get llm() {
    return L('テキストエンコーダー (LLM)', 'Text encoder (LLM)')
  },
}

export interface ComponentSource {
  repo: string
  path: string
  /** 表示用の目安 (実際のサイズはダウンロード時に HF から取る) */
  sizeBytes: number
  label: string
  note?: string
}

export interface ComponentSpec {
  role: ComponentRole
  /** 候補。先頭が既定 */
  options: ComponentSource[]
}

/** 部品のライセンス。restriction があるものは商用利用などに制限がある (利用者がモデルページを見ずに取得するので明示する) */
export interface ComponentLicense {
  name: string
  url: string
  restriction?: string
}

const APACHE: ComponentLicense = { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' }

/** 入手先リポジトリ → ライセンス (2026-09 時点の各リポジトリの表記)。載っていないものは Apache-2.0 */
const COMPONENT_LICENSES: Record<string, ComponentLicense> = {
  'Comfy-Org/stable-diffusion-3.5-fp8': {
    name: 'Stability AI Community License',
    url: 'https://huggingface.co/stabilityai/stable-diffusion-3.5-large/blob/main/LICENSE.md',
    get restriction() {
      return L('商用利用には Stability AI への登録が必要 (年間収益 100 万ドル超は別契約)', 'Commercial use requires registration with Stability AI (a separate agreement above US$1M annual revenue)')
    },
  },
  'Comfy-Org/Qwen-Image-2.1': {
    name: 'Qwen Research License',
    url: 'https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE',
    get restriction() {
      return L('非商用 (研究・評価) 目的に限る', 'Non-commercial use only (research and evaluation)')
    },
  },
}

export const componentLicense = (repo: string): ComponentLicense => COMPONENT_LICENSES[repo] ?? APACHE

const MB = 1024 * 1024
/** 文言。言語共通の文字列か [日本語, English] */
type Text = string | readonly [string, string]
const text = (t: Text): string => (typeof t === 'string' ? t : L(t[0], t[1]))
const src = (repo: string, path: string, sizeMB: number, label: Text, note?: Text): ComponentSource => ({
  repo,
  path,
  sizeBytes: sizeMB * MB,
  get label() {
    return text(label)
  },
  get note() {
    return note === undefined ? undefined : text(note)
  },
})

const FLUX_VAE: ComponentSpec = {
  role: 'vae',
  options: [
    src('second-state/FLUX.1-schnell-GGUF', 'ae.safetensors', 320, 'FLUX VAE (ae.safetensors)', ['公式と同じ重みの再配布 (規約同意不要)', 'Redistribution of the official weights (no license agreement needed)']),
    src('lodestones/Chroma', 'ae.safetensors', 320, ['FLUX VAE (Chroma リポジトリ)', 'FLUX VAE (Chroma repository)']),
  ],
}
const CLIP_L: ComponentSpec = { role: 'clip_l', options: [src('comfyanonymous/flux_text_encoders', 'clip_l.safetensors', 235, 'CLIP-L')] }
// T5-XXL は GGUF 量子化版を既定にする。comfyanonymous の fp8 (e4m3fn / scaled) safetensors は
// stable-diffusion.cpp の CPU 計算でクラッシュする (2026-09 時点、master-929) ため使わない
const T5XXL: ComponentSpec = {
  role: 't5xxl',
  options: [
    src('city96/t5-v1_1-xxl-encoder-gguf', 't5-v1_1-xxl-encoder-Q4_K_M.gguf', 2762, 'T5-XXL Q4_K_M (GGUF)', ['省メモリ。品質はほぼ同等', 'Saves memory. Nearly the same quality']),
    src('city96/t5-v1_1-xxl-encoder-gguf', 't5-v1_1-xxl-encoder-Q8_0.gguf', 4827, 'T5-XXL Q8_0 (GGUF)', ['高精度', 'High precision']),
    src('comfyanonymous/flux_text_encoders', 't5xxl_fp16.safetensors', 9334, 'T5-XXL fp16', ['元の精度。RAM を約 10GB 使う', 'Original precision. Uses about 10GB of RAM']),
  ],
}
const QWEN21_VAE: ComponentSpec = { role: 'vae', options: [src('Comfy-Org/Qwen-Image-2.1', 'vae/qwen_image_2.1_vae_bf16.safetensors', 644, 'Qwen-Image 2.1 VAE')] }

/** 系統 → 必要な部品。1 ファイル完結の系統 (sd1 / sdxl) は空 */
export const COMPONENT_CATALOG: Record<string, ComponentSpec[]> = {
  flux: [FLUX_VAE, CLIP_L, T5XXL],
  sd3: [
    CLIP_L,
    { role: 'clip_g', options: [src('Comfy-Org/stable-diffusion-3.5-fp8', 'text_encoders/clip_g.safetensors', 1325, 'CLIP-G')] },
    T5XXL,
  ],
  qwen_image: [
    { role: 'vae', options: [src('QuantStack/Qwen-Image-GGUF', 'VAE/Qwen_Image-VAE.safetensors', 242, 'Qwen-Image VAE')] },
    {
      role: 'llm',
      options: [
        src('mradermacher/Qwen2.5-VL-7B-Instruct-GGUF', 'Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf', 4466, 'Qwen2.5-VL-7B Q4_K_M', ['省メモリ', 'Saves memory']),
        src('mradermacher/Qwen2.5-VL-7B-Instruct-GGUF', 'Qwen2.5-VL-7B-Instruct.Q8_0.gguf', 7723, 'Qwen2.5-VL-7B Q8_0', ['高精度', 'High precision']),
      ],
    },
  ],
  'qwen_image_2.1': [
    QWEN21_VAE,
    {
      role: 'llm',
      options: [
        src('Qwen/Qwen3-VL-8B-Instruct-GGUF', 'Qwen3VL-8B-Instruct-Q4_K_M.gguf', 4795, 'Qwen3-VL-8B Q4_K_M', ['省メモリ', 'Saves memory']),
        src('Qwen/Qwen3-VL-8B-Instruct-GGUF', 'Qwen3VL-8B-Instruct-Q8_0.gguf', 8306, 'Qwen3-VL-8B Q8_0', ['高精度', 'High precision']),
      ],
    },
  ],
  'qwen_image_2.1_pe_t2i': [
    QWEN21_VAE,
    { role: 'llm', options: [src('Comfy-Org/Qwen-Image-2.1', 'text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors', 9032, 'Qwen3.5-9B PE-T2I (int8)', ['PE 版専用のテキストエンコーダー', 'Text encoder for the PE version only'])] },
  ],
  'qwen_image_2.1_pe_i2i': [
    QWEN21_VAE,
    { role: 'llm', options: [src('Comfy-Org/Qwen-Image-2.1', 'text_encoders/qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors', 9032, 'Qwen3.5-9B PE-I2I (int8)', ['PE 版専用のテキストエンコーダー', 'Text encoder for the PE version only'])] },
  ],
}

/** 部品カタログのある (= 部品を自動で揃えられる) 系統か */
export const hasComponentCatalog = (family: string) => (COMPONENT_CATALOG[family]?.length ?? 0) > 0

const CATALOG_PATHS = new Set(
  Object.values(COMPONENT_CATALOG)
    .flat()
    .flatMap((s) => s.options.map((o) => `${o.repo}/${o.path}`.toLowerCase())),
)

/** モデルフォルダ内の相対パス (owner/repo/file、区切りは /) がカタログの部品か。手動で置いた部品をモデル一覧に出さないために使う */
export const isCatalogComponentPath = (rel: string) => CATALOG_PATHS.has(rel.toLowerCase())

/** 系統ごとの生成パラメータの既定値 (stable-diffusion.cpp のドキュメントに準拠) */
export function familyDefaults(family: string, fileName = ''): { steps: number; cfgScale: number; width: number; height: number } {
  if (family === 'flux') return /schnell/i.test(fileName) ? { steps: 4, cfgScale: 1, width: 1024, height: 1024 } : { steps: 20, cfgScale: 1, width: 1024, height: 1024 }
  if (family.startsWith('qwen_image_2.1')) return { steps: 20, cfgScale: 6, width: 1024, height: 1024 }
  if (family === 'qwen_image') return { steps: 20, cfgScale: 2.5, width: 1024, height: 1024 }
  if (family === 'sd3') return { steps: 28, cfgScale: 4.5, width: 1024, height: 1024 }
  if (family === 'sdxl') return { steps: 25, cfgScale: 7, width: 1024, height: 1024 }
  return { steps: 20, cfgScale: 7, width: 512, height: 512 }
}
