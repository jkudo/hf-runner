import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: shared },
    // バンドルに埋め込む React などの著作権表示 (/** @license … */) を消さずにファイル末尾に残す (MIT の表示義務)
    esbuild: { legalComments: 'eof' },
    // 開発時に Vite / React Refresh が注入するインラインスクリプトを CSP で許可するための nonce
    html: { cspNonce: 'hfrunner-dev' },
  },
})
