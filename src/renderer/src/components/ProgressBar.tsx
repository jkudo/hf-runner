export function ProgressBar({ value, max, className = '' }: { value?: number; max?: number; className?: string }) {
  const pct = max && value !== undefined ? Math.min(100, Math.max(0, (value / max) * 100)) : null
  return (
    <div className={`progress ${className}`}>
      <div className={`progress-fill ${pct === null ? 'indeterminate' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  )
}
