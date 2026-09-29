import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ModelHeaderInfo } from '@shared/types'
import { headerFromConfig, parseHfConfig } from '@shared/config'
import { L } from '@shared/i18n'
import { describeUnsupportedDtype, detectDiffusionByKeys, isUnsupportedSdcppTensor, refineFamilyByName, type DiffusionInfo } from '@shared/diffusion'

export interface SafetensorsHeader {
  paramCount: number
  tensorCount: number
  dtype?: string
  /** テンソル名の先頭 2 階層のプレフィックス一覧 (拡散モデルの判定用。例: model.diffusion_model, first_stage_model) */
  keys: string[]
  /** stable-diffusion.cpp で読めない dtype のテンソルがあれば、その最初の 1 つ */
  unsupportedForSdcpp?: { key: string; dtype: string }
}

/** "model.diffusion_model.input_blocks.0.0.weight" → "model.diffusion_model.input_blocks" (系統の判別に 3 階層まで要る) */
export const keyPrefix = (key: string) => key.split('.').slice(0, 3).join('.')
/** 集めるプレフィックスの上限。FLUX の double_blocks.N.* など連番で増えるので多めに */
export const MAX_PREFIXES = 256

/** safetensors のヘッダ JSON (テンソル名 → dtype / shape) を集計する */
export function parseSafetensorsHeaderJson(json: Record<string, { dtype?: string; shape?: number[] }>): SafetensorsHeader {
  let paramCount = 0
  let tensorCount = 0
  let dtype: string | undefined
  // キーは数千個あり先頭だけでは偏る (SD のチェックポイントは cond_stage_model.* が先に並ぶ) ので、先頭 2 階層のプレフィックスを集める
  const prefixes = new Set<string>()
  let unsupportedForSdcpp: SafetensorsHeader['unsupportedForSdcpp']
  for (const [key, t] of Object.entries(json)) {
    if (key === '__metadata__') continue
    tensorCount++
    if (prefixes.size < MAX_PREFIXES) prefixes.add(keyPrefix(key))
    if (Array.isArray(t.shape)) paramCount += t.shape.reduce((a, b) => a * b, 1)
    dtype ??= t.dtype
    if (!unsupportedForSdcpp && isUnsupportedSdcppTensor(key, t.dtype)) unsupportedForSdcpp = { key, dtype: t.dtype! }
  }
  return { paramCount, tensorCount, dtype, keys: [...prefixes], unsupportedForSdcpp }
}

/** ヘッダの JSON 部分の最大サイズ (これを超えるものは壊れているとみなす) */
export const MAX_HEADER_BYTES = 256 * 1024 * 1024

/** safetensors ファイルの先頭 (8 バイトの長さ + JSON ヘッダ) だけを読んでテンソル形状を集計する */
export async function readSafetensorsHeader(file: string): Promise<SafetensorsHeader> {
  const handle = await fsp.open(file, 'r')
  try {
    const lenBuf = Buffer.alloc(8)
    await handle.read(lenBuf, 0, 8, 0)
    const n = Number(lenBuf.readBigUInt64LE(0))
    if (n <= 0 || n > MAX_HEADER_BYTES) throw new Error(L('safetensors ヘッダが不正です', 'Invalid safetensors header'))
    const buf = Buffer.alloc(n)
    await handle.read(buf, 0, n, 8)
    return parseSafetensorsHeaderJson(JSON.parse(buf.toString('utf8')))
  } finally {
    await handle.close()
  }
}

/** ヘッダの集計から拡散モデルの系統を判定する (読めない dtype があればその理由も付ける)。拡散モデルでなければ null */
export function diffusionInfoFromHeader(h: SafetensorsHeader, fileName: string): DiffusionInfo | null {
  const diffusion = refineFamilyByName(detectDiffusionByKeys(h.keys), fileName)
  if (diffusion && h.unsupportedForSdcpp) diffusion.unsupported = describeUnsupportedDtype(fileName, h.unsupportedForSdcpp.dtype)
  return diffusion
}

/**
 * 1 ファイルの safetensors が拡散モデル (画像生成) かを判定してヘッダ情報にする。
 * 全部入りチェックポイント (SD1.x / SDXL) なら singleFile、拡散モデル本体だけなら false
 */
export async function readDiffusionCheckpoint(file: string): Promise<ModelHeaderInfo | null> {
  const h = await readSafetensorsHeader(file)
  const diffusion = diffusionInfoFromHeader(h, path.basename(file))
  if (!diffusion) return null
  return {
    format: 'diffusion',
    version: 0,
    tensorCount: h.tensorCount,
    kvCount: 0,
    architecture: diffusion.family,
    paramCount: h.paramCount,
    hasChatTemplate: false,
    metadata: {},
    truncated: false,
    dtype: h.dtype,
    tensorNames: h.keys,
    diffusion,
  }
}

/** ダウンロード済みの safetensors モデルフォルダから config.json と重みのヘッダを読む */
export async function readTransformersModel(dir: string): Promise<ModelHeaderInfo | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await fsp.readFile(path.join(dir, 'config.json'), 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const cfg = parseHfConfig(raw as Record<string, unknown>)
  const files = (await fsp.readdir(dir)).filter((f) => /\.safetensors$/i.test(f))
  let paramCount = 0
  let tensorCount = 0
  let dtype: string | undefined
  for (const f of files) {
    const h = await readSafetensorsHeader(path.join(dir, f)).catch(() => null)
    if (!h) continue
    paramCount += h.paramCount
    tensorCount += h.tensorCount
    dtype ??= h.dtype
  }
  const info = headerFromConfig(cfg, paramCount || undefined, dtype)
  info.tensorCount = tensorCount
  info.hasChatTemplate = await hasChatTemplate(dir)
  return info
}

async function hasChatTemplate(dir: string): Promise<boolean> {
  try {
    await fsp.access(path.join(dir, 'chat_template.jinja'))
    return true
  } catch {
    /* 次へ */
  }
  try {
    const tc = await fsp.readFile(path.join(dir, 'tokenizer_config.json'), 'utf8')
    return tc.includes('"chat_template"')
  } catch {
    return false
  }
}
