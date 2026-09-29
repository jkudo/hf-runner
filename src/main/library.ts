import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { shell } from 'electron'
import type { ComponentStatus, LibraryModel, ModelHeaderInfo, Settings } from '@shared/types'
import { countSplitParts, groupGgufFiles, parseParamsB, stripSplitSuffix } from '@shared/quant'
import type { ComponentManager } from './components'
import type { Sidecar } from './downloads'
import { fileSource, parseGgufHeader } from './gguf'
import { readDiffusionCheckpoint, readTransformersModel } from './safetensors'
import { hasComponentCatalog, isCatalogComponentPath } from '@shared/diffusion'
import { L } from '@shared/i18n'

interface WalkEntry {
  rel: string
  size: number
  mtimeMs: number
}

const toPosix = (p: string) => p.split(path.sep).join('/')
const toId = (rel: string) => Buffer.from(toPosix(rel)).toString('base64url')
/** ライブラリ直下に置かれたファイルの repoId (表示用。言語は走査した時点のもの) */
const localRepo = () => L('(ローカルファイル)', '(local file)')

/** ダウンロード済みモデルの一覧管理 */
export class LibraryManager extends EventEmitter {
  private headerCache = new Map<string, { mtimeMs: number; header: ModelHeaderInfo | null }>()

  constructor(private readonly deps: { getSettings: () => Settings; components?: ComponentManager }) {
    super()
  }

  /** 部品分割型の画像生成モデルに、必要な部品の状態を付ける。同じ系統の状態は一覧 1 回につき 1 度だけ調べる */
  private withComponents(m: LibraryModel, cache: Map<string, ComponentStatus[]>): LibraryModel {
    const d = m.header?.diffusion
    if (m.format !== 'diffusion' || !d || d.singleFile || !this.deps.components || !hasComponentCatalog(d.family)) return m
    const components = cache.get(d.family) ?? cache.set(d.family, this.deps.components.status(d.family)).get(d.family)!
    return { ...m, components }
  }

  /** 表示言語を変えたときに呼ぶ。ヘッダ情報に含まれる文言 (非対応形式の理由、メタデータの「[N 件]」など) を作り直させる */
  clearHeaderCache(): void {
    this.headerCache.clear()
  }

  async list(): Promise<LibraryModel[]> {
    const root = this.deps.getSettings().modelsDir
    if (!fs.existsSync(root)) return []
    // 部品 (VAE / テキストエンコーダー) は手動で置かれてサイドカーが無くてもモデル扱いしない
    // (T5 の GGUF などは llama.cpp で起動できないため)
    const files = (await walk(root, 5)).filter((f) => !isCatalogComponentPath(toPosix(f.rel)))
    const models: LibraryModel[] = []
    const claimed = new Set<string>()
    const claimedDirs = new Set<string>()

    for (const sc of files.filter((f) => f.rel.endsWith('.hfrunner.json'))) {
      try {
        const data = JSON.parse(await fsp.readFile(path.join(root, sc.rel), 'utf8')) as Sidecar
        const dirRel = path.dirname(sc.rel)
        const dir = path.join(root, dirRel)
        if (!data.files?.length || !data.files.every((f) => fs.existsSync(path.join(dir, f)))) continue
        let format = data.format ?? 'gguf'
        data.files.forEach((f) => claimed.add(path.join(dirRel, f)))
        // 部品 (VAE / テキストエンコーダー) はモデルとして一覧に出さない
        if (data.component) continue
        if (format === 'safetensors') claimedDirs.add(dirRel)
        const mainFile = format === 'safetensors' ? 'config.json' : data.files[0]
        const header =
          format === 'safetensors' ? await this.transformersHeader(dir) : format === 'diffusion' ? await this.diffusionHeader(path.join(dir, mainFile)) : await this.ggufHeader(path.join(dir, mainFile))
        // 画像生成モデルの GGUF を言語モデルとして記録してしまっていても、ヘッダで判定し直す
        if (format === 'gguf' && header?.diffusion) format = 'diffusion'
        const mmprojFile = data.mmproj && fs.existsSync(path.join(dir, data.mmproj)) ? data.mmproj : undefined
        models.push({
          id: toId(path.join(dirRel, mainFile)),
          repoId: data.repoId,
          entryKey: data.entryKey,
          // 旧版は表示名に「(N 分割)」を入れて保存していたので取り除く (表示名は言語を含めずに扱う)
          displayName: stripSplitSuffix(data.displayName),
          splitParts: countSplitParts(data.files) || undefined,
          format,
          quant: data.quant,
          dir,
          mainFile,
          files: data.files,
          totalSize: data.totalSize,
          downloadedAt: data.downloadedAt,
          header,
          hfMeta: data.hfMeta ?? null,
          paramsB: data.paramsB ?? (header?.paramCount ? header.paramCount / 1e9 : null),
          mmprojFile,
          vision: format === 'safetensors' ? !!header?.hasVision : format === 'diffusion' ? false : !!mmprojFile,
        })
      } catch {
        /* 壊れたサイドカーは無視 */
      }
    }

    // サイドカーのない GGUF(手動で置いたファイル)も拾う
    const loose = files.filter((f) => /\.gguf$/i.test(f.rel) && !claimed.has(f.rel))
    const { entries, mmproj } = groupGgufFiles(loose.map((f) => ({ path: toPosix(f.rel), size: f.size })))
    for (const e of entries) {
      const mainFile = e.files[0].path
      const header = await this.ggufHeader(path.join(root, mainFile))
      const mtime = loose.find((f) => toPosix(f.rel) === mainFile)?.mtimeMs ?? Date.now()
      // 同じフォルダに mmproj が置いてあれば画像入力用として紐付ける
      const mm = mmproj.find((m) => path.posix.dirname(m.files[0].path) === path.posix.dirname(mainFile))
      const isDiffusion = !!header?.diffusion
      models.push({
        id: toId(mainFile),
        repoId: localRepo(),
        entryKey: e.key,
        displayName: e.displayName,
        splitParts: e.isSplit ? e.files.length : undefined,
        format: isDiffusion ? 'diffusion' : 'gguf',
        quant: e.quant,
        dir: root,
        mainFile,
        files: e.files.map((f) => f.path),
        totalSize: e.totalSize,
        downloadedAt: new Date(mtime).toISOString(),
        header,
        hfMeta: null,
        paramsB: header?.paramCount ? header.paramCount / 1e9 : parseParamsB(e.displayName),
        mmprojFile: isDiffusion ? undefined : mm?.files[0].path,
        vision: !isDiffusion && !!mm,
      })
    }

    // サイドカーのない 1 ファイルの safetensors (config.json が無いフォルダ) は、拡散モデルのチェックポイントかもしれない
    for (const f of files) {
      if (!/\.safetensors$/i.test(f.rel) || claimed.has(f.rel)) continue
      const dirRel = path.dirname(f.rel)
      if (claimedDirs.has(dirRel) || fs.existsSync(path.join(root, dirRel, 'config.json'))) continue
      const header = await this.diffusionHeader(path.join(root, f.rel))
      if (!header?.diffusion) continue
      const rel = toPosix(f.rel)
      const name = path.basename(f.rel).replace(/\.safetensors$/i, '')
      models.push({
        id: toId(rel),
        repoId: dirRel === '.' ? localRepo() : toPosix(dirRel),
        entryKey: name.toLowerCase(),
        displayName: name,
        format: 'diffusion',
        quant: header.dtype ?? 'safetensors',
        dir: root,
        mainFile: rel,
        files: [rel],
        totalSize: f.size,
        downloadedAt: new Date(f.mtimeMs).toISOString(),
        header,
        hfMeta: null,
        paramsB: header.paramCount ? header.paramCount / 1e9 : null,
        vision: false,
      })
    }

    // サイドカーのない safetensors フォルダ(config.json + *.safetensors)
    const stDirs = new Map<string, WalkEntry[]>()
    for (const f of files) {
      if (!/\.safetensors$/i.test(f.rel)) continue
      const dirRel = path.dirname(f.rel)
      if (claimedDirs.has(dirRel)) continue
      const list = stDirs.get(dirRel) ?? []
      list.push(f)
      stDirs.set(dirRel, list)
    }
    for (const [dirRel, weights] of stDirs) {
      const dir = path.join(root, dirRel)
      if (!fs.existsSync(path.join(dir, 'config.json'))) continue
      const inDir = files.filter((f) => path.dirname(f.rel) === dirRel)
      const header = await this.transformersHeader(dir)
      const name = dirRel === '.' ? path.basename(root) : path.basename(dirRel)
      models.push({
        id: toId(path.join(dirRel, 'config.json')),
        repoId: dirRel === '.' ? localRepo() : toPosix(dirRel),
        entryKey: 'transformers',
        displayName: name,
        format: 'safetensors',
        quant: header?.dtype ?? 'safetensors',
        dir,
        mainFile: 'config.json',
        files: inDir.map((f) => path.basename(f.rel)),
        totalSize: inDir.reduce((a, f) => a + f.size, 0),
        downloadedAt: new Date(Math.max(...weights.map((w) => w.mtimeMs))).toISOString(),
        header,
        hfMeta: null,
        paramsB: header?.paramCount ? header.paramCount / 1e9 : parseParamsB(name),
        vision: !!header?.hasVision,
      })
    }

    const componentCache = new Map<string, ComponentStatus[]>()
    return models.map((m) => this.withComponents(m, componentCache)).sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt))
  }

  async get(id: string): Promise<LibraryModel | undefined> {
    return (await this.list()).find((m) => m.id === id)
  }

  async remove(id: string): Promise<void> {
    const m = await this.get(id)
    if (!m) return
    for (const f of m.files) await fsp.rm(path.join(m.dir, f), { force: true })
    for (const f of await fsp.readdir(m.dir).catch(() => [] as string[])) {
      if (f.endsWith('.hfrunner.json')) {
        const data = JSON.parse(await fsp.readFile(path.join(m.dir, f), 'utf8').catch(() => '{}')) as Partial<Sidecar>
        if (data.entryKey === m.entryKey) await fsp.rm(path.join(m.dir, f), { force: true })
      }
    }
    await removeEmptyDirs(m.dir, this.deps.getSettings().modelsDir)
    this.emit('change')
  }

  async openFolder(id: string): Promise<void> {
    const m = await this.get(id)
    if (m) shell.showItemInFolder(path.join(m.dir, m.mainFile))
  }

  private async ggufHeader(abs: string): Promise<ModelHeaderInfo | null> {
    const st = await fsp.stat(abs).catch(() => null)
    if (!st) return null
    const cached = this.headerCache.get(abs)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.header
    const header = await parseGgufHeader(fileSource(abs), { parseTensors: true, fileName: path.basename(abs) }).catch(() => null)
    this.headerCache.set(abs, { mtimeMs: st.mtimeMs, header })
    return header
  }

  /** 画像生成モデル (1 ファイル)。.gguf は GGUF ヘッダ、.safetensors はキーで判定する */
  private async diffusionHeader(abs: string): Promise<ModelHeaderInfo | null> {
    if (/\.gguf$/i.test(abs)) return this.ggufHeader(abs)
    const st = await fsp.stat(abs).catch(() => null)
    if (!st) return null
    const cached = this.headerCache.get(abs)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.header
    const header = await readDiffusionCheckpoint(abs).catch(() => null)
    this.headerCache.set(abs, { mtimeMs: st.mtimeMs, header })
    return header
  }

  private async transformersHeader(dir: string): Promise<ModelHeaderInfo | null> {
    const cfg = path.join(dir, 'config.json')
    const st = await fsp.stat(cfg).catch(() => null)
    if (!st) return null
    const cached = this.headerCache.get(cfg)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.header
    const header = await readTransformersModel(dir).catch(() => null)
    this.headerCache.set(cfg, { mtimeMs: st.mtimeMs, header })
    return header
  }
}

async function walk(root: string, maxDepth: number): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  async function rec(dir: string, depth: number) {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth && !e.name.startsWith('.')) await rec(abs, depth + 1)
      } else if (e.isFile()) {
        const st = await fsp.stat(abs).catch(() => null)
        if (st) out.push({ rel: path.relative(root, abs), size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }
  await rec(root, 0)
  return out
}

async function removeEmptyDirs(dir: string, stopAt: string): Promise<void> {
  let cur = path.resolve(dir)
  const stop = path.resolve(stopAt)
  while (cur !== stop && cur.startsWith(stop)) {
    const entries = await fsp.readdir(cur).catch(() => null)
    if (!entries || entries.length > 0) return
    await fsp.rmdir(cur).catch(() => {})
    cur = path.dirname(cur)
  }
}
