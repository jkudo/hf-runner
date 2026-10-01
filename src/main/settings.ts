import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '@shared/types'
import { DEFAULT_TRANSLATION_MODEL } from '@shared/translation'
import { AUTO_GPU } from '@shared/gpu'
import { isInside } from './portable'
import { recommendedBackend } from './runtime'
import { recommendedSdBackend } from './sdcpp'

const KEYS: Array<keyof Settings> = [
  'modelsDir',
  'hfToken',
  'backend',
  'contextSize',
  'gpuLayers',
  'threads',
  'serverPort',
  'systemPrompt',
  'temperature',
  'maxTokens',
  'thinkingMode',
  'torchBackend',
  'transformersPrecision',
  'downloadConnections',
  'sdBackend',
  'promptTranslation',
  'translationModel',
  'lanEnabled',
  'lanPort',
  'lanApiKey',
  'trayEnabled',
  'language',
  'llamaCommand',
  'sdCommand',
  'pythonCommand',
  'gpuSelection',
]

/**
 * userData/settings.json に保存する設定ストア。
 * portableDir が与えられた場合(zip 版)はモデルの既定保存先を portableDir/models にし、
 * portableDir 配下のパスは相対で保存してフォルダごと移動しても壊れないようにする
 */
export class SettingsStore {
  private data: Settings
  private readonly file: string

  constructor(private readonly portableDir: string | null = null) {
    this.file = path.join(app.getPath('userData'), 'settings.json')
    this.data = { ...this.defaults(), ...this.load() }
  }

  private defaults(): Settings {
    return {
      modelsDir: this.portableDir ? path.join(this.portableDir, 'models') : path.join(app.getPath('documents'), 'HFRunner', 'models'),
      hfToken: '',
      backend: recommendedBackend(process.platform, process.arch),
      contextSize: 4096,
      gpuLayers: 99,
      threads: 0,
      serverPort: 18080,
      systemPrompt: '',
      temperature: 0.7,
      maxTokens: 2048,
      thinkingMode: 'standard',
      torchBackend: 'auto',
      transformersPrecision: 'auto',
      downloadConnections: 4,
      sdBackend: recommendedSdBackend(process.platform, process.arch),
      promptTranslation: false,
      translationModel: DEFAULT_TRANSLATION_MODEL,
      lanEnabled: false,
      lanPort: 18000,
      lanApiKey: '',
      trayEnabled: false,
      language: 'auto',
      llamaCommand: '',
      sdCommand: '',
      pythonCommand: '',
      gpuSelection: AUTO_GPU,
    }
  }

  private load(): Partial<Settings> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of KEYS) if (k in raw) out[k] = raw[k]
      // 翻訳モデルを選べるようになる前から翻訳を使っていた人は、取得済みの Qwen3-1.7B のままにする (勝手に 2.3GB を取りに行かない)
      if (!('translationModel' in raw) && raw.promptTranslation === true) out.translationModel = 'qwen3-1.7b'
      // ポータブル時に相対で保存したモデルフォルダを絶対パスに戻す
      if (this.portableDir && typeof out.modelsDir === 'string' && !path.isAbsolute(out.modelsDir)) {
        out.modelsDir = path.resolve(this.portableDir, out.modelsDir)
      }
      return out as Partial<Settings>
    } catch {
      return {}
    }
  }

  /** ファイルに書く形。ポータブル時、data/ 配下のモデルフォルダは相対パスにする */
  private serialize(): Settings {
    const s = { ...this.data }
    if (this.portableDir && isInside(this.portableDir, s.modelsDir)) {
      s.modelsDir = path.relative(this.portableDir, s.modelsDir) || '.'
    }
    return s
  }

  get(): Settings {
    return { ...this.data }
  }

  update(patch: Partial<Settings>): Settings {
    const clean: Record<string, unknown> = {}
    for (const k of KEYS) if (k in patch && patch[k] !== undefined) clean[k] = patch[k]
    this.data = { ...this.data, ...(clean as Partial<Settings>) }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.serialize(), null, 2))
    return this.get()
  }
}
