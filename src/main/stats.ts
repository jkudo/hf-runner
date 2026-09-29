import os from 'node:os'
import type { GpuStats, SystemStats } from '@shared/types'
import { numOrNull, queryNvidiaSmi } from './nvidia'

interface CpuSnapshot {
  idle: number
  total: number
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle
  }
  return { idle, total }
}

/** GPU はプロセス起動 (nvidia-smi) が要るので CPU / メモリより間隔を空ける */
const GPU_INTERVAL_MS = 6_000

/** CPU / メモリ / GPU の現在の使用率。サイドバーに数秒おきに表示する */
export class StatsSampler {
  private last: CpuSnapshot | null = null
  private gpuCache: { at: number; gpus: GpuStats[] } | null = null
  /** nvidia-smi が失敗した時刻。しばらくは再試行しない */
  private gpuFailedAt = 0

  async sample(): Promise<SystemStats> {
    const now = cpuSnapshot()
    let cpuPercent: number | null = null
    if (this.last) {
      const dTotal = now.total - this.last.total
      const dIdle = now.idle - this.last.idle
      if (dTotal > 0) cpuPercent = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100))
    }
    this.last = now
    const memTotalBytes = os.totalmem()
    return {
      cpuPercent,
      memUsedBytes: memTotalBytes - os.freemem(),
      memTotalBytes,
      gpus: await this.gpuStats(),
    }
  }

  private async gpuStats(): Promise<GpuStats[]> {
    const now = Date.now()
    if (this.gpuCache && now - this.gpuCache.at < GPU_INTERVAL_MS) return this.gpuCache.gpus
    if (now - this.gpuFailedAt < 60_000) return []
    const rows = await queryNvidiaSmi(['index', 'name', 'utilization.gpu', 'memory.used', 'memory.total'])
    if (rows === null) {
      this.gpuFailedAt = now
      this.gpuCache = null
      return []
    }
    const gpus = parseNvidiaSmi(rows)
    this.gpuCache = { at: now, gpus }
    return gpus
  }
}

/** nvidia-smi の行 (index, name, utilization.gpu, memory.used, memory.total) を GPU ごとの統計に。使用率が "[N/A]" でも VRAM は残す */
export function parseNvidiaSmi(rows: string[][]): GpuStats[] {
  const gpus: GpuStats[] = []
  for (const [index, name, util, used, total] of rows) {
    if (!name) continue
    gpus.push({
      index: numOrNull(index) ?? gpus.length,
      name,
      percent: numOrNull(util),
      vramUsedMiB: numOrNull(used) ?? 0,
      vramTotalMiB: numOrNull(total) ?? 0,
    })
  }
  return gpus
}
