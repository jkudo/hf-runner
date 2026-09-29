import fsp from 'node:fs/promises'
import type { ModelHeaderInfo } from '@shared/types'
import { detectDiffusion, refineFamilyByName } from '@shared/diffusion'
import { FORK_TENSOR_TYPE_MIN, missingLayers } from '@shared/quant'
import { L } from '@shared/i18n'

/** 任意のオフセットからバイト列を読み出せるソース(ローカルファイル / HTTP Range) */
export interface ByteSource {
  read(offset: number, length: number): Promise<Uint8Array>
  close(): Promise<void>
}

export function fileSource(filePath: string): ByteSource {
  let handle: fsp.FileHandle | null = null
  return {
    async read(offset, length) {
      handle ??= await fsp.open(filePath, 'r')
      const buf = new Uint8Array(length)
      const { bytesRead } = await handle.read(buf, 0, length, offset)
      return buf.subarray(0, bytesRead)
    },
    async close() {
      await handle?.close()
      handle = null
    },
  }
}

export function remoteSource(url: string, headers: Record<string, string> = {}): ByteSource {
  return {
    async read(offset, length) {
      const res = await fetch(url, {
        headers: { ...headers, Range: `bytes=${offset}-${offset + length - 1}` },
        redirect: 'follow',
      })
      if (res.status === 416) return new Uint8Array(0)
      if (res.status === 200) {
        await res.body?.cancel()
        throw new Error(L('サーバーが Range リクエストに対応していません', 'The server does not support Range requests'))
      }
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },
    async close() {},
  }
}

/** 同じ範囲の読み出しを繰り返さないよう、取得済みの範囲をメモリに残す (同じヘッダを 2 回解析するリモート判定向け) */
export function cachingSource(inner: ByteSource): ByteSource {
  const cache = new Map<string, Promise<Uint8Array>>()
  return {
    read(offset, length) {
      const key = `${offset}:${length}`
      const hit = cache.get(key)
      if (hit) return hit
      const p = inner.read(offset, length)
      cache.set(key, p)
      p.catch(() => cache.delete(key))
      return p
    },
    close: () => inner.close(),
  }
}

export class GgufTruncatedError extends Error {
  constructor() {
    super(L('GGUF ヘッダが読み取り上限を超えました', 'The GGUF header exceeds the read limit'))
  }
}

// GGUF の値型
const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 } as const
const SCALAR_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }

// llama_ftype → 表示名
const FTYPE: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1', 10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M',
  13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS',
  21: 'Q2_K_S', 22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M', 28: 'IQ2_S',
  29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 36: 'TQ1_0', 37: 'TQ2_0', 38: 'MXFP4',
}

const decoder = new TextDecoder('utf-8')

/** 必要になった分だけソースから取り込む前方読みカーソル。skip() はデータを取得せずに位置だけ進める */
class Cursor {
  private buf = new Uint8Array(0)
  private bufStart = 0
  pos = 0
  fetched = 0
  private chunk = 256 * 1024

  constructor(
    private readonly src: ByteSource,
    private readonly maxBytes: number,
  ) {}

  private async ensure(n: number): Promise<void> {
    const bufEnd = this.bufStart + this.buf.length
    if (this.pos >= this.bufStart && this.pos + n <= bufEnd) return
    const have = this.pos >= this.bufStart && this.pos < bufEnd ? this.buf.subarray(this.pos - this.bufStart) : new Uint8Array(0)
    const need = Math.max(n - have.length, this.chunk)
    if (this.fetched + need > this.maxBytes) throw new GgufTruncatedError()
    const more = await this.src.read(this.pos + have.length, need)
    this.fetched += more.length
    if (have.length + more.length < n) throw new Error(L('GGUF: データが途中で終わっています', 'GGUF: the data ends prematurely'))
    const merged = new Uint8Array(have.length + more.length)
    merged.set(have)
    merged.set(more, have.length)
    this.buf = merged
    this.bufStart = this.pos
    this.chunk = Math.min(this.chunk * 2, 8 * 1024 * 1024)
  }

  async bytes(n: number): Promise<Uint8Array> {
    await this.ensure(n)
    const start = this.pos - this.bufStart
    this.pos += n
    return this.buf.subarray(start, start + n)
  }

  skip(n: number): void {
    this.pos += n
  }

  private async view(n: number): Promise<DataView> {
    const b = await this.bytes(n)
    return new DataView(b.buffer, b.byteOffset, b.byteLength)
  }

  async u32(): Promise<number> {
    return (await this.view(4)).getUint32(0, true)
  }

  async u64(): Promise<number> {
    return Number((await this.view(8)).getBigUint64(0, true))
  }

  async string(): Promise<string> {
    const len = await this.u64()
    return decoder.decode(await this.bytes(len))
  }

  async skipString(): Promise<void> {
    this.skip(await this.u64())
  }

  async scalar(type: number): Promise<number | boolean> {
    const dv = await this.view(SCALAR_SIZE[type])
    switch (type) {
      case T.U8: return dv.getUint8(0)
      case T.I8: return dv.getInt8(0)
      case T.U16: return dv.getUint16(0, true)
      case T.I16: return dv.getInt16(0, true)
      case T.U32: return dv.getUint32(0, true)
      case T.I32: return dv.getInt32(0, true)
      case T.F32: return dv.getFloat32(0, true)
      case T.BOOL: return dv.getUint8(0) !== 0
      case T.U64: return Number(dv.getBigUint64(0, true))
      case T.I64: return Number(dv.getBigInt64(0, true))
      case T.F64: return dv.getFloat64(0, true)
      default: throw new Error(L(`GGUF: 未知の値型 ${type}`, `GGUF: unknown value type ${type}`))
    }
  }
}

export interface ParseOptions {
  /** 取り込むバイト数の上限 */
  maxBytes?: number
  /** tokenizer の巨大配列に到達したら(必要な情報が揃っていれば)解析を打ち切る。リモート解析向け */
  stopAtTokenizer?: boolean
  /** テンソル情報を読んでパラメータ数を数える(ローカル向け) */
  parseTensors?: boolean
  /** ファイル名。拡散モデルの系統をファイル名で補正する (Qwen-Image 2.1 の PE-T2I / PE-I2I など) のに使う */
  fileName?: string
}

export async function parseGgufHeader(src: ByteSource, opts: ParseOptions = {}): Promise<ModelHeaderInfo> {
  const { maxBytes = 512 * 1024 * 1024, stopAtTokenizer = false, parseTensors = true, fileName } = opts
  const cur = new Cursor(src, maxBytes)
  try {
    if ((await cur.u32()) !== 0x46554747) throw new Error(L('GGUF 形式のファイルではありません', 'Not a GGUF file'))
    const version = await cur.u32()
    if (version < 2 || version > 3) throw new Error(L(`未対応の GGUF バージョン: ${version}`, `Unsupported GGUF version: ${version}`))
    const tensorCount = await cur.u64()
    const kvCount = await cur.u64()

    const meta: Record<string, string | number | boolean> = {}
    let arch: string | undefined
    let truncated = false
    let hasChatTemplate = false

    for (let i = 0; i < kvCount; i++) {
      const key = await cur.string()
      const type = await cur.u32()
      if (type === T.ARRAY) {
        const elemType = await cur.u32()
        const count = await cur.u64()
        if (stopAtTokenizer && key.startsWith('tokenizer.') && arch && meta[`${arch}.block_count`] !== undefined) {
          truncated = true
          break
        }
        if (elemType === T.STRING) {
          for (let j = 0; j < count; j++) await cur.skipString()
        } else if (elemType === T.ARRAY) {
          truncated = true
          break
        } else {
          cur.skip(count * SCALAR_SIZE[elemType])
        }
        meta[key] = L(`[${count} 件]`, `[${count} items]`)
      } else if (type === T.STRING) {
        const s = await cur.string()
        if (key === 'tokenizer.chat_template') {
          hasChatTemplate = true
          meta[key] = L('(あり)', '(present)')
        } else {
          meta[key] = s.length > 200 ? `${s.slice(0, 200)}…` : s
        }
        if (key === 'general.architecture') arch = s
      } else {
        meta[key] = await cur.scalar(type)
      }
    }

    let paramCount = 0
    // テンソル名の先頭 3 階層のプレフィックス (拡散モデルの系統判定に使う)
    const prefixes = new Set<string>()
    // 入っているレイヤー (blk.N) の番号。一部しか無いファイルの検出用
    const blocks = new Set<number>()
    // 公式の llama.cpp に無い型 (フォーク専用の量子化) のテンソルがあれば、その型番号
    let unknownTensorType: number | undefined
    if (parseTensors && !truncated) {
      for (let i = 0; i < tensorCount; i++) {
        const name = await cur.string()
        if (prefixes.size < 256) prefixes.add(name.split('.').slice(0, 3).join('.'))
        const blk = /^blk\.(\d+)\./.exec(name)
        if (blk) blocks.add(Number(blk[1]))
        const nDims = await cur.u32()
        let n = 1
        for (let d = 0; d < nDims; d++) n *= await cur.u64()
        const type = await cur.u32()
        if (type >= FORK_TENSOR_TYPE_MIN) unknownTensorType ??= type
        await cur.u64() // offset
        paramCount += n
      }
    }

    const num = (k: string) => (typeof meta[k] === 'number' ? (meta[k] as number) : undefined)
    const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : undefined)
    const a = arch ?? ''
    const fileType = num('general.file_type')
    const tensorNames = [...prefixes]
    const diffusion = refineFamilyByName(detectDiffusion(arch, tensorNames), fileName ?? '') ?? undefined
    return {
      format: diffusion ? 'diffusion' : 'gguf',
      tensorNames: tensorNames.length ? tensorNames : undefined,
      missingLayers: missingLayers(blocks, num(`${a}.block_count`)),
      unknownTensorType,
      diffusion,
      version,
      tensorCount,
      kvCount,
      architecture: arch,
      name: str('general.name'),
      sizeLabel: str('general.size_label'),
      fileType,
      fileTypeName: fileType !== undefined ? FTYPE[fileType] : undefined,
      paramCount: paramCount || num('general.parameter_count'),
      contextLength: num(`${a}.context_length`),
      blockCount: num(`${a}.block_count`),
      embeddingLength: num(`${a}.embedding_length`),
      headCount: num(`${a}.attention.head_count`),
      headCountKv: num(`${a}.attention.head_count_kv`),
      keyLength: num(`${a}.attention.key_length`),
      valueLength: num(`${a}.attention.value_length`),
      vocabSize: num(`${a}.vocab_size`),
      expertCount: num(`${a}.expert_count`),
      hasChatTemplate,
      metadata: meta,
      truncated,
    }
  } finally {
    await src.close()
  }
}
