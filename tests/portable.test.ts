import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { name: 'HF Runner', isPackaged: false } }))
const { isInstalledLayout } = await import('../src/main/portable')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfr-layout-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** 配布フォルダのルートを作る (ランチャー + 本体を入れた app/ + 追加のファイル) */
const layout = (name: string, extra: string[]) => {
  const root = path.join(tmp, name)
  fs.mkdirSync(path.join(root, 'app'), { recursive: true })
  for (const f of ['HF Runner.exe', 'LICENSE.txt', 'app/HF Runner App.exe', ...extra]) fs.writeFileSync(path.join(root, f), '')
  return root
}

describe('isInstalledLayout', () => {
  it('recognizes the installer version by its uninstaller, whatever electron-builder names it', () => {
    // 本体を "HF Runner App.exe" にしてからのアンインストーラー名 (以前はこれを見落としてポータブル扱いになっていた)
    expect(isInstalledLayout(layout('installed-app', ['Uninstall HF Runner App.exe']))).toBe(true)
    expect(isInstalledLayout(layout('installed-old', ['Uninstall HF Runner.exe']))).toBe(true)
  })
  it('treats the zip version (no uninstaller) as portable', () => {
    expect(isInstalledLayout(layout('zip', []))).toBe(false)
  })
  it('does not throw for a missing folder', () => {
    expect(isInstalledLayout(path.join(tmp, 'nope'))).toBe(false)
  })
})
