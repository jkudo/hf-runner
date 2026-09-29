import { useEffect, useMemo, useRef, useState } from 'react'
import type { GeneratedImage, ImageCapabilities, ImageGenParams, LibraryModel } from '@shared/types'
import { IMAGE_SIZE_PRESETS } from '@shared/engines'
import { DIFFUSION_FAMILY_LABEL, familyDefaults } from '@shared/diffusion'
import { formatBytes } from '@shared/format'
import { quantLabel } from '@shared/quant'
import { needsTranslation } from '@shared/text'
import { TRANSLATION_MODELS, translationModel, type TranslationModelId } from '@shared/translation'
import { getLang, L } from '@shared/i18n'
import { api, errMsg } from '../api'
import { ComponentsLine, LaunchButton } from './LibraryPage'
import { Section, useApp } from '../App'
import { LoadProgressView } from '../components/LoadProgress'
import { ProgressBar } from '../components/ProgressBar'

/** 生成画像の URL。メインプロセスの hfimg:// プロトコルが images/ の中のファイルだけを配信する */
export const imageUrl = (img: GeneratedImage) => `hfimg://images/${encodeURIComponent(img.name)}`

const DEFAULTS: ImageGenParams = { prompt: '', negativePrompt: '', width: 512, height: 512, steps: 20, cfgScale: 7, seed: -1 }

/** 生成開始からの経過秒。1 秒ごとにこの表示だけを更新する (ページ全体は再描画しない) */
function ElapsedSeconds({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const sec = Math.max(0, Math.round((now - since) / 1000))
  return <>{L(`${sec} 秒経過`, `${sec}s elapsed`)}</>
}

export function ImagePage() {
  const app = useApp()
  const s = app.server
  const ready = s.state === 'running' && s.engine === 'sdcpp'
  const st = app.imageStatus
  const generating = st.state === 'generating'
  const [params, setParams] = useState<ImageGenParams>(DEFAULTS)
  const [caps, setCaps] = useState<ImageCapabilities | null>(null)
  const [gallery, setGallery] = useState<GeneratedImage[]>([])
  const [selected, setSelected] = useState<GeneratedImage | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refreshGallery = async () => {
    const list = await api.image.list().catch(() => [] as GeneratedImage[])
    setGallery(list)
    setSelected((cur) => (cur && list.some((g) => g.file === cur.file) ? cur : (list[0] ?? null)))
  }
  useEffect(() => {
    void refreshGallery()
  }, [])

  // モデルが起動したらサンプラー一覧と既定値を取得する
  useEffect(() => {
    if (!ready) {
      setCaps(null)
      return
    }
    let alive = true
    api.image
      .capabilities()
      .then((c) => {
        if (!alive) return
        setCaps(c)
        if (c) setParams((p) => ({ ...p, sampler: p.sampler && c.samplers.includes(p.sampler) ? p.sampler : c.defaultSampler }))
      })
      .catch(() => alive && setCaps(null))
    return () => {
      alive = false
    }
  }, [ready, s.modelId])

  // 生成が終わったら一覧に加えて選択する
  useEffect(() => {
    if (st.state === 'done' && st.result) {
      setGallery((g) => (g.some((x) => x.file === st.result!.file) ? g : [st.result!, ...g]))
      setSelected(st.result)
    }
  }, [st.state, st.result])

  const diffusionModels = useMemo(() => app.library.filter((m) => m.format === 'diffusion'), [app.library])
  // 起動中のモデルのテキストエンコーダーが CLIP (SD1.x / SD2.x / SDXL) なら英語プロンプト向け
  const running = useMemo(() => app.library.find((m) => m.id === s.modelId), [app.library, s.modelId])
  const family = running?.header?.diffusion?.family ?? 'unet'
  const clipOnly = ready && ['unet', 'sd1', 'sd2', 'sdxl'].includes(family)
  // 系統が変わったら、その系統の推奨値 (FLUX schnell は 4 ステップ / CFG 1 など) をパラメータに入れる
  const lastFamily = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || !running) return
    const key = `${family}:${running.mainFile}`
    if (lastFamily.current === key) return
    lastFamily.current = key
    setParams((p) => ({ ...p, ...familyDefaults(family, running.mainFile) }))
  }, [ready, running, family])

  // プロンプト翻訳 (英語以外の言語 → 英語)。有効なら、英語以外の文字を含むプロンプトを生成時に自動で英訳し、送った内容を欄の下に表示する
  const tr = app.translation
  const translateOn = !!tr && tr.enabled && tr.available
  const [translating, setTranslating] = useState(false)
  const [translated, setTranslated] = useState<{ prompt?: string; negative?: string } | null>(null)
  const nonEnglish = needsTranslation(params.prompt) || needsTranslation(params.negativePrompt)
  /** force: 「英訳を確認」から。英語の文字だけの文 (アクセント記号の無いフランス語など) も翻訳する */
  const translateBoth = async (force = false): Promise<{ prompt: string; negativePrompt: string }> => {
    const toEn = (t: string) => (t.trim() && (force || needsTranslation(t)) ? api.translate.run(t) : Promise.resolve(t))
    const [prompt, negativePrompt] = await Promise.all([toEn(params.prompt), toEn(params.negativePrompt)])
    setTranslated({ prompt: prompt !== params.prompt ? prompt : undefined, negative: negativePrompt !== params.negativePrompt ? negativePrompt : undefined })
    return { prompt, negativePrompt }
  }
  const translatePreview = async () => {
    setTranslating(true)
    try {
      await translateBoth(true)
    } catch (e) {
      app.toast(errMsg(e), 'error')
    } finally {
      setTranslating(false)
    }
  }
  const toggleTranslate = async (on: boolean) => {
    try {
      await api.translate.setEnabled(on)
      if (!on) setTranslated(null)
    } catch (e) {
      app.toast(errMsg(e), 'error')
    }
  }
  const trModel = translationModel(tr?.modelId)
  const changeTranslationModel = async (id: TranslationModelId) => {
    try {
      await api.translate.setModel(id)
      setTranslated(null)
    } catch (e) {
      app.toast(errMsg(e), 'error')
    }
  }

  const generate = async () => {
    if (!ready || generating || !params.prompt.trim()) return
    try {
      let used = params
      if (translateOn && nonEnglish) {
        setTranslating(true)
        try {
          used = { ...params, ...(await translateBoth()) }
        } finally {
          setTranslating(false)
        }
      }
      await api.image.generate(used)
    } catch (e) {
      app.toast(errMsg(e), 'error')
    }
  }
  const launch = async (m: LibraryModel) => {
    setBusyId(m.id)
    try {
      await api.server.start({ modelId: m.id })
    } catch (e) {
      app.toast(errMsg(e), 'error')
    } finally {
      setBusyId(null)
    }
  }
  const remove = async (img: GeneratedImage) => {
    if (!window.confirm(L(`${img.name} を削除します。よろしいですか?`, `Delete ${img.name}?`))) return
    try {
      await api.image.remove(img.file)
      // 一覧を読み直さず手元で外す
      setGallery((g) => g.filter((x) => x.file !== img.file))
      setSelected((cur) => (cur?.file === img.file ? (gallery.find((x) => x.file !== img.file) ?? null) : cur))
    } catch (e) {
      app.toast(errMsg(e), 'error')
    }
  }
  const useParams = (img: GeneratedImage) => {
    if (!img.params.prompt && !img.params.width) return
    setParams(img.params)
  }

  const preset = IMAGE_SIZE_PRESETS.find((p) => p.width === params.width && p.height === params.height)
  const set = (patch: Partial<ImageGenParams>) => {
    // プロンプトを書き換えたら、前の英訳表示は実際に送られる内容と食い違うので消す
    if ('prompt' in patch || 'negativePrompt' in patch) setTranslated(null)
    setParams((p) => ({ ...p, ...patch }))
  }
  // 数値欄を空にしたときに NaN を送らない
  const num = (value: string, fallback: number) => {
    const n = Number(value)
    return value.trim() !== '' && Number.isFinite(n) ? n : fallback
  }

  return (
    <div className="page scroll">
      <Section
        title={L('画像生成', 'Image generation')}
        right={
          ready ? (
            <span className="muted small">
              <span className="status-dot ok" /> {s.modelName} · {s.buildInfo}
            </span>
          ) : undefined
        }
      >
        {s.state === 'starting' && s.engine === 'sdcpp' && (
          <div className="chat-loading">
            <div className="muted small">{L(`${s.modelName} を読み込み中…`, `Loading ${s.modelName}…`)}</div>
            <LoadProgressView progress={s.progress} />
          </div>
        )}
        {!ready && s.state !== 'starting' && (
          <div className="stack">
            <div className="muted">
              {L(
                '画像生成モデル(Stable Diffusion 1.x / SDXL、FLUX.1、Qwen-Image など)を起動すると、ここで画像を生成できます。',
                'Launch an image generation model (Stable Diffusion 1.x / SDXL, FLUX.1, Qwen-Image, …) to generate images here.',
              )}
              {!app.sd?.installed && (
                <>
                  {' '}
                  {L('画像生成エンジン (stable-diffusion.cpp) が未インストールです →', 'The image generation engine (stable-diffusion.cpp) is not installed →')}{' '}
                  <a className="link" onClick={() => app.setPage('settings')}>
                    {L('設定でインストール', 'Install it in Settings')}
                  </a>
                </>
              )}
            </div>
            {diffusionModels.length === 0 ? (
              <div className="muted small">
                {getLang() === 'en' ? (
                  <>
                    There are no image generation models in your library. In <a className="link" onClick={() => app.setPage('search')}>Find models</a>, check
                    "Image generation" and search (e.g. stable-diffusion-v1-5, SDXL).
                  </>
                ) : (
                  <>
                    ライブラリに画像生成モデルがありません。<a className="link" onClick={() => app.setPage('search')}>モデルを探す</a>で「画像生成」にチェックを入れて検索してください(例: stable-diffusion-v1-5、SDXL)。
                  </>
                )}
              </div>
            ) : (
              <div className="entries">
                {diffusionModels.map((m) => (
                  <div key={m.id} className="entry">
                    <div className="entry-main">
                      <div className="entry-title">
                        <span className="quant">{quantLabel(m.quant)}</span>
                        <span className="entry-name">{m.displayName}</span>
                        {m.header?.diffusion && <span className="tag img">{DIFFUSION_FAMILY_LABEL[m.header.diffusion.family] ?? m.header.diffusion.family}</span>}
                      </div>
                      <div className="entry-sub muted small">
                        {m.repoId} · {formatBytes(m.totalSize)}
                        {m.header?.diffusion && !m.header.diffusion.singleFile && !m.components && L(' · この系統の部品の入手先が未登録のため実行できません', " · Can't run: no source is registered for this family's components")}
                      </div>
                      {m.header?.diffusion?.unsupported && <div className="small warn-text">{m.header.diffusion.unsupported}</div>}
                      {m.components && <ComponentsLine model={m} />}
                    </div>
                    <div className="entry-actions">
                      <LaunchButton model={m} busy={busyId === m.id} disabled={!app.sd?.installed} onLaunch={() => launch(m)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {ready && (
          <div className="image-layout">
            <form
              className="image-form stack"
              onSubmit={(e) => {
                e.preventDefault()
                void generate()
              }}
            >
              <label>
                {L('プロンプト', 'Prompt')}
                <textarea
                  rows={4}
                  value={params.prompt}
                  onChange={(e) => set({ prompt: e.target.value })}
                  placeholder={L('例: a cat sitting on a windowsill, soft morning light, watercolor', 'e.g. a cat sitting on a windowsill, soft morning light, watercolor')}
                  disabled={generating}
                />
              </label>
              {clipOnly && !translateOn && nonEnglish && (
                <div className="notice small">
                  {L('このモデルのテキストエンコーダー (CLIP) は英語で学習されているため、', "This model's text encoder (CLIP) was trained on English, so ")}
                  <b>{L('英語以外のプロンプトは意図どおりに反映されません', "prompts in other languages won't work as intended")}</b>
                  {L('。英語で書くか、下の「プロンプトを英語に翻訳する」を有効にしてください。', '. Write in English, or turn on "Translate prompts into English" below.')}
                </div>
              )}
              <div className="translate-row">
                <label className={`check ${tr?.available ? '' : 'disabled'}`} title={
                    tr?.available
                      ? L(
                          '右で選んだ翻訳モデルを取得して CPU で常駐させ、英語以外 (日本語・中国語・韓国語・フランス語など) のプロンプトを生成時に英語へ変換します。英語の文字だけで書いた文は英語とみなして自動では翻訳しません (「英訳を確認」で翻訳できます)',
                          'Downloads the translation model selected on the right, keeps it running on the CPU, and translates prompts in other languages (Japanese, Chinese, Korean, French, …) into English when you generate. Text written only with English letters is treated as English and not translated automatically (use "Preview translation" to translate it)',
                        )
                      : L('llama.cpp ランタイムが必要です', 'Requires the llama.cpp runtime')
                  }
                >
                  <input type="checkbox" checked={!!tr?.enabled} onChange={(e) => toggleTranslate(e.target.checked)} disabled={!tr?.available || generating || translating} />
                  {L('プロンプトを英語に翻訳する (多言語)', 'Translate prompts into English (multilingual)')}
                </label>
                <select
                  className="translate-model"
                  value={trModel.id}
                  onChange={(e) => changeTranslationModel(e.target.value as TranslationModelId)}
                  // 翻訳中に切り替えると翻訳サーバーが止まって失敗するので、終わるまで待たせる
                  disabled={!tr?.available || generating || translating}
                  title={trModel.note()}
                  aria-label={L('翻訳モデル', 'Translation model')}
                >
                  {TRANSLATION_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} ({formatBytes(m.bytes)})
                    </option>
                  ))}
                </select>
                {tr && !tr.available && (
                  <span className="small warn-text">
                    {L('llama.cpp が未インストールのため使えません →', 'Unavailable because llama.cpp is not installed →')}{' '}
                    <a className="link" onClick={() => app.setPage('settings')}>
                      {L('設定でインストール', 'Install it in Settings')}
                    </a>
                  </span>
                )}
                {translateOn && tr.model === 'downloading' && (
                  <span className="small muted translate-progress">
                    {L('翻訳モデルをダウンロード中', 'Downloading the translation model')} {tr.progress ? `${formatBytes(tr.progress.doneBytes)} / ${formatBytes(tr.progress.totalBytes)}` : ''}
                    <ProgressBar value={tr.progress?.doneBytes} max={tr.progress?.totalBytes} />
                  </span>
                )}
                {translateOn && tr.model === 'ready' && tr.server !== 'running' && !tr.error && <span className="small muted">{L('翻訳サーバーを起動中…', 'Starting the translation server…')}</span>}
                {translateOn && tr.server === 'running' && (
                  <button type="button" className="ghost small" onClick={translatePreview} disabled={translating || generating || !(params.prompt.trim() || params.negativePrompt.trim())}>
                    {translating ? L('英訳中…', 'Translating…') : L('英訳を確認', 'Preview translation')}
                  </button>
                )}
                {tr?.error && <span className="small err">{tr.error}</span>}
              </div>
              {translateOn && <div className="small muted">{L(`翻訳モデル: ${trModel.label} — ${trModel.note()}`, `Translation model: ${trModel.label} — ${trModel.note()}`)}</div>}
              {translated && (translated.prompt || translated.negative) && (
                <div className="notice small stack">
                  {translated.prompt && (
                    <div>
                      <span className="muted">{L('英訳 (プロンプト): ', 'English translation (prompt): ')}</span>
                      {translated.prompt}
                    </div>
                  )}
                  {translated.negative && (
                    <div>
                      <span className="muted">{L('英訳 (ネガティブ): ', 'English translation (negative): ')}</span>
                      {translated.negative}
                    </div>
                  )}
                  <div className="row gap">
                    <button type="button" className="ghost small" onClick={() => setParams((p) => ({ ...p, prompt: translated.prompt ?? p.prompt, negativePrompt: translated.negative ?? p.negativePrompt }))} disabled={generating}>
                      {L('英訳で置き換える', 'Replace with translation')}
                    </button>
                    <span className="muted">
                      {nonEnglish
                        ? L('生成時は自動で英訳した内容が送られます', 'The translated text is sent automatically when you generate')
                        : L('英語の文字だけの文は自動では翻訳しません。使う場合は「英訳で置き換える」を押してください', 'Text with only English letters is not translated automatically. Click "Replace with translation" to use it')}
                    </span>
                  </div>
                </div>
              )}
              <label>
                {L('ネガティブプロンプト', 'Negative prompt')}
                <textarea
                  rows={2}
                  value={params.negativePrompt}
                  onChange={(e) => set({ negativePrompt: e.target.value })}
                  placeholder={L('例: blurry, low quality, text', 'e.g. blurry, low quality, text')}
                  disabled={generating}
                />
              </label>
              <div className="row gap">
                <label className="inline">
                  {L('サイズ', 'Size')}
                  <select
                    value={preset ? `${preset.width}x${preset.height}` : 'custom'}
                    onChange={(e) => {
                      const p = IMAGE_SIZE_PRESETS.find((x) => `${x.width}x${x.height}` === e.target.value)
                      if (p) set({ width: p.width, height: p.height })
                    }}
                    disabled={generating}
                  >
                    {IMAGE_SIZE_PRESETS.map((p) => (
                      <option key={p.label} value={`${p.width}x${p.height}`}>
                        {p.label}
                      </option>
                    ))}
                    {!preset && <option value="custom">{L('カスタム', 'Custom')}</option>}
                  </select>
                </label>
                <label className="inline">
                  {L('幅', 'Width')}
                  <input type="number" min={64} max={caps?.maxWidth ?? 2048} step={8} value={params.width} onChange={(e) => set({ width: Number(e.target.value) || 512 })} disabled={generating} className="narrow" />
                </label>
                <label className="inline">
                  {L('高さ', 'Height')}
                  <input type="number" min={64} max={caps?.maxHeight ?? 2048} step={8} value={params.height} onChange={(e) => set({ height: Number(e.target.value) || 512 })} disabled={generating} className="narrow" />
                </label>
              </div>
              <div className="row gap">
                <label className="inline">
                  {L('ステップ', 'Steps')}
                  <input type="number" min={1} max={150} value={params.steps} onChange={(e) => set({ steps: Number(e.target.value) || 20 })} disabled={generating} className="narrow" />
                </label>
                <label className="inline">
                  CFG
                  <input type="number" min={0} max={30} step={0.5} value={params.cfgScale} onChange={(e) => set({ cfgScale: num(e.target.value, params.cfgScale) })} disabled={generating} className="narrow" />
                </label>
                <label className="inline">
                  {L('シード', 'Seed')}
                  <input type="number" min={-1} value={params.seed} onChange={(e) => set({ seed: num(e.target.value, -1) })} disabled={generating} className="narrow" title={L('-1 = ランダム', '-1 = random')} />
                </label>
                {caps && caps.samplers.length > 0 && (
                  <label className="inline">
                    {L('サンプラー', 'Sampler')}
                    <select value={params.sampler ?? caps.defaultSampler} onChange={(e) => set({ sampler: e.target.value })} disabled={generating}>
                      {caps.samplers.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <div className="row gap">
                {generating ? (
                  <button type="button" className="danger" onClick={() => api.image.cancel()}>
                    {L('■ 中止', '■ Cancel')}
                  </button>
                ) : (
                  <button type="submit" className="primary" disabled={!params.prompt.trim() || translating}>
                    {translating ? L('英訳中…', 'Translating…') : L('🎨 生成', '🎨 Generate')}
                  </button>
                )}
                {generating && (
                  <div className="gen-progress">
                    <ProgressBar value={st.step} max={st.steps} />
                    <span className="small muted">
                      {st.step !== undefined ? L(`${st.step} / ${st.steps} ステップ`, `${st.step} / ${st.steps} steps`) : L('準備中…', 'Preparing…')}
                      {st.secPerStep !== undefined && L(` · ${st.secPerStep.toFixed(1)} 秒/ステップ`, ` · ${st.secPerStep.toFixed(1)} s/step`)}
                      {st.startedAt !== undefined && (
                        <>
                          {' · '}
                          <ElapsedSeconds since={st.startedAt} />
                        </>
                      )}
                    </span>
                  </div>
                )}
                {st.state === 'error' && <span className="err small">{st.error}</span>}
                {st.state === 'cancelled' && <span className="muted small">{L('中止しました', 'Cancelled')}</span>}
              </div>
            </form>
            <div className="gen-preview">
              {selected ? (
                <>
                  <img src={imageUrl(selected)} alt={selected.params.prompt} />
                  <div className="small muted pre">
                    {selected.params.prompt}
                    {selected.params.negativePrompt && L(` / ネガティブ: ${selected.params.negativePrompt}`, ` / Negative: ${selected.params.negativePrompt}`)}
                  </div>
                  <div className="small muted">
                    {selected.params.width} × {selected.params.height} ·{' '}
                    {L(
                      `${selected.params.steps} ステップ · CFG ${selected.params.cfgScale} · シード ${selected.params.seed}`,
                      `${selected.params.steps} steps · CFG ${selected.params.cfgScale} · Seed ${selected.params.seed}`,
                    )}
                    {selected.params.sampler && ` · ${selected.params.sampler}`}
                    {selected.elapsedMs !== undefined && L(` · ${(selected.elapsedMs / 1000).toFixed(1)} 秒`, ` · ${(selected.elapsedMs / 1000).toFixed(1)} s`)}
                    {selected.modelName && ` · ${selected.modelName}`}
                  </div>
                  <div className="row gap">
                    <button className="ghost small" onClick={() => useParams(selected)} disabled={generating}>
                      {L('この設定を使う', 'Use these settings')}
                    </button>
                    <button className="ghost small" onClick={() => api.image.openFolder()}>
                      {L('📂 フォルダを開く', '📂 Open folder')}
                    </button>
                    <button className="ghost small" onClick={() => remove(selected)} disabled={generating}>
                      {L('🗑 削除', '🗑 Delete')}
                    </button>
                  </div>
                </>
              ) : (
                <div className="empty">
                  <div className="empty-icon">🎨</div>
                  <p>{L('プロンプトを入力して「生成」を押すと、ここに画像が表示されます。', 'Enter a prompt and press "Generate" to see the image here.')}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </Section>

      <Section
        title={L(`生成した画像 (${gallery.length})`, `Generated images (${gallery.length})`)}
        right={
          <div className="row gap">
            <button className="ghost" onClick={() => api.image.openFolder()}>
              {L('📂 フォルダを開く', '📂 Open folder')}
            </button>
            <button className="ghost" onClick={() => refreshGallery()}>
              {L('更新', 'Refresh')}
            </button>
          </div>
        }
      >
        {gallery.length === 0 ? (
          <div className="muted">{L('まだ画像がありません。', 'No images yet.')}</div>
        ) : (
          <div className="gallery">
            {gallery.map((g) => (
              <button key={g.file} className={`gallery-item ${selected?.file === g.file ? 'selected' : ''}`} onClick={() => setSelected(g)} title={g.params.prompt}>
                <img src={imageUrl(g)} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
