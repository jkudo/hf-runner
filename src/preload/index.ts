import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '@shared/types'

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>

const on = <T extends unknown[]>(channel: string, cb: (...args: T) => void) => {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: Api = {
  boot: {
    progress: (p) => ipcRenderer.send('boot:progress', p),
    done: () => ipcRenderer.send('boot:done'),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    chooseModelsDir: () => invoke('settings:chooseModelsDir'),
  },
  system: {
    info: () => invoke('system:info'),
    stats: () => invoke('system:stats'),
  },
  hf: {
    search: (opts) => invoke('hf:search', opts),
    modelInfo: (repoId) => invoke('hf:modelInfo', repoId),
    files: (repoId) => invoke('hf:files', repoId),
    quantizedVariants: (repoId) => invoke('hf:quantizedVariants', repoId),
    remoteHeader: (repoId, path) => invoke('hf:remoteHeader', repoId, path),
    modelConfig: (repoId) => invoke('hf:modelConfig', repoId),
    diffusionCheck: (repoId, path) => invoke('hf:diffusionCheck', repoId, path),
  },
  downloads: {
    start: (repoId, entry, hfMeta, mmproj) => invoke('downloads:start', repoId, entry, hfMeta, mmproj ?? null),
    cancel: (id) => invoke('downloads:cancel', id),
    resume: (id) => invoke('downloads:resume', id),
    remove: (id) => invoke('downloads:remove', id),
    list: () => invoke('downloads:list'),
    onUpdate: (cb) => on('downloads:update', cb),
  },
  library: {
    list: () => invoke('library:list'),
    remove: (id) => invoke('library:remove', id),
    openFolder: (id) => invoke('library:openFolder', id),
    onChange: (cb) => on('library:change', cb),
  },
  runtime: {
    info: () => invoke('runtime:info'),
    backends: () => invoke('runtime:backends'),
    install: (backend) => invoke('runtime:install', backend),
    checkUpdate: (backend) => invoke('runtime:checkUpdate', backend),
    onProgress: (cb) => on('runtime:progress', cb),
  },
  python: {
    info: () => invoke('python:info'),
    install: (backend) => invoke('python:install', backend),
    remove: () => invoke('python:remove'),
    onProgress: (cb) => on('python:progress', cb),
  },
  server: {
    start: (opts) => invoke('server:start', opts),
    stop: () => invoke('server:stop'),
    status: () => invoke('server:status'),
    onStatus: (cb) => on('server:status', cb),
  },
  shell: {
    openExternal: (url) => invoke('shell:openExternal', url),
  },
  sd: {
    info: () => invoke('sd:info'),
    backends: () => invoke('sd:backends'),
    install: (backend) => invoke('sd:install', backend),
    onProgress: (cb) => on('sd:progress', cb),
  },
  image: {
    capabilities: () => invoke('image:capabilities'),
    generate: (params) => invoke('image:generate', params),
    cancel: () => invoke('image:cancel'),
    status: () => invoke('image:status'),
    list: () => invoke('image:list'),
    remove: (file) => invoke('image:remove', file),
    openFolder: () => invoke('image:openFolder'),
    onStatus: (cb) => on('image:status', cb),
  },
  components: {
    status: (family) => invoke('components:status', family),
    download: (family) => invoke('components:download', family),
  },
  translate: {
    status: () => invoke('translate:status'),
    setEnabled: (on) => invoke('translate:setEnabled', on),
    setModel: (id) => invoke('translate:setModel', id),
    run: (text) => invoke('translate:run', text),
    onStatus: (cb) => on('translate:status', cb),
  },
  lan: {
    status: () => invoke('lan:status'),
    regenerateKey: () => invoke('lan:regenerateKey'),
    onStatus: (cb) => on('lan:status', cb),
  },
}

contextBridge.exposeInMainWorld('api', api)
