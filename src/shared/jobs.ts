// ダウンロードジョブの ID とキー。main とレンダラーの両方で同じ形を使う

/** ダウンロードジョブの ID (リポジトリ + エントリキー) */
export const downloadJobId = (repoId: string, entryKey: string) => `${repoId}::${entryKey}`

const COMPONENT_PREFIX = 'component:'

/** 画像生成モデルの部品 (VAE / テキストエンコーダー) のエントリキー。モデルのエントリと衝突しないよう接頭辞を付ける */
export const componentKey = (source: { path: string }) => `${COMPONENT_PREFIX}${source.path.toLowerCase()}`

export const isComponentKey = (entryKey: string) => entryKey.startsWith(COMPONENT_PREFIX)
