// One open project: memory store, incremental indexer, watcher, and the read API the renderer uses.
// Pure Node (no electron import) so it can be exercised in tests.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, isAbsolute, sep } from 'node:path';
import {
  buildContext, buildGraph, buildOverview, createIndexer, detectLang, findUnmapped, impactOf, importAiConfig, openStore,
} from '@atomic/core';
import type {
  ChangeSet, ContextPack, GraphData, GraphView, ImportedSource, Indexer, KnowledgeNode, MemoryStats, MemoryStore, NodeFilter,
  RouteRecord,
} from '@atomic/core';
import type { EventPayloads, FileContent, NodeDetail, ProjectSummary, PromptOptions, TraceMatch } from '../shared/ipc';

export type Emit = <K extends keyof EventPayloads>(channel: K, payload: EventPayloads[K]) => void;

const VIEWER_MAX_BYTES = 512 * 1024;
const REV_POLL_MS = 1500;
const FIRST_PROMPT_OVERVIEW_TOKENS = 400;

type ActiveSession = { sessionId: string; agentId: string } | null;

const pick = (n: KnowledgeNode) => ({ id: n.id, kind: n.kind, title: n.title, status: n.status });
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';

/** `.atomic/` holds project memory; keep it out of git without touching tracked files. */
async function initAtomicDir(root: string): Promise<boolean> {
  await mkdir(join(root, '.atomic'), { recursive: true });
  const gitDir = join(root, '.git');
  if (!existsSync(gitDir)) {
    await writeFile(join(root, '.atomic', '.gitignore'), '*\n').catch(() => undefined);
    return false;
  }
  try {
    const st = await stat(gitDir);
    if (!st.isDirectory()) return true; // worktree/submodule `.git` file: leave git config alone
    const exclude = join(gitDir, 'info', 'exclude');
    const current = await readFile(exclude, 'utf8').catch(() => '');
    if (!current.split(/\r?\n/).some((l) => l.trim() === '.atomic/' || l.trim() === '.atomic')) {
      await mkdir(join(gitDir, 'info'), { recursive: true });
      await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# Atomic Workspace memory\n.atomic/\n`);
    }
  } catch { /* exclude is best effort */ }
  return true;
}

export class ProjectSession {
  readonly name: string;
  private aiSources: ImportedSource[] = [];
  private stopWatch?: () => void;
  private revTimer?: NodeJS.Timeout;
  private lastRev: string | undefined;
  private active: ActiveSession = null;
  /** node ids already handed to each agent session (context dedupe) */
  private readonly sent = new Map<string, Set<string>>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly root: string,
    readonly isGit: boolean,
    readonly store: MemoryStore,
    readonly indexer: Indexer,
    private readonly emit: Emit,
  ) {
    this.name = basename(root);
  }

  static async open(root: string, emit: Emit): Promise<ProjectSession> {
    const abs = resolve(root);
    const st = await stat(abs);
    if (!st.isDirectory()) throw new Error(`${abs} is not a directory`);
    const isGit = await initAtomicDir(abs);
    const store = openStore(abs);
    const session = new ProjectSession(abs, isGit, store, createIndexer(store), emit);
    await session.reindex();
    session.startWatching();
    return session;
  }

  /** serialize index mutations started from here (watcher applies are serialized inside the indexer) */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async reindex(): Promise<ProjectSummary> {
    const cs = await this.serial(() => this.indexer.sync((p) => this.emit('index:progress', p)));
    this.emit('index:progress', { phase: 'done', done: 1, total: 1 });
    this.aiSources = await importAiConfig(this.root).catch(() => []);
    this.lastRev = this.store.getMeta('rev');
    if (cs.files.length || cs.affectedNodes.length) this.emit('memory:changed', cs);
    return this.summary();
  }

  private startWatching(): void {
    this.stopWatch = this.indexer.watch(
      (cs) => this.changed(cs),
      () => (this.active ? { source: 'agent', ...this.active } : { source: 'external' }),
    );
    // the MCP server (separate process, same WAL db) bumps meta `rev` on every agent write
    this.revTimer = setInterval(() => {
      const rev = this.store.getMeta('rev');
      if (rev === this.lastRev) return;
      this.lastRev = rev;
      const latest = this.store.listChanges(1)[0];
      if (latest) this.emit('memory:changed', latest);
      this.emit('project:changed', this.summary());
    }, REV_POLL_MS);
    this.revTimer.unref?.();
  }

  private changed(cs: ChangeSet): void {
    if (!cs.files.length && !cs.affectedNodes.length && !cs.staleNodes.length) return;
    this.emit('memory:changed', cs);
    this.emit('project:changed', this.summary());
  }

  /** paths reported by an agent (fs/write_text_file or tool-call locations) */
  applyPaths(paths: string[], sessionId: string, agentId?: string): void {
    if (!paths.length) return;
    void this.serial(() => this.indexer.apply(paths, { source: 'agent', sessionId, agentId }))
      .then((cs) => this.changed(cs))
      .catch(() => undefined);
  }

  setActiveSession(s: ActiveSession): void { this.active = s; }

  forgetSession(sessionId: string): void { this.sent.delete(sessionId); }

  stats(): MemoryStats {
    const u = findUnmapped(this.store);
    return { ...this.store.stats(), unmapped: { modules: u.modules.length, routes: u.routes.length, entities: u.entities.length } };
  }

  summary(): ProjectSummary {
    const stats = this.stats();
    return {
      root: this.root,
      name: this.name,
      isGit: this.isGit,
      stack: this.indexer.stack(),
      stats,
      needsBootstrap: (stats.nodesByOrigin.agent ?? 0) === 0,
      aiSources: this.aiSources.map(({ path, tool, kind, title }) => ({ path, tool, kind, title })),
    };
  }

  // ── context for agents ──────────────────────────────────────────────

  /** Pack attached to a prompt. First prompt of a session also carries a short overview; later ones skip nodes already sent. */
  composeContext(sessionId: string, task: string, opts: PromptOptions): ContextPack | null {
    const sent = this.sent.get(sessionId) ?? new Set<string>();
    const first = !this.sent.has(sessionId);
    const pack = buildContext(this.store, task, { budgetTokens: opts.budgetTokens, excludeNodeIds: [...sent] });
    let out = pack;
    if (first) {
      const overview = buildOverview(this.store, { budgetTokens: FIRST_PROMPT_OVERVIEW_TOKENS });
      const text = `${overview.text}\n\n${pack.text}`.trim();
      out = {
        ...pack,
        text,
        estimatedTokens: overview.estimatedTokens + pack.estimatedTokens,
        sections: [...overview.sections, ...pack.sections],
        nodeIds: [...new Set([...overview.nodeIds, ...pack.nodeIds])],
      };
    } else if (!pack.nodeIds.length) {
      return null; // nothing new to tell this agent
    }
    for (const id of out.nodeIds) sent.add(id);
    this.sent.set(sessionId, sent);
    this.store.recordContextServed(out.estimatedTokens);
    return out;
  }

  // ── renderer read API ───────────────────────────────────────────────

  listNodes(filter?: NodeFilter): KnowledgeNode[] { return this.store.listNodes(filter); }

  nodeDetail(id: string): NodeDetail | null {
    const node = this.store.getNode(id);
    if (!node) return null;
    const look = (nid: string) => { const n = this.store.getNode(nid); return n ? pick(n) : undefined; };
    const outgoing = this.store.edges({ from: id }).map((e) => ({ ...e, target: look(e.to) }));
    const incoming = this.store.edges({ to: id }).map((e) => ({ ...e, source: look(e.from) }));
    const files = this.filesOf(node);
    const symbols = files.flatMap((p) => {
      const ranges = node.anchors.filter((a) => a.path === p && a.startLine != null);
      return this.store.symbolsInFile(p).filter((s) =>
        !ranges.length || ranges.some((a) => s.endLine >= (a.startLine ?? 0) && s.startLine <= (a.endLine ?? a.startLine ?? Infinity)));
    }).slice(0, 50);
    const tests = node.kind === 'test_suite'
      ? this.store.tests(String((node.data as { path?: string } | undefined)?.path ?? id.slice('test_suite:'.length)))
      : files.length ? impactOf(this.store, files).tests.slice(0, 50) : [];
    const changes = this.store.listChanges(200).filter((c) => c.affectedNodes.includes(id) || c.staleNodes.includes(id)).slice(0, 10);
    return { node, outgoing, incoming, symbols, tests, changes };
  }

  /** files a node stands for: anchors, module files, route/test file */
  private filesOf(node: KnowledgeNode): string[] {
    const data = (node.data ?? {}) as { files?: unknown; path?: unknown };
    const out = new Set(node.anchors.map((a) => a.path));
    if (Array.isArray(data.files)) for (const f of data.files) if (typeof f === 'string') out.add(f);
    if (typeof data.path === 'string') out.add(data.path);
    return [...out];
  }

  graph(view: GraphView, focus?: string): GraphData {
    const changedNodeIds = this.store.listChanges(8)
      .filter((c) => c.source !== 'index')
      .slice(0, 5)
      .flatMap((c) => c.affectedNodes);
    return buildGraph(this.store, view, { focus, changedNodeIds });
  }

  async readFile(path: string): Promise<FileContent | null> {
    const abs = resolve(this.root, path);
    const rel = relative(this.root, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep)[0] === '.atomic') return null;
    let buf: Buffer;
    try { buf = await readFile(abs); } catch { return null; }
    const complete = buf.length <= VIEWER_MAX_BYTES;
    const posix = rel.split(sep).join('/');
    return { path: posix, content: buf.subarray(0, VIEWER_MAX_BYTES).toString('utf8'), lang: detectLang(posix), complete };
  }

  impact(paths: string[]) { return impactOf(this.store, paths); }

  previewContext(task: string, budgetTokens?: number): ContextPack {
    return buildContext(this.store, task, { budgetTokens });
  }

  async sources(): Promise<ImportedSource[]> {
    this.aiSources = await importAiConfig(this.root).catch(() => this.aiSources);
    return this.aiSources;
  }

  addNote(input: { kind: 'note' | 'rule' | 'decision' | 'convention'; title: string; summary: string; anchors?: { path: string; startLine?: number; endLine?: number }[] }): KnowledgeNode {
    const title = input.title.trim();
    const summary = input.summary.trim();
    if (!title || !summary) throw new Error('Title and summary are required');
    const anchors = (input.anchors ?? []).map((a) => {
      const f = this.store.getFile(a.path);
      if (!f) throw new Error(`Unknown file ${a.path}`);
      return { ...a, hash: f.hash };
    });
    let id = `${input.kind}:${slug(title)}`;
    const existing = this.store.getNode(id);
    if (existing && existing.origin !== 'user') id = `${id}-${Date.now().toString(36)}`;
    const node = this.store.upsertNode({
      id, kind: input.kind, title, summary, origin: 'user', anchors,
      status: anchors.length ? 'fresh' : 'unverified',
    });
    this.emit('project:changed', this.summary());
    return node;
  }

  markVerified(id: string): KnowledgeNode | null {
    const node = this.store.markVerified(id) ?? null;
    if (node) this.emit('project:changed', this.summary());
    return node;
  }

  // ── application-mode helpers (route nodes carry mount-resolved patterns) ──

  routeRecords(): RouteRecord[] {
    return this.store.listNodes({ kinds: ['route'] }).flatMap((n) => {
      const d = (n.data ?? {}) as Partial<RouteRecord>;
      if (!d.method || !d.pattern) return [];
      return [{
        id: n.id, path: d.path ?? '', line: d.line ?? 1, method: d.method, pattern: d.pattern,
        framework: d.framework ?? 'unknown', handler: d.handler, handlerSymbolId: d.handlerSymbolId,
      } as RouteRecord];
    });
  }

  routeRelated(routeId: string): TraceMatch['related'] {
    const ids = new Set<string>();
    const hop = (id: string) => [
      ...this.store.edges({ from: id }).map((e) => e.to),
      ...this.store.edges({ to: id }).map((e) => e.from),
    ];
    for (const a of hop(routeId)) {
      ids.add(a);
      const n = this.store.getNode(a);
      if (n?.kind === 'module') for (const b of hop(a)) ids.add(b);
    }
    ids.delete(routeId);
    const wanted = new Set(['capability', 'flow', 'rule', 'module', 'entity', 'integration']);
    return [...ids].flatMap((id) => {
      const n = this.store.getNode(id);
      return n && wanted.has(n.kind) ? [{ id: n.id, kind: n.kind, title: n.title }] : [];
    }).sort((a, b) => order(a.kind) - order(b.kind)).slice(0, 12);
  }

  routeHandler(route: RouteRecord): TraceMatch['handler'] {
    if (!route.path) return undefined;
    const sym = route.handlerSymbolId ? this.store.getSymbol(route.handlerSymbolId) : undefined;
    return sym
      ? { path: sym.path, line: sym.startLine, symbol: sym.name }
      : { path: route.path, line: route.line, symbol: route.handler };
  }

  close(): void {
    this.stopWatch?.();
    if (this.revTimer) clearInterval(this.revTimer);
    this.store.close();
  }
}

const KIND_ORDER = ['capability', 'flow', 'rule', 'module', 'entity', 'integration'];
const order = (k: string) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? 99 : i; };
