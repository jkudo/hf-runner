import { describe, expect, it, vi } from 'vitest'
import type { LibraryModel, Settings } from '../src/shared/types'
import { splitArgs } from '../src/shared/args'
import { argValue, buildCommand, commandProblems, DEFAULT_COMMANDS, sameCommand, type CommandVars } from '../src/shared/command'

vi.mock('electron', () => ({ app: {}, shell: {} }))
const { commandSetting, passedValues, ServerManager } = await import('../src/main/server')

describe('splitArgs', () => {
  it('空白で区切る (連続・前後の空白・改行は無視)', () => {
    expect(splitArgs('  -c 8192   -ngl  20\n--flash-attn on ')).toEqual(['-c', '8192', '-ngl', '20', '--flash-attn', 'on'])
  })

  it('空文字や空白だけなら空', () => {
    expect(splitArgs('')).toEqual([])
    expect(splitArgs('   ')).toEqual([])
  })

  it('引用符で囲むと空白を含めて 1 つの引数になり、引用符自体は外す', () => {
    expect(splitArgs('--chat-template-file "C:\\my templates\\a.jinja" --alias \'my model\'')).toEqual([
      '--chat-template-file',
      'C:\\my templates\\a.jinja',
      '--alias',
      'my model',
    ])
  })

  it('Windows のパスの \\ はそのまま残す', () => {
    expect(splitArgs('--lora C:\\models\\a.gguf')).toEqual(['--lora', 'C:\\models\\a.gguf'])
  })

  it('空の引用符は空の引数、途中の引用符は前後とつながる', () => {
    expect(splitArgs('--system-prompt "" --x=a"b c"d')).toEqual(['--system-prompt', '', '--x=ab cd'])
  })

  it('反対側の引用符は文字として扱う', () => {
    expect(splitArgs(`--prompt "it's"`)).toEqual(['--prompt', "it's"])
  })
})

describe('buildCommand', () => {
  const llama: CommandVars = {
    exe: 'C:\\Program Files\\rt\\llama-server.exe',
    model: 'C:\\my models\\a.gguf',
    port: '18080',
    ctx: '4096',
    ngl: 'auto',
    name: 'my model',
    threads: [],
    device: ['--device', 'CUDA0'],
    mmproj: [],
  }

  it('既定のひな形は従来と同じ引数になる (空の項目は消え、空白を含むパスも 1 つの引数)', () => {
    expect(buildCommand(DEFAULT_COMMANDS.llamacpp, 'llamacpp', llama)).toEqual({
      command: 'C:\\Program Files\\rt\\llama-server.exe',
      args: ['-m', 'C:\\my models\\a.gguf', '--host', '127.0.0.1', '--port', '18080', '-c', '4096', '-ngl', 'auto', '--jinja', '-a', 'my model', '--device', 'CUDA0'],
    })
  })

  it('本文を編集すると、その並びで差し込む (値の変更・オプションの追加削除・実行ファイルの差し替え)', () => {
    const edited = 'D:\\fork\\llama-server.exe -m {model} --port {port} -c 8192 -ngl 20 -ctk q8_0 {mmproj}'
    expect(buildCommand(edited, 'llamacpp', { ...llama, mmproj: ['--mmproj', 'C:\\m\\mm.gguf'] })).toEqual({
      command: 'D:\\fork\\llama-server.exe',
      args: ['-m', 'C:\\my models\\a.gguf', '--port', '18080', '-c', '8192', '-ngl', '20', '-ctk', 'q8_0', '--mmproj', 'C:\\m\\mm.gguf'],
    })
  })

  it('語の一部に書いた項目は文字列として埋め込む', () => {
    expect(buildCommand('{exe} --model={model} --port {port} --x={device}', 'llamacpp', llama).args).toEqual(['--model=C:\\my models\\a.gguf', '--port', '18080', '--x=--device CUDA0'])
  })

  it('JSON などの {…} は差し込み項目として扱わない', () => {
    const t = `{exe} --port {port} --chat-template-kwargs '{"enable_thinking":false}'`
    expect(commandProblems(t, 'llamacpp')).toEqual([])
    expect(buildCommand(t, 'llamacpp', llama).args).toEqual(['--port', '18080', '--chat-template-kwargs', '{"enable_thinking":false}'])
  })

  it('問題のある本文は起動しない ({port} が無い・不明な項目・先頭がオプション・空)', () => {
    expect(() => buildCommand('{exe} -m {model}', 'llamacpp', llama)).toThrow(/\{port\}/)
    expect(commandProblems('{exe} --port {port} {modle}', 'llamacpp').join()).toMatch(/\{modle\}/)
    expect(commandProblems('-m {model} --port {port}', 'llamacpp')).toHaveLength(1)
    expect(commandProblems('  ', 'llamacpp')).toHaveLength(1)
    // エンジンごとに使える項目が違う
    expect(commandProblems('{python} {script} --port {port} {mmproj}', 'transformers').join()).toMatch(/\{mmproj\}/)
  })

  it('既定のひな形はどのエンジンも問題なし', () => {
    for (const engine of ['llamacpp', 'sdcpp', 'transformers'] as const) expect(commandProblems(DEFAULT_COMMANDS[engine], engine)).toEqual([])
  })

  it('空白や改行の違いだけなら同じ本文とみなす', () => {
    expect(sameCommand(DEFAULT_COMMANDS.llamacpp.replace(/ /g, '\n  '), DEFAULT_COMMANDS.llamacpp)).toBe(true)
    expect(sameCommand(DEFAULT_COMMANDS.llamacpp + ' -np 1', DEFAULT_COMMANDS.llamacpp)).toBe(false)
  })
})

describe('commandSetting', () => {
  const s = { llamaCommand: 'a', sdCommand: 'b', pythonCommand: 'c' } as Settings
  it('エンジンごとの設定を返す', () => {
    expect(commandSetting(s, 'llamacpp')).toBe('a')
    expect(commandSetting(s, 'sdcpp')).toBe('b')
    expect(commandSetting(s, 'transformers')).toBe('c')
  })
  it('古い設定ファイル (項目なし) でも空 (= 既定) として扱う', () => {
    expect(commandSetting({} as Settings, 'llamacpp')).toBe('')
  })
})

describe('argValue / passedValues', () => {
  it('reads the last occurrence, in both "-c 8192" and "--ctx-size=8192" forms', () => {
    expect(argValue(['-c', '4096', '--jinja', '-c', '8192'], ['-c', '--ctx-size'])).toBe('8192')
    expect(argValue(['-c', '4096', '--ctx-size=16384'], ['-c', '--ctx-size'])).toBe('16384')
    expect(argValue(['--jinja'], ['-c'])).toBeUndefined()
    // 値の無い末尾のフラグは無視
    expect(argValue(['-c'], ['-c'])).toBeUndefined()
  })
  it('shows the values actually passed to the engine', () => {
    // 既定のひな形 (-c {ctx} -ngl auto) なら設定の値
    expect(passedValues('llamacpp', ['-c', '4096', '-ngl', 'auto'], 4096, 99)).toEqual({ contextSize: 4096, gpuLayers: 99 })
    // 本文で書き換えた値
    expect(passedValues('llamacpp', ['-c', '4096', '-ngl', 'auto', '-c', '8192', '--n-gpu-layers', '20'], 4096, 99)).toEqual({ contextSize: 8192, gpuLayers: 20 })
    // -c 0 はモデルの既定 (値が分からない)
    expect(passedValues('llamacpp', ['-c', '0'], 4096, 99).contextSize).toBeUndefined()
    expect(passedValues('transformers', ['--max-context', '2048', '--max-context', '8192'], 4096, 99)).toEqual({ contextSize: 8192, gpuLayers: undefined })
    expect(passedValues('sdcpp', ['-m', 'x'], 4096, 99)).toEqual({ contextSize: 4096, gpuLayers: undefined })
  })
})

describe('ServerManager.start with an invalid launch command', () => {
  it('refuses before stopping the running model', async () => {
    const settings = { serverPort: 18080, contextSize: 4096, gpuLayers: 99, llamaCommand: '{exe} -m {model}' } as Settings
    const mgr = new ServerManager({ runtime: {} as never, python: {} as never, sd: {} as never, getSettings: () => settings, historyPath: 'unused', customCommand: true })
    const stop = vi.spyOn(mgr, 'stop')
    const model = { id: 'm', format: 'gguf', dir: '.', mainFile: 'a.gguf', displayName: 'a' } as LibraryModel
    await expect(mgr.start(model, { modelId: 'm' })).rejects.toThrow(/\{port\}/)
    expect(stop).not.toHaveBeenCalled()
  })
})
