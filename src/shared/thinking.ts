import { L } from './i18n'

/** チャットの「思考」の設定。思考するモデル (Qwen3 / DeepSeek-R1 / gpt-oss など) が考える量を変える */
export type ThinkingMode = 'standard' | 'short' | 'minimal' | 'off'

export const THINKING_MODES: Array<{ id: ThinkingMode; label: () => string; budget?: number }> = [
  { id: 'standard', label: () => L('標準 (制限なし)', 'Standard (no limit)') },
  { id: 'short', label: () => L('短め (1,024 トークンまで)', 'Short (up to 1,024 tokens)'), budget: 1024 },
  { id: 'minimal', label: () => L('最小 (256 トークンまで)', 'Minimal (up to 256 tokens)'), budget: 256 },
  { id: 'off', label: () => L('オフ (考えずに答える)', 'Off (answer without thinking)'), budget: 0 },
]

/**
 * チャットのリクエストに足すパラメータ。llama.cpp と HF Runner の Python サーバーが同じ名前で受け付ける。
 * - thinking_budget_tokens: 思考の上限トークン数。超えたら思考を打ち切って回答させる (思考するモデル全般に効く)
 * - chat_template_kwargs.enable_thinking: false で思考そのものを止める (Qwen3 など切り替えに対応したモデル)
 * - chat_template_kwargs.reasoning_effort: 思考の段階 (gpt-oss など段階に対応したモデル。対応していないモデルでは無視される)
 * 標準では何も足さない (モデルの既定のまま)
 */
/**
 * 生成が上限で止まった (finish_reason = "length") ときに、回答の下に出す説明。
 * hasAnswer: 回答 (本文) が出始めていたか / thought: 思考があったか /
 * byMaxTokens: 最大出力トークンに達したか (そうでなければコンテキスト長がいっぱいになった)
 */
export function limitNotice(hasAnswer: boolean, thought: boolean, byMaxTokens: boolean, maxTokens: number, contextSize?: number): string {
  const n = (v: number | undefined) => (v === undefined ? '-' : v.toLocaleString())
  const limitJa = byMaxTokens ? `最大出力トークン (${n(maxTokens)})` : `コンテキスト長 (${n(contextSize)})`
  const limitEn = byMaxTokens ? `the max output tokens (${n(maxTokens)})` : `the context length (${n(contextSize)})`
  const raiseJa = byMaxTokens ? '「パラメータ」の「最大出力トークン」を増やして' : '設定の「コンテキスト長」を増やして (モデルの起動し直しが必要です)'
  const raiseEn = byMaxTokens ? 'raise "Max output tokens" under "Parameters"' : 'raise "Context length" in Settings (relaunch the model)'
  if (!hasAnswer && thought)
    return L(
      `思考の途中で${limitJa}に達したため、回答が出ませんでした。「パラメータ」の「思考」を「短め」「最小」「オフ」にするか、${raiseJa}ください。`,
      `Thinking reached ${limitEn} before the answer started, so there is no answer. Set "Thinking" under "Parameters" to Short, Minimal or Off, or ${raiseEn}.`,
    )
  return L(`${limitJa}に達したため、回答が途中で終わりました。続きが必要なら${raiseJa}ください。`, `The answer stopped at ${limitEn}. To get the rest, ${raiseEn}.`)
}

export function thinkingParams(mode: ThinkingMode | undefined): Record<string, unknown> {
  const m = THINKING_MODES.find((x) => x.id === mode)
  if (!m || m.budget === undefined) return {}
  return {
    thinking_budget_tokens: m.budget,
    chat_template_kwargs: { reasoning_effort: 'low', ...(m.id === 'off' ? { enable_thinking: false } : {}) },
  }
}
