import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 配布フォルダのルート。パッケージ版では本体 (HF Runner App.exe) は app/ の中にあり、
 * その親にランチャー (HF Runner.exe) がある (scripts/nest-app.js)。
 * インストーラー版のアンインストーラーやポータブルの data/ はそのルートに置かれる
 */
export function distRoot(): string {
  const exeDir = path.dirname(process.execPath)
  const parent = path.dirname(exeDir)
  if (path.basename(exeDir) === 'app' && fs.existsSync(path.join(parent, `${app.name}.exe`))) return parent
  return exeDir
}

/**
 * インストーラー版 (NSIS) のフォルダか。ルートにアンインストーラー "Uninstall <名前>.exe" があるかで見分ける。
 * 名前は electron-builder の設定 (本体の実行ファイル名など) で変わるので固定しない。
 * 以前は "Uninstall HF Runner.exe" 決め打ちで、本体を "HF Runner App.exe" にしたとき実際の名前
 * "Uninstall HF Runner App.exe" と合わずにポータブル扱いになり、設定・エンジン・モデルをインストール先の data/ に
 * 保存していた (上書きインストールでは旧版のアンインストーラーがインストール先を丸ごと消すので、一緒に消えていた)
 */
export function isInstalledLayout(root: string): boolean {
  try {
    return fs.readdirSync(root).some((f) => /^Uninstall .+\.exe$/i.test(f))
  } catch {
    return false
  }
}

/**
 * ポータブルモード(zip 版)の判定。
 * インストーラー版はルートに NSIS のアンインストーラーがあるのでそれで見分け (データは通常の userData = %APPDATA% に置く)、
 * 無ければルートの data/ に設定・ランタイム・Python 環境・モデルを全て保存する。
 * 開発時(electron.exe から起動)は通常の userData を使う。
 * Windows の zip 配布専用。Linux の AppImage は読み取り専用の一時マウントで実行されるので対象外
 */
export function portableDataDir(): string | null {
  if (!app.isPackaged || process.platform !== 'win32') return null
  const root = distRoot()
  if (isInstalledLayout(root)) return null
  return path.join(root, 'data')
}

/** p が base の中(base 自身を含む)にあるか */
export function isInside(base: string, p: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(p))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
