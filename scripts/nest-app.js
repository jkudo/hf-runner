// electron-builder の artifactBuildStarted フック (Windows のみ)。
// zip / NSIS の各ターゲットを作る直前に、パッケージ済みフォルダ (dist/win-unpacked) を
// ルートにはランチャー (HF Runner.exe) だけを残し、Electron 本体一式を app/ に移した構成に組み替える。
//
//   HF Runner.exe         ← ランチャー (ユーザーがダブルクリックする唯一の exe)
//   app/HF Runner App.exe ← 本体 + DLL / resources / locales …
//   data/                 ← ポータブルモードの保存先 (実行時に作られる)
//
// afterPack ではなくこのフックを使うのは、afterPack の直後に electron-builder が
// resources/app.asar の整合性チェックと署名を行うため (移動後だと見つからず失敗する)。
// ターゲットごとに呼ばれるので、2 回目以降は何もしない。
const fs = require('node:fs/promises')
const path = require('node:path')

const LAUNCHER = 'HF Runner.exe'
// ルートに残すもの (ランチャーとこのアプリのライセンス)
const KEEP_AT_ROOT = [LAUNCHER, 'LICENSE.txt']
const APP_DIR = 'app'
const UNPACKED_DIRS = ['win-unpacked', 'win-ia32-unpacked', 'win-arm64-unpacked']

module.exports = async function artifactBuildStarted(event) {
  if (process.platform !== 'win32') return
  const outDir = path.dirname(event.file)
  for (const name of UNPACKED_DIRS) {
    const root = path.join(outDir, name)
    const entries = await fs.readdir(root).catch(() => null)
    if (!entries) continue
    if (!entries.includes(APP_DIR)) {
      if (!entries.includes(LAUNCHER)) throw new Error(`[nest-app] ${root} に ${LAUNCHER} がありません。npm run build:launcher を先に実行してください`)
      const appDir = path.join(root, APP_DIR)
      await fs.mkdir(appDir)
      for (const entry of entries) {
        if (KEEP_AT_ROOT.includes(entry)) continue
        await fs.rename(path.join(root, entry), path.join(appDir, entry))
      }
      console.log(`  • moved app files into ${name}/${APP_DIR}/ (launcher stays at root)`)
    }
    // NSIS ターゲットは UAC 昇格用の elevate.exe をルートの resources/ にコピーし、
    // インストーラーも $INSTDIR\resources\elevate.exe を使うので、そのフォルダを用意しておく (zip には不要)
    if (event.targetPresentableName === 'nsis') await fs.mkdir(path.join(root, 'resources'), { recursive: true })
  }
}
