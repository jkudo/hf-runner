import { describe, expect, it } from 'vitest'
import { limitNotice, thinkingParams } from '../src/shared/thinking'

describe('thinkingParams', () => {
  it('adds nothing for the standard mode (model default)', () => {
    expect(thinkingParams('standard')).toEqual({})
    expect(thinkingParams(undefined)).toEqual({})
  })
  it('limits thinking with thinking_budget_tokens and asks for low effort', () => {
    expect(thinkingParams('short')).toEqual({ thinking_budget_tokens: 1024, chat_template_kwargs: { reasoning_effort: 'low' } })
    expect(thinkingParams('minimal')).toEqual({ thinking_budget_tokens: 256, chat_template_kwargs: { reasoning_effort: 'low' } })
  })
  it('turns thinking off for models that support it, and ends it at once for the others', () => {
    expect(thinkingParams('off')).toEqual({ thinking_budget_tokens: 0, chat_template_kwargs: { reasoning_effort: 'low', enable_thinking: false } })
  })
})

describe('limitNotice', () => {
  it('explains a missing answer when thinking used up the max output tokens', () => {
    const t = limitNotice(false, true, true, 2048, 4096)
    expect(t).toContain('思考の途中')
    expect(t).toContain('最大出力トークン (2,048)')
    expect(t).toContain('「思考」')
  })
  it('names the context length when the context filled up first', () => {
    const t = limitNotice(false, true, false, 999999, 4096)
    expect(t).toContain('コンテキスト長 (4,096)')
    expect(t).toContain('起動し直し')
  })
  it('says the answer was cut off when it had started', () => {
    expect(limitNotice(true, true, true, 2048, 4096)).toContain('回答が途中で終わりました')
    expect(limitNotice(true, false, false, 2048, 4096)).toContain('コンテキスト長')
  })
})
