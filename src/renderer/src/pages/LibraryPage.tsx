import { useMemo, useState } from 'react'
import type { DownloadJob, LibraryModel, Precision } from '@shared/types'
import { COMPONENT_ROLE_LABEL, DIFFUSION_FAMILY_LABEL } from '@shared/diffusion'
import { ENGINE_LABEL, FORMAT_LABEL, PRECISIONS, engineForFormat } from '@shared/engines'
import { quantLabel, splitSuffix, standaloneBlock } from '@shared/quant'
import { getLang, L } from '@shared/i18n'
import { estimateMemory, judgeFit } from '@shared/fit'
import { formatBytes, formatCount, formatDate, formatParams } from '@shared/format'
import { api, errMsg, openExternal } from '../api'
import { Section, useApp } from '../App'
import { FitBadge } from '../components/FitBadge'
import { JobProgress } from '../components/JobProgress'
import { LoadProgressView } from '../components/LoadProgress'

export function LibraryPage() {
  const app = useApp()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const activeJobs = app.downloads.filter((d) => d.status !== 'done')

  const launch = async (m: LibraryModel, precision?: Precision, trustRemoteCode?: boolean) => {
    setBusyId(m.id)
    try {
      await api.server.start({ modelId: m.id, precision, trustRemoteCode })
      app.setPage(m.format === 'diffusion' ? 'image' : 'chat')
    } catch (e) {
      app.toast(errMsg(e), 'error')
    } finally {
      setBusyId(null)
    }
  }
  const remove = async (m: LibraryModel) => {
    if (!window.confirm(L(`「${m.displayName}」(${formatBytes(m.totalSize)}) をディスクから削除します。よろしいですか?`, `Delete "${m.displayName}" (${formatBytes(m.totalSize)}) from disk?`))) return
    try {
      await api.library.remove(m.id)
      app.toast(L('削除しました', 'Deleted'))
    } catch (e) {
      app.toast(errMsg(e), 'error')
    }
  }

  const s = app.server
  return (
    <div className="page scroll">
      <Section
        title={L('実行中のモデル', 'Running model')}
        right={
          s.state !== 'stopped' && (
            <button className="danger" onClick={() => api.server.stop()} title={L('モデルをメモリから降ろしてサーバーを終了します', 'Unload the model from memory and stop the server')}>
              {L('⏏ 解放', '⏏ Unload')}
            </button>
          )
        }
      >
        {s.state === 'stopped' && <div className="muted">{L('モデルは読み込まれていません。下のライブラリから起動してください。', 'No model is loaded. Launch one from the library below.')}</div>}
        {s.state === 'error' && <div className="error-box pre">{s.error}</div>}
        {(s.state === 'starting' || s.state === 'running') && (
          <div className="server-card">
            <div className="server-line">
              <span className={`status-dot ${s.state === 'running' ? 'ok' : 'warn'}`} />
              <strong>{s.modelName}</strong>
              {s.engine && <span className="tag">{ENGINE_LABEL[s.engine]}</span>}
              <span className="muted">{s.state === 'running' ? L('応答可能', 'Ready') : L('モデル読み込み中…', 'Loading model…')}</span>
            </div>
            <div className="server-line muted small">
              {L('コンテキスト', 'Context')} {formatCount(s.contextSize)}
              {s.gpuLayers !== undefined && L(` · GPU レイヤー ${s.gpuLayers}`, ` · GPU layers ${s.gpuLayers}`)}
              {s.precision && L(` · 精度 ${PRECISIONS.find((p) => p.id === s.precision)?.label ?? s.precision}`, ` · Precision ${PRECISIONS.find((p) => p.id === s.precision)?.label ?? s.precision}`)}
              {' · '}
              {s.buildInfo} · http://127.0.0.1:{s.port}
              {(s.engine === 'llamacpp' || s.engine === 'sdcpp') && (
                <a className="link" onClick={() => openExternal(`http://127.0.0.1:${s.port}`)}>
                  {L('Web UI を開く ↗', 'Open Web UI ↗')}
                </a>
              )}
            </div>
            {s.state === 'starting' && <LoadProgressView progress={s.progress} />}
          </div>
        )}
        {s.logTail.length > 0 && (
          <div className="log-wrap">
            <button className="ghost small" onClick={() => setShowLog((v) => !v)}>
              {showLog ? L('ログを隠す', 'Hide log') : L('サーバーログを表示', 'Show server log')}
            </button>
            {showLog && <pre className="log">{s.logTail.join('\n')}</pre>}
          </div>
        )}
      </Section>

      {activeJobs.length > 0 && (
        <Section title={L('ダウンロード', 'Downloads')}>
          {activeJobs.map((j) => (
            <div className="job" key={j.id}>
              <div className="job-main">
                <div>
                  <span className="quant">{quantLabel(j.quant)}</span> {j.displayName}
                  <span className="muted small">
                    {' '}
                    · {j.repoId} · {FORMAT_LABEL[j.format]}
                  </span>
                </div>
                <JobProgress job={j} />
              </div>
              <div className="job-actions">
                {(j.status === 'downloading' || j.status === 'queued') && <button className="ghost" onClick={() => api.downloads.cancel(j.id)}>{L('中断', 'Stop')}</button>}
                {(j.status === 'error' || j.status === 'cancelled') && (
                  <>
                    {/* 部品のジョブは検索画面に対応する項目が無いので、記録済みのエントリでそのまま再開する */}
                    <button onClick={() => (j.component ? api.downloads.resume(j.id) : app.openRepo(j.repoId))}>{L('再開', 'Resume')}</button>
                    <button className="ghost" onClick={() => api.downloads.remove(j.id)}>{L('消す', 'Remove')}</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </Section>
      )}

      <Section
        title={L(`ダウンロード済みモデル (${app.library.length})`, `Downloaded models (${app.library.length})`)}
        right={
          <button className="ghost" onClick={() => app.refreshLibrary()}>
            {L('更新', 'Refresh')}
          </button>
        }
      >
        {app.library.length === 0 && (
          <div className="muted">
            {getLang() === 'en' ? (
              <>
                No models yet. Download one from <a className="link" onClick={() => app.setPage('search')}>Find models</a>.
              </>
            ) : (
              <>
                まだモデルがありません。<a className="link" onClick={() => app.setPage('search')}>モデルを探す</a>からダウンロードしてください。
              </>
            )}
            <div className="small">
              {L('保存先: ', 'Save location: ')}
              <code>{app.settings?.modelsDir}</code>
              {L('(既存の .gguf や safetensors フォルダをここに置いても認識されます)', ' (existing .gguf files or safetensors folders placed here are also detected)')}
            </div>
          </div>
        )}
        {app.library.map((m) => (
          <LibraryRow key={m.id} model={m} busy={busyId === m.id} onLaunch={(p, t) => launch(m, p, t)} onRemove={() => remove(m)} />
        ))}
      </Section>
    </div>
  )
}

/** 画像生成モデルの部品 (VAE / テキストエンコーダー) のダウンロードジョブのうち、進行中のもの */
export function componentJobs(downloads: DownloadJob[], m: LibraryModel): DownloadJob[] {
  const ids = new Set((m.components ?? []).map((c) => c.jobId))
  return downloads.filter((j) => (j.status === 'downloading' || j.status === 'queued') && ids.has(j.id))
}

/**
 * 画像生成モデルを今起動できない理由。ボタンの表示 (label) とツールチップ (reason)。
 * 部品のダウンロード中かどうかは、ライブラリ一覧のスナップショットではなく常に最新のジョブ一覧から判断する
 * (一覧は取得時点の値で、中断・失敗のたびに届くとは限らないため)
 */
export function launchBlock(m: LibraryModel, downloads: DownloadJob[]): { label: string; reason: string } | null {
  if (m.format === 'gguf') {
    // 一部のレイヤーしか入っていない GGUF (投機的デコード用のドラフトなど) は llama-server が落ちる
    const block = standaloneBlock(m.displayName, m.header)
    return block ? { label: L('起動できません', "Can't launch"), reason: block } : null
  }
  const d = m.header?.diffusion
  if (d?.unsupported) return { label: L('非対応', 'Unsupported'), reason: d.unsupported }
  const comps = m.components ?? []
  if (componentJobs(downloads, m).length > 0) return {
      label: L('⇣ 部品を取得中…', '⇣ Getting components…'),
      reason: L('必要な部品 (テキストエンコーダー / VAE) をダウンロードしています。揃うと起動できます', 'Downloading the required components (text encoder / VAE). You can launch once they are all in place'),
    }
  if (comps.some((c) => !c.present)) return {
      label: L('部品が未取得', 'Components missing'),
      reason: L('必要な部品 (テキストエンコーダー / VAE) が揃っていません。「部品を取得」で自動ダウンロードできます', 'Some required components (text encoder / VAE) are missing. Use "Get components" to download them automatically'),
    }
  if (d && !d.singleFile && !m.components) return { label: L('起動できません', "Can't launch"), reason: L('この系統の部品の入手先が未登録のため実行できません', "Can't run: no source is registered for this family's components") }
  return null
}

/** 部品のダウンロードをまとめて中断するボタン。モデル本体の「中断」と同じ見た目 */
export function CancelComponentsButton({ jobs }: { jobs: DownloadJob[] }) {
  return (
    <button className="ghost" onClick={() => jobs.forEach((j) => void api.downloads.cancel(j.id))} title={L('部品のダウンロードを中断します', 'Stop downloading the components')}>
      {L('中断', 'Stop')}
    </button>
  )
}

/**
 * モデルの起動ボタン。画像生成モデルは部品のダウンロード中なら「中断」に、起動できない理由があれば無効化して理由を出す
 * (ライブラリ・画像生成ページで共通)
 */
export function LaunchButton({ model: m, busy, disabled, onLaunch }: { model: LibraryModel; busy: boolean; disabled?: boolean; onLaunch: () => void }) {
  const app = useApp()
  const partJobs = m.format === 'diffusion' ? componentJobs(app.downloads, m) : []
  if (partJobs.length > 0) return <CancelComponentsButton jobs={partJobs} />
  const block = launchBlock(m, app.downloads)
  return (
    <button className="primary" onClick={() => onLaunch()} disabled={busy || app.server.state === 'starting' || disabled || !!block} title={block?.reason}>
      {busy ? L('読み込み中…', 'Loading…') : (block?.label ?? L('▶ 起動', '▶ Launch'))}
    </button>
  )
}

/** 商用利用などに制限があるライセンスの部品を、ライセンス名とリンク付きで知らせる (制限の無いものは出さない) */
export function RestrictedLicenses({ licenses }: { licenses: Array<{ label: string; name: string; url: string; restriction?: string }> }) {
  const restricted = licenses.filter((l) => l.restriction)
  if (restricted.length === 0) return null
  return (
    <div className="small warn-text">
      {restricted.map((l) => (
        <div key={l.label}>
          ⚠ {l.label}
          {L(' は', ' —')}{' '}
          <a className="link" onClick={() => openExternal(l.url)}>
            {l.name}
          </a>
          : {l.restriction}
        </div>
      ))}
    </div>
  )
}

/** 部品分割型の画像生成モデル: 必要な部品の状態と「部品を取得」。ダウンロード中は部品ごとに進捗バーを出す */
export function ComponentsLine({ model: m }: { model: LibraryModel }) {
  const app = useApp()
  const [busy, setBusy] = useState(false)
  const comps = m.components ?? []
  const missing = comps.filter((c) => !c.present)
  const jobs = componentJobs(app.downloads, m)
  const downloading = jobs.length > 0
  const fetchParts = async () => {
    if (!m.header?.diffusion) return
    setBusy(true)
    try {
      await api.components.download(m.header.diffusion.family)
      app.toast(L('部品のダウンロードを開始しました', 'Started downloading the components'))
    } catch (e) {
      app.toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="components">
      <span className="small row gap components-line">
        <span className="muted">{L('部品:', 'Components:')}</span>
        {comps.map((c) => (
          <span key={c.role} className={c.present ? 'ok-text' : 'warn-text'} title={`${c.repo}/${c.path} (${c.label})\n${L('ライセンス', 'License')}: ${c.license.name}${c.license.restriction ? ` — ${c.license.restriction}` : ''}`}>
            {c.present ? '✓' : jobs.some((j) => j.id === c.jobId) ? '⇣' : '✗'} {COMPONENT_ROLE_LABEL[c.role]}
            {!c.present && ` (${formatBytes(c.sizeBytes)})`}
          </span>
        ))}
        {missing.length > 0 && !downloading && (
          <button className="small" onClick={fetchParts} disabled={busy}>
            {L('部品を取得', 'Get components')} ({formatBytes(missing.reduce((a, c) => a + c.sizeBytes, 0))})
          </button>
        )}
      </span>
      <RestrictedLicenses licenses={comps.map((c) => ({ label: COMPONENT_ROLE_LABEL[c.role], ...c.license }))} />
      {jobs.map((j) => (
        <div key={j.id} className="component-job">
          <span className="small">
            <span className="quant">{quantLabel(j.quant)}</span> {j.displayName}
          </span>
          <JobProgress job={j} />
        </div>
      ))}
    </div>
  )
}

function LibraryRow({
  model: m,
  busy,
  onLaunch,
  onRemove,
}: {
  model: LibraryModel
  busy: boolean
  onLaunch: (precision?: Precision, trustRemoteCode?: boolean) => void
  onRemove: () => void
}) {
  const app = useApp()
  const isActive = app.server.modelId === m.id && app.server.state !== 'stopped'
  const isSt = m.format === 'safetensors'
  const isImg = m.format === 'diffusion'
  const [precision, setPrecision] = useState<Precision>(app.settings?.transformersPrecision ?? 'auto')
  const [trust, setTrust] = useState(false)
  const py = app.python
  const cudaOk = !!py?.installed && !!py.cuda && !!py.bitsandbytes
  const engineReady = isSt ? !!py?.installed : isImg ? !!app.sd?.installed : !!app.runtime?.installed
  const fit = useMemo(() => {
    const est = estimateMemory({
      format: m.format,
      totalSize: m.totalSize,
      header: m.header,
      hfMeta: m.hfMeta,
      paramsB: m.paramsB,
      contextSize: app.settings?.contextSize ?? 4096,
      precision: isSt ? precision : undefined,
    })
    return judgeFit(est, app.sys, app.fitGpus(m.format))
  }, [m, app.sys, app.fitGpus, app.settings?.contextSize, isSt, precision, getLang()]) // 言語を切り替えたら表示の文言を作り直す
  const h = m.header
  return (
    <div className={`lib-row ${isActive ? 'active' : ''}`}>
      <div className="lib-main">
        <div className="lib-title">
          <span className="quant">{quantLabel(m.quant)}</span>
          <strong>{m.displayName + splitSuffix(m.splitParts)}</strong>
          <span className={`tag ${isSt ? 'st' : isImg ? 'img' : 'gguf'}`}>{FORMAT_LABEL[m.format]}</span>
          {isImg && m.header?.diffusion && (
            <span className="tag" title={m.header.diffusion.singleFile ? L('1 ファイルで実行できます', 'Runs from a single file') : L('テキストエンコーダーと VAE が別途必要', 'Needs a separate text encoder and VAE')}>
              {DIFFUSION_FAMILY_LABEL[m.header.diffusion.family] ?? m.header.diffusion.family}
              {!m.header.diffusion.singleFile && L(' (本体のみ)', ' (model only)')}
            </span>
          )}
          {isImg && m.header?.diffusion?.unsupported && (
            <span className="tag warn" title={m.header.diffusion.unsupported}>
              {L('非対応の形式', 'Unsupported format')}
            </span>
          )}
          {m.vision && (
            <span className="tag ok" title={m.mmprojFile ? `mmproj: ${m.mmprojFile}` : L('視覚言語モデル', 'Vision-language model')}>
              {L('画像入力', 'Image input')}
            </span>
          )}
          {m.format === 'gguf' && standaloneBlock(m.displayName, h) && (
            <span className="tag warn" title={standaloneBlock(m.displayName, h) ?? undefined}>
              {L('単体では実行不可', "Can't run on its own")}
            </span>
          )}
          {isActive && (
            <span className={`tag ${app.server.state === 'running' ? 'ok' : 'warn'}`}>
              {app.server.state === 'running'
                ? L('実行中', 'Running')
                : L(`読み込み中 ${Math.round((app.server.progress?.fraction ?? 0) * 100)}%`, `Loading ${Math.round((app.server.progress?.fraction ?? 0) * 100)}%`)}
            </span>
          )}
        </div>
        <div className="muted small">
          {m.repoId.includes('/') ? (
            <a className="link" onClick={() => app.openRepo(m.repoId)}>
              {m.repoId}
            </a>
          ) : (
            m.repoId
          )}
          {' · '}
          {formatBytes(m.totalSize)}
          {h?.architecture && ` · ${h.architecture}`}
          {m.paramsB && ` · ${formatParams(m.paramsB)}`}
          {h?.contextLength && ` · ctx ${formatCount(h.contextLength)}`}
          {' · '}
          {ENGINE_LABEL[engineForFormat(m.format)]}
          {' · '}
          {formatDate(m.downloadedAt)}
        </div>
        <div className="small row gap">
          <FitBadge fit={fit} />
          {isSt && (
            <label className="inline small">
              {L('精度', 'Precision')}
              <select value={precision} onChange={(e) => setPrecision(e.target.value as Precision)} disabled={isActive}>
                {PRECISIONS.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.id !== 'auto' && !cudaOk}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {isSt && h?.hasAutoMap && (
            <label className="check small">
              <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} disabled={isActive} />
              trust_remote_code
            </label>
          )}
          {m.components && <ComponentsLine model={m} />}
          {isImg && m.header?.diffusion?.unsupported && (
            <span className="warn-text">
              {m.header.diffusion.unsupported}
              {L('。fp8 / bf16 の safetensors か GGUF 版を使ってください', '. Use an fp8 / bf16 safetensors or a GGUF version.')}
            </span>
          )}
          {m.format === 'gguf' && standaloneBlock(m.displayName, h) && <span className="warn-text">{standaloneBlock(m.displayName, h)}</span>}
          {!engineReady && (
            <span className="warn-text">
              {isSt ? L('Python エンジン', 'Python engine') : isImg ? L('画像生成エンジン (stable-diffusion.cpp)', 'Image generation engine (stable-diffusion.cpp)') : 'llama.cpp'}
              {L('が未インストール →', ' is not installed →')}{' '}
              <a className="link" onClick={() => app.setPage('settings')}>
                {L('設定', 'Settings')}
              </a>
            </span>
          )}
        </div>
      </div>
      <div className="lib-actions">
        {isActive ? (
          <button className="danger" onClick={() => api.server.stop()} title={L('モデルをメモリから降ろしてサーバーを終了します', 'Unload the model from memory and stop the server')}>
            {L('⏏ 解放', '⏏ Unload')}
          </button>
        ) : (
          <LaunchButton model={m} busy={busy} onLaunch={() => onLaunch(isSt ? precision : undefined, isSt ? trust : undefined)} />
        )}
        <button className="ghost" onClick={() => api.library.openFolder(m.id)} title={L('保存フォルダを開く', 'Open folder')}>
          📂
        </button>
        <button className="ghost" onClick={onRemove} disabled={isActive} title={L('削除', 'Delete')}>
          🗑
        </button>
      </div>
    </div>
  )
}
