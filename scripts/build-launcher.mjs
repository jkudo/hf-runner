// ランチャー (launcher/Launcher.cs) を Windows 標準の .NET Framework の csc.exe でビルドし、
// launcher/dist/HF Runner.exe に出力する。electron-builder が win.extraFiles で exe の隣に同梱する。
// アイコンは build/icon.png を electron-builder と同じ変換処理 (app-builder-lib の convertIcon) で .ico にして埋め込む。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'launcher', 'dist')
const outExe = path.join(outDir, 'HF Runner.exe')

if (process.platform !== 'win32') {
  console.log('[launcher] Windows 以外ではビルドしません')
  process.exit(0)
}

const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!fs.existsSync(csc)) {
  console.error(`[launcher] csc.exe が見つかりません: ${csc}(.NET Framework 4.x が必要です)`)
  process.exit(1)
}

// build/icon.png → .ico(package.json の exports を避けるため絶対パスで読み込む)
const require = createRequire(import.meta.url)
const { convertIcon } = require(path.join(root, 'node_modules', 'app-builder-lib', 'out', 'util', 'iconConverter.js'))
const iconDir = path.join(outDir, 'icon')
fs.mkdirSync(iconDir, { recursive: true })
const { icons } = await convertIcon({ sources: ['build/icon.png'], fallbackSources: [], roots: [root], format: 'ico', outDir: iconDir })
const ico = icons[0]?.file
if (!ico) throw new Error('[launcher] build/icon.png を .ico に変換できませんでした')

execFileSync(
  csc,
  [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:anycpu',
    `/win32icon:${ico}`,
    `/win32manifest:${path.join(root, 'launcher', 'app.manifest')}`,
    `/out:${outExe}`,
    path.join(root, 'launcher', 'Launcher.cs'),
  ],
  { stdio: 'inherit' },
)
console.log(`[launcher] ${path.relative(root, outExe)} (${Math.round(fs.statSync(outExe).size / 1024)} KB)`)
