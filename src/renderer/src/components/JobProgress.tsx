import type { DownloadJob } from '@shared/types'
import { formatBytes, formatEta, formatSpeed } from '@shared/format'
import { L } from '@shared/i18n'
import { ProgressBar } from './ProgressBar'

/** ダウンロードジョブ 1 件の進捗バーと状態 (モデル本体・部品で共通の見た目) */
export function JobProgress({ job }: { job: DownloadJob }) {
  if (job.status === 'done') return null
  return (
    <div className="entry-progress">
      <ProgressBar value={job.doneBytes} max={job.totalBytes} />
      <span className="small muted">
        {job.status === 'queued' && L('待機中', 'Queued')}
        {job.status === 'downloading' && `${formatBytes(job.doneBytes)} / ${formatBytes(job.totalBytes)} · ${formatSpeed(job.speedBps)} ${formatEta(job.totalBytes - job.doneBytes, job.speedBps)}`}
        {job.status === 'error' && (
          <span className="err">
            {L('エラー', 'Error')}: {job.error}
          </span>
        )}
        {job.status === 'cancelled' && L('中断しました(再開できます)', 'Stopped (you can resume)')}
      </span>
    </div>
  )
}
