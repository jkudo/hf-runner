import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { needsTranslation } from '../src/shared/text'
import { groupGgufFiles } from '../src/shared/quant'
import { DEFAULT_TRANSLATION_MODEL, TRANSLATION_MODELS, translationModel } from '../src/shared/translation'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hfr-settings-'))
vi.mock('electron', () => ({ app: { getPath: () => userData }, shell: {} }))
const { SettingsStore } = await import('../src/main/settings')
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }))

describe('prompt translation helpers', () => {
  it('translates prompts written in any non-English language', () => {
    for (const text of [
      '猫が窓辺に座っている', // 日本語
      'カタカナ only',
      '夕阳下海边散步的白猫', // 中国語
      '해질녘 바닷가를 걷는 하얀 고양이', // 韓国語
      'белая кошка на пляже', // ロシア語
      'قطة بيضاء على الشاطئ', // アラビア語
      'แมวขาวบนชายหาด', // タイ語
      'une chatte blanche près de la fenêtre', // フランス語 (アクセント記号あり)
      'eine weiße Katze', // ドイツ語
      'un gato pequeño en la montaña', // スペイン語
      'một con mèo trắng', // ベトナム語
    ])
      expect(needsTranslation(text), text).toBe(true)
  })
  it('leaves English prompts (including weights, punctuation and emoji) untouched', () => {
    for (const text of ['a cat on a windowsill, watercolor', '(masterpiece:1.2), best quality, <lora:x:0.8>', 'a cat — “cute” 🐱', ''])
      expect(needsTranslation(text), text).toBe(false)
  })
})

describe('translation models', () => {
  // 各リポジトリの実際のファイル名
  const FILES: Record<string, string> = {
    'qwen3-4b': 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    'qwen3-1.7b': 'Qwen3-1.7B-Q4_K_M.gguf',
  }
  it('entry keys match the ones groupGgufFiles produces', () => {
    for (const m of TRANSLATION_MODELS) {
      const { entries } = groupGgufFiles([{ path: FILES[m.id], size: m.bytes }], m.repo)
      expect(entries[0].key, m.id).toBe(m.entryKey)
    }
  })
  it('falls back to the default for unknown or missing ids', () => {
    expect(translationModel(undefined).id).toBe(DEFAULT_TRANSLATION_MODEL)
    expect(translationModel('nope').id).toBe(DEFAULT_TRANSLATION_MODEL)
    expect(translationModel('qwen3-1.7b').id).toBe('qwen3-1.7b')
  })
})

describe('translation model setting', () => {
  const write = (s: object) => fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(s))
  it('new users get the default model', () => {
    write({})
    expect(new SettingsStore().get().translationModel).toBe(DEFAULT_TRANSLATION_MODEL)
  })
  it('users who already used translation (with Qwen3-1.7B) keep it', () => {
    write({ promptTranslation: true })
    expect(new SettingsStore().get().translationModel).toBe('qwen3-1.7b')
  })
  it('an explicit choice wins', () => {
    write({ promptTranslation: true, translationModel: 'qwen3-4b' })
    expect(new SettingsStore().get().translationModel).toBe('qwen3-4b')
  })
})
