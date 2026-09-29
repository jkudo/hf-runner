import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, shell: {} }))
const { isPortFree } = await import('../src/main/server')

const PORT = 18923
let blocker: net.Server | null = null

const listen = (host: string) =>
  new Promise<net.Server>((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(PORT, host, () => resolve(s))
  })

afterEach(async () => {
  await new Promise<void>((r) => (blocker ? blocker.close(() => r()) : r()))
  blocker = null
})

describe('isPortFree', () => {
  it('treats a port as free when nothing listens on it', async () => {
    expect(await isPortFree(PORT)).toBe(true)
  })
  it('detects another app on 127.0.0.1', async () => {
    blocker = await listen('127.0.0.1')
    expect(await isPortFree(PORT)).toBe(false)
  })
  // Windows では 0.0.0.0 で待ち受ける他のアプリがいても 127.0.0.1 を開けてしまい、localhost の通信を横取りする
  it('detects another app listening on all addresses (0.0.0.0)', async () => {
    blocker = await listen('0.0.0.0')
    expect(await isPortFree(PORT)).toBe(false)
  })
})
