import { app, type BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { LibraryModel } from '@shared/types'
import { sleep } from '@shared/async'

/**
 * E2E スモークテスト。HFRUNNER_E2E_DIR が設定されている時だけ有効。
 * 画面を順に操作してスクリーンショットを outDir に保存し、終わったらアプリを終了する。
 */
export function setupE2E(win: BrowserWindow, outDir: string): void {
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', d.reason))
  win.webContents.once('did-finish-load', () => {
    runE2E(win, outDir)
      .then(() => app.quit())
      .catch((e) => {
        console.error('[e2e] failed:', e)
        app.exit(1)
      })
  })
}

/**
 * E2E の手順は日本語の文言でボタンを探すので、実行中は表示言語を日本語に固定し、終わったら (失敗しても) 元の設定に戻す。
 * HFRUNNER_E2E_LANG の手順は自分で言語を切り替える
 */
async function runE2E(win: BrowserWindow, outDir: string): Promise<void> {
  const wc = win.webContents
  const js = <T = unknown>(code: string) => wc.executeJavaScript(code, true) as Promise<T>
  const original = (await js<{ language: string }>(`window.api.settings.get()`)).language
  try {
    if (!process.env.HFRUNNER_E2E_LANG && original !== 'ja') await switchLanguage(wc, 'ja')
    await run(win, outDir)
  } finally {
    if (!win.isDestroyed()) {
      const now = (await js<{ language: string }>(`window.api.settings.get()`).catch(() => null))?.language
      if (now !== original) await js(`window.api.settings.set({ language: ${JSON.stringify(original)} })`).catch(() => {})
    }
  }
}

/** 設定の表示言語を変えて画面を読み直す */
async function switchLanguage(wc: Electron.WebContents, lang: string): Promise<void> {
  await wc.executeJavaScript(`window.api.settings.set({ language: ${JSON.stringify(lang)} })`, true)
  wc.reload()
  await new Promise<void>((resolve) => wc.once('did-finish-load', () => resolve()))
  await sleep(2500)
}

async function run(win: BrowserWindow, outDir: string): Promise<void> {
  const wc = win.webContents
  await fsp.mkdir(outDir, { recursive: true })
  const js = <T = unknown>(code: string) => wc.executeJavaScript(code, true) as Promise<T>
  // HFRUNNER_E2E_TRANSLATE_SWITCH: 翻訳モデルのダウンロード中に別のモデルへ切り替え、さらに戻す。
  // 切り替えのたびに前のダウンロードが止まり、最後に選んだモデルだけが取得・起動されて訳せることを確かめる (モデル未取得の環境で使う)
  if (process.env.HFRUNNER_E2E_TRANSLATE_SWITCH) {
    await sleep(2000)
    type St = { modelId: string; model: string; server: string; progress?: { doneBytes: number }; error?: string }
    const status = () => js<St>(`window.api.translate.status()`)
    const jobs = () => js<string>(`window.api.downloads.list().then(l => l.map(j => j.entryKey + ':' + j.status + ':' + Math.round(j.doneBytes / 1e6) + 'MB').join(', '))`)
    const until = async (ok: (s: St) => boolean, sec: number) => {
      let s = await status()
      for (let w = 0; w < sec * 2 && !ok(s); w++) {
        await sleep(500)
        s = await status()
      }
      return s
    }
    const downloading = (id: string) => (s: St) => s.modelId === id && s.model === 'downloading' && (s.progress?.doneBytes ?? 0) > 30e6
    await js(`window.api.translate.setModel('qwen3-1.7b')`)
    await js(`window.api.translate.setEnabled(true)`)
    console.log('[e2e] switch: enabled 1.7b →', JSON.stringify(await until(downloading('qwen3-1.7b'), 120)), '|', await jobs())
    await js(`window.api.translate.setModel('qwen3-4b')`)
    console.log('[e2e] switch: → 4b', JSON.stringify(await until(downloading('qwen3-4b'), 120)), '|', await jobs())
    await js(`window.api.translate.setModel('qwen3-1.7b')`)
    const final = await until((s) => s.modelId === 'qwen3-1.7b' && (s.server === 'running' || !!s.error), 900)
    console.log('[e2e] switch: → 1.7b', JSON.stringify(final), '|', await jobs())
    const out = await js<string>(`window.api.translate.run('赤いリンゴと青い空').catch(e => 'error: ' + e.message)`)
    console.log(`[e2e] switch: translate → ${JSON.stringify(out)}`)
    await js(`window.api.translate.setEnabled(false)`)
    console.log('[e2e] done')
    return
  }
  // HFRUNNER_E2E_MODELS=<JSON>:指定したモデルを順にダウンロード → 起動 → 質問して結果を記録する (モデルの動作確認)
  if (process.env.HFRUNNER_E2E_MODELS) {
    await sleep(3000)
    // HFRUNNER_E2E_PYTHON=<auto|cpu|cu128|…>: 先に Python エンジンを指定のバックエンドで入れ直す (設定画面の「インストール」と同じ処理)
    if (process.env.HFRUNNER_E2E_PYTHON) {
      const t = Date.now()
      const info = await js<Record<string, unknown>>(`window.api.python.install(${JSON.stringify(process.env.HFRUNNER_E2E_PYTHON)}).catch(e => ({ error: e.message }))`)
      console.log(`[models] python install (${process.env.HFRUNNER_E2E_PYTHON}) in ${Math.round((Date.now() - t) / 1000)}s: ${JSON.stringify({ torch: info.torchVersion, cuda: info.cuda, backend: info.backend, bitsandbytes: info.bitsandbytes, devices: info.devices, error: info.error })}`)
    }
    await runModelTests(js, outDir, process.env.HFRUNNER_E2E_MODELS)
    return
  }
  const shot = async (name: string) => {
    await sleep(300)
    const img = await wc.capturePage()
    await fsp.writeFile(path.join(outDir, `${name}.png`), img.toPNG())
    console.log(`[e2e] screenshot ${name}`)
  }
  // ナビは表示言語に関係なくページ ID で押す (呼び出し側は日本語のラベルで指定する)
  const NAV_PAGE: Record<string, string> = { モデルを探す: 'search', ライブラリ: 'library', チャット: 'chat', 画像生成: 'image', 設定: 'settings' }
  const clickNav = (label: string) =>
    js<boolean>(`(() => { const b = document.querySelector('.nav-btn[data-page="${NAV_PAGE[label] ?? label}"]'); b?.click(); return !!b })()`)

  // HFRUNNER_E2E_LANG=en|ja: 表示言語を切り替えて画面を一巡し、各ページを撮る。最後に設定画面から言語をもう一方へ切り替え、
  // 画面を作り直さずに文言だけが変わるか (入力中の検索語が残り、ファイル一覧の説明も新しい言語になるか) を確かめる。
  // 元の言語設定は runE2E が戻す
  if (process.env.HFRUNNER_E2E_LANG) {
    const lang = process.env.HFRUNNER_E2E_LANG
    await sleep(3000)
    await switchLanguage(wc, lang)
    const query = process.env.HFRUNNER_E2E_QUERY ?? 'gemma-3-4b-it-GGUF'
    await js(`(() => { const i = document.querySelector('.search-input'); i.focus(); document.execCommand('insertText', false, ${JSON.stringify(query)}); i.form.requestSubmit(); })()`)
    await sleep(4000)
    await js(`document.querySelector('.result-card')?.click()`)
    await sleep(8000)
    await shot(`${lang}-1-search-detail`)
    for (const [label, name] of [['ライブラリ', 'library'], ['チャット', 'chat'], ['画像生成', 'image'], ['設定', 'settings']] as const) {
      await clickNav(label)
      await sleep(1200)
      await shot(`${lang}-${name}`)
      if (name === 'settings') {
        for (const [i, section] of ['サーバーモード', 'Server mode'].entries()) {
          const found = await js<boolean>(`(() => { const s = [...document.querySelectorAll('.section')].find(s => s.textContent.includes(${JSON.stringify(section)})); s?.scrollIntoView(); return !!s })()`)
          if (found) {
            await sleep(300)
            await shot(`${lang}-settings-${i + 2}`)
            break
          }
        }
      }
    }
    // 設定画面の言語の選択肢を実際に変えて (読み直しなしで) 切り替える
    const other = lang === 'en' ? 'ja' : 'en'
    await clickNav('設定')
    await sleep(500)
    const switched = await js<boolean>(`(() => {
      const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'auto') && [...s.options].some(o => o.value === 'en'))
      if (!sel) return false
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(other)})
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(1500)
    await clickNav('モデルを探す')
    await sleep(8000) // モデル詳細のファイル一覧の取り直しを待つ
    await shot(`${lang}-switched-to-${other}`)
    const check = await js<{ nav: string[]; query: string; detail: string }>(`({
      nav: [...document.querySelectorAll('.nav-btn .nav-label')].map(b => b.textContent),
      query: document.querySelector('.search-input')?.value ?? '',
      detail: document.querySelector('.model-detail')?.textContent ?? '',
    })`)
    // Q4_K_M の説明が新しい言語で出ていれば、メインプロセス側の文言も取り直せている
    const q4 = { ja: 'サイズと品質のバランスが良く', en: 'Good balance of size and quality' }
    const detailOk = check.detail.includes(q4[other]) && !check.detail.includes(q4[lang as 'ja' | 'en'])
    console.log(
      `[e2e] live switch ${lang} -> ${other}: switched=${switched} nav=${JSON.stringify(check.nav)} query kept=${check.query === query} detail in ${other}=${detailOk}`,
    )
    return
  }

  await sleep(4000)
  await shot('01-search-initial')

  const query = process.env.HFRUNNER_E2E_QUERY ?? 'smollm2 135m'
  await js(`(() => { const i = document.querySelector('.search-input'); i.focus(); document.execCommand('insertText', false, ${JSON.stringify(query)}); i.form.requestSubmit(); })()`)
  await sleep(4000)
  await shot('02-search-results')

  await js(`document.querySelector('.result-card')?.click()`)
  await sleep(8000)
  await shot('03-model-detail')

  // HFRUNNER_E2E_DETAIL_LAUNCH: モデル詳細の「起動」ボタンを実際に押す (ダウンロード済みのエントリがあれば)
  if (process.env.HFRUNNER_E2E_DETAIL_LAUNCH) {
    const clicked = await js<boolean>(`(() => { const b = [...document.querySelectorAll('.model-detail button.primary')].find(b => b.textContent.includes('起動') && !b.disabled); b?.click(); return !!b })()`)
    let state = ''
    for (let w = 0; w < 300 && clicked; w++) {
      await sleep(1000)
      state = await js<string>(`window.api.server.status().then(s => s.state + (s.error ? ': ' + s.error.split('\\n')[0] : ''))`)
      if (state !== 'starting') break
    }
    const toasts = await js<string[]>(`[...document.querySelectorAll('.toast')].map(t => t.textContent)`)
    console.log(`[e2e] detail launch: clicked=${clicked} state=${state} toasts=${JSON.stringify(toasts)}`)
    const args = await js<string>(`window.api.server.status().then(s => (s.logTail[0] ?? '').replace(/"[^"]*"/g, '…'))`)
    console.log(`[e2e] detail launch command: ${args}`)
    await shot('03-detail-launch')
    await js(`window.api.server.stop()`)
  }

  await clickNav('ライブラリ')
  await sleep(1000)
  await shot('04-library')

  // HFRUNNER_E2E_FORMAT=gguf,diffusion で形式を、HFRUNNER_E2E_NAME=flux で名前 (部分一致) を絞れる
  const only = process.env.HFRUNNER_E2E_FORMAT?.split(',').map((s) => s.trim()).filter(Boolean)
  const nameFilter = process.env.HFRUNNER_E2E_NAME?.toLowerCase()
  const models = (await js<LibraryModel[]>(`window.api.library.list()`)).filter((m) => (!only || only.includes(m.format)) && (!nameFilter || m.displayName.toLowerCase().includes(nameFilter)))
  console.log('[e2e] library:', models.map((m) => `${m.displayName} (${m.format})`).join(', ') || '(none)')
  for (const [i, m] of models.entries()) {
    // GGUF は既定で CPU (GPU レイヤー 0)。HFRUNNER_E2E_NGL=99 などで GPU に載せる (使う GPU の選択の確認用)
    const ngl = Number(process.env.HFRUNNER_E2E_NGL ?? 0)
    const opts = m.format === 'gguf' ? { modelId: m.id, contextSize: 2048, gpuLayers: ngl } : { modelId: m.id, contextSize: 2048, precision: 'auto' }
    if (m.components?.some((c) => !c.present)) {
      // 部品分割型の画像生成モデル: 欠けている部品 (VAE / テキストエンコーダー) を自動取得してから起動する
      const family = m.header?.diffusion?.family
      console.log(`[e2e] components missing for ${m.displayName} (${family}):`, m.components.filter((c) => !c.present).map((c) => c.label).join(', '))
      await js(`window.api.components.download(${JSON.stringify(family)})`)
      await sleep(2500)
      // ダウンロード中の表示 (部品の進捗バーと「中断」) を撮ってから、一度中断して復帰できる (「部品を取得」が戻る) ことを確認する
      await shot(`04-parts-downloading-${i}`)
      await js(`window.api.downloads.list().then(l => l.filter(j => j.component && (j.status === 'downloading' || j.status === 'queued')).forEach(j => window.api.downloads.cancel(j.id)))`)
      await sleep(1500)
      await shot(`04-parts-cancelled-${i}`)
      const fetchBtn = await js<boolean>(`!![...document.querySelectorAll('.lib-row button')].find(b => b.textContent.includes('部品を取得'))`)
      const launchLabel = await js<string>(`[...document.querySelectorAll('.lib-row')].find(r => r.textContent.includes(${JSON.stringify(m.displayName)}))?.querySelector('.lib-actions button')?.textContent ?? ''`)
      console.log(`[e2e] after cancel: fetch button=${fetchBtn} launch button=${JSON.stringify(launchLabel)}`)
      await js(`window.api.components.download(${JSON.stringify(family)})`)
      for (let w = 0; w < 1800; w++) {
        const ready = await js<boolean>(`window.api.library.list().then(l => { const x = l.find(m => m.id === ${JSON.stringify(m.id)}); return !!x && !!x.components && x.components.every(c => c.present) })`)
        if (ready) break
        await sleep(2000)
      }
      console.log('[e2e] components ready')
    }
    // 起動は待たずに始め、読み込み中の進捗バーを撮ってから完了を待つ
    await js(`(() => { window.__start = window.api.server.start(${JSON.stringify(opts)}).then(s => s.state).catch(e => 'error: ' + e.message); return true })()`)
    await clickNav('ライブラリ')
    await sleep(m.format === 'gguf' ? 400 : 2500)
    await shot(`05-loading-${i}-${m.format}`)
    const started = await js<string>(`window.__start`)
    console.log(`[e2e] start ${m.format} ${m.displayName} →`, started)
    // 実際の起動コマンド (設定で編集した本文が反映されているかの確認用)
    console.log(`[e2e] command: ${await js<string>(`window.api.server.status().then(s => '[' + s.state + ' ' + (s.modelName ?? '') + ' ctx=' + s.contextSize + ' ngl=' + s.gpuLayers + '] ' + (s.logTail[0] ?? ''))`)}`)
    await sleep(500)
    await shot(`05-running-${i}-${m.format}`)
    if (started !== 'running') continue

    if (m.format === 'diffusion') {
      // 画像生成モデル: 小さな画像を 1 枚生成して画像生成ページを撮る
      await clickNav('画像生成')
      await sleep(600)
      if (process.env.HFRUNNER_E2E_TRANSLATE) {
        // プロンプト翻訳: 有効化 → モデル取得と翻訳サーバー起動を待つ → 日本語を英訳
        await js(`window.api.translate.setEnabled(true)`)
        for (let w = 0; w < 600; w++) {
          const st = await js<{ server: string; model: string; error?: string }>(`window.api.translate.status()`)
          if (st.server === 'running' || st.error) {
            console.log('[e2e] translate status:', JSON.stringify(st))
            break
          }
          await sleep(1000)
        }
        const t1 = Date.now()
        const en = await js<string>(`window.api.translate.run('白い背景に赤い丸と青い四角、フラットなイラスト').catch(e => 'error: ' + e.message)`)
        console.log(`[e2e] translate → ${JSON.stringify(en)} (${((Date.now() - t1) / 1000).toFixed(1)}s)`)
        // 画面から: 日本語以外 (中国語) のプロンプトを入力して「英訳を確認」を押し、表示された英訳を読む
        await js(`(() => { const t = document.querySelector('.image-form textarea'); t.focus(); t.select(); document.execCommand('insertText', false, '白色背景上的红色圆形和蓝色正方形，扁平插画') })()`)
        await sleep(300)
        const previewed = await js<boolean>(`(() => { const b = [...document.querySelectorAll('.translate-row button')].find(b => b.textContent.includes('英訳を確認') && !b.disabled); b?.click(); return !!b })()`)
        let shown = ''
        for (let w = 0; w < 60 && previewed && !shown; w++) {
          await sleep(500)
          shown = await js<string>(`document.querySelector('.image-form .notice.stack')?.textContent ?? ''`)
        }
        console.log(`[e2e] translate (zh, from the UI): button=${previewed} → ${JSON.stringify(shown.slice(0, 160))}`)
        await shot(`06-translate-${i}`)
        // 翻訳モデルを画面の選択肢で切り替え、翻訳サーバーが新しいモデルで動くのを待って同じ文を訳す。全モデルを試して元のモデルに戻す
        const originalModel = (await js<{ modelId: string }>(`window.api.translate.status()`)).modelId
        const options = await js<string[]>(`[...document.querySelectorAll('select.translate-model option')].map(o => o.value)`)
        for (const id of [...options.filter((x) => x !== originalModel), originalModel]) {
          await js(
            `(() => { const s = document.querySelector('select.translate-model'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(id)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`,
          )
          let st: { modelId: string; server: string; model: string; error?: string } | null = null
          for (let w = 0; w < 900; w++) {
            await sleep(1000)
            st = await js(`window.api.translate.status()`)
            if (st && st.modelId === id && (st.server === 'running' || st.error)) break
          }
          const t2 = Date.now()
          const out = await js<string>(`window.api.translate.run('una acuarela de un gato blanco sobre un sofá rojo').catch(e => 'error: ' + e.message)`)
          console.log(`[e2e] translate model ${id}: status=${JSON.stringify(st)} es → ${JSON.stringify(out)} (${((Date.now() - t2) / 1000).toFixed(1)}s)`)
          await shot(`06-translate-model-${id}`)
        }
        // 元の英語のプロンプトに戻しておく (以降の生成は英語で行う)
        await js(`(() => { const t = document.querySelector('.image-form textarea'); t.focus(); t.select(); document.execCommand('insertText', false, 'a red circle and a blue square on white background') })()`)
      }
      const t0 = Date.now()
      const fam = m.header?.diffusion?.family ?? 'unet'
      const cfg = fam === 'flux' ? 1 : fam.startsWith('qwen_image_2.1') ? 6 : fam === 'qwen_image' ? 2.5 : 7
      const result = await js<string>(
        `window.api.image.generate({ prompt: 'a red circle and a blue square on white background', negativePrompt: '', width: 256, height: 256, steps: 4, cfgScale: ${cfg}, seed: 1 }).then(s => s.state + ' ' + (s.result?.name ?? '')).catch(e => 'error: ' + e.message)`,
      )
      console.log(`[e2e] image generate → ${result} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
      await sleep(800)
      await shot(`06-image-${i}`)
      await js(`window.api.server.stop()`)
      await sleep(800)
      continue
    }

    await clickNav('チャット')
    await sleep(600)
    // HFRUNNER_E2E_IMAGE に画像を指定すると、画像入力対応モデルにはその画像を貼り付けて内容を尋ねる
    const vision = (await js<boolean>(`!!document.querySelector('.composer .attach:not([disabled])')`)) && !!process.env.HFRUNNER_E2E_IMAGE
    if (vision) {
      const img = await fsp.readFile(process.env.HFRUNNER_E2E_IMAGE!)
      const mime = process.env.HFRUNNER_E2E_IMAGE!.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
      // fetch('data:…') は CSP (connect-src) で弾かれるので、base64 を直接デコードして File を作る
      await js(`(() => {
        const bytes = Uint8Array.from(atob('${img.toString('base64')}'), (c) => c.charCodeAt(0))
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], 'test.png', { type: '${mime}' }))
        document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
      })()`)
      await sleep(1500)
      console.log('[e2e] attached image:', await js<number>(`document.querySelectorAll('.attach-strip .thumb').length`))
    }
    // 画像の質問は英語にする (小型の視覚言語モデルは英語中心で、日本語だと応答が崩れて確認にならないため)
    const prompt = vision ? 'What shapes and colors are in this image? Answer briefly.' : 'こんにちは。自己紹介を一文でお願いします。'
    await js(`(() => { const t = document.querySelector('.composer textarea'); t.focus(); document.execCommand('insertText', false, ${JSON.stringify(prompt)}); })()`)
    await sleep(300)
    await js(`document.querySelector('.composer button[type=submit]')?.click()`)
    // 回答が終わる (統計が出る) まで待つ。思考するモデルは長くかかるので最大 3 分
    for (let w = 0; w < 360; w++) {
      await sleep(500)
      if (await js<boolean>(`!![...document.querySelectorAll('.msg.assistant')].pop()?.querySelector('.msg-stats')`)) break
    }
    await shot(`06-chat-${i}-${m.format}`)
    const reply = await js<string>(`[...document.querySelectorAll('.msg.assistant .msg-body')].pop()?.textContent ?? ''`)
    const stats = await js<string>(`[...document.querySelectorAll('.msg.assistant .msg-stats')].pop()?.textContent ?? ''`)
    // 思考の長さと、上限で止まったときの説明 (思考 = 設定の「思考」、上限 = 最大出力トークン / コンテキスト長)
    const thought = await js<number>(`[...document.querySelectorAll('.msg.assistant')].pop()?.querySelector('.reasoning .pre')?.textContent?.length ?? 0`)
    const notice = await js<string>(`[...document.querySelectorAll('.msg.assistant')].pop()?.querySelector('.msg-notice')?.textContent ?? ''`)
    console.log(`[e2e] reply (${m.format}):`, JSON.stringify(reply).slice(0, 300))
    console.log(`[e2e] stats (${m.format}):`, stats, `| thinking chars: ${thought}`, notice ? `| notice: ${notice}` : '')
    // パラメータ (システムプロンプト・温度・最大出力トークン・思考) を開いて撮る
    await js(`[...document.querySelectorAll('.chat-head-actions button')].find(b => b.textContent.includes('パラメータ'))?.click()`)
    await sleep(300)
    await shot(`06-chat-params-${i}`)
    await js(`[...document.querySelectorAll('.chat-head-actions button')].find(b => b.textContent.includes('パラメータを隠す'))?.click()`)
    // HFRUNNER_E2E_LAN: サーバーモードを有効にし、LAN 側の IP アドレス経由 (他の PC と同じ経路) で API を呼ぶ
    if (process.env.HFRUNNER_E2E_LAN) {
      // 設定画面のチェックボックスを実際に押して有効にする
      await clickNav('設定')
      await sleep(600)
      const toggle = (text: string) => js(`[...document.querySelectorAll('label.check')].find(l => l.textContent.includes(${JSON.stringify(text)}))?.querySelector('input')?.click()`)
      await toggle('同じネットワークの他の PC')
      await toggle('ウィンドウを閉じても終了せず')
      await sleep(1500)
      const st = await js<{ lanApiKey: string }>(`window.api.settings.get()`)
      const lan = await js<{ listening: boolean; urls: string[]; error?: string }>(`window.api.lan.status()`)
      console.log('[e2e] lan status:', JSON.stringify(lan))
      const url = lan.urls[0]
      if (url) {
        const noKey = await fetch(`${url}/models`).then((r) => r.status)
        const res = await fetch(`${url}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${st.lanApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello in one short sentence.' }], max_tokens: 60, chat_template_kwargs: { enable_thinking: false } }),
        })
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        console.log(`[e2e] lan: without key -> ${noKey}, with key -> ${res.status}: ${JSON.stringify(data.choices?.[0]?.message?.content ?? data).slice(0, 160)}`)
      }
      await sleep(500)
      await js(`[...document.querySelectorAll('.section')].find(s => s.textContent.includes('サーバーモード'))?.scrollIntoView()`)
      await sleep(300)
      await shot(`06-lan-${i}`)
      // トレイ常駐: 閉じるボタンで終了せず隠れるだけで、サーバーモードも動き続けること
      win.close()
      await sleep(800)
      const health = lan.urls[0] ? await fetch(lan.urls[0].replace(/\/v1$/, '/health')).then((r) => r.status).catch((e) => `error ${e}`) : 'no url'
      console.log(`[e2e] tray: after close -> destroyed=${win.isDestroyed()} visible=${!win.isDestroyed() && win.isVisible()} health=${health}`)
      if (!win.isDestroyed()) win.show()
      await sleep(500)
      await toggle('同じネットワークの他の PC')
      await toggle('ウィンドウを閉じても終了せず')
      await sleep(800)
      console.log('[e2e] lan after disabling:', JSON.stringify(await js(`window.api.lan.status()`)))
      await clickNav('チャット')
    }
    // 生成中なら停止してから会話をクリアし、次のモデルへ
    await js(`document.querySelector('.composer button.danger')?.click()`)
    await sleep(800)
    await js(`[...document.querySelectorAll('.chat-head-actions button')].find(b => b.textContent.includes('クリア'))?.click()`)
    await js(`window.api.server.stop()`)
    await sleep(800)
  }

  await clickNav('設定')
  await sleep(800)
  await shot('07-settings')
  // 起動コマンドの編集欄: 差し込み項目の一覧を開いて撮る
  await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('差し込み項目')); b?.click(); setTimeout(() => b?.closest('.form-row')?.scrollIntoView({ block: 'center' }), 50) })()`)
  await sleep(500)
  await shot('07-settings-command')
  // 本文を書き換えて、欄から出ずにそのまま「既定に戻す」を (本物のマウス操作で) 押すと既定 (空) に戻ること。
  // 押した瞬間に欄のフォーカスが外れて書き換えた本文が先に保存されるので、それに負けないかを見る
  const row = `[...document.querySelectorAll('.command-edit')][0]`
  await js(`(() => { const t = ${row}.querySelector('textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); document.execCommand('insertText', false, ' -np 1') })()`)
  const rect = await js<{ x: number; y: number }>(`(() => { const r = [...${row}.querySelectorAll('button')].find(b => b.textContent.includes('既定に戻す')).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  wc.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await sleep(800)
  const saved = await js<string>(`window.api.settings.get().then(s => s.llamaCommand)`)
  const shown = await js<string>(`${row}.querySelector('textarea').value`)
  console.log(`[e2e] command restore: saved=${JSON.stringify(saved)} textarea ends with -np 1=${shown.endsWith('-np 1')}`)
  // 「この PC」(検出した GPU の一覧。内蔵 GPU は「使わない」表示) とサイドバー
  console.log('[e2e] gpus:', JSON.stringify(await js(`window.api.system.info().then(s => ({ source: s.gpuSource, gpus: s.gpus.map(g => g.name + (g.integrated ? ' [integrated]' : '')) }))`)))
  console.log('[e2e] sidebar gpus:', JSON.stringify(await js(`[...document.querySelectorAll('.sidebar-footer .sys-line')].map(e => e.textContent).filter(t => t.startsWith('GPU'))`)))
  await js(`[...document.querySelectorAll('.kv')].pop()?.scrollIntoView({ block: 'center' })`)
  await sleep(400)
  await shot('07-settings-pc')
  await js(`[...document.querySelectorAll('.form-label')].find(e => e.textContent === '使用する GPU')?.closest('.form-row')?.scrollIntoView({ block: 'center' })`)
  await sleep(400)
  await shot('07-settings-gpu')

  // 設定の入力欄 (システムプロンプト) に日本語入力 (IME) で打っても、変換中の文字が重複しないこと。
  // Chrome DevTools Protocol の Input.imeSetComposition で変換中の文字を 1 文字ずつ増やし、最後に Input.insertText で確定する
  await clickNav('チャット')
  await sleep(500)
  const originalPrompt = await js<string>(`window.api.settings.get().then(s => s.systemPrompt)`)
  await js(`[...document.querySelectorAll('.chat-head-actions button')].find(b => b.textContent.includes('パラメータ'))?.click()`)
  await sleep(300)
  await js(`(() => { const t = document.querySelector('.params textarea'); t.focus(); t.select(); document.execCommand('delete') })()`)
  await sleep(300)
  const word = 'あいうえおかきくけこ'
  wc.debugger.attach('1.3')
  try {
    for (let i = 1; i <= word.length; i++) {
      await wc.debugger.sendCommand('Input.imeSetComposition', { text: word.slice(0, i), selectionStart: i, selectionEnd: i })
      await sleep(40)
    }
    await wc.debugger.sendCommand('Input.insertText', { text: word })
  } finally {
    wc.debugger.detach()
  }
  await sleep(800)
  const shownPrompt = await js<string>(`document.querySelector('.params textarea').value`)
  const savedPrompt = await js<string>(`window.api.settings.get().then(s => s.systemPrompt)`)
  console.log(`[e2e] IME input: shown=${JSON.stringify(shownPrompt)} saved=${JSON.stringify(savedPrompt)} ok=${shownPrompt === word && savedPrompt === word}`)
  await shot('08-ime-system-prompt')
  await js(`window.api.settings.set({ systemPrompt: ${JSON.stringify(originalPrompt)} })`)

  // 最大出力トークン: スライドバーはよく使う値に吸い付き、横の欄は手入力 (入力中は補正せず、Enter / 欄から離れたときに反映)
  const originalMax = await js<number>(`window.api.settings.get().then(s => s.maxTokens)`)
  const savedMax = () => js<number>(`window.api.settings.get().then(s => s.maxTokens)`)
  const field = `document.querySelector('.slider-with-input input[type=number]')`
  // スライドバーを 7 番目の目盛り (8,192) へ。React の range は input イベントで値を受け取る
  await js(
    `(() => { const r = document.querySelector('.slider-with-input input[type=range]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, '6'); r.dispatchEvent(new Event('input', { bubbles: true })) })()`,
  )
  await sleep(400)
  const bySlider = await savedMax()
  // 手入力: 「1」を打った時点では補正されず、続けて「000」で 1000、Enter で保存
  await js(`(() => { const t = ${field}; t.focus(); t.select(); document.execCommand('insertText', false, '1') })()`)
  await sleep(300)
  const whileTyping = await js<string>(`${field}.value`)
  await js(`(() => { const t = ${field}; document.execCommand('insertText', false, '000'); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
  await sleep(400)
  const byTyping = await savedMax()
  const label = await js<string>(`document.querySelector('.params-field > span')?.textContent ?? ''`)
  console.log(`[e2e] max tokens: slider=${bySlider} while typing="${whileTyping}" typed=${byTyping} label="${label}" ok=${bySlider === 8192 && whileTyping === '1' && byTyping === 1000}`)
  await shot('08-max-tokens')
  await js(`window.api.settings.set({ maxTokens: ${originalMax} })`)

  console.log('[e2e] done')
}

interface ModelTestCase {
  repo: string
  /** gguf: 量子化 (Q4_K_M など) のエントリを選ぶ / safetensors: Transformers で実行 */
  kind: 'gguf' | 'safetensors'
  quant?: string
}

interface ModelTestResult {
  repo: string
  kind: string
  file?: string
  sizeGB?: number
  fit?: string
  download: string
  downloadSec?: number
  load: string
  loadSec?: number
  vision?: boolean
  text?: { ok: boolean; reply: string; tokens?: number; tokPerSec?: number; sec: number }
  image?: { ok: boolean; reply: string; sec: number }
  error?: string
}

const TEXT_PROMPT = '日本の首都はどこですか?一文で答えてください。'
const IMAGE_PROMPT = 'What shapes and colors are in this image? Answer briefly.'

/** 思考部分 (<think>…</think>) を除いた返答 */
const stripThink = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim()

/**
 * モデルの動作確認。アプリと同じ経路 (ファイル一覧 → ダウンロード → ライブラリ → 起動) で 1 つずつ試し、
 * 日本語の質問 (と画像入力対応なら画像の質問) に答えられるかを記録する。結果は outDir/model-tests.json と .md
 */
async function runModelTests(js: <T = unknown>(code: string) => Promise<T>, outDir: string, listFile: string): Promise<void> {
  const cases = JSON.parse(await fsp.readFile(listFile, 'utf8')) as ModelTestCase[]
  const image = process.env.HFRUNNER_E2E_IMAGE ? (await fsp.readFile(process.env.HFRUNNER_E2E_IMAGE)).toString('base64') : null
  const results: ModelTestResult[] = []
  const save = async () => {
    await fsp.writeFile(path.join(outDir, 'model-tests.json'), JSON.stringify(results, null, 2))
    await fsp.writeFile(path.join(outDir, 'model-tests.md'), resultsTable(results))
  }
  for (const c of cases) {
    const r: ModelTestResult = { repo: c.repo, kind: c.kind, download: '-', load: '-' }
    results.push(r)
    try {
      // 1. ファイル一覧から対象のエントリを選ぶ (画面と同じく、mmproj はあれば最小のものを一緒に)
      const pick = await js<{ entry: unknown; mmproj: unknown; meta: unknown; file: string; size: number } | null>(`(async () => {
        const [files, info] = await Promise.all([window.api.hf.files(${JSON.stringify(c.repo)}), window.api.hf.modelInfo(${JSON.stringify(c.repo)})])
        const entry = ${JSON.stringify(c.kind)} === 'gguf' ? files.entries.find(e => e.quant === ${JSON.stringify(c.quant ?? 'Q4_K_M')}) : files.transformersEntry
        if (!entry) return null
        const mmproj = ${JSON.stringify(c.kind)} === 'gguf' && files.mmproj.length ? [...files.mmproj].sort((a, b) => a.totalSize - b.totalSize)[0] : null
        return { entry, mmproj, meta: info.gguf ?? null, file: entry.files[0].path + (entry.files.length > 1 ? ' ほか ' + (entry.files.length - 1) : ''), size: entry.totalSize + (mmproj ? mmproj.totalSize : 0) }
      })()`)
      if (!pick) throw new Error(`${c.kind === 'gguf' ? c.quant ?? 'Q4_K_M' : 'Transformers'} のエントリが見つかりません`)
      r.file = pick.file
      r.sizeGB = Math.round((pick.size / 1e9) * 100) / 100
      console.log(`[models] ${c.repo}: ${pick.file} (${r.sizeGB} GB)`)

      // 2. ダウンロード (済みなら飛ばす)
      const t0 = Date.now()
      const job = await js<{ id: string }>(`window.api.downloads.start(${JSON.stringify(c.repo)}, ${JSON.stringify(pick.entry)}, ${JSON.stringify(pick.meta)}, ${JSON.stringify(pick.mmproj)})`)
      for (;;) {
        const j = await js<{ status: string; error?: string } | undefined>(`window.api.downloads.list().then(l => l.find(j => j.id === ${JSON.stringify(job.id)}))`)
        if (!j || j.status === 'done') break
        if (j.status === 'error' || j.status === 'cancelled') throw new Error(`ダウンロード失敗: ${j.error ?? j.status}`)
        await sleep(2000)
      }
      r.downloadSec = Math.round((Date.now() - t0) / 1000)
      r.download = 'ok'
      await sleep(1500) // ライブラリの更新を待つ
      const entryKey = (pick.entry as { key: string }).key
      const model = await js<{ id: string; displayName: string } | undefined>(`window.api.library.list().then(l => l.find(m => m.repoId === ${JSON.stringify(c.repo)} && m.entryKey === ${JSON.stringify(entryKey)}))`)
      if (!model) throw new Error('ライブラリに見つかりません')

      // 3. 起動 (llama.cpp は GPU レイヤー自動、Transformers は精度自動)
      const t1 = Date.now()
      const status = await js<{ state: string; port?: number; vision?: boolean; error?: string }>(
        `window.api.server.start({ modelId: ${JSON.stringify(model.id)}, contextSize: 4096 }).catch(e => ({ state: 'error', error: e.message }))`,
      )
      r.loadSec = Math.round((Date.now() - t1) / 1000)
      if (status.state !== 'running' || !status.port) {
        r.load = 'error'
        throw new Error((status.error ?? status.state).split('\n').slice(0, 2).join(' '))
      }
      r.load = 'ok'
      r.vision = !!status.vision
      const chat = async (content: unknown, maxTokens: number) => {
        const s = Date.now()
        const res = await fetch(`http://127.0.0.1:${status.port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content }], max_tokens: maxTokens, temperature: 0, chat_template_kwargs: { enable_thinking: false } }),
          signal: AbortSignal.timeout(600_000),
        })
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { completion_tokens?: number }; timings?: { predicted_per_second?: number }; error?: { message?: string } }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error?.message ?? ''}`)
        const sec = (Date.now() - s) / 1000
        const tokens = data.usage?.completion_tokens
        return { reply: stripThink(data.choices?.[0]?.message?.content ?? ''), sec: Math.round(sec * 10) / 10, tokens, tokPerSec: data.timings?.predicted_per_second ?? (tokens ? tokens / sec : undefined) }
      }

      // 4. 日本語の質問 (東京と答えられるか)。思考するモデル向けに長めに取る
      const text = await chat(TEXT_PROMPT, 512)
      r.text = { ok: /東京|Tokyo/i.test(text.reply), reply: text.reply.slice(0, 120), tokens: text.tokens, tokPerSec: text.tokPerSec ? Math.round(text.tokPerSec * 10) / 10 : undefined, sec: text.sec }
      // 速度は短い返答だと読み込み・通信の時間で低く出るので、64 トークン程度の返答で測り直す
      const speed = await chat('1から40までの数字を、読点で区切って書いてください。', 64)
      if (speed.tokPerSec) r.text.tokPerSec = Math.round(speed.tokPerSec * 10) / 10
      console.log(`[models]   text ${r.text.ok ? 'OK' : 'NG'} (${r.text.tokPerSec ?? '-'} tok/s): ${JSON.stringify(r.text.reply.slice(0, 80))}`)

      // 5. 画像入力対応なら、赤い丸と青い四角の画像について尋ねる
      if (r.vision && image) {
        const img = await chat([{ type: 'text', text: IMAGE_PROMPT }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }], 128)
        r.image = { ok: /red|赤/i.test(img.reply) && /blue|青/i.test(img.reply), reply: img.reply.slice(0, 120), sec: img.sec }
        console.log(`[models]   image ${r.image.ok ? 'OK' : 'NG'}: ${JSON.stringify(r.image.reply.slice(0, 80))}`)
      }
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e)
      console.log(`[models]   ERROR: ${r.error}`)
    } finally {
      await js(`window.api.server.stop()`).catch(() => {})
      await save()
    }
  }
  console.log('[models] done')
}

function resultsTable(results: ModelTestResult[]): string {
  const rows = results.map((r) => {
    const verdict = r.error ? '✗' : r.text?.ok && (!r.vision || r.image?.ok !== false) ? '✓' : '△'
    return `| ${verdict} | ${r.kind} | ${r.repo} | ${r.sizeGB ?? '-'} | ${r.loadSec ?? '-'} s | ${r.text?.tokPerSec ?? '-'} | ${r.text ? (r.text.ok ? 'OK' : 'NG') : '-'} | ${r.vision ? (r.image?.ok ? 'OK' : 'NG') : '-'} | ${(r.error ?? r.text?.reply ?? '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 80)} |`
  })
  return ['| 判定 | エンジン | モデル | サイズ GB | 読み込み | tok/s | 日本語 | 画像 | 返答 / エラー |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n') + '\n'
}
