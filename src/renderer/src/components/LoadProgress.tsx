import type { LoadProgress } from '@shared/types'
import { L } from '@shared/i18n'
import { ProgressBar } from './ProgressBar'

// L() は呼んだ時点の言語を返すので、表示のたびに関数で作る
const sourceLabel = (source: LoadProgress['source']): string =>
  source === 'history'
    ? L('前回の読み込み時間から推定', 'estimated from the last load time')
    : source === 'heuristic'
      ? L('ファイルサイズから推定', 'estimated from the file size')
      : ''

/** モデル読み込み中の進捗バー。進捗情報がまだ無いときは不定表示 */
export function LoadProgressView({ progress, compact = false }: { progress?: LoadProgress; compact?: boolean }) {
  if (!progress) return <ProgressBar />
  const pct = Math.round(progress.fraction * 100)
  const sec = Math.floor(progress.elapsedMs / 1000)
  const note = sourceLabel(progress.source)
  return (
    <div className="load-progress">
      <ProgressBar value={pct} max={100} />
      <div className="small muted row gap">
        <span className="load-pct">{pct}%</span>
        <span>{progress.phase}</span>
        <span>{L(`${sec} 秒経過`, `${sec}s elapsed`)}</span>
        {!compact && note && <span>({note})</span>}
      </div>
    </div>
  )
}
