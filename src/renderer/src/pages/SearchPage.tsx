import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HFModelSummary, SearchPipeline, SearchSort } from '@shared/types'
import { formatCount, formatDate } from '@shared/format'
import { L, getLang } from '@shared/i18n'
import { api, errMsg } from '../api'
import { useApp } from '../App'
import { ModelDetail } from './ModelDetail'

// L() は呼んだ時点の言語を返すので、描画のたびに作る
const sortOptions = (): Array<{ id: SearchSort; label: string }> => [
  { id: 'downloads', label: L('ダウンロード数順', 'Most downloads') },
  { id: 'trendingScore', label: L('トレンド順', 'Trending') },
  { id: 'likes', label: L('いいね数順', 'Most likes') },
  { id: 'lastModified', label: L('更新日順', 'Recently updated') },
  { id: 'createdAt', label: L('作成日順', 'Recently created') },
]

export function SearchPage() {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [ggufOnly, setGgufOnly] = useState(false)
  // 種類のチェックボックス。両方 ON = 両方を検索、片方 = その種類だけ、両方 OFF = 種類で絞らない
  const [textGen, setTextGen] = useState(true)
  const [vision, setVision] = useState(true)
  const [imageGen, setImageGen] = useState(false)
  const pipelines = useMemo<SearchPipeline[]>(
    () => [...(textGen ? ['text-generation' as const] : []), ...(vision ? ['image-text-to-text' as const] : []), ...(imageGen ? ['text-to-image' as const] : [])],
    [textGen, vision, imageGen],
  )
  const [sort, setSort] = useState<SearchSort>('downloads')
  const [results, setResults] = useState<HFModelSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const seq = useRef(0)

  const runSearch = useCallback(
    async (q: string, gguf: boolean, p: SearchPipeline[], s: SearchSort) => {
      const id = ++seq.current
      setLoading(true)
      setError(null)
      try {
        const r = await api.hf.search({ query: q, ggufOnly: gguf, pipelines: p, sort: s, limit: 50 })
        if (id === seq.current) setResults(r)
      } catch (e) {
        if (id === seq.current) setError(errMsg(e))
      } finally {
        if (id === seq.current) setLoading(false)
      }
    },
    [],
  )

  // 初回と、フィルタ / 並び順の変更時に検索
  useEffect(() => {
    void runSearch(query, ggufOnly, pipelines, sort)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ggufOnly, pipelines, sort])

  // 他ページから「このモデルを開く」
  useEffect(() => {
    if (app.pendingRepo) {
      setSelected(app.pendingRepo)
      app.clearPendingRepo()
    }
  }, [app])

  return (
    <div className="page">
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault()
          void runSearch(query, ggufOnly, pipelines, sort)
        }}
      >
        <input
          className="search-input"
          placeholder={L('モデル名で検索 (例: Qwen3, gemma, Llama-3.1, ELYZA, owner/repo)', 'Search by model name (e.g. Qwen3, gemma, Llama-3.1, ELYZA, owner/repo)')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button className="primary" type="submit" disabled={loading}>
          {L('検索', 'Search')}
        </button>
        <label className="check" title={L('llama.cpp でそのまま実行できる GGUF 形式のモデルだけに絞る', 'Show only GGUF models that llama.cpp can run directly')}>
          <input type="checkbox" checked={ggufOnly} onChange={(e) => setGgufOnly(e.target.checked)} />
          {L('GGUF のみ', 'GGUF only')}
        </label>
        <label className="check" title={L('pipeline が text-generation のモデルを含める', 'Include models whose pipeline is text-generation')}>
          <input type="checkbox" checked={textGen} onChange={(e) => setTextGen(e.target.checked)} />
          {L('テキスト生成', 'Text generation')}
        </label>
        <label
          className="check"
          title={L(
            'pipeline が image-text-to-text (視覚言語モデル) のモデルを含める。すべて外すと種類で絞りません',
            'Include models whose pipeline is image-text-to-text (vision-language models). Uncheck all to show every type',
          )}
        >
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
          {L('画像入力', 'Image input')}
        </label>
        <label className="check" title={L('pipeline が text-to-image (画像生成モデル) のモデルを含める', 'Include models whose pipeline is text-to-image (image generation models)')}>
          <input type="checkbox" checked={imageGen} onChange={(e) => setImageGen(e.target.checked)} />
          {L('画像生成', 'Image generation')}
        </label>
        <select value={sort} onChange={(e) => setSort(e.target.value as SearchSort)}>
          {sortOptions().map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </form>

      <div className="search-layout">
        <div className="results">
          {error && <div className="error-box">{error}</div>}
          {loading && results.length === 0 && <div className="muted pad">{L('検索中…', 'Searching…')}</div>}
          {!loading && !error && results.length === 0 && (
            <div className="muted pad">
              {L('該当するモデルがありません', 'No matching models')}
              {!imageGen && (
                <div className="small">
                  {L(
                    '画像生成モデル (Stable Diffusion など) を探すときは「画像生成」にチェックを入れてください。',
                    'To find image generation models (such as Stable Diffusion), check "Image generation".',
                  )}
                </div>
              )}
            </div>
          )}
          {results.map((m) => (
            <button key={m.id} className={`result-card ${selected === m.id ? 'selected' : ''}`} onClick={() => setSelected(m.id)}>
              <div className="result-title">
                <span className="result-owner">{m.author}/</span>
                <span className="result-name">{m.id.slice(m.author.length + 1)}</span>
              </div>
              <div className="result-meta">
                <span title={L('ダウンロード数', 'Downloads')}>⬇ {formatCount(m.downloads)}</span>
                <span title={L('いいね', 'Likes')}>♥ {formatCount(m.likes)}</span>
                <span title={L('更新日', 'Last updated')}>{formatDate(m.lastModified ?? m.createdAt)}</span>
                {m.hasGguf && <span className="tag gguf">GGUF</span>}
                {m.hasSafetensors && <span className="tag st">safetensors</span>}
                {!m.hasGguf && !m.hasSafetensors && <span className="tag">{L('他形式', 'Other format')}</span>}
                {m.gated && <span className="tag gated">{L('要同意', 'Gated')}</span>}
                {m.pipelineTag === 'image-text-to-text' ? (
                  <span className="tag ok" title={L('image-text-to-text (視覚言語モデル)', 'image-text-to-text (vision-language model)')}>
                    {L('画像入力', 'Image input')}
                  </span>
                ) : m.pipelineTag === 'text-to-image' || m.pipelineTag === 'image-to-image' ? (
                  <span className="tag img" title={L(`${m.pipelineTag} (画像生成モデル)`, `${m.pipelineTag} (image generation model)`)}>
                    {L('画像生成', 'Image generation')}
                  </span>
                ) : (
                  m.pipelineTag && <span className="tag">{m.pipelineTag}</span>
                )}
              </div>
            </button>
          ))}
        </div>
        <div className="detail">
          {selected ? (
            <ModelDetail repoId={selected} onOpenRepo={setSelected} />
          ) : (
            <div className="empty">
              <div className="empty-icon">🤗</div>
              <p>
                {L(
                  '左の一覧からモデルを選ぶと、量子化ファイルの一覧と、この PC のメモリで動くかの目安を表示します。',
                  "Select a model on the left to see its quantized files and an estimate of whether it fits in this PC's memory.",
                )}
              </p>
              <p className="muted small">
                {getLang() === 'en' ? (
                  <>
                    <span className="tag gguf">GGUF</span> models run efficiently with llama.cpp; <span className="tag st">safetensors</span> models run the original weights as-is with the Python (Transformers) engine. For models without GGUF, you can also look for derived GGUF repositories.
                  </>
                ) : (
                  <>
                    <span className="tag gguf">GGUF</span> は llama.cpp で軽量に実行、<span className="tag st">safetensors</span> は元の重みを Python (Transformers) エンジンでそのまま実行します。GGUF が無いモデルは GGUF 版の派生リポジトリも探せます。
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
