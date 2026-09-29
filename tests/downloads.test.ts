import { describe, expect, it } from 'vitest'
import type { DownloadJob, DownloadStatus, Settings } from '../src/shared/types'
import type { HfClient } from '../src/main/hf'
import { DownloadManager, planSegments } from '../src/main/downloads'

const MB = 1024 * 1024

describe('planSegments', () => {
  it('splits a large file into contiguous ranges covering every byte', () => {
    const size = 100 * MB + 123
    const segs = planSegments(size, 4)
    expect(segs).toHaveLength(4)
    expect(segs[0].start).toBe(0)
    expect(segs[segs.length - 1].end).toBe(size - 1)
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end + 1)
    expect(segs.reduce((a, g) => a + (g.end - g.start + 1), 0)).toBe(size)
    expect(segs.every((g) => g.done === 0)).toBe(true)
  })
  it('uses fewer connections when the file is small relative to the minimum segment size', () => {
    expect(planSegments(20 * MB, 8)).toHaveLength(2)
    expect(planSegments(5 * MB, 8)).toHaveLength(1)
    expect(planSegments(5 * MB, 8)[0]).toEqual({ start: 0, end: 5 * MB - 1, done: 0 })
  })
  it('handles edge cases', () => {
    expect(planSegments(0, 4)).toEqual([])
    expect(planSegments(64 * MB, 1)).toHaveLength(1)
  })
})

describe('DownloadManager.cancel', () => {
  // ダウンロードは走らせず、ジョブの状態だけを置いて cancel の扱いを見る
  const managerWith = (status: DownloadStatus, queued = false) => {
    const dm = new DownloadManager({ hf: {} as HfClient, getSettings: () => ({ modelsDir: '.' }) as Settings })
    const job = { id: 'j', repoId: 'r', entryKey: 'e', displayName: 'e', format: 'gguf', quant: 'Q4_K_M', files: [], destDir: '.', totalBytes: 1, doneBytes: 1, speedBps: 0, status, createdAt: 0, updatedAt: 0 } as DownloadJob
    const internal = dm as unknown as { states: Map<string, unknown>; queue: string[] }
    internal.states.set('j', { job, entry: {}, mmproj: null, component: false, hfMeta: null, controller: null, lastTickAt: 0, lastTickBytes: 0 })
    if (queued) internal.queue.push('j')
    return { dm, job, internal }
  }
  it('leaves finished jobs alone (a completed download must not turn into "stopped")', () => {
    for (const status of ['done', 'error', 'cancelled'] as const) {
      const { dm, job } = managerWith(status)
      dm.cancel('j')
      expect(job.status, status).toBe(status)
    }
  })
  it('cancels a queued job and removes it from the queue', () => {
    const { dm, job, internal } = managerWith('queued', true)
    dm.cancel('j')
    expect(job.status).toBe('cancelled')
    expect(internal.queue).toEqual([])
  })
})
