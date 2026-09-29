import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Settings } from '../src/shared/types'
import { authorized, generateApiKey, lanAddresses, LanServer, type LanTarget } from '../src/main/lan'

const LAN_PORT = 18931
const KEY = generateApiKey()

// 推論サーバーの代わり。受け取ったヘッダを返し、/stream は少しずつ送る
let upstream: http.Server
let upstreamPort = 0
let target: LanTarget | null = null
let lan: LanServer

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: 1\n\n')
      setTimeout(() => res.end('data: [DONE]\n\n'), 50)
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ path: req.url, method: req.method, auth: req.headers.authorization ?? null, body }))
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  upstreamPort = (upstream.address() as AddressInfo).port
  const settings = { lanEnabled: true, lanPort: LAN_PORT, lanApiKey: KEY } as Settings
  lan = new LanServer({ getSettings: () => settings, getTarget: () => target })
  await lan.apply()
})

afterAll(async () => {
  await lan.close()
  await new Promise<void>((r) => upstream.close(() => r()))
})

const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${LAN_PORT}${path}`, init)
const withKey = (key = KEY): RequestInit => ({ headers: { Authorization: `Bearer ${key}` } })

describe('lanAddresses', () => {
  const nic = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '', mac: '', cidr: null })
  it('lists real adapters and hides WSL / Hyper-V ones', () => {
    expect(lanAddresses({ 'Wi-Fi': [nic('192.168.8.120')], 'vEthernet (WSL (Hyper-V firewall))': [nic('172.25.48.1')], 'Loopback Pseudo-Interface 1': [nic('127.0.0.1', true)] })).toEqual(['192.168.8.120'])
  })
  it('falls back to virtual adapters when nothing else exists', () => {
    expect(lanAddresses({ 'vEthernet (Default Switch)': [nic('172.20.0.1')] })).toEqual(['172.20.0.1'])
  })
})

describe('authorized', () => {
  it('accepts Bearer or X-API-Key with the exact key only', () => {
    expect(authorized({ authorization: `Bearer ${KEY}` }, KEY)).toBe(true)
    expect(authorized({ 'x-api-key': KEY }, KEY)).toBe(true)
    expect(authorized({ authorization: `Bearer ${KEY}x` }, KEY)).toBe(false)
    expect(authorized({}, KEY)).toBe(false)
    expect(authorized({ authorization: 'Bearer ' }, '')).toBe(false)
  })
})

describe('LanServer (server mode gateway)', () => {
  it('listens on all addresses and reports its state', () => {
    const s = lan.getStatus()
    expect(s.listening).toBe(true)
    expect(s.port).toBe(LAN_PORT)
  })
  it('answers /health without a key, and 503 when no model is loaded', async () => {
    target = null
    expect((await call('/health')).status).toBe(503)
    target = { port: upstreamPort }
    expect(await (await call('/health')).json()).toEqual({ status: 'ok' })
  })
  it('rejects requests without the right API key', async () => {
    target = { port: upstreamPort }
    expect((await call('/v1/models')).status).toBe(401)
    expect((await call('/v1/models', withKey('wrong'))).status).toBe(401)
  })
  it('returns 503 with a clear message when no model is running', async () => {
    target = null
    const res = await call('/v1/models', withKey())
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('model_not_loaded')
  })
  it('forwards method, path and body to the running model without the gateway key', async () => {
    target = { port: upstreamPort }
    const res = await call('/v1/chat/completions?x=1', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: '{"a":1}' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: '/v1/chat/completions?x=1', method: 'POST', auth: null, body: '{"a":1}' })
    // CORS ヘッダは 1 つだけ (推論サーバーのものと重複させない)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
  it('passes streaming responses through', async () => {
    target = { port: upstreamPort }
    const text = await (await call('/stream', withKey())).text()
    expect(text).toBe('data: 1\n\ndata: [DONE]\n\n')
  })
  it('counts authenticated requests and records the last access', () => {
    const s = lan.getStatus()
    expect(s.requests).toBeGreaterThan(0)
    expect(s.lastAccess?.path).toBe('/stream')
  })
})
