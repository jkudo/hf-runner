import fs from 'node:fs'
import path from 'node:path'
import type { ComponentStatus, ModelEntry, RepoFilesResult, Settings } from '@shared/types'
import { COMPONENT_CATALOG, COMPONENT_ROLE_LABEL, componentLicense, type ComponentRole, type ComponentSource } from '@shared/diffusion'
import { componentKey, downloadJobId } from '@shared/jobs'
import { L } from '@shared/i18n'
import { repoDir, type DownloadManager } from './downloads'
import type { HfClient } from './hf'

/**
 * 画像生成モデルの部品 (VAE / テキストエンコーダー) の管理。
 * カタログの入手先からモデルフォルダの <owner>/<repo>/ に取得し、系統ごとに揃っているかを調べる。
 * 同じ部品 (FLUX の T5 など) は複数のモデルで共有される
 */
export class ComponentManager {
  constructor(private readonly deps: { hf: HfClient; downloads: DownloadManager; getSettings: () => Settings }) {}

  private fileOf(source: ComponentSource): string {
    return path.join(repoDir(this.deps.getSettings().modelsDir, source.repo), ...source.path.split('/'))
  }

  /** 系統に必要な部品と状態。候補のうち揃っているものがあればそれを、無ければ既定を返す */
  status(family: string): ComponentStatus[] {
    const specs = COMPONENT_CATALOG[family] ?? []
    return specs.map((spec) => {
      const present = spec.options.find((o) => fs.existsSync(this.fileOf(o)))
      const source = present ?? spec.options[0]
      return {
        role: spec.role,
        label: source.label,
        present: !!present,
        file: present ? this.fileOf(present) : undefined,
        repo: source.repo,
        path: source.path,
        sizeBytes: source.sizeBytes,
        note: source.note,
        jobId: downloadJobId(source.repo, componentKey(source)),
        license: componentLicense(source.repo),
      }
    })
  }

  /** 揃っていれば role → 絶対パス。1 つでも欠けていれば null */
  resolve(family: string): Partial<Record<ComponentRole, string>> | null {
    const st = this.status(family)
    if (st.some((s) => !s.present)) return null
    return Object.fromEntries(st.map((s) => [s.role, s.file!])) as Partial<Record<ComponentRole, string>>
  }

  /** 欠けている部品を既定の候補でダウンロードキューに入れる。開始したジョブの ID を返す */
  async download(family: string): Promise<string[]> {
    const missing = this.status(family).filter((s) => !s.present)
    // 同じリポジトリの部品はファイル一覧を 1 回で済ませ、リポジトリごとに並列で取る
    const listings = new Map<string, Promise<RepoFilesResult>>()
    const listing = (repo: string) => listings.get(repo) ?? listings.set(repo, this.deps.hf.listFiles(repo)).get(repo)!
    const entries = await Promise.all(
      missing.map(async (s): Promise<[ComponentStatus, ModelEntry]> => {
        const files = await listing(s.repo)
        const file = [...files.entries, ...files.mmproj, ...files.diffusionEntries].flatMap((e) => e.files).concat(files.otherFiles).find((f) => f.path === s.path)
        if (!file) throw new Error(L(`${s.repo} に ${s.path} が見つかりません`, `${s.path} was not found in ${s.repo}`))
        return [
          s,
          {
            key: componentKey(s),
            displayName: `${COMPONENT_ROLE_LABEL[s.role]} ${path.basename(s.path)}`,
            format: 'diffusion',
            quant: s.role,
            quantInfo: null,
            files: [file],
            totalSize: file.size,
            isMmproj: false,
            isSplit: false,
            paramsB: null,
          },
        ]
      }),
    )
    return entries.map(([s, entry]) => this.deps.downloads.start(s.repo, entry, null, null, { component: true }).id)
  }
}
