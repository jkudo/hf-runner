import { useEffect, useMemo, useState } from 'react'
import type { DownloadJob, FitResult, HFModelConfig, HFModelInfo, HFModelSummary, ModelEntry, ModelHeaderInfo, Precision, RepoFilesResult, ServerStartOptions } from '@shared/types'
import { downloadJobId } from '@shared/jobs'
import { quantLabel, splitSuffix, standaloneBlock } from '@shared/quant'
import { getLang, L } from '@shared/i18n'
import { headerFromConfig } from '@shared/config'
import { COMPONENT_CATALOG, COMPONENT_ROLE_LABEL, componentLicense, DIFFUSION_FAMILY_LABEL, hasComponentCatalog, isImageGenPipeline, type DiffusionInfo } from '@shared/diffusion'
import { PRECISIONS } from '@shared/engines'
import { estimateMemory, judgeFit } from '@shared/fit'
import { formatBytes, formatCount, formatParams } from '@shared/format'
import { api, errMsg, openExternal } from '../api'
import { useApp } from '../App'
import { FitBadge } from '../components/FitBadge'
import { CancelComponentsButton, ComponentsLine, componentJobs, launchBlock, RestrictedLicenses } from './LibraryPage'
import { JobProgress } from '../components/JobProgress'

const CTX_OPTIONS = [2048, 4096, 8192, 16384, 32768, 65536, 131072]

export function ModelDetail({ repoId, onOpenRepo }: { repoId: string; onOpenRepo: (id: string) => void }) {
  const app = useApp()
  // ファイル一覧の説明 (量子化の解説、非対応の理由など) はメインプロセスが作るので、言語を変えたら取り直す
  const lang = getLang()
  const [info, setInfo] = useState<HFModelInfo | null>(null)
  const [files, setFiles] = useState<RepoFilesResult | null>(null)
  const [header, setHeader] = useState<ModelHeaderInfo | null>(null)
  const [config, setConfig] = useState<HFModelConfig | null>(null)
  const [variants, setVariants] = useState<HFModelSummary[] | null>(null)
  // ルート直下の大きな .safetensors / .gguf が拡散モデルか (ファイルの中身で判定。null = 拡散モデルではない)
  const [diffChecks, setDiffChecks] = useState<Map<string, DiffusionInfo | null> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [ctx, setCtx] = useState<number>(app.settings?.contextSize ?? 4096)
  const [precision, setPrecision] = useState<Precision>(app.settings?.transformersPrecision ?? 'auto')
  // 画像入力用の mmproj。リポジトリにあれば既定で一緒にダウンロードする(複数あれば最小のもの)
  const [withMmproj, setWithMmproj] = useState(true)
  const [mmprojKey, setMmprojKey] = useState<string | null>(null)
  const mmprojList = useMemo(() => (files ? [...files.mmproj].sort((a, b) => a.totalSize - b.totalSize) : []), [files])
  const mmproj = withMmproj ? (mmprojList.find((m) => m.key === mmprojKey) ?? mmprojList[0] ?? null) : null

  useEffect(() => {
    let alive = true
    setInfo(null)
    setFiles(null)
    setHeader(null)
    setConfig(null)
    setVariants(null)
    setMmprojKey(null)
    setDiffChecks(null)
    setError(null)
    setLoading(true)
    void (async () => {
      try {
        const [i, f] = await Promise.all([api.hf.modelInfo(repoId), api.hf.files(repoId)])
        if (!alive) return
        setInfo(i)
        setFiles(f)
        setLoading(false)
        const tasks: Promise<unknown>[] = []
        // 種類が言語モデルと分かっているリポジトリ (pipeline が text-generation など) はヘッダを読みに行かない。
        // 画像生成系か種類不明なら、全ファイルをヘッダだけ読んで判定する (同時 4 件まで。部品の要否はファイルごとに違いうる)
        const textRepo = !!i?.pipelineTag && !isImageGenRepo(i)
        if (textRepo) setDiffChecks(new Map())
        else if (f.diffusionEntries.length > 0) {
          tasks.push(
            mapLimit(f.diffusionEntries, 4, async (e) => [e.key, await api.hf.diffusionCheck(repoId, e.files[0].path)] as const).then((pairs) => {
              if (alive) setDiffChecks(new Map(pairs))
            }),
          )
        }
        if (f.entries.length > 0) {
          // 量子化が違ってもアーキテクチャ情報は同じなので、最小のファイルからヘッダだけ読む
          const smallest = [...f.entries].sort((a, b) => a.totalSize - b.totalSize)[0]
          tasks.push(api.hf.remoteHeader(repoId, smallest.files[0].path).then((h) => alive && setHeader(h)))
        }
        if (f.transformersEntry) tasks.push(api.hf.modelConfig(repoId).then((c) => alive && setConfig(c)))
        if (f.entries.length === 0) tasks.push(api.hf.quantizedVariants(repoId).then((v) => alive && setVariants(v)))
        await Promise.allSettled(tasks)
      } catch (e) {
        if (alive) {
          setError(errMsg(e))
          setLoading(false)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [repoId, lang])

  const fits = useMemo(() => {
    const m = new Map<string, FitResult>()
    if (!files) return m
    for (const e of files.entries) {
      // mmproj (視覚エンコーダー) も一緒に読み込まれるのでメモリに加算する
      const est = estimateMemory({ format: 'gguf', totalSize: e.totalSize + (mmproj?.totalSize ?? 0), header, hfMeta: info?.gguf ?? null, paramsB: e.paramsB, contextSize: ctx })
      m.set(e.key, judgeFit(est, app.sys, app.fitGpus('gguf')))
    }
    return m
  }, [files, header, info, ctx, app.sys, app.fitGpus, mmproj, getLang()]) // 言語を切り替えたら表示の文言を作り直す

  const dtype = info?.safetensors ? Object.keys(info.safetensors.parameters)[0] : undefined
  const paramCount = info?.safetensors?.total
  const tfEntry = useMemo<ModelEntry | null>(() => {
    const e = files?.transformersEntry
    if (!e) return null
    return { ...e, quant: dtype ?? e.quant, dtype, paramsB: paramCount ? paramCount / 1e9 : e.paramsB }
  }, [files, dtype, paramCount])
  const tfHeader = useMemo(() => (config ? headerFromConfig(config, paramCount, dtype) : null), [config, paramCount, dtype])
  const tfFit = useMemo(
    () =>
      tfEntry
        ? judgeFit(
            estimateMemory({ format: 'safetensors', totalSize: tfEntry.totalSize, header: tfHeader, paramCount, paramsB: tfEntry.paramsB, contextSize: ctx, precision }),
            app.sys,
            app.fitGpus('safetensors'),
          )
        : null,
    [tfEntry, tfHeader, paramCount, ctx, precision, app.sys, app.fitGpus, getLang()],
  )

  const hfUrl = `https://huggingface.co/${repoId}`
  const needsToken = !!info?.gated && !app.settings?.hfToken
  // 画像生成系のリポジトリ (pipeline が text-to-image など、または GGUF ヘッダ / ファイルの中身が拡散モデル) は、GGUF も含めて画像生成モデルとして扱う
  const byPipeline = isImageGenRepo(info)
  const isImageGen = byPipeline || !!header?.diffusion || (!!diffChecks && [...diffChecks.values()].some((v) => v !== null))
  const diffusionEntries = useMemo(() => {
    if (!files) return []
    // 種類が分かっているリポジトリは全部、そうでなければ中身で拡散モデルと判定できたものだけ
    return files.diffusionEntries.filter((e) => byPipeline || !!header?.diffusion || diffChecks?.get(e.key))
  }, [files, byPipeline, header, diffChecks])
  const hasGguf = !!files && files.entries.length > 0 && !isImageGen
  const checking = !!files && files.diffusionEntries.length > 0 && diffChecks === null
  const nothingRunnable = !!files && !hasGguf && !tfEntry && diffusionEntries.length === 0 && !loading && !checking
  const imgFits = useMemo(() => {
    const m = new Map<string, FitResult>()
    for (const e of diffusionEntries) {
      // 部品分割型は部品 (テキストエンコーダー / VAE) の分も加算する
      const d = diffChecks?.get(e.key)
      const parts = d && !d.singleFile ? (COMPONENT_CATALOG[d.family] ?? []).reduce((a, s) => a + s.options[0].sizeBytes, 0) : 0
      m.set(e.key, judgeFit(estimateMemory({ format: 'diffusion', totalSize: e.totalSize + parts, contextSize: 0 }), app.sys, app.fitGpus('diffusion')))
    }
    return m
  }, [diffusionEntries, diffChecks, app.sys, app.fitGpus, getLang()])

  return (
    <div className="model-detail">
      <div className="detail-head">
        <div>
          <h1 className="detail-title">{repoId}</h1>
          <div className="detail-meta">
            {info && (
              <>
                <span>⬇ {formatCount(info.downloads)}</span>
                <span>♥ {formatCount(info.likes)}</span>
                {info.license && <span>{L('ライセンス', 'License')}: {info.license}</span>}
                {(info.gguf?.architecture ?? info.modelType) && <span>arch: {info.gguf?.architecture ?? info.modelType}</span>}
                {(header?.paramCount || info.gguf?.total || paramCount) && <span>{L('パラメータ', 'Parameters')}: {formatParams((header?.paramCount ?? info.gguf?.total ?? paramCount ?? 0) / 1e9)}</span>}
                {(header?.contextLength || info.gguf?.context_length || tfHeader?.contextLength) && (
                  <span>{L('最大コンテキスト', 'Max context')}: {formatCount(header?.contextLength ?? info.gguf?.context_length ?? tfHeader?.contextLength)}</span>
                )}
                {info.pipelineTag && <span>{info.pipelineTag}</span>}
              </>
            )}
          </div>
        </div>
        <button className="ghost" onClick={() => openExternal(hfUrl)}>
          {L('Hugging Face で開く ↗', 'Open on Hugging Face ↗')}
        </button>
      </div>

      {loading && <div className="muted pad">{L('読み込み中…', 'Loading…')}</div>}
      {error && <div className="error-box">{error}</div>}

      {info?.gated && (
        <div className={`notice ${needsToken ? 'warn' : ''}`}>
          {L('このモデルは利用規約への同意が必要です(gated)。', 'This model requires accepting its terms of use (gated).')}
          {needsToken ? (
            getLang() === 'en' ? (
              <>
                {' '}
                Accept the terms on the <a onClick={() => openExternal(hfUrl)}>model page</a>, then enter your HF token in{' '}
                <a onClick={() => app.setPage('settings')}>Settings</a>.
              </>
            ) : (
              <>
                {' '}
                <a onClick={() => openExternal(hfUrl)}>モデルページ</a>で同意した上で、
                <a onClick={() => app.setPage('settings')}>設定</a>に HF トークンを入力してください。
              </>
            )
          ) : (
            L(' HF トークンが設定されているので、同意済みであればダウンロードできます。', ' An HF token is set, so you can download it once you have accepted the terms.')
          )}
        </div>
      )}

      {diffusionEntries.length > 0 && (
        <>
          <h3 className="sub-head">
            <span className="tag img">{L('画像生成', 'Image generation')}</span> {L('stable-diffusion.cpp で実行', 'Runs with stable-diffusion.cpp')}
          </h3>
          <p className="muted small">
            {L(
              '画像生成(拡散)モデルです。Stable Diffusion 1.x / SDXL の 1 ファイル版はそのまま、FLUX / Qwen-Image / SD3 のように本体だけのファイルは必要な部品(テキストエンコーダー・VAE)を自動で一緒に取得します。',
              'An image generation (diffusion) model. Single-file Stable Diffusion 1.x / SDXL models run as is; model-only files such as FLUX / Qwen-Image / SD3 automatically get the required components (text encoder, VAE) as well.',
            )}
          </p>
          <div className="entries">
            {diffusionEntries.map((e) => (
              <DiffusionRow key={e.key} repoId={repoId} entry={e} fit={imgFits.get(e.key)} info={info} diff={diffChecks?.get(e.key) ?? null} />
            ))}
          </div>
        </>
      )}
      {checking && !isImageGen && <div className="muted small pad">{L('ファイルの種類を確認しています…', 'Checking file types…')}</div>}

      {(hasGguf || tfEntry) && (
        <div className="entries-head">
          <h2>{L('ファイルを選んでダウンロード', 'Choose a file to download')}</h2>
          <label className="inline">
            {L('判定に使うコンテキスト長', 'Context length for the estimate')}
            <select value={ctx} onChange={(e) => setCtx(Number(e.target.value))}>
              {CTX_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {formatCount(c)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {hasGguf && files && (
        <>
          <h3 className="sub-head">
            <span className="tag gguf">GGUF</span> {L('llama.cpp で実行(軽量・高速)', 'Runs with llama.cpp (lightweight, fast)')}
          </h3>
          <p className="muted small">
            {L('数字が小さいほど小型で低品質になります。迷ったら ', 'Smaller numbers mean smaller files and lower quality. If unsure, ')}
            <b>Q4_K_M</b>
            {L(' がバランス良好です。', ' offers a good balance.')}
            {header ? L(' メモリ見積もりはモデルのヘッダ情報に基づきます。', ' The memory estimate is based on the model header.') : L(' メモリ見積もりは概算です。', ' The memory estimate is approximate.')}
          </p>
          {mmprojList.length > 0 && (
            <div className="notice small row gap">
              <label className="check">
                <input type="checkbox" checked={withMmproj} onChange={(e) => setWithMmproj(e.target.checked)} />
                {L('画像入力用の mmproj も一緒にダウンロードする(チャットに画像を添付できます)', 'Also download the mmproj for image input (lets you attach images in chat)')}
              </label>
              {mmprojList.length > 1 ? (
                <select value={mmproj?.key ?? mmprojList[0].key} onChange={(e) => setMmprojKey(e.target.value)} disabled={!withMmproj}>
                  {mmprojList.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.displayName} ({formatBytes(m.totalSize)})
                    </option>
                  ))}
                </select>
              ) : (
                <span className="muted">
                  {mmprojList[0].displayName} ({formatBytes(mmprojList[0].totalSize)})
                </span>
              )}
            </div>
          )}
          <div className="entries">
            {files.entries.map((e) => (
              <EntryRow key={e.key} repoId={repoId} entry={e} fit={fits.get(e.key)} info={info} mmproj={mmproj} />
            ))}
          </div>
        </>
      )}

      {tfEntry && (
        <>
          <h3 className="sub-head">
            <span className="tag st">safetensors</span> {L('元の重みを Transformers (Python) で実行', 'Runs the original weights with Transformers (Python)')}
          </h3>
          <p className="muted small">
            {L(
              '変換なしの元モデルをそのまま動かします。8bit / 4bit は bitsandbytes による読み込み時量子化で、NVIDIA GPU が必要です。',
              'Runs the original model as is, without conversion. 8bit / 4bit use load-time quantization with bitsandbytes and require an NVIDIA GPU.',
            )}
            {tfHeader ? L(' メモリ見積もりは config.json に基づきます。', ' The memory estimate is based on config.json.') : L(' メモリ見積もりは概算です。', ' The memory estimate is approximate.')}
          </p>
          <TransformersRow repoId={repoId} entry={tfEntry} fit={tfFit} info={info} header={tfHeader} precision={precision} onPrecision={setPrecision} />
          {info?.pipelineTag && info.pipelineTag !== 'text-generation' && info.pipelineTag !== 'image-text-to-text' && (
            <div className="notice warn small">
              {L(
                `このモデルの種類は「${info.pipelineTag}」です。Transformers エンジンはテキスト生成モデル向けなので、正しく動作しない可能性があります。`,
                `This model's type is "${info.pipelineTag}". The Transformers engine is meant for text generation models, so it may not work correctly.`,
              )}
            </div>
          )}
        </>
      )}

      {!hasGguf && !isImageGen && files && !loading && !checking && (
        <div className="notice">
          {nothingRunnable ? (
            <strong>{L('このリポジトリには実行できる重み(GGUF / safetensors)がありません。', 'This repository has no runnable weights (GGUF / safetensors).')}</strong>
          ) : (
            <strong>{L('軽量な GGUF 版(llama.cpp 向け)も探せます', 'You can also look for a lightweight GGUF version (for llama.cpp)')}</strong>
          )}
          {variants === null ? (
            <div className="muted small">{L('GGUF 版を探しています…', 'Looking for GGUF versions…')}</div>
          ) : variants.length === 0 ? (
            <div className="muted small">
              {L(
                `GGUF 版の派生リポジトリは見つかりませんでした。検索欄で「${repoId.split('/').pop()} GGUF」を検索してみてください。`,
                `No GGUF derivative repositories were found. Try searching for "${repoId.split('/').pop()} GGUF".`,
              )}
            </div>
          ) : (
            <div className="variants">
              {variants.map((v) => (
                <button key={v.id} className="variant" onClick={() => onOpenRepo(v.id)}>
                  <span className="variant-id">{v.id}</span>
                  <span className="muted small">⬇ {formatCount(v.downloads)} · ♥ {formatCount(v.likes)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** リポジトリの種類 (pipeline / タグ) から画像生成系と分かるか */
const isImageGenRepo = (info: HFModelInfo | null) => isImageGenPipeline(info?.pipelineTag) || !!info?.tags?.some((t) => /^(diffusers|stable-diffusion|text-to-image|image-to-image|flux)$/i.test(t))

/** 同時実行数を抑えて map する (リモートのヘッダ読みを全ファイルに対して一斉に投げないため) */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function useEntryState(repoId: string, entry: ModelEntry) {
  const app = useApp()
  const jobId = downloadJobId(repoId, entry.key)
  const job: DownloadJob | undefined = app.downloads.find((d) => d.id === jobId)
  const owned = app.library.find((m) => m.repoId === repoId && m.entryKey === entry.key)
  const running = owned && app.server.modelId === owned.id && app.server.state !== 'stopped'
  const [busy, setBusy] = useState(false)
  // 起動して、そのモデルを使うページ (画像生成 / チャット) へ移る
  const launch = async (opts: Omit<ServerStartOptions, 'modelId'> = {}) => {
    if (!owned) return
    setBusy(true)
    try {
      await api.server.start({ modelId: owned.id, ...opts })
      app.setPage(owned.format === 'diffusion' ? 'image' : 'chat')
    } catch (e) {
      app.toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return { app, job, owned, running, busy, launch }
}

function EntryActions({
  repoId,
  entry,
  fit,
  info,
  onLaunch,
  busy,
  mmproj = null,
  afterStart,
  blocked,
}: {
  repoId: string
  entry: ModelEntry
  fit?: FitResult | null
  info: HFModelInfo | null
  onLaunch: () => Promise<void>
  busy: boolean
  /** GGUF: 一緒にダウンロードする画像入力用 mmproj */
  mmproj?: ModelEntry | null
  /** ダウンロード開始後に追加で行うこと (画像生成モデルの部品取得など) */
  afterStart?: () => Promise<void>
  /** 指定するとダウンロードも起動もできない。label をボタンに、reason をツールチップに出す */
  blocked?: { label: string; reason: string }
}) {
  const { app, job, owned, running } = useEntryState(repoId, entry)
  const start = async () => {
    try {
      await api.downloads.start(repoId, entry, info?.gguf ?? null, mmproj)
      await afterStart?.()
    } catch (e) {
      app.toast(errMsg(e), 'error')
    }
  }
  return (
    <div className="entry-actions">
      {owned ? (
        <button className="primary" onClick={() => void onLaunch()} disabled={busy || !!running || !!blocked} title={blocked?.reason}>
          {running
            ? app.server.state === 'starting'
              ? L(`読み込み中 ${Math.round((app.server.progress?.fraction ?? 0) * 100)}%`, `Loading ${Math.round((app.server.progress?.fraction ?? 0) * 100)}%`)
              : L('起動中', 'Running')
            : busy
              ? L('読み込み中…', 'Loading…')
              : (blocked?.label ?? L('▶ 起動', '▶ Launch'))}
        </button>
      ) : job && (job.status === 'downloading' || job.status === 'queued') ? (
        <button className="ghost" onClick={() => api.downloads.cancel(job.id)}>
          {L('中断', 'Stop')}
        </button>
      ) : job && (job.status === 'error' || job.status === 'cancelled') ? (
        <button onClick={start}>{L('再開', 'Resume')}</button>
      ) : (
        <button onClick={start} disabled={fit?.level === 'no' || !!blocked} title={blocked?.reason ?? (fit?.level === 'no' ? L('メモリ不足の可能性が高いためお勧めしません', 'Not recommended: likely not enough memory') : '')}>
          {L('ダウンロード', 'Download')}
        </button>
      )}
      {fit?.level === 'no' && !owned && !job && !blocked && (
        <button className="ghost small" onClick={start}>
          {L('それでも保存', 'Save anyway')}
        </button>
      )}
    </div>
  )
}

function EntryRow({ repoId, entry, fit, info, mmproj: repoMmproj }: { repoId: string; entry: ModelEntry; fit?: FitResult; info: HFModelInfo | null; mmproj: ModelEntry | null }) {
  const { app, job, owned, busy, launch } = useEntryState(repoId, entry)
  // 投機的デコード用のドラフト (本体の一部のレイヤーだけ) やフォーク専用の量子化は公式の llama-server で動かないので、
  // 起動もダウンロードも止め、mmproj も付けない
  const nameBlock = standaloneBlock(entry.displayName)
  const notStandalone = owned ? launchBlock(owned, app.downloads) : nameBlock ? { label: L('実行不可', "Can't run"), reason: nameBlock } : null
  const mmproj = nameBlock ? null : repoMmproj
  return (
    <div className={`entry ${fit ? `entry-${fit.level}` : ''}`}>
      <div className="entry-main">
        <div className="entry-title">
          <span className="quant">{quantLabel(entry.quant)}</span>
          <span className="entry-name" title={entry.files.map((f) => f.path).join('\n')}>
            {entry.displayName + splitSuffix(entry.isSplit ? entry.files.length : 0)}
          </span>
          {entry.draft &&<span className="tag warn">{L('ドラフト (単体では実行不可)', "Draft (can't run on its own)")}</span>}
          {!entry.draft && nameBlock && <span className="tag warn">{L('独自の量子化 (実行不可)', "Custom quantization (can't run)")}</span>}
        </div>
        <div className="entry-sub muted small">
          {entry.quantInfo ? `${entry.quantInfo.label}${entry.quantInfo.note ? ` · ${entry.quantInfo.note}` : ''}` : L('量子化タイプ不明', 'Unknown quantization type')}
        </div>
        {notStandalone && <div className="small warn-text">{notStandalone.reason}</div>}
        {job && <JobProgress job={job} />}
      </div>
      <div className="entry-right">
        <div className="entry-size">{formatBytes(entry.totalSize)}</div>
        {mmproj && <div className="muted small">+ mmproj {formatBytes(mmproj.totalSize)}</div>}
        {fit && <FitBadge fit={fit} />}
      </div>
      <EntryActions repoId={repoId} entry={entry} fit={fit} info={info} onLaunch={launch} busy={busy} mmproj={mmproj} blocked={notStandalone ?? undefined} />
    </div>
  )
}

/** 画像生成モデルの行。部品分割型なら必要な部品も一緒に取得する。起動後は画像生成ページへ */
function DiffusionRow({ repoId, entry, fit, info, diff }: { repoId: string; entry: ModelEntry; fit?: FitResult; info: HFModelInfo | null; diff: DiffusionInfo | null }) {
  const { app, job, owned, busy, launch } = useEntryState(repoId, entry)
  const [withParts, setWithParts] = useState(true)
  const multiPart = !!diff && !diff.singleFile
  const catalog = multiPart && hasComponentCatalog(diff.family) ? COMPONENT_CATALOG[diff.family] : null
  const partsBytes = catalog ? catalog.reduce((a, s) => a + s.options[0].sizeBytes, 0) : 0
  const unsupported = diff?.unsupported ?? owned?.header?.diffusion?.unsupported
  // ダウンロード済みでも部品が揃うまでは起動させない (部品はモデル本体の後にダウンロードされる)。
  // 部品のダウンロード中は本体と同じく「中断」を出す
  const blocked = owned ? launchBlock(owned, app.downloads) : unsupported ? { label: L('非対応', 'Unsupported'), reason: unsupported } : null
  const partJobs = owned ? componentJobs(app.downloads, owned) : []
  const fetchParts = async () => {
    if (!catalog || !withParts || !diff) return
    await api.components.download(diff.family)
  }
  return (
    <div className={`entry ${fit ? `entry-${fit.level}` : ''}`}>
      <div className="entry-main">
        <div className="entry-title">
          <span className="quant">{quantLabel(entry.quant)}</span>
          <span className="entry-name" title={entry.files[0].path}>
            {entry.displayName}
          </span>
          {diff && <span className={`tag ${diff.singleFile || catalog ? 'ok' : 'warn'}`}>{DIFFUSION_FAMILY_LABEL[diff.family] ?? diff.family}{diff.singleFile ? '' : catalog ? L(' (本体のみ)', ' (model only)') : L(' (部品不明)', ' (components unknown)')}</span>}
          {unsupported && <span className="tag warn">{L('非対応の形式', 'Unsupported format')}</span>}
        </div>
        <div className="entry-sub muted small">
          {entry.files[0].path}
          {entry.paramsB ? ` · ${formatParams(entry.paramsB)}` : ''}
          {multiPart && !catalog && L(' · この系統の部品 (テキストエンコーダー / VAE) の入手先が未登録のため、現在は実行できません', " · Can't run yet: no source is registered for this family's components (text encoder / VAE)")}
        </div>
        {unsupported && <div className="small warn-text">{unsupported}
            {L('。fp8 / bf16 の safetensors か GGUF 版を選んでください', '. Choose an fp8 / bf16 safetensors or a GGUF version.')}
          </div>}
        {owned?.components && <ComponentsLine model={owned} />}
        {catalog && !unsupported && (
          <label className="check small">
            <input type="checkbox" checked={withParts} onChange={(e) => setWithParts(e.target.checked)} />
            {L(
              `必要な部品も一緒にダウンロード(合計 ${formatBytes(partsBytes)}: ${catalog.map((s) => `${COMPONENT_ROLE_LABEL[s.role]} ${formatBytes(s.options[0].sizeBytes)}`).join('、')})。同じ部品は他のモデルと共有されます`,
              `Also download the required components (${formatBytes(partsBytes)} total: ${catalog.map((s) => `${COMPONENT_ROLE_LABEL[s.role]} ${formatBytes(s.options[0].sizeBytes)}`).join(', ')}). Components are shared with other models`,
            )}
          </label>
        )}
        {catalog && !unsupported && <RestrictedLicenses licenses={catalog.map((s) => ({ label: COMPONENT_ROLE_LABEL[s.role], ...componentLicense(s.options[0].repo) }))} />}
        {!app.sd?.installed && (
          <div className="small warn-text">
            {L('画像生成エンジンが未インストールです。', 'The image generation engine is not installed. ')}
            <a className="link" onClick={() => app.setPage('settings')}>
              {L('設定でインストール', 'Install it in Settings')}
            </a>
            {L('(ダウンロードは可能です)', ' (you can still download)')}
          </div>
        )}
        {job && <JobProgress job={job} />}
      </div>
      <div className="entry-right">
        <div className="entry-size">{formatBytes(entry.totalSize)}</div>
        {catalog && withParts && !unsupported && <div className="muted small">+ {L('部品', 'components')} {formatBytes(partsBytes)}</div>}
        {fit && <FitBadge fit={fit} />}
      </div>
      {partJobs.length > 0 ? (
        <div className="entry-actions">
          <CancelComponentsButton jobs={partJobs} />
        </div>
      ) : (
        <EntryActions
          repoId={repoId}
          entry={entry}
          fit={fit}
          info={info}
          onLaunch={launch}
          busy={busy}
          afterStart={catalog ? fetchParts : undefined}
          blocked={blocked ?? undefined}
        />
      )}
    </div>
  )
}

function TransformersRow({
  repoId,
  entry,
  fit,
  info,
  header,
  precision,
  onPrecision,
}: {
  repoId: string
  entry: ModelEntry
  fit: FitResult | null
  info: HFModelInfo | null
  header: ModelHeaderInfo | null
  precision: Precision
  onPrecision: (p: Precision) => void
}) {
  const { app, job, busy, launch } = useEntryState(repoId, entry)
  const [trust, setTrust] = useState(false)
  const py = app.python
  const cudaOk = !!py?.installed && !!py.cuda && !!py.bitsandbytes
  const weights = entry.files.filter((f) => /\.safetensors$/i.test(f.path)).length
  return (
    <div className={`entry ${fit ? `entry-${fit.level}` : ''}`}>
      <div className="entry-main">
        <div className="entry-title">
          <span className="quant">{quantLabel(entry.quant)}</span>
          <span className="entry-name">{entry.displayName}</span>
        </div>
        <div className="entry-sub muted small">
          {L(`safetensors ${weights} ファイル + 設定 / トークナイザ`, `safetensors ${weights} files + config / tokenizer`)}
          {entry.paramsB ? ` · ${formatParams(entry.paramsB)}` : ''}
          {header?.architecture ? ` · ${header.architecture}` : ''}
          {header?.hasVision && <span className="tag ok">{L('画像入力', 'Image input')}</span>}
        </div>
        <div className="entry-sub row gap">
          <label className="inline small">
            {L('読み込み精度', 'Load precision')}
            <select value={precision} onChange={(e) => onPrecision(e.target.value as Precision)}>
              {PRECISIONS.map((p) => (
                <option key={p.id} value={p.id} disabled={p.id !== 'auto' && py?.installed === true && !cudaOk}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small">{PRECISIONS.find((p) => p.id === precision)?.note}</span>
        </div>
        {header?.hasAutoMap && (
          <label className="check small">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            {L('カスタムモデルコードの実行を許可する (trust_remote_code) — このモデルには必要です', 'Allow running custom model code (trust_remote_code) — required for this model')}
          </label>
        )}
        {!py?.installed && (
          <div className="small warn-text">
            {L('Python エンジンが未インストールです。', 'The Python engine is not installed. ')}
            <a className="link" onClick={() => app.setPage('settings')}>
              {L('設定でインストール', 'Install it in Settings')}
            </a>
            {L('(ダウンロードは可能です)', ' (you can still download)')}
          </div>
        )}
        {job && <JobProgress job={job} />}
      </div>
      <div className="entry-right">
        <div className="entry-size">{formatBytes(entry.totalSize)}</div>
        {fit && <FitBadge fit={fit} />}
      </div>
      <EntryActions repoId={repoId} entry={entry} fit={fit} info={info} onLaunch={() => launch({ precision, trustRemoteCode: trust })} busy={busy} />
    </div>
  )
}
