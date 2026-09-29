import { describe, expect, it } from 'vitest'
import { COMPONENT_CATALOG, describeUnsupportedDtype, detectDiffusion, detectDiffusionByKeys, familyDefaults, isCatalogComponentPath, isImageGenPipeline, isUnsupportedSdcppTensor, refineFamilyByName } from '../src/shared/diffusion'
import { buildDiffusionEntries } from '../src/shared/quant'

describe('diffusion detection', () => {
  it('recognises a full SD checkpoint from 3-level key prefixes (in any order)', () => {
    // SD1.5 のチェックポイントはキーがアルファベット順で、先頭は cond_stage_model.*
    const prefixes = ['cond_stage_model.transformer.text_model', 'first_stage_model.decoder.conv_in', 'model.diffusion_model.input_blocks', 'model.diffusion_model.output_blocks', 'model_ema.decay']
    expect(detectDiffusionByKeys(prefixes)).toEqual({ family: 'unet', singleFile: true })
    // 完全なテンソル名でも同じ
    expect(detectDiffusionByKeys(['model.diffusion_model.input_blocks.0.0.weight', 'first_stage_model.decoder.conv_in.bias', 'cond_stage_model.x'])).toEqual({ family: 'unet', singleFile: true })
  })
  it('recognises FLUX / Qwen-Image / SD3 diffusion-only files from tensor names (no metadata)', () => {
    expect(detectDiffusionByKeys(['double_blocks.0.img_attn', 'single_blocks.0.linear1', 'img_in.weight', 'final_layer.linear'])).toEqual({ family: 'flux', singleFile: false })
    expect(detectDiffusionByKeys(['transformer_blocks.0.attn', 'time_text_embed.timestep_embedder', 'img_in.weight'])).toEqual({ family: 'qwen_image', singleFile: false })
    expect(detectDiffusionByKeys(['transformer_blocks.0.attn', 'time_text_embed.timestep_embedder', 'modulation.1', 'img_in.weight'])).toEqual({ family: 'qwen_image_2.1', singleFile: false })
    expect(detectDiffusionByKeys(['joint_blocks.0.context_block', 'x_embedder.proj'])).toEqual({ family: 'sd3', singleFile: false })
    expect(detectDiffusionByKeys(['model.diffusion_model.input_blocks'])).toEqual({ family: 'unet', singleFile: false })
  })
  it('treats an all-in-one FLUX checkpoint (vae + text_encoders inside) as single file', () => {
    expect(detectDiffusionByKeys(['model.diffusion_model.double_blocks', 'vae.decoder.conv_in', 'text_encoders.clip_l.transformer'])).toEqual({ family: 'flux', singleFile: true })
  })
  it('uses the GGUF architecture when present and ignores language models', () => {
    expect(detectDiffusion('sdxl', [])).toEqual({ family: 'sdxl', singleFile: true })
    // ComfyUI-GGUF の UNet 単体変換は arch=sdxl でもテキストエンコーダー / VAE を含まない
    expect(detectDiffusion('sdxl', ['input_blocks.0.0', 'output_blocks.0.0', 'time_embed.0'])).toEqual({ family: 'sdxl', singleFile: false })
    expect(detectDiffusion('sd1', ['model.diffusion_model.input_blocks', 'first_stage_model.decoder', 'cond_stage_model.transformer'])).toEqual({ family: 'sd1', singleFile: true })
    expect(detectDiffusion('qwen_image', ['transformer_blocks.0'])).toEqual({ family: 'qwen_image', singleFile: false })
    // ComfyUI-GGUF が書く 2.1 のアーキテクチャ名、および arch が qwen_image でも中身が 2.1 の場合
    expect(detectDiffusion('qwen_image21', [])).toEqual({ family: 'qwen_image_2.1', singleFile: false })
    expect(detectDiffusion('qwen_image', ['transformer_blocks.0.attn', 'time_text_embed.timestep_embedder', 'modulation.1'])).toEqual({ family: 'qwen_image_2.1', singleFile: false })
    expect(detectDiffusion('llama', ['token_embd.weight', 'blk.0.attn_q'])).toBeNull()
    expect(detectDiffusion('qwen2vl', ['blk.0.attn_q', 'output.weight'])).toBeNull()
  })
  it('refines Qwen-Image 2.1 PE variants by file name', () => {
    const base = { family: 'qwen_image_2.1', singleFile: false }
    expect(refineFamilyByName(base, 'Qwen-Image-2.1-PE-I2I.Q3_K_M.gguf')?.family).toBe('qwen_image_2.1_pe_i2i')
    expect(refineFamilyByName(base, 'qwen_image_2.1_pe_t2i-Q4_K.gguf')?.family).toBe('qwen_image_2.1_pe_t2i')
    expect(refineFamilyByName(base, 'qwen_image_2.1-Q2_K.gguf')?.family).toBe('qwen_image_2.1')
    expect(refineFamilyByName({ family: 'flux', singleFile: false }, 'x-pe-i2i.gguf')?.family).toBe('flux')
    expect(refineFamilyByName(null, 'a.gguf')).toBeNull()
  })
  it('classifies pipelines', () => {
    expect(isImageGenPipeline('text-to-image')).toBe(true)
    expect(isImageGenPipeline('image-to-image')).toBe(true)
    expect(isImageGenPipeline('text-generation')).toBe(false)
    expect(isImageGenPipeline(undefined)).toBe(false)
  })
})

describe('component catalog', () => {
  it('lists a VAE and text encoders for every multi-part family, with a default option each', () => {
    for (const [family, specs] of Object.entries(COMPONENT_CATALOG)) {
      expect(specs.length, family).toBeGreaterThan(0)
      for (const s of specs) {
        expect(s.options.length, `${family}/${s.role}`).toBeGreaterThan(0)
        for (const o of s.options) {
          expect(o.repo).toMatch(/^[\w.-]+\/[\w.-]+$/)
          expect(o.path).toMatch(/\.(safetensors|gguf)$/)
          expect(o.sizeBytes).toBeGreaterThan(0)
        }
      }
    }
    expect(COMPONENT_CATALOG.flux.map((s) => s.role)).toEqual(['vae', 'clip_l', 't5xxl'])
    expect(COMPONENT_CATALOG['qwen_image_2.1'].map((s) => s.role)).toEqual(['vae', 'llm'])
    // T5-XXL の既定は GGUF (fp8 safetensors は sd.cpp の CPU 計算で落ちる)
    expect(COMPONENT_CATALOG.flux[2].options[0].path).toMatch(/\.gguf$/)
  })
  it('flags safetensors dtypes that stable-diffusion.cpp cannot load (MLX U32, NVFP4 U8) but not fp8 / int8 / comfy_quant', () => {
    expect(isUnsupportedSdcppTensor('img_in.weight', 'U32')).toBe(true)
    expect(isUnsupportedSdcppTensor('transformer_blocks.0.attn.to_k.weight', 'U8')).toBe(true)
    expect(isUnsupportedSdcppTensor('transformer_blocks.0.attn.to_k.comfy_quant', 'U8')).toBe(false)
    expect(isUnsupportedSdcppTensor('modulation.1.scale_input', 'U8')).toBe(false)
    for (const d of ['F16', 'BF16', 'F32', 'F8_E4M3', 'F8_E5M2', 'I8']) expect(isUnsupportedSdcppTensor('x.weight', d), d).toBe(false)
    expect(describeUnsupportedDtype('qwen-image-2.1-UC-MLX-4bit.safetensors', 'U32')).toMatch(/MLX.*U32/)
    expect(describeUnsupportedDtype('qwen-image-2.1-UC-NVFP4.safetensors', 'U8')).toMatch(/NVFP4/)
  })
  it('recognises catalog component paths so hand-placed parts are hidden from the model list', () => {
    expect(isCatalogComponentPath('city96/t5-v1_1-xxl-encoder-gguf/t5-v1_1-xxl-encoder-Q4_K_M.gguf')).toBe(true)
    expect(isCatalogComponentPath('City96/T5-v1_1-xxl-encoder-gguf/T5-V1_1-XXL-ENCODER-Q4_K_M.GGUF')).toBe(true)
    expect(isCatalogComponentPath('second-state/FLUX.1-schnell-GGUF/ae.safetensors')).toBe(true)
    expect(isCatalogComponentPath('second-state/FLUX.1-schnell-GGUF/flux1-schnell-Q4_0.gguf')).toBe(false)
    expect(isCatalogComponentPath('unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf')).toBe(false)
  })
  it('gives family-specific generation defaults', () => {
    expect(familyDefaults('flux', 'flux1-schnell-q2_k.gguf')).toMatchObject({ steps: 4, cfgScale: 1 })
    expect(familyDefaults('flux', 'flux1-dev-q8_0.gguf')).toMatchObject({ steps: 20, cfgScale: 1 })
    expect(familyDefaults('qwen_image_2.1_pe_i2i')).toMatchObject({ cfgScale: 6 })
    expect(familyDefaults('unet')).toMatchObject({ width: 512, cfgScale: 7 })
  })
})

describe('buildDiffusionEntries', () => {
  it('lists large root-level checkpoints only', () => {
    const files = [
      { path: 'v1-5-pruned-emaonly-fp16.safetensors', size: 2_132_696_762 },
      { path: 'v1-5-pruned.safetensors', size: 7_703_807_346 },
      { path: 'unet/diffusion_pytorch_model.safetensors', size: 3_438_167_536 },
      { path: 'model_index.json', size: 541 },
      { path: 'small.safetensors', size: 1_000_000 },
    ]
    const entries = buildDiffusionEntries(files, 'Comfy-Org/stable-diffusion-v1-5-archive')
    expect(entries.map((e) => e.displayName)).toEqual(['v1-5-pruned', 'v1-5-pruned-emaonly-fp16'])
    expect(entries[1].quant).toBe('F16')
    expect(entries[1].format).toBe('diffusion')
  })
})
