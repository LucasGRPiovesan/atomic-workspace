import { contextBridge, ipcRenderer } from 'electron';
import type { AtomicApi, EventPayloads } from '../shared/ipc';

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const ns = <T extends Record<string, unknown>>(name: string, methods: (keyof T)[]): T =>
  Object.fromEntries(methods.map((m) => [m, call(`${name}:${String(m)}`)])) as T;

const api: AtomicApi = {
  project: ns('project', ['pickFolder', 'open', 'current', 'recent', 'reindex']),
  memory: ns('memory', [
    'stats', 'listNodes', 'getNode', 'search', 'graph', 'changes', 'readFile',
    'previewContext', 'impact', 'sources', 'addNote', 'markVerified',
  ]),
  agents: ns('agents', ['list', 'start', 'prompt', 'template', 'cancel', 'setMode', 'respondPermission', 'close']),
  app: ns('app', ['scripts', 'start', 'stop', 'status', 'reportInteraction', 'webviewPreloadPath']),
  on<K extends keyof EventPayloads>(channel: K, cb: (payload: EventPayloads[K]) => void) {
    const listener = (_e: Electron.IpcRendererEvent, payload: EventPayloads[K]) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('atomic', api);
