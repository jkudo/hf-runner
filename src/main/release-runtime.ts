import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import extract from 'extract-zip'
import type { RuntimeProgress } from '@shared/types'
import { L } from '@shared/i18n'

/** コマンドを実行して標準出力と標準エラーをまとめて返す (--list-devices など)。出力があれば終了コードは問わない */
export function runCapture(file: string, args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`
      if (err && !out.trim()) reject(err)
      else resolve(out)
    })
  })
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

export interface Release {
  tag_name: string
  prerelease: boolean
  published_at: string
  assets: ReleaseAsset[]
}

export interface AssetRule {
  main: RegExp
  /** CUDA ランタイム DLL など、同じフォルダに展開する追加アーカイブ */
  extra?: RegExp
}

/** GitHub のリリースから取得する推論サーバー (llama.cpp / stable-diffusion.cpp) の定義 */
export interface ReleaseSpec<B extends string> {
  /** 表示名 (llama.cpp など) */
  productLabel: string
  releasesUrl: string
  /** 展開したファイルから探す実行ファイル名 (拡張子なし) */
  exeName: string
  /** バイナリ付きのビルドのタグか。バージョンタグには資産が無いことがある */
  isBuildTag: (tag: string) => boolean
  /** プラットフォーム (platformKey) → バックエンド → 資産名パターン */
  rules: Record<string, Partial<Record<B, AssetRule>>>
  labels: Record<B, { label: string; description: string }>
  recommend: (platform: string, arch: string) => B
}

export interface InstalledInfo<B extends string> {
  installed: boolean
  backend?: B
  tag?: string
  serverPath?: string
  dir?: string
  installedAt?: string
}

export const platformKey = (platform: string, arch: string) => `${platform}-${arch}`

export function backendOptions<B extends string>(spec: ReleaseSpec<B>, platform: string, arch: string): Array<{ id: B; label: string; description: string; recommended: boolean }> {
  const rules = spec.rules[platformKey(platform, arch)] ?? {}
  const rec = spec.recommend(platform, arch)
  return (Object.keys(rules) as B[]).map((id) => ({ id, ...spec.labels[id], recommended: id === rec }))
}

export function selectAssets<B extends string>(spec: ReleaseSpec<B>, release: Release, backend: B, platform: string, arch: string): ReleaseAsset[] {
  const key = platformKey(platform, arch)
  const rule = spec.rules[key]?.[backend]
  if (!rule) throw new Error(L(`このプラットフォーム (${key}) では ${spec.labels[backend].label} は利用できません`, `${spec.labels[backend].label} is not available on this platform (${key})`))
  const main = release.assets.find((a) => rule.main.test(a.name))
  if (!main) throw new Error(L(`リリース ${release.tag_name} に ${spec.labels[backend].label} 用のバイナリが見つかりません`, `Release ${release.tag_name} has no binaries for ${spec.labels[backend].label}`))
  const list = [main]
  if (rule.extra) {
    const extra = release.assets.find((a) => rule.extra!.test(a.name))
    if (extra) list.push(extra)
  }
  return list
}

/** そのリリースに backend 用の資産 (本体と、必要なら cudart) が揃っているか */
export function hasAssetsFor<B extends string>(spec: ReleaseSpec<B>, release: Release, backend: B, platform: string, arch: string): boolean {
  const rule = spec.rules[platformKey(platform, arch)]?.[backend]
  if (!rule) return false
  const has = (re: RegExp) => release.assets.some((a) => re.test(a.name))
  return has(rule.main) && (!rule.extra || has(rule.extra))
}

/**
 * バイナリ付きの最新ビルドを選ぶ。backend を渡すと、そのバックエンド用の資産が揃っている最新のリリースを選ぶ。
 * CI が資産を順次アップロードするので、公開直後のリリースは一部の資産しか無いことがある
 */
export function pickRelease<B extends string>(spec: ReleaseSpec<B>, releases: Release[], backend?: B, platform = process.platform, arch = process.arch): Release | null {
  return releases.find((r) => spec.isBuildTag(r.tag_name) && r.assets.length > 0 && (backend === undefined || hasAssetsFor(spec, r, backend, platform, arch))) ?? null
}

/** GitHub リリースの取得・展開・バージョン管理。rootDir/<backend>-<tag>/ に展開し、current.json に記録する */
export class ReleaseRuntime<B extends string> extends EventEmitter {
  private releaseCache: { at: number; releases: Release[] } | null = null

  constructor(
    protected readonly spec: ReleaseSpec<B>,
    protected readonly rootDir: string,
  ) {
    super()
  }

  private get infoPath() {
    return path.join(this.rootDir, 'current.json')
  }

  async getInfo(): Promise<InstalledInfo<B>> {
    try {
      // serverRel(rootDir からの相対パス)を優先して解決し、フォルダごと移動されても見つかるようにする
      const { serverRel, ...info } = JSON.parse(await fsp.readFile(this.infoPath, 'utf8')) as InstalledInfo<B> & { serverRel?: string }
      const serverPath = serverRel ? path.join(this.rootDir, serverRel) : info.serverPath
      if (serverPath && fs.existsSync(serverPath)) return { ...info, serverPath, dir: path.dirname(serverPath), installed: true }
    } catch {
      /* 未インストール */
    }
    return { installed: false }
  }

  async fetchReleases(force = false): Promise<Release[]> {
    if (!force && this.releaseCache && Date.now() - this.releaseCache.at < 10 * 60_000) return this.releaseCache.releases
    const res = await fetch(this.spec.releasesUrl, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hfrunner/0.1' } })
    if (!res.ok) throw new Error(L(`GitHub API エラー (HTTP ${res.status})。しばらく待ってから再試行してください`, `GitHub API error (HTTP ${res.status}). Please wait a while and try again`))
    const releases = (await res.json()) as Release[]
    this.releaseCache = { at: Date.now(), releases }
    return releases
  }

  /** backend 用の資産が揃っている最新リリース。無ければ理由付きで例外 */
  async latestInstallable(backend: B, force = false): Promise<Release> {
    const releases = await this.fetchReleases(force)
    const release = pickRelease(this.spec, releases, backend)
    if (release) return release
    const newest = pickRelease(this.spec, releases)
    const label = this.spec.labels[backend].label
    throw new Error(
      newest
        ? L(
            `${label} 用のバイナリを含む ${this.spec.productLabel} リリースが見つかりません (最新 ${newest.tag_name} はアップロード途中の可能性があります。しばらく待つか、別のバックエンドを選んでください)`,
            `No ${this.spec.productLabel} release with binaries for ${label} was found (the latest, ${newest.tag_name}, may still be uploading. Wait a while or choose another backend)`,
          )
        : L(`バイナリ付きの ${this.spec.productLabel} リリースが見つかりません`, `No ${this.spec.productLabel} release with binaries was found`),
    )
  }

  async install(backend: B): Promise<InstalledInfo<B>> {
    const progress = (p: RuntimeProgress) => this.emit('progress', p)
    try {
      progress({ state: 'fetching', message: L(`最新の ${this.spec.productLabel} リリースを確認しています…`, `Checking for the latest ${this.spec.productLabel} release…`) })
      const release = await this.latestInstallable(backend, true)
      const assets = selectAssets(this.spec, release, backend, process.platform, process.arch)
      const targetDir = path.join(this.rootDir, `${backend}-${release.tag_name}`)
      const tmpDir = path.join(this.rootDir, 'tmp')
      await fsp.rm(tmpDir, { recursive: true, force: true })
      await fsp.rm(targetDir, { recursive: true, force: true })
      await fsp.mkdir(tmpDir, { recursive: true })
      await fsp.mkdir(targetDir, { recursive: true })

      const totalBytes = assets.reduce((a, b) => a + b.size, 0)
      let doneBytes = 0
      for (const asset of assets) {
        const archive = path.join(tmpDir, asset.name)
        await downloadToFile(asset.browser_download_url, archive, (n) =>
          progress({ state: 'downloading', message: L(`${asset.name} をダウンロード中`, `Downloading ${asset.name}`), doneBytes: doneBytes + n, totalBytes }),
        )
        doneBytes += asset.size
        progress({ state: 'extracting', message: L(`${asset.name} を展開中…`, `Extracting ${asset.name}…`), doneBytes, totalBytes })
        await extractArchive(archive, targetDir)
      }

      const exe = process.platform === 'win32' ? `${this.spec.exeName}.exe` : this.spec.exeName
      const serverPath = await findFile(targetDir, exe)
      if (!serverPath) throw new Error(L(`展開したファイルに ${this.spec.exeName} が見つかりません`, `${this.spec.exeName} was not found in the extracted files`))
      if (process.platform !== 'win32') await fsp.chmod(serverPath, 0o755).catch(() => {})

      const info: InstalledInfo<B> = { installed: true, backend, tag: release.tag_name, serverPath, dir: path.dirname(serverPath), installedAt: new Date().toISOString() }
      await fsp.writeFile(this.infoPath, JSON.stringify({ ...info, serverRel: path.relative(this.rootDir, serverPath) }, null, 2))
      await fsp.rm(tmpDir, { recursive: true, force: true })
      // 古いランタイムは削除
      for (const name of await fsp.readdir(this.rootDir)) {
        const p = path.join(this.rootDir, name)
        if (p !== targetDir && (await fsp.stat(p)).isDirectory()) await fsp.rm(p, { recursive: true, force: true }).catch(() => {})
      }
      this.onInstalled()
      progress({
        state: 'done',
        message: L(
          `${this.spec.productLabel} ${release.tag_name} (${this.spec.labels[backend].label}) をインストールしました`,
          `Installed ${this.spec.productLabel} ${release.tag_name} (${this.spec.labels[backend].label})`,
        ),
        doneBytes: totalBytes,
        totalBytes,
      })
      return info
    } catch (err) {
      progress({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  /** インストール直後の後処理 (キャッシュの破棄など) */
  protected onInstalled(): void {}
}

export async function downloadToFile(url: string, dest: string, onProgress: (done: number) => void): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'hfrunner/0.1' }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(L(`ダウンロードに失敗しました (HTTP ${res.status}): ${url}`, `Download failed (HTTP ${res.status}): ${url}`))
  let done = 0
  let last = 0
  const progress = new Transform({
    transform: (chunk: Buffer, _enc, cb) => {
      done += chunk.length
      const now = Date.now()
      if (now - last > 200) {
        last = now
        onProgress(done)
      }
      cb(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), progress, fs.createWriteStream(dest))
  onProgress(done)
}

export async function extractArchive(archive: string, dir: string): Promise<void> {
  if (archive.endsWith('.zip')) {
    await extract(archive, { dir })
    return
  }
  if (/\.tar\.gz$|\.tgz$/.test(archive)) {
    await new Promise<void>((resolve, reject) => {
      const p = spawn('tar', ['-xzf', archive, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      p.stderr.on('data', (d: Buffer) => (err += d.toString()))
      p.on('error', reject)
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(L(`tar の展開に失敗しました: ${err}`, `tar extraction failed: ${err}`)))))
    })
    return
  }
  throw new Error(L(`未対応のアーカイブ形式: ${archive}`, `Unsupported archive format: ${archive}`))
}

export async function findFile(dir: string, name: string): Promise<string | null> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isFile() && e.name === name) return path.join(dir, e.name)
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findFile(path.join(dir, e.name), name)
      if (found) return found
    }
  }
  return null
}
