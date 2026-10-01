/** チャットの「最大出力トークン」のスライドバーの目盛り (よく使う値)。これ以外の値は横の入力欄で指定する */
export const MAX_TOKEN_STOPS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768]

export const MIN_MAX_TOKENS = 16
export const MAX_MAX_TOKENS = 1_000_000

/** 値にいちばん近い目盛りの位置。倍率で比べる (3000 は 2048 と 4096 のうち近い 4096 側)。目盛りの外の値は端 */
export function nearestStopIndex(value: number, stops: number[] = MAX_TOKEN_STOPS): number {
  let best = 0
  for (let i = 1; i < stops.length; i++) {
    if (Math.abs(Math.log(value / stops[i])) < Math.abs(Math.log(value / stops[best]))) best = i
  }
  return best
}

/** 手入力の値を整える。数でなければ null、範囲外は 16 〜 1,000,000 に収める */
export function parseMaxTokens(text: string): number | null {
  const n = Math.round(Number(text.replace(/[,\s]/g, '')))
  if (!text.trim() || !Number.isFinite(n)) return null
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, n))
}
