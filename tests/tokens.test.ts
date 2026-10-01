import { describe, expect, it } from 'vitest'
import { MAX_TOKEN_STOPS, nearestStopIndex, parseMaxTokens } from '../src/shared/tokens'

describe('nearestStopIndex', () => {
  it('finds the exact stop', () => {
    MAX_TOKEN_STOPS.forEach((v, i) => expect(nearestStopIndex(v)).toBe(i))
  })
  it('picks the nearest stop by ratio, clamping values outside the range to the ends', () => {
    expect(MAX_TOKEN_STOPS[nearestStopIndex(3000)]).toBe(4096)
    expect(MAX_TOKEN_STOPS[nearestStopIndex(2500)]).toBe(2048)
    expect(nearestStopIndex(16)).toBe(0)
    expect(nearestStopIndex(999999)).toBe(MAX_TOKEN_STOPS.length - 1)
  })
})

describe('parseMaxTokens', () => {
  it('accepts plain and comma-separated numbers', () => {
    expect(parseMaxTokens('3000')).toBe(3000)
    expect(parseMaxTokens('12,000')).toBe(12000)
    expect(parseMaxTokens(' 4096 ')).toBe(4096)
  })
  it('clamps to the allowed range', () => {
    expect(parseMaxTokens('1')).toBe(16)
    expect(parseMaxTokens('99999999')).toBe(1_000_000)
  })
  it('rejects empty or non-numeric input', () => {
    expect(parseMaxTokens('')).toBeNull()
    expect(parseMaxTokens('abc')).toBeNull()
  })
})
