// CHANGELOG.md から指定バージョンの節を取り出して標準出力に書く (GitHub のリリースの本文に使う)。
// 使い方: GITHUB_REPOSITORY=<所有者>/<リポジトリ> node scripts/release-notes.mjs v0.1.0 > notes.md
import fs from 'node:fs'

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>')
  process.exit(1)
}
const lines = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/)
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`))
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`)
  process.exit(1)
}
const rest = lines.slice(start + 1)
// 次のバージョンの見出しか、末尾のリンク定義 ([0.1.0]: …) の手前まで
const end = rest.findIndex((l) => l.startsWith('## [') || /^\[[^\]]+\]:\s/.test(l))
const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
// リリースの本文では相対リンクが解決されないので、GITHUB_REPOSITORY があればリポジトリの URL を付ける
const repo = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : '../..'
process.stdout.write(
  `${body}\n\n---\n\n` +
    `Download **\`HF-Runner-${version}-win-x64.exe\`** (installer) or **\`HF-Runner-${version}-win-x64.zip\`** (no installation) below. ` +
    `See the [README](${repo}/blob/main/README.md) for requirements and usage ([日本語](${repo}/blob/main/README.ja.md)).\n`,
)
