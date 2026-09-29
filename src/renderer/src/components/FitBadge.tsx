import type { FitResult } from '@shared/types'

const ICON: Record<FitResult['level'], string> = { gpu: '●', 'gpu-partial': '◐', cpu: '○', no: '✕', unknown: '…' }

export function FitBadge({ fit, compact = false }: { fit: FitResult; compact?: boolean }) {
  return (
    <span className={`fit fit-${fit.level}`} title={fit.detail}>
      <span className="fit-icon">{ICON[fit.level]}</span>
      {!compact && <span>{fit.label}</span>}
    </span>
  )
}
