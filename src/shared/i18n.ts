// 表示言語 (日本語 / 英語)。メインプロセスとレンダラーで同じ仕組みを使う。
// 文言は呼び出し側に L('日本語', 'English') の形で両方を並べて書く (キーの辞書は作らない。2 言語だけなので、
// 読むときにその場で両方が見え、訳し漏れも見つけやすい)。L は呼ばれた時点の言語を返すので、
// モジュールの読み込み時に評価される定数には使わない (関数か getter の中で呼ぶ)

export type Lang = 'ja' | 'en'
/** 設定値。auto は OS (Electron のロケール) に従う */
export type LanguageSetting = 'auto' | Lang

let current: Lang = 'ja'

export const setLang = (lang: Lang): void => {
  current = lang
}

export const getLang = (): Lang => current

/** 今の言語の文言を返す */
export const L = (ja: string, en: string): string => (current === 'en' ? en : ja)

/** 設定とロケール (app.getLocale() / navigator.language) から表示言語を決める。日本語以外のロケールは英語 */
export function resolveLang(setting: LanguageSetting | undefined, locale: string): Lang {
  if (setting === 'ja' || setting === 'en') return setting
  return /^ja\b/i.test(locale) ? 'ja' : 'en'
}
