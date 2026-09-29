import type {
  HFFile,
  HFGgufMeta,
  HFModelConfig,
  HFModelInfo,
  HFModelSummary,
  HFSafetensorsMeta,
  ModelHeaderInfo,
  RepoFilesResult,
  SearchOptions,
} from '@shared/types'
import path from 'node:path'
import { buildDiffusionEntries, buildTransformersEntry, groupGgufFiles } from '@shared/quant'
import { parseHfConfig } from '@shared/config'
import { L } from '@shared/i18n'
import { needsTensorCheck, type DiffusionInfo } from '@shared/diffusion'
import { cachingSource, parseGgufHeader, remoteSource } from './gguf'
import { diffusionInfoFromHeader, parseSafetensorsHeaderJson } from './safetensors'

export const HF_BASE = 'https://huggingface.co'

export class HfError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function describeHttp(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return L(
        'アクセスが拒否されました。このモデルは利用規約への同意(gated)が必要です。Hugging Face でアクセスを申請し、設定画面で HF トークンを入力してください',
        'Access denied. This model requires accepting its terms (gated). Request access on Hugging Face and enter your HF token in Settings',
      )
    case 404:
      return L('モデルまたはファイルが見つかりません', 'Model or file not found')
    case 429:
      return L('リクエストが多すぎます。しばらく待ってから再試行してください', 'Too many requests. Please wait a while and try again')
    default:
      return L(`Hugging Face との通信に失敗しました (HTTP ${status})`, `Failed to communicate with Hugging Face (HTTP ${status})`)
  }
}

interface RawModel {
  id: string
  author?: string
  likes?: number
  downloads?: number
  tags?: string[]
  pipeline_tag?: string
  library_name?: string
  createdAt?: string
  lastModified?: string
  trendingScore?: number
  gated?: boolean | 'auto' | 'manual'
  sha?: string
  gguf?: HFGgufMeta
  safetensors?: HFSafetensorsMeta
  config?: { model_type?: string; architectures?: string[] }
  siblings?: Array<{ rfilename: string }>
  cardData?: { license?: string | string[]; language?: string | string[]; base_model?: string | string[] }
}

interface RawTreeEntry {
  type: 'file' | 'directory'
  path: string
  size?: number
  lfs?: { size?: number }
}

const asList = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : [])

function toSummary(raw: RawModel): HFModelSummary {
  const tags = raw.tags ?? []
  return {
    id: raw.id,
    author: raw.author ?? raw.id.split('/')[0],
    likes: raw.likes ?? 0,
    downloads: raw.downloads ?? 0,
    tags,
    pipelineTag: raw.pipeline_tag,
    libraryName: raw.library_name,
    createdAt: raw.createdAt,
    lastModified: raw.lastModified,
    trendingScore: raw.trendingScore,
    gated: raw.gated === true ? 'manual' : raw.gated || false,
    hasGguf: tags.includes('gguf'),
    hasSafetensors: tags.includes('safetensors'),
  }
}

const EXPAND = ['gated', 'lastModified', 'downloads', 'likes', 'tags', 'pipeline_tag', 'library_name', 'createdAt', 'trendingScore']

/** Hugging Face Hub API クライアント */
export class HfClient {
  constructor(private readonly getToken: () => string) {}

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'User-Agent': 'hfrunner/0.1', ...extra }
    const token = this.getToken().trim()
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }

  private async getJson<T>(url: string): Promise<{ data: T; headers: Headers }> {
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      await res.body?.cancel()
      throw new HfError(res.status, describeHttp(res.status))
    }
    return { data: (await res.json()) as T, headers: res.headers }
  }

  async search(opts: SearchOptions): Promise<HFModelSummary[]> {
    const query = opts.query.trim()
    const limit = opts.limit ?? 40
    // HF API の pipeline_tag は 1 つしか指定できないので、種類が複数のときは種類ごとに検索して統合する
    const pipelines: Array<string | undefined> = opts.pipelines.length > 0 ? opts.pipelines : [undefined]
    const lists = await Promise.all(pipelines.map((p) => this.searchOnce(query, opts, p, limit)))
    const seen = new Set<string>()
    const results: HFModelSummary[] = []
    for (const list of lists) for (const m of list) if (!seen.has(m.id)) { seen.add(m.id); results.push(m) }
    if (lists.length > 1) {
      const key = (m: HFModelSummary) => (m as unknown as Record<string, number | string | undefined>)[opts.sort] ?? 0
      results.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0))
      results.splice(limit)
    }

    // "owner/name" 形式で入力された場合はそのリポジトリを先頭に出す
    if (/^[\w.-]+\/[\w.-]+$/.test(query) && !results.some((r) => r.id.toLowerCase() === query.toLowerCase())) {
      const exact = await this.modelInfo(query).catch(() => null)
      if (exact && (!opts.ggufOnly || exact.hasGguf)) results.unshift(exact)
    }
    return results
  }

  private async searchOnce(query: string, opts: SearchOptions, pipelineTag: string | undefined, limit: number): Promise<HFModelSummary[]> {
    const params = new URLSearchParams()
    if (query) params.set('search', query)
    if (opts.ggufOnly) params.set('filter', 'gguf')
    if (pipelineTag) params.set('pipeline_tag', pipelineTag)
    params.set('sort', opts.sort)
    params.set('direction', '-1')
    params.set('limit', String(limit))
    for (const e of EXPAND) params.append('expand[]', e)
    const { data } = await this.getJson<RawModel[]>(`${HF_BASE}/api/models?${params}`)
    return data.map(toSummary)
  }

  async modelInfo(repoId: string): Promise<HFModelInfo> {
    const { data } = await this.getJson<RawModel>(`${HF_BASE}/api/models/${encodeRepo(repoId)}`)
    const siblings = data.siblings?.map((s) => s.rfilename) ?? []
    const summary = toSummary(data)
    return {
      ...summary,
      sha: data.sha,
      gguf: data.gguf,
      safetensors: data.safetensors,
      modelType: data.config?.model_type,
      architectures: data.config?.architectures ?? [],
      baseModels: asList(data.cardData?.base_model),
      license: asList(data.cardData?.license)[0],
      languages: asList(data.cardData?.language),
      hasSafetensors: summary.hasSafetensors || siblings.some((f) => f.endsWith('.safetensors')),
      hasGguf: summary.hasGguf || siblings.some((f) => /\.gguf$/i.test(f)),
    }
  }

  async listFiles(repoId: string, revision = 'main'): Promise<RepoFilesResult> {
    const files: HFFile[] = []
    let url: string | null = `${HF_BASE}/api/models/${encodeRepo(repoId)}/tree/${encodeURIComponent(revision)}?recursive=true`
    for (let page = 0; url && page < 10; page++) {
      const { data, headers } = await this.getJson<RawTreeEntry[]>(url)
      for (const e of data) {
        if (e.type !== 'file') continue
        files.push({ path: e.path, size: e.lfs?.size ?? e.size ?? 0 })
      }
      url = nextLink(headers.get('link'))
    }
    const { entries, mmproj } = groupGgufFiles(files, repoId)
    const transformersEntry = buildTransformersEntry(files, repoId)
    return {
      repoId,
      entries,
      mmproj,
      diffusionEntries: buildDiffusionEntries(files, repoId),
      transformersEntry,
      otherFiles: files.filter((f) => !/\.gguf$/i.test(f.path)),
      hasGguf: entries.length > 0 || mmproj.length > 0,
      hasSafetensors: transformersEntry !== null,
    }
  }

  /** このモデルを GGUF に量子化した派生リポジトリを探す */
  async quantizedVariants(repoId: string): Promise<HFModelSummary[]> {
    const params = new URLSearchParams()
    params.set('filter', `base_model:quantized:${repoId},gguf`)
    params.set('sort', 'downloads')
    params.set('direction', '-1')
    params.set('limit', '20')
    for (const e of EXPAND) params.append('expand[]', e)
    const { data } = await this.getJson<RawModel[]>(`${HF_BASE}/api/models?${params}`)
    return data.map(toSummary)
  }

  fileUrl(repoId: string, filePath: string, revision = 'main'): string {
    const p = filePath.split('/').map(encodeURIComponent).join('/')
    return `${HF_BASE}/${repoId}/resolve/${encodeURIComponent(revision)}/${p}`
  }

  /** ダウンロードせずに GGUF のヘッダ(アーキテクチャ・レイヤー数など)だけを読む */
  async remoteHeader(repoId: string, filePath: string): Promise<ModelHeaderInfo> {
    const src = remoteSource(this.fileUrl(repoId, filePath), this.headers())
    return parseGgufHeader(src, { stopAtTokenizer: true, parseTensors: false, maxBytes: 32 * 1024 * 1024, fileName: path.posix.basename(filePath) })
  }

  /**
   * ダウンロードせずに、そのファイルが拡散モデル (画像生成) かを判定する。
   * .safetensors は先頭の JSON ヘッダだけを Range で読んでキーから、.gguf はヘッダのアーキテクチャから判定する。
   * 結果はセッション中キャッシュする (同じリポジトリを開き直すたびに読み直さない)
   */
  async diffusionCheck(repoId: string, filePath: string): Promise<DiffusionInfo | null> {
    const key = `${repoId}/${filePath}`
    const cached = this.diffusionCache.get(key)
    if (cached) return cached
    const p = this.diffusionCheckUncached(repoId, filePath)
    this.diffusionCache.set(key, p)
    p.catch(() => this.diffusionCache.delete(key))
    return p
  }

  private readonly diffusionCache = new Map<string, Promise<DiffusionInfo | null>>()

  /** 表示言語を変えたときに呼ぶ。判定結果に含まれる文言 (非対応形式の理由) を作り直させる */
  clearCaches(): void {
    this.diffusionCache.clear()
  }

  private async diffusionCheckUncached(repoId: string, filePath: string): Promise<DiffusionInfo | null> {
    const fileName = path.posix.basename(filePath)
    // 同じ先頭部分を 2 回読むことがある (下記) ので、取得済みの範囲はメモリに残す
    const src = cachingSource(remoteSource(this.fileUrl(repoId, filePath), this.headers()))
    if (/\.gguf$/i.test(filePath)) {
      // まずメタデータだけ読む。アーキテクチャ名で判定できなければテンソル名まで読む。
      // stable-diffusion.cpp の convert で作った GGUF はメタデータが無く (kv=0)、ComfyUI-GGUF の変換は
      // 未知のアーキテクチャ名 (qwen_image21 など) を書くことがある。LLM の GGUF (block_count がある) は読み直さない
      const h = await parseGgufHeader(src, { stopAtTokenizer: true, parseTensors: false, maxBytes: 32 * 1024 * 1024, fileName }).catch(() => null)
      // sd1 / sdxl は UNet 単体の GGUF も同じアーキテクチャ名なので、テンソル名で 1 ファイル完結かを確かめる
      if (h?.diffusion && !needsTensorCheck(h.diffusion.family)) return h.diffusion
      if (!h?.diffusion && h?.architecture && h.blockCount !== undefined) return null
      const full = await parseGgufHeader(src, { stopAtTokenizer: false, parseTensors: true, maxBytes: 16 * 1024 * 1024, fileName }).catch(() => null)
      // テンソル名まで読めなかったら、アーキテクチャ名だけの判定に戻す
      return full?.diffusion ?? h?.diffusion ?? null
    }
    if (!/\.safetensors$/i.test(filePath)) return null
    const head = await src.read(0, 8)
    if (head.length < 8) return null
    const n = Number(new DataView(head.buffer, head.byteOffset, 8).getBigUint64(0, true))
    if (n <= 0 || n > 8 * 1024 * 1024) return null
    const json = JSON.parse(new TextDecoder().decode(await src.read(8, n))) as Record<string, { dtype?: string; shape?: number[] }>
    return diffusionInfoFromHeader(parseSafetensorsHeaderJson(json), fileName)
  }

  /** config.json を読んで Transformers 実行時のメモリ見積もりに使う */
  async modelConfig(repoId: string): Promise<HFModelConfig | null> {
    const res = await fetch(this.fileUrl(repoId, 'config.json'), { headers: this.headers() })
    if (!res.ok) {
      await res.body?.cancel()
      if (res.status === 404) return null
      throw new HfError(res.status, describeHttp(res.status))
    }
    const raw = (await res.json()) as unknown
    if (!raw || typeof raw !== 'object') return null
    return parseHfConfig(raw as Record<string, unknown>)
  }
}

function encodeRepo(repoId: string): string {
  return repoId.split('/').map(encodeURIComponent).join('/')
}

function nextLink(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim())
    if (m) return m[1]
  }
  return null
}
