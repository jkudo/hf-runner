import { execFile } from 'node:child_process'

/** nvidia-smi が見つからなかったら二度と呼ばない(NVIDIA 以外の環境で毎回プロセス起動を試みないため) */
let missing = false

/**
 * `nvidia-smi --query-gpu=<fields> --format=csv,noheader,nounits` を実行して行ごとの列を返す。
 * 失敗時は null。値が取れない列は nvidia-smi が "[N/A]" を返すので、呼び出し側で扱う
 */
export function queryNvidiaSmi(fields: string[], timeout = 1500): Promise<string[][] | null> {
  if (missing) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      [`--query-gpu=${fields.join(',')}`, '--format=csv,noheader,nounits'],
      { timeout, windowsHide: true },
      (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') missing = true
          return resolve(null)
        }
        resolve(splitCsv(stdout))
      },
    )
  })
}

export function splitCsv(out: string): string[][] {
  return out
    .split(/\r?\n/)
    .map((line) => line.split(',').map((s) => s.trim()))
    .filter((cols) => cols.length > 1 || cols[0] !== '')
}

/** "[N/A]" や空文字は null に */
export function numOrNull(s: string | undefined): number | null {
  const n = Number(s)
  return s !== undefined && s !== '' && Number.isFinite(n) ? n : null
}
