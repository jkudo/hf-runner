import type { Api } from '@shared/types'

export const api: Api = window.api

/** IPC 越しのエラーメッセージから Electron の接頭辞を取り除く */
export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function openExternal(url: string): void {
  void api.shell.openExternal(url)
}
