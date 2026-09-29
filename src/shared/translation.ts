import { L } from './i18n'

export type TranslationModelId = 'qwen3-4b' | 'qwen3-1.7b'

/** プロンプト翻訳に使えるモデル (llama.cpp で CPU 常駐させる GGUF)。どちらも Apache-2.0 */
export interface TranslationModel {
  id: TranslationModelId
  /** Hugging Face のリポジトリと、groupGgufFiles が作るエントリのキー */
  repo: string
  entryKey: string
  label: string
  /** おおよそのダウンロードサイズ (バイト) */
  bytes: number
  note: () => string
}

export const TRANSLATION_MODELS: TranslationModel[] = [
  {
    id: 'qwen3-4b',
    repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    entryKey: 'qwen3-4b-instruct-2507-q4_k_m',
    label: 'Qwen3-4B-Instruct-2507',
    bytes: 2_497_281_120,
    note: () => L('推奨。多くの言語を正確に訳す。1 回 2〜3 秒、メモリ約 3GB', 'Recommended. Accurate in many languages. 2–3 s per prompt, about 3 GB of memory'),
  },
  {
    id: 'qwen3-1.7b',
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    entryKey: 'qwen3-1.7b-q4_k_m',
    label: 'Qwen3-1.7B',
    bytes: 1_107_409_472,
    note: () =>
      L(
        '軽量。1 回約 1 秒、メモリ約 1.5GB。日本語・中国語・韓国語は良好だが、ドイツ語・スペイン語などで訳し間違いがある',
        'Lightweight. About 1 s per prompt, about 1.5 GB of memory. Good for Japanese, Chinese and Korean, but makes mistakes in German, Spanish, etc.',
      ),
  },
]

export const DEFAULT_TRANSLATION_MODEL: TranslationModelId = 'qwen3-4b'

/** 設定の値からモデルを引く (不明な値・古い設定は既定) */
export const translationModel = (id: string | undefined): TranslationModel =>
  TRANSLATION_MODELS.find((m) => m.id === id) ?? TRANSLATION_MODELS.find((m) => m.id === DEFAULT_TRANSLATION_MODEL)!
