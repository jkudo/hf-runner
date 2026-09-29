import { L } from './i18n'

export function formatBytes(n: number | undefined | null, digits = 2): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '-'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`
}

export function formatCount(n: number | undefined | null): string {
  if (n === undefined || n === null) return '-'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

export function formatParams(paramsB: number | null | undefined): string {
  if (paramsB === null || paramsB === undefined) return '-'
  if (paramsB < 1) return `${Math.round(paramsB * 1000)}M`
  return `${Number(paramsB.toFixed(1))}B`
}

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export function formatSpeed(bps: number): string {
  if (!bps) return ''
  return `${formatBytes(bps, 1)}/s`
}

export function formatEta(remainingBytes: number, bps: number): string {
  if (!bps || remainingBytes <= 0) return ''
  const s = Math.round(remainingBytes / bps)
  if (s < 60) return L(`残り ${s} 秒`, `${s} s left`)
  if (s < 3600) return L(`残り ${Math.round(s / 60)} 分`, `${Math.round(s / 60)} min left`)
  return L(`残り ${(s / 3600).toFixed(1)} 時間`, `${(s / 3600).toFixed(1)} h left`)
}
