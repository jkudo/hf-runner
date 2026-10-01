import { useEffect, useRef, useState, type DragEvent, type ClipboardEvent } from 'react'
import { formatCount } from '@shared/format'
import { L } from '@shared/i18n'
import { limitNotice, THINKING_MODES, thinkingParams, type ThinkingMode } from '@shared/thinking'
import { MAX_MAX_TOKENS, MAX_TOKEN_STOPS, MIN_MAX_TOKENS, nearestStopIndex, parseMaxTokens } from '@shared/tokens'
import { useApp } from '../App'
import { LoadProgressView } from '../components/LoadProgress'

interface Message {
  role: 'user' | 'assistant'
  content: string
  /** 添付画像 (data URL) */
  images?: string[]
  reasoning?: string
  stats?: string
  /** 生成中で、まだ本文が届いていない (応答待ち or 思考中) */
  thinking?: boolean
  /** 思考 (reasoning_content) が始まった時刻 (Date.now) */
  reasoningStartedAt?: number
  /** 思考にかかった時間。本文が始まった、または生成が終わった時点で確定 */
  reasoningMs?: number
  /** 上限に達して止まったときの説明 (回答が出なかった・途中で終わった) */
  notice?: string
}

interface StreamChunk {
  error?: { message?: string } | string
  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }>
  usage?: { completion_tokens?: number; prompt_tokens?: number }
  timings?: { predicted_per_second?: number; predicted_n?: number; prompt_per_second?: number }
}

/** 添付画像の長辺の上限。画像トークン数と送信サイズを抑える */
const MAX_EDGE = 1536
const MAX_IMAGES = 8

/** 画像ファイルを縮小して data URL にする。PNG は透過を保つため PNG のまま、それ以外は JPEG */
async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9)
}

/** OpenAI 互換 API に送る content。画像があれば text + image_url のパーツ配列にする */
function toApiContent(m: Message): string | Array<Record<string, unknown>> {
  if (!m.images?.length) return m.content
  return [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
}

export function ChatPage() {
  const app = useApp()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const [showParams, setShowParams] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const s = app.server
  const ready = s.state === 'running' && s.port
  const vision = !!ready && !!s.vision

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  // モデルが変わったら添付をクリア(画像非対応モデルに送らないため)
  useEffect(() => {
    setPending([])
  }, [s.modelId])

  const addFiles = async (files: Iterable<File>) => {
    const images = [...files].filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    if (!vision) {
      app.toast(
        L(
          'このモデルは画像入力に対応していません(GGUF は mmproj 付き、safetensors は視覚言語モデルが必要です)',
          'This model does not support image input (GGUF needs an mmproj file; safetensors needs a vision-language model)',
        ),
        'error',
      )
      return
    }
    try {
      const urls = await Promise.all(images.slice(0, MAX_IMAGES).map(fileToDataUrl))
      setPending((prev) => [...prev, ...urls].slice(0, MAX_IMAGES))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      app.toast(L(`画像を読み込めません: ${msg}`, `Could not load the image: ${msg}`), 'error')
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    void addFiles(e.dataTransfer.files)
  }

  const send = async () => {
    const text = input.trim()
    if ((!text && pending.length === 0) || !ready || streaming) return
    setInput('')
    const images = pending
    setPending([])
    const history: Message[] = [...messages, { role: 'user', content: text, images: images.length ? images : undefined }]
    setMessages([...history, { role: 'assistant', content: '', thinking: true }])
    setStreaming(true)
    const controller = new AbortController()
    abortRef.current = controller
    const t0 = performance.now()
    let content = ''
    let reasoning = ''
    let tokens = 0
    let tps: number | undefined
    let reasonStart: number | undefined
    let reasonEnd: number | undefined
    let finish: string | null | undefined
    const maxTokens = app.settings?.maxTokens ?? 2048
    const flush = (done = false) =>
      setMessages((prev) => {
        const next = [...prev]
        const reasoningMs = reasonStart !== undefined ? (reasonEnd ?? Date.now()) - reasonStart : undefined
        next[next.length - 1] = { role: 'assistant', content, reasoning: reasoning || undefined, thinking: !done && !content, reasoningStartedAt: reasonStart, reasoningMs }
        return next
      })
    try {
      const body = {
        messages: [
          ...(app.settings?.systemPrompt?.trim() ? [{ role: 'system', content: app.settings.systemPrompt }] : []),
          ...history.map((m) => ({ role: m.role, content: toApiContent(m) })),
        ],
        stream: true,
        temperature: app.settings?.temperature ?? 0.7,
        max_tokens: maxTokens,
        stream_options: { include_usage: true },
        // 思考の量 (思考の上限トークン数・思考のオン/オフ)。標準では何も足さない
        ...thinkingParams(app.settings?.thinkingMode),
      }
      const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const detail = await res.text()
        throw new Error(L(`サーバーエラー (HTTP ${res.status}): ${detail}`, `Server error (HTTP ${res.status}): ${detail}`))
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let lastFlush = 0
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') break outer
            let chunk: StreamChunk
            try {
              chunk = JSON.parse(data) as StreamChunk
            } catch {
              continue
            }
            if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? L('生成エラー', 'Generation error')))
            const delta = chunk.choices?.[0]?.delta
            if (delta?.reasoning_content) {
              reasoning += delta.reasoning_content
              reasonStart ??= Date.now()
            }
            if (delta?.content) {
              if (reasonStart !== undefined && reasonEnd === undefined) reasonEnd = Date.now()
              content += delta.content
              tokens++
            }
            if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason
            if (chunk.usage?.completion_tokens) tokens = chunk.usage.completion_tokens
            if (chunk.timings?.predicted_per_second) tps = chunk.timings.predicted_per_second
          }
          const now = performance.now()
          if (now - lastFlush > 40) {
            lastFlush = now
            flush()
          }
        }
      }
      flush(true)
      const sec = (performance.now() - t0) / 1000
      const rate = tps ?? tokens / Math.max(sec, 0.001)
      const notice = finish === 'length' ? limitNotice(!!content.trim(), !!reasoning, tokens >= maxTokens, maxTokens, s.contextSize) : undefined
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        next[next.length - 1] = {
          ...last,
          notice,
          stats: L(`${tokens} トークン · ${rate.toFixed(1)} tok/s · ${sec.toFixed(1)} 秒`, `${tokens} tokens · ${rate.toFixed(1)} tok/s · ${sec.toFixed(1)}s`),
        }
        return next
      })
    } catch (e) {
      const aborted = controller.signal.aborted
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, thinking: false, content: last.content + (aborted ? L('\n\n(停止しました)', '\n\n(Stopped)') : `\n\n⚠ ${e instanceof Error ? e.message : String(e)}`) }
        return next
      })
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  return (
    <div className="page chat-page" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="chat-head">
        <div>
          {ready ? (
            <>
              <span className="status-dot ok" /> <strong>{s.modelName}</strong>
              <span className="muted small">
                {' '}
                · ctx {formatCount(s.contextSize)}
                {s.gpuLayers !== undefined && L(` · GPU レイヤー ${s.gpuLayers}`, ` · GPU layers ${s.gpuLayers}`)}
                {s.engine === 'transformers' && ` · Transformers (${s.precision ?? 'auto'})`}
                {vision && L(' · 画像入力可', ' · Image input')}
              </span>
            </>
          ) : s.state === 'starting' ? (
            <>
              <span className="status-dot warn" /> {L(`${s.modelName} を読み込み中…`, `Loading ${s.modelName}…`)}
            </>
          ) : (
            <span className="muted">{L('モデルが起動していません。', 'No model is running.')}</span>
          )}
        </div>
        <div className="chat-head-actions">
          <button className="ghost small" onClick={() => setShowParams((v) => !v)}>
            {showParams ? L('パラメータを隠す', 'Hide parameters') : L('パラメータ', 'Parameters')}
          </button>
          <button className="ghost small" onClick={() => setMessages([])} disabled={streaming || messages.length === 0}>
            {L('会話をクリア', 'Clear chat')}
          </button>
          {!ready && s.state !== 'starting' && (
            <button className="primary small" onClick={() => app.setPage('library')}>
              {L('ライブラリからモデルを起動', 'Launch a model from the Library')}
            </button>
          )}
        </div>
      </div>

      {s.state === 'starting' && (
        <div className="chat-loading">
          <LoadProgressView progress={s.progress} />
        </div>
      )}

      {showParams && app.settings && (
        <div className="params">
          <label>
            {L('システムプロンプト', 'System prompt')}
            <textarea
              rows={2}
              value={app.settings.systemPrompt}
              onChange={(e) => app.updateSettings({ systemPrompt: e.target.value })}
              placeholder={L('例: あなたは親切な日本語アシスタントです。', 'e.g. You are a helpful assistant.')}
            />
          </label>
          <label>
            {L('温度', 'Temperature')} {app.settings.temperature.toFixed(2)}
            <input type="range" min={0} max={2} step={0.05} value={app.settings.temperature} onChange={(e) => app.updateSettings({ temperature: Number(e.target.value) })} />
          </label>
          <MaxTokensField value={app.settings.maxTokens} contextSize={s.contextSize ?? app.settings.contextSize} onChange={(maxTokens) => app.updateSettings({ maxTokens })} />
          <label title={L('Qwen3・DeepSeek-R1・gpt-oss など、回答の前に考えるモデルで効きます。短くするほど回答が早く出ますが、難しい質問の正確さは下がることがあります', 'Applies to models that think before answering (Qwen3, DeepSeek-R1, gpt-oss, …). Shorter thinking answers sooner but may be less accurate on hard questions')}>
            {L('思考', 'Thinking')}
            <select value={app.settings.thinkingMode ?? 'standard'} onChange={(e) => app.updateSettings({ thinkingMode: e.target.value as ThinkingMode })}>
              {THINKING_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label()}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-icon">💬</div>
            <p>
              {ready
                ? vision
                  ? L(
                      'メッセージを入力して送信してください。画像は貼り付け・ドロップ・🖼 ボタンで添付できます。',
                      'Type a message and send it. You can attach images by pasting, dropping, or using the 🖼 button.',
                    )
                  : L('メッセージを入力して送信してください。', 'Type a message and send it.')
                : L('モデルを起動するとここでチャットできます。', 'Launch a model to chat here.')}
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.reasoning && (
              <details className="reasoning">
                <summary>
                  {m.thinking ? (
                    <>
                      <span className="spinner" /> {L('思考中…', 'Thinking…')} <ThinkingSeconds since={m.reasoningStartedAt} />
                      {L(' 秒', 's')}
                    </>
                  ) : (
                    L('思考過程', 'Reasoning') +
                    (m.reasoningMs !== undefined ? L(` (${Math.round(m.reasoningMs / 1000)} 秒)`, ` (${Math.round(m.reasoningMs / 1000)}s)`) : '')
                  )}
                </summary>
                <div className="pre">{m.reasoning}</div>
              </details>
            )}
            {m.thinking && m.reasoning && <div className="think-preview muted small">{lastLine(m.reasoning)}</div>}
            {m.thinking && !m.reasoning && (
              <div className="typing" aria-label={L('応答を待っています', 'Waiting for a response')}>
                <span />
                <span />
                <span />
              </div>
            )}
            {m.images && m.images.length > 0 && (
              <div className="msg-images">
                {m.images.map((src, j) => (
                  <img key={j} src={src} alt="" />
                ))}
              </div>
            )}
            <MessageBody text={m.content} />
            {m.notice && <div className="notice small warn msg-notice">⚠ {m.notice}</div>}
            {m.stats && <div className="msg-stats muted small">{m.stats}</div>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {pending.length > 0 && (
        <div className="attach-strip">
          {pending.map((src, i) => (
            <div key={i} className="thumb">
              <img src={src} alt="" />
              <button type="button" className="ghost" title={L('外す', 'Remove')} onClick={() => setPending((p) => p.filter((_, k) => k !== i))}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(e.target.files ?? [])
            e.target.value = ''
          }}
        />
        <button
          type="button"
          className="ghost attach"
          onClick={() => fileRef.current?.click()}
          disabled={!ready || !vision || streaming}
          title={vision ? L('画像を添付(貼り付け・ドロップも可)', 'Attach images (you can also paste or drop them)') : L('このモデルは画像入力に対応していません', 'This model does not support image input')}
        >
          🖼
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={
            ready
              ? vision
                ? L('メッセージを入力 (Enter で送信、Shift+Enter で改行、画像は貼り付け可)', 'Type a message (Enter to send, Shift+Enter for a new line, paste images)')
                : L('メッセージを入力 (Enter で送信、Shift+Enter で改行)', 'Type a message (Enter to send, Shift+Enter for a new line)')
              : L('モデルを起動してください', 'Launch a model first')
          }
          disabled={!ready}
          rows={2}
        />
        {streaming ? (
          <button type="button" className="danger" onClick={() => abortRef.current?.abort()}>
            {L('■ 停止', '■ Stop')}
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!ready || (!input.trim() && pending.length === 0)}>
            {L('送信', 'Send')}
          </button>
        )}
      </form>
    </div>
  )
}

/**
 * 最大出力トークン。スライドバーはよく使う値 (MAX_TOKEN_STOPS) に吸い付き、それ以外は横の欄に手で入れる。
 * 手入力は入力中に値を補正しない (「1」を打った時点で下限に直されると「1000」が打てない) よう、欄から離れたとき・Enter で反映する
 */
function MaxTokensField({ value, contextSize, onChange }: { value: number; contextSize?: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const v = parseMaxTokens(text)
    if (v === null) setText(String(value))
    else if (v !== value) onChange(v)
    else setText(String(value))
  }
  return (
    <div className="params-field">
      <span>
        {L('最大出力トークン', 'Max output tokens')} {value.toLocaleString()}
      </span>
      <div className="slider-with-input">
        <input
          type="range"
          min={0}
          max={MAX_TOKEN_STOPS.length - 1}
          step={1}
          list="max-token-stops"
          value={nearestStopIndex(value)}
          onChange={(e) => onChange(MAX_TOKEN_STOPS[Number(e.target.value)])}
          aria-label={L('最大出力トークン (よく使う値)', 'Max output tokens (common values)')}
        />
        <datalist id="max-token-stops">
          {MAX_TOKEN_STOPS.map((_, i) => (
            <option key={i} value={i} />
          ))}
        </datalist>
        <input
          type="number"
          min={MIN_MAX_TOKENS}
          max={MAX_MAX_TOKENS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          aria-label={L('最大出力トークン (手入力)', 'Max output tokens (manual)')}
        />
      </div>
      {contextSize !== undefined && value > contextSize && (
        <span className="small">
          {L(`コンテキスト長 (${contextSize.toLocaleString()}) を超える分は使われません`, `Anything beyond the context length (${contextSize.toLocaleString()}) is not used`)}
        </span>
      )}
    </div>
  )
}

/** 思考中の経過秒数。0.5 秒ごとにこの表示だけを更新する (メッセージ一覧全体は再描画しない) */
function ThinkingSeconds({ since }: { since?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  return <>{Math.max(0, Math.round((now - (since ?? now)) / 1000))}</>
}

/** 思考中に流し表示する直近の 1 行 (長ければ末尾 120 文字) */
function lastLine(text: string): string {
  const line = text.trimEnd().split('\n').pop() ?? ''
  return line.length > 120 ? `…${line.slice(-120)}` : line
}

/** ``` コードブロックだけを区別して表示する簡易レンダラ */
function MessageBody({ text }: { text: string }) {
  const parts = text.split(/```/)
  return (
    <div className="msg-body">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="code">
            {p.replace(/^[a-zA-Z0-9_+-]*\n/, '')}
          </pre>
        ) : (
          <div key={i} className="pre">
            {p}
          </div>
        ),
      )}
    </div>
  )
}
