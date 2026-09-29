/**
 * 設定画面で編集した起動コマンドの文字列をコマンドライン引数に分ける。空白で区切り、"…" / '…' で囲んだ部分は
 * 空白を含めて 1 つの引数にする (例: `--flash-attn on --chat-template-file "C:\my templates\a.jinja"`)。
 * シェルは通さない (引数の配列としてそのまま渡す) ので、変数展開やリダイレクトは起きない
 */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}
