import { describe, expect, it } from 'vitest'
import { numOrNull, splitCsv } from '../src/main/nvidia'
import { parseNvidiaSmi } from '../src/main/stats'

describe('parseNvidiaSmi', () => {
  it('returns one entry per GPU', () => {
    const rows = splitCsv('0, NVIDIA GeForce RTX 4090, 37, 5120, 24564\n1, NVIDIA RTX A6000, 0, 812, 49140\n')
    expect(parseNvidiaSmi(rows)).toEqual([
      { index: 0, name: 'NVIDIA GeForce RTX 4090', percent: 37, vramUsedMiB: 5120, vramTotalMiB: 24564 },
      { index: 1, name: 'NVIDIA RTX A6000', percent: 0, vramUsedMiB: 812, vramTotalMiB: 49140 },
    ])
  })
  it('keeps a GPU whose utilization is [N/A] so its VRAM is still shown', () => {
    expect(parseNvidiaSmi(splitCsv('0, NVIDIA GeForce MX450, [N/A], 812, 2048\n'))).toEqual([
      { index: 0, name: 'NVIDIA GeForce MX450', percent: null, vramUsedMiB: 812, vramTotalMiB: 2048 },
    ])
  })
  it('ignores empty output', () => {
    expect(parseNvidiaSmi(splitCsv(''))).toEqual([])
    expect(parseNvidiaSmi(splitCsv('\n\n'))).toEqual([])
  })
})

describe('numOrNull', () => {
  it('maps [N/A] / empty to null', () => {
    expect(numOrNull('37')).toBe(37)
    expect(numOrNull('[N/A]')).toBeNull()
    expect(numOrNull('')).toBeNull()
    expect(numOrNull(undefined)).toBeNull()
  })
})
