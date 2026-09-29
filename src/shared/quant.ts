import type { HFFile, ModelEntry, QuantInfo } from './types'
import { L } from './i18n'

// 量子化タイプ一覧。品質が高い順(= 概ねサイズが大きい順)。bpw は 1 重みあたりのビット数の目安。
// label / note は文字列 (言語共通) か [日本語, English]。表示言語は参照時に決まるので BY_NAME では getter にする
type Text = string | readonly [string, string]
const TABLE: ReadonlyArray<{ name: string; bpw: number; label: Text; note: Text }> = [
  { name: 'F32', bpw: 32, label: ['32bit 浮動小数', '32-bit float'], note: ['元の精度そのまま。非常に大きい', 'Original precision. Very large'] },
  { name: 'F16', bpw: 16, label: ['16bit 浮動小数', '16-bit float'], note: ['元の精度に近い。大きい', 'Close to original precision. Large'] },
  { name: 'BF16', bpw: 16, label: 'BFloat16', note: ['元の精度に近い。大きい', 'Close to original precision. Large'] },
  { name: 'Q8_0', bpw: 8.5, label: '8bit', note: ['ほぼ無劣化。品質最優先', 'Nearly lossless. Best quality'] },
  { name: 'Q6_K', bpw: 6.56, label: '6bit', note: ['ほぼ無劣化', 'Nearly lossless'] },
  { name: 'Q5_K_M', bpw: 5.69, label: '5bit (M)', note: ['高品質', 'High quality'] },
  { name: 'Q5_K_S', bpw: 5.54, label: '5bit (S)', note: ['高品質。少し小さい', 'High quality. Slightly smaller'] },
  { name: 'Q5_1', bpw: 6.0, label: ['5bit (旧形式)', '5bit (legacy)'], note: ['旧形式', 'Legacy format'] },
  { name: 'Q5_0', bpw: 5.5, label: ['5bit (旧形式)', '5bit (legacy)'], note: ['旧形式', 'Legacy format'] },
  { name: 'Q4_K_M', bpw: 4.85, label: '4bit (M)', note: ['サイズと品質のバランスが良く、まず試すのに最適', 'Good balance of size and quality. Best to try first'] },
  { name: 'Q4_K_S', bpw: 4.58, label: '4bit (S)', note: ['やや小さい。品質は良好', 'Slightly smaller. Good quality'] },
  { name: 'Q4_1', bpw: 5.0, label: ['4bit (旧形式)', '4bit (legacy)'], note: ['旧形式', 'Legacy format'] },
  { name: 'Q4_0', bpw: 4.55, label: ['4bit (旧形式)', '4bit (legacy)'], note: ['ARM CPU では高速な場合あり', 'Can be fast on ARM CPUs'] },
  { name: 'IQ4_NL', bpw: 4.5, label: '4bit (IQ-NL)', note: ['小型で高効率', 'Small and efficient'] },
  { name: 'IQ4_XS', bpw: 4.25, label: '4bit (IQ-XS)', note: ['小型で高効率', 'Small and efficient'] },
  { name: 'MXFP4', bpw: 4.25, label: 'MXFP4', note: ['MoE モデル向けの 4bit 浮動小数', '4-bit float for MoE models'] },
  { name: 'Q3_K_L', bpw: 4.27, label: '3bit (L)', note: ['小型。品質低下あり', 'Small. Some quality loss'] },
  { name: 'Q3_K_M', bpw: 3.91, label: '3bit (M)', note: ['小型。品質低下あり', 'Small. Some quality loss'] },
  { name: 'IQ3_M', bpw: 3.66, label: '3bit (IQ-M)', note: ['小型。Q3_K より高品質', 'Small. Better quality than Q3_K'] },
  { name: 'Q3_K_S', bpw: 3.5, label: '3bit (S)', note: ['小型。品質低下が目立つ', 'Small. Noticeable quality loss'] },
  { name: 'IQ3_S', bpw: 3.44, label: '3bit (IQ-S)', note: ['小型。品質低下あり', 'Small. Some quality loss'] },
  { name: 'IQ3_XS', bpw: 3.3, label: '3bit (IQ-XS)', note: ['小型。品質低下あり', 'Small. Some quality loss'] },
  { name: 'Q2_K', bpw: 3.35, label: '2bit (K)', note: ['非常に小型。品質劣化大', 'Very small. Large quality loss'] },
  { name: 'IQ3_XXS', bpw: 3.06, label: '3bit (IQ-XXS)', note: ['非常に小型。品質劣化あり', 'Very small. Some quality loss'] },
  { name: 'Q2_K_S', bpw: 2.96, label: '2bit (K-S)', note: ['非常に小型。品質劣化大', 'Very small. Large quality loss'] },
  { name: 'IQ2_M', bpw: 2.7, label: '2bit (IQ-M)', note: ['非常に小型。品質劣化大', 'Very small. Large quality loss'] },
  { name: 'IQ2_S', bpw: 2.5, label: '2bit (IQ-S)', note: ['非常に小型。品質劣化大', 'Very small. Large quality loss'] },
  { name: 'IQ2_XS', bpw: 2.31, label: '2bit (IQ-XS)', note: ['極小。品質劣化が大きい', 'Tiny. Large quality loss'] },
  { name: 'TQ2_0', bpw: 2.06, label: 'Ternary 2bit', note: ['BitNet 系専用', 'For BitNet models only'] },
  { name: 'IQ2_XXS', bpw: 2.06, label: '2bit (IQ-XXS)', note: ['極小。品質劣化が大きい', 'Tiny. Large quality loss'] },
  { name: 'IQ1_M', bpw: 1.75, label: '1bit (IQ-M)', note: ['極小。用途は限定的', 'Tiny. Limited use'] },
  { name: 'TQ1_0', bpw: 1.69, label: 'Ternary 1.6bit', note: ['BitNet 系専用', 'For BitNet models only'] },
  { name: 'IQ1_S', bpw: 1.56, label: '1bit (IQ-S)', note: ['極小。用途は限定的', 'Tiny. Limited use'] },
]

const text = (t: Text): string => (typeof t === 'string' ? t : L(t[0], t[1]))

const BY_NAME = new Map<string, QuantInfo>(
  TABLE.map((q, i) => [
    q.name,
    {
      name: q.name,
      bpw: q.bpw,
      get label() {
        return text(q.label)
      },
      get note() {
        return text(q.note)
      },
      rank: i,
    },
  ]),
)

const QUANT_RE =
  /(?<![A-Z0-9])(IQ[1-4]_[A-Z]{1,3}|Q[2-8]_K_[SMLX]{1,2}|Q[2-8]_K|Q[2-8]_[01]|TQ[12]_0|MXFP4|BF16|F16|F32|FP16|FP32)(?![A-Z0-9])/g
const SPLIT_RE = /^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i

/** ファイル名から量子化を判別できなかったときの値 (データ。表示は quantLabel で) */
export const UNKNOWN_QUANT = '?'

/** 量子化名の表示。判別できなかったもの (旧版が保存した '不明' / 'Unknown' を含む) は今の言語で */
export const quantLabel = (quant: string) => (quant === UNKNOWN_QUANT || quant === '不明' || quant === 'Unknown' ? L('不明', 'Unknown') : quant)

/** 分割 GGUF の表示名に付ける注記 (" (3 分割)")。分割でなければ空 */
export const splitSuffix = (parts: number | undefined) => (parts && parts > 1 ? L(` (${parts} 分割)`, ` (${parts} parts)`) : '')

/** 旧版が表示名に保存した分割の注記を取り除く (表示名は言語を含めずに扱う) */
export const stripSplitSuffix = (name: string) => name.replace(/ \(\d+ (?:分割|parts)\)$/, '')

/** ファイル一覧のうち分割 GGUF のパーツ数 (分割でなければ 0) */
export const countSplitParts = (files: string[]) => files.filter((f) => SPLIT_RE.test(f.split('/').pop() ?? f)).length

/** ファイル名から量子化タイプ名(Q4_K_M など)を取り出す */
export function parseQuantName(fileName: string): string | null {
  const base = fileName
    .split('/')
    .pop()!
    .replace(/\.gguf$/i, '')
    .replace(/-\d{5}-of-\d{5}$/i, '')
    .toUpperCase()
  const matches = [...base.matchAll(QUANT_RE)].map((m) => m[1])
  if (matches.length === 0) return null
  let name = matches[matches.length - 1]
  if (name === 'FP16') name = 'F16'
  if (name === 'FP32') name = 'F32'
  return name
}

export function quantInfo(name: string | null): QuantInfo | null {
  if (!name) return null
  const exact = BY_NAME.get(name)
  if (exact) return exact
  // 派生表記 (unsloth の _XL, bartowski の _L など) は基本形にマッピングする
  const derived = /^Q(\d)_K_(L|XL)$/.exec(name)
  if (derived) {
    const base = BY_NAME.get(`Q${derived[1]}_K_M`) ?? BY_NAME.get(`Q${derived[1]}_K`) ?? BY_NAME.get(`Q${derived[1]}_0`)
    if (base) {
      return {
        ...base,
        name,
        label: `${base.label.replace(/ \(M\)$/, '')} (${derived[2]})`,
        note: L(`${base.note}。埋め込み/出力層を高精度にした派生版`, `${base.note}. Variant with higher-precision embedding/output layers`),
        bpw: base.bpw + (derived[2] === 'XL' ? 0.6 : 0.3),
      }
    }
  }
  const bits = /^I?Q(\d)/.exec(name)
  const n = bits ? Number(bits[1]) : 4
  return { name, bpw: n + 0.5, label: `${n}bit`, note: '', rank: 100 - n }
}

/** "Qwen2.5-7B-Instruct" → 7, "SmolLM2-135M" → 0.135 */
export function parseParamsB(text: string): number | null {
  const s = text.toUpperCase()
  const b = /(?<![A-Z0-9.])(\d+(?:\.\d+)?)B(?![A-Z0-9])/.exec(s)
  if (b) return Number(b[1])
  const m = /(?<![A-Z0-9.])(\d+(?:\.\d+)?)M(?![A-Z0-9])/.exec(s)
  if (m) return Number(m[1]) / 1000
  return null
}

/**
 * 投機的デコード用のドラフト (下書き) モデルのファイル名か。本体の一部のレイヤー (MTP) だけを抜き出したもので、
 * 単体では実行できない (HF Runner は投機的デコードに未対応)
 */
export const isDraftName = (name: string) => /(^|[-_.\s])draft([-_.\s]|$)/i.test(name)

/**
 * blk.N の並びから、block_count に対して欠けているレイヤー数。一部のレイヤーだけ入ったファイル (MTP のドラフトなど) の検出用。
 * 全レイヤーが揃っていれば undefined
 */
export function missingLayers(blocks: Iterable<number>, blockCount?: number): number | undefined {
  const n = new Set(blocks).size
  return blockCount && n > 0 && n < blockCount ? blockCount - n : undefined
}

/**
 * 公式の llama.cpp に無い独自の量子化 (フォーク版の llama.cpp が必要) のファイル名か。
 * PrismML の Ternary Bonsai (PTQ1_0 / PQ2_0) は ggml の型番号 143 などを使い、公式版では読み込めない
 */
export const isForkOnlyQuantName = (name: string) => /(^|[-_.\s])PT?Q\d_\d([-_.\s]|$)/i.test(name)

/**
 * 公式 llama.cpp の ggml 型番号の上限の目安。公式の型は 0 から順に増えていく (2026-09 時点で 43 未満)。
 * フォークは衝突を避けて大きな番号 (100 以上) を使うので、それ以上は「公式版では読めない型」とみなす
 */
export const FORK_TENSOR_TYPE_MIN = 100

/**
 * GGUF を公式の llama-server で実行できない理由 (無ければ null)。
 * - 一部のレイヤーしか無い (投機的デコード用のドラフト)。llama-server はエラーではなくクラッシュ (0xC0000005) する
 * - 公式版に無い量子化の型 (フォーク専用)。llama-server は「invalid ggml type」で読み込みに失敗する
 * header はローカルで解析した値 (テンソル情報まで読んだもの)。無ければファイル名だけで判断する
 */
export function standaloneBlock(name: string, header?: { missingLayers?: number; blockCount?: number; unknownTensorType?: number } | null): string | null {
  const { missingLayers: missing, blockCount, unknownTensorType } = header ?? {}
  if (unknownTensorType !== undefined || isForkOnlyQuantName(name)) {
    return L(
      `公式の llama.cpp に無い独自の量子化${unknownTensorType !== undefined ? ` (ggml 型 ${unknownTensorType})` : ''}のため実行できません (PrismML の Ternary Bonsai など、フォーク版の llama.cpp が必要)。同じリポジトリの Q4_K_M などを選んでください`,
      `Can't run: uses a custom quantization not in the official llama.cpp${unknownTensorType !== undefined ? ` (ggml type ${unknownTensorType})` : ''} (e.g. PrismML's Ternary Bonsai, which needs a forked llama.cpp). Choose Q4_K_M or similar from the same repository`,
    )
  }
  if (missing && blockCount)
    return L(
      `レイヤーが ${blockCount - missing} / ${blockCount} しか入っていないため単体では実行できません (投機的デコード用のドラフトモデルなど。HF Runner は投機的デコードに未対応)`,
      `Can't run on its own: contains only ${blockCount - missing} / ${blockCount} layers (e.g. a draft model for speculative decoding, which HF Runner doesn't support)`,
    )
  if (isDraftName(name))
    return L(
      '投機的デコード用のドラフトモデルで、単体では実行できません (HF Runner は投機的デコードに未対応)',
      "This is a draft model for speculative decoding and can't run on its own (HF Runner doesn't support speculative decoding)",
    )
  return null
}

/** リポジトリ内のファイル一覧から GGUF をエントリ単位(分割ファイルは 1 つ)にまとめる */
export function groupGgufFiles(files: HFFile[], repoId?: string): { entries: ModelEntry[]; mmproj: ModelEntry[] } {
  const groups = new Map<string, { base: string; parts: Array<{ file: HFFile; index: number; total: number }> }>()
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path)) continue
    const m = SPLIT_RE.exec(f.path)
    const base = m ? m[1] : f.path.replace(/\.gguf$/i, '')
    const key = base.toLowerCase()
    let g = groups.get(key)
    if (!g) {
      g = { base, parts: [] }
      groups.set(key, g)
    }
    g.parts.push({ file: f, index: m ? Number(m[2]) : 1, total: m ? Number(m[3]) : 1 })
  }

  const repoParams = repoId ? parseParamsB(repoId.split('/').pop() ?? '') : null
  const entries: ModelEntry[] = []
  const mmproj: ModelEntry[] = []
  for (const [key, g] of groups) {
    g.parts.sort((a, b) => a.index - b.index)
    const total = g.parts[0].total
    // 分割ファイルが揃っていないものは実行できないので除外
    if (g.parts.length !== total) continue
    const baseName = g.base.split('/').pop()!
    const quant = parseQuantName(baseName)
    const isMmproj = /mmproj/i.test(baseName)
    const entry: ModelEntry = {
      key,
      // 表示名と量子化名はデータとしても使う (サイドカーに保存、推論サーバーのモデル名) ので言語を含めない。
      // 分割の注記 (splitSuffix) と「不明」(quantLabel) は表示するときに付ける
      displayName: baseName,
      format: 'gguf',
      quant: quant ?? UNKNOWN_QUANT,
      quantInfo: quantInfo(quant),
      files: g.parts.map((p) => p.file),
      totalSize: g.parts.reduce((a, p) => a + p.file.size, 0),
      isMmproj,
      isSplit: total > 1,
      paramsB: parseParamsB(baseName) ?? repoParams,
      ...(isDraftName(baseName) ? { draft: true } : {}),
    }
    ;(isMmproj ? mmproj : entries).push(entry)
  }
  entries.sort((a, b) => b.totalSize - a.totalSize)
  mmproj.sort((a, b) => b.totalSize - a.totalSize)
  return { entries, mmproj }
}

// Transformers で実行するために必要なファイル(リポジトリ直下のみ)
const TF_INCLUDE = /\.(safetensors|json|txt|model|tiktoken|jinja|py|spm)$/i
const TF_EXCLUDE = /^(readme|.*results|trainer_state|training_args)\.|\.(md|bin|gguf|h5|msgpack|ckpt|pth|pt|onnx)$/i

/** safetensors 一式(重み + 設定 + トークナイザ)を選ぶ。学習ログや他形式の重みは除外 */
export function selectTransformersFiles(files: HFFile[]): HFFile[] {
  return files.filter((f) => !f.path.includes('/') && TF_INCLUDE.test(f.path) && !TF_EXCLUDE.test(f.path))
}

/**
 * 画像生成モデルの候補: ルート直下の大きな .safetensors / .gguf を 1 ファイル 1 エントリにする。
 * 画像生成系のリポジトリ (pipeline が text-to-image など) で使う。実際に 1 ファイルで動くかは中身次第なので、起動時に判定する
 */
export function buildDiffusionEntries(files: HFFile[], repoId?: string): ModelEntry[] {
  const repoParams = repoId ? parseParamsB(repoId.split('/').pop() ?? '') : null
  return files
    .filter((f) => !f.path.includes('/') && /\.(safetensors|gguf)$/i.test(f.path) && f.size >= 100 * 1024 * 1024)
    .map((f) => {
      const base = f.path.replace(/\.(safetensors|gguf)$/i, '')
      const quant = parseQuantName(f.path) ?? (/fp8|f8/i.test(base) ? 'FP8' : /fp16|f16/i.test(base) ? 'F16' : /bf16/i.test(base) ? 'BF16' : /fp32|f32/i.test(base) ? 'F32' : null)
      return {
        key: `diffusion:${f.path.toLowerCase()}`,
        displayName: base,
        format: 'diffusion' as const,
        quant: quant ?? (/\.gguf$/i.test(f.path) ? 'GGUF' : 'safetensors'),
        quantInfo: quantInfo(quant),
        files: [f],
        totalSize: f.size,
        isMmproj: false,
        isSplit: false,
        paramsB: parseParamsB(base) ?? repoParams,
      }
    })
    .sort((a, b) => b.totalSize - a.totalSize)
}

/** リポジトリを Transformers で丸ごと実行するエントリ。safetensors と config.json が無ければ null */
export function buildTransformersEntry(files: HFFile[], repoId: string): ModelEntry | null {
  const selected = selectTransformersFiles(files)
  const weights = selected.filter((f) => /\.safetensors$/i.test(f.path))
  if (weights.length === 0 || !selected.some((f) => f.path === 'config.json')) return null
  const name = repoId.split('/').pop() ?? repoId
  return {
    key: 'transformers',
    displayName: name,
    format: 'safetensors',
    quant: 'safetensors',
    quantInfo: null,
    files: selected,
    totalSize: selected.reduce((a, f) => a + f.size, 0),
    isMmproj: false,
    isSplit: weights.length > 1,
    paramsB: parseParamsB(name),
  }
}
