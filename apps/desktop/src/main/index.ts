import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { APP_PARTITION } from '../shared/ipc';
import type { AppRunStatus, ProjectSummary, RecentProject } from '../shared/ipc';
import { AgentManager } from './agents';
import { AppRunner } from './app/runner';
import { Tracer } from './app/tracer';
import { attachTracer } from './app/electron-trace';
import { ProjectSession, type Emit } from './project';

const here = import.meta.dirname;
const MCP_ENTRY = join(here, 'mcp.js');
const WEBVIEW_PRELOAD = join(here, '../preload/webview.cjs');
const RECENT_MAX = 12;

let win: BrowserWindow | null = null;
let project: ProjectSession | null = null;
let agents: AgentManager | null = null;
let runner: AppRunner | null = null;
let tracerRef: Tracer | null = null;
let detachTracer: (() => void) | null = null;
/** sessionId → agentId for sessions of the current project */
const sessionAgents = new Map<string, string>();

const emit: Emit = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const log = (msg: string) => { process.stderr.write(`${msg}\n`); };

function requireProject(): ProjectSession {
  if (!project) throw new Error('No project is open');
  return project;
}

// ── recent projects ─────────────────────────────────────────────────

const recentFile = () => join(app.getPath('userData'), 'recent-projects.json');

async function readRecent(): Promise<RecentProject[]> {
  try {
    const list = JSON.parse(await readFile(recentFile(), 'utf8')) as RecentProject[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function pushRecent(root: string): Promise<void> {
  const list = (await readRecent()).filter((r) => r.root !== root);
  list.unshift({ root, name: basename(root), openedAt: new Date().toISOString() });
  await writeFile(recentFile(), JSON.stringify(list.slice(0, RECENT_MAX), null, 2)).catch(() => undefined);
}

// ── project lifecycle ───────────────────────────────────────────────

async function closeProject(): Promise<void> {
  detachTracer?.();
  detachTracer = null;
  tracerRef = null;
  await runner?.stop().catch(() => undefined);
  runner = null;
  await agents?.dispose().catch(() => undefined);
  agents = null;
  sessionAgents.clear();
  // a failing close (e.g. a db error) must not leave the old session attached and block every later open
  try { project?.close(); } catch (e) { log(`[atomic] closing project failed: ${(e as Error).message}`); }
  project = null;
}

async function openProject(root: string): Promise<ProjectSummary> {
  await closeProject();
  const p = await ProjectSession.open(root, emit);
  project = p;
  agents = createAgents(p);
  setupApplication(p);
  await pushRecent(p.root);
  return p.summary();
}

function createAgents(p: ProjectSession): AgentManager {
  return new AgentManager({
    emit(ev) {
      if (ev.type === 'state') {
        const agentId = sessionAgents.get(ev.sessionId);
        if (ev.state === 'prompting' && agentId) p.setActiveSession({ sessionId: ev.sessionId, agentId });
        else if (ev.state !== 'starting') p.setActiveSession(null);
        if (ev.state === 'closed' || ev.state === 'error') p.forgetSession(ev.sessionId);
      }
      emit('agent:event', ev);
    },
    // the Atomic memory server: same Electron binary in Node mode, own WAL connection to the project db
    mcpServers: (agentId) => [{
      name: 'atomic',
      command: process.execPath,
      args: [MCP_ENTRY, '--project', p.root, '--agent', agentId],
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    }],
    composeContext: async (sessionId, text, opts) => p.composeContext(sessionId, text, opts),
    onFilesWritten: (paths, sessionId, agentId) => p.applyPaths(paths, sessionId, agentId),
    onToolLocations: (paths, sessionId) => p.applyPaths(paths, sessionId, sessionAgents.get(sessionId)),
    log,
  }, { clientVersion: app.getVersion() });
}

function setupApplication(p: ProjectSession): void {
  const r = new AppRunner({ emit: (channel, payload) => emit(channel, payload as never), root: p.root });
  const appOrigin = () => {
    const url = r.getStatus().url;
    if (!url) return undefined;
    try { return new URL(url).origin; } catch { return undefined; }
  };
  const tracer = new Tracer({
    routes: () => p.routeRecords(),
    related: (routeId) => p.routeRelated(routeId),
    handlerOf: (route) => p.routeHandler(route),
    emit: (channel, ev) => emit(channel, ev),
    appOrigin,
  });
  runner = r;
  tracerRef = tracer;
  detachTracer = attachTracer(session.fromPartition(APP_PARTITION), tracer, appOrigin);
}

// ── IPC ─────────────────────────────────────────────────────────────

type Handlers = Record<string, (...args: never[]) => unknown>;

function handle(ns: string, handlers: Handlers): void {
  for (const [method, fn] of Object.entries(handlers)) {
    ipcMain.handle(`${ns}:${method}`, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args));
  }
}

function registerIpc(): void {
  handle('project', {
    pickFolder: async () => {
      const res = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Open project folder' })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return res.canceled ? null : res.filePaths[0] ?? null;
    },
    open: (root: string) => openProject(root),
    current: () => project?.summary() ?? null,
    recent: () => readRecent(),
    reindex: () => requireProject().reindex(),
  });

  handle('memory', {
    stats: () => requireProject().stats(),
    listNodes: (filter) => requireProject().listNodes(filter),
    getNode: (id: string) => requireProject().nodeDetail(id),
    search: (query: string) => requireProject().store.search(query, { limit: 40 }),
    graph: (view, focus?: string) => requireProject().graph(view, focus),
    changes: (limit?: number) => requireProject().store.listChanges(limit ?? 50),
    readFile: (path: string) => requireProject().readFile(path),
    previewContext: (task: string, budget?: number) => requireProject().previewContext(task, budget),
    impact: (paths: string[]) => requireProject().impact(paths),
    sources: () => requireProject().sources(),
    addNote: (input) => requireProject().addNote(input),
    markVerified: (id: string) => requireProject().markVerified(id),
  });

  const requireAgents = () => { if (!agents) throw new Error('No project is open'); return agents; };
  handle('agents', {
    list: () => (agents ?? createAgentsPreview()).list(),
    start: async (agentId: string) => {
      const p = requireProject();
      const info = await requireAgents().start(agentId, p.root);
      sessionAgents.set(info.sessionId, info.agentId);
      return info;
    },
    prompt: (sessionId: string, text: string, opts) => requireAgents().prompt(sessionId, text, opts ?? {}),
    template: (kind) => requireAgents().template(kind),
    cancel: (sessionId: string) => requireAgents().cancel(sessionId),
    setMode: (sessionId: string, modeId: string) => requireAgents().setMode(sessionId, modeId),
    respondPermission: (requestId: string, optionId: string | null) => requireAgents().respondPermission(requestId, optionId),
    close: async (sessionId: string) => {
      await requireAgents().close(sessionId);
      sessionAgents.delete(sessionId);
      project?.forgetSession(sessionId);
    },
  });

  const stopped: AppRunStatus = { state: 'stopped' };
  handle('app', {
    scripts: () => project?.indexer.stack()?.scripts ?? [],
    start: async (scriptName: string) => {
      const p = requireProject();
      const stack = p.indexer.stack();
      const script = stack?.scripts.find((s) => s.name === scriptName);
      if (!script || !runner) throw new Error(`Unknown script ${scriptName}`);
      return runner.start(script, stack?.packageManagers[0] ?? 'npm');
    },
    stop: async () => (runner ? runner.stop() : stopped),
    status: () => runner?.getStatus() ?? stopped,
    reportInteraction: (e) => {
      if (!tracerRef) throw new Error('No project is open');
      return tracerRef.onInteraction(e);
    },
    webviewPreloadPath: () => WEBVIEW_PRELOAD,
  });
}

/** agent availability is project-independent; list it before a project is open */
let previewAgents: AgentManager | null = null;
function createAgentsPreview(): AgentManager {
  previewAgents ??= new AgentManager({
    emit: () => undefined, mcpServers: () => [], composeContext: async () => null,
    onFilesWritten: () => undefined, onToolLocations: () => undefined, log,
  });
  return previewAgents;
}

// ── window ──────────────────────────────────────────────────────────

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0e1014',
    title: 'Atomic Workspace',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      // the preload only uses contextBridge + ipcRenderer, which the sandbox allows
      sandbox: true,
      contextIsolation: true,
      webviewTag: true,
    },
  });
  win.on('closed', () => { win = null; });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(here, '../renderer/index.html'));
}

// the app webview may only load the project's local app, never navigate the shell or open popups
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // the user may browse anywhere on the web, but never into file:// or other local schemes
    contents.on('will-navigate', (ev, url) => { if (!isWebUrl(url)) ev.preventDefault(); });
    contents.on('will-redirect', (ev, url) => { if (!isWebUrl(url)) ev.preventDefault(); });
  } else {
    // whatever the renderer asks for, a guest page gets our tracing preload only and no Node
    contents.on('will-attach-webview', (ev, prefs, params) => {
      if (!isWebUrl(params.src)) { ev.preventDefault(); return; }
      prefs.preload = WEBVIEW_PRELOAD;
      prefs.nodeIntegration = false;
      prefs.nodeIntegrationInSubFrames = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      delete params.allowpopups;
    });
    contents.on('will-navigate', (ev, url) => {
      if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) return;
      ev.preventDefault();
    });
  }
});

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  // `--project <dir>` (or ATOMIC_PROJECT) opens a project at launch: used by e2e and power users
  const i = process.argv.indexOf('--project');
  const initial = (i >= 0 ? process.argv[i + 1] : undefined) ?? process.env.ATOMIC_PROJECT;
  if (initial) {
    try {
      emit('project:changed', await openProject(initial));
    } catch (e) {
      log(`[atomic] failed to open ${initial}: ${(e as Error).message}`);
    }
  }
});

let quitting = false;
app.on('before-quit', (ev) => {
  if (quitting) return;
  quitting = true;
  ev.preventDefault();
  void closeProject().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());

