import { EventEmitter } from 'node:events'
import http from 'node:http'
import os from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { LanStatus, Settings } from '@shared/types'
import { L } from '@shared/i18n'

/** 転送先 (起動中の推論サーバー)。起動していなければ null */
export interface LanTarget {
  port: number
  modelName?: string
}

/** 転送しないヘッダ (接続ごとのものと、このゲートウェイ用の認証) */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'x-api-key'])

export const generateApiKey = () => `hfr-${randomBytes(24).toString('base64url')}`

/** Authorization: Bearer <key> または X-API-Key: <key> が一致するか (時間差で推測されないよう定数時間で比較) */
export function authorized(headers: http.IncomingHttpHeaders, key: string): boolean {
  if (!key) return false
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1]
  const given = bearer ?? (typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : '')
  const a = Buffer.from(given)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 他の機器からは届かない仮想ネットワーク (WSL / Hyper-V / 仮想マシン / Docker / VPN の一部) のアダプター名 */
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|Loopback|Bluetooth/i

/** この PC の LAN 側 IPv4 アドレス (他の機器からの接続先)。仮想アダプターは除く (それしか無ければ残す) */
export function lanAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const all = Object.entries(ifaces).flatMap(([name, list]) => (list ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ name, address: i.address })))
  const real = all.filter((a) => !VIRTUAL_ADAPTER.test(a.name))
  return (real.length > 0 ? real : all).map((a) => a.address)
}

/**
 * サーバーモード: 外部の PC やアプリからのリクエストを受ける入口 (ゲートウェイ)。
 * 全アドレス (0.0.0.0) の固定ポートで待ち受け、API キーを確認してから、127.0.0.1 で動いている推論サーバー
 * (llama-server / server.py / sd-server) へそのまま転送する。推論サーバー自体は外に出さないので、
 * モデルを切り替えて内部のポートが変わっても、外から見える URL とキーは変わらない
 */
export class LanServer extends EventEmitter {
  private srv: http.Server | null = null
  private current: { port: number; key: string } | null = null
  private status: LanStatus = { enabled: false, listening: false, port: 0, urls: [], requests: 0 }

  constructor(private readonly deps: { getSettings: () => Settings; getTarget: () => LanTarget | null }) {
    super()
  }

  getStatus(): LanStatus {
    return { ...this.status, urls: this.status.listening ? lanAddresses().map((a) => `http://${a}:${this.status.port}/v1`) : [] }
  }

  private setStatus(patch: Partial<LanStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.getStatus())
  }

  /** 設定に合わせて起動 / 停止 / 再起動する (設定が変わるたびに呼ぶ) */
  async apply(): Promise<void> {
    const s = this.deps.getSettings()
    if (!s.lanEnabled || !s.lanApiKey) {
      await this.close()
      this.setStatus({ enabled: s.lanEnabled, listening: false, port: s.lanPort, error: undefined })
      return
    }
    if (this.srv && this.current?.port === s.lanPort) {
      // キーだけの変更は作り直さずに反映する (次のリクエストから)
      this.current.key = s.lanApiKey
      return
    }
    await this.close()
    this.current = { port: s.lanPort, key: s.lanApiKey }
    const srv = http.createServer((req, res) => this.handle(req, res))
    this.srv = srv
    await new Promise<void>((resolve) => {
      srv.once('error', (err: NodeJS.ErrnoException) => {
        this.srv = null
        this.current = null
        const error =
          err.code === 'EADDRINUSE'
            ? L(`ポート ${s.lanPort} は他のアプリが使っています。別の番号にしてください`, `Port ${s.lanPort} is in use by another app. Choose a different number`)
            : L(`待ち受けを開始できません: ${err.message}`, `Could not start listening: ${err.message}`)
        this.setStatus({ enabled: true, listening: false, port: s.lanPort, error })
        resolve()
      })
      srv.listen(s.lanPort, '0.0.0.0', () => {
        this.setStatus({ enabled: true, listening: true, port: s.lanPort, error: undefined })
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    const srv = this.srv
    this.srv = null
    this.current = null
    if (!srv) return
    await new Promise<void>((resolve) => {
      srv.close(() => resolve())
      srv.closeAllConnections()
    })
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // ブラウザから呼ぶアプリ向けの CORS。事前確認 (OPTIONS) は認証なしで答える
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key', 'Access-Control-Max-Age': '600' })
      res.end()
      return
    }
    const target = this.deps.getTarget()
    // 死活確認は認証なしで答える (接続できるかの確認用。モデル名は出さない)
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, target ? 200 : 503, { status: target ? 'ok' : 'no model loaded' })
    }
    if (!this.current || !authorized(req.headers, this.current.key)) {
      return json(res, 401, { error: { message: L('API キーが違います。Authorization: Bearer <API キー> を付けてください', 'Invalid API key. Send the header Authorization: Bearer <API key>'), type: 'invalid_api_key' } })
    }
    this.setStatus({ requests: this.status.requests + 1, lastAccess: { from: (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''), path: (req.url ?? '').split('?')[0], at: new Date().toISOString() } })
    if (!target) {
      return json(res, 503, { error: { message: L('モデルが起動していません。HF Runner でモデルを起動してください', 'No model is loaded. Launch a model in HF Runner'), type: 'model_not_loaded' } })
    }

    const headers: http.OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v
    const upstream = http.request({ host: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers }, (up) => {
      const out: http.OutgoingHttpHeaders = {}
      for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k) && k !== 'access-control-allow-origin') out[k] = v
      res.writeHead(up.statusCode ?? 502, out)
      up.pipe(res)
    })
    upstream.on('error', (err) => {
      if (!res.headersSent) json(res, 502, { error: { message: L(`推論サーバーに接続できません: ${err.message}`, `Could not connect to the inference server: ${err.message}`), type: 'upstream_error' } })
      else res.destroy()
    })
    // クライアントが切断したら (ストリーミング中の中止など) 推論サーバー側の要求も止める
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
