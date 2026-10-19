import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import type { CreateIndexer, IndexProgress, Indexer, MemoryStore } from '../contracts.js';
import { detectStack } from '../detect/index.js';
import { extractFile } from '../extract/index.js';
import { importAiConfig, sourcesToNodes } from '../importer/index.js';
import type { ChangeSet, FileChange, FileRecord, KnowledgeEdge, StackInfo } from '../types.js';
import { applyLayer, deriveLayer } from './derive.js';
import { moduleOf } from './modules.js';
import { parseMounts, type Mount } from './mounts.js';
import { SKIP_DIRS, isIgnoredPath, isLockfile, loadIgnore, scan, statEntries, type ScanEntry } from './scan.js';

type Meta = NonNullable<Parameters<Indexer['apply']>[1]>;

const CONCURRENCY = 8;
const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 1500;
const META_STACK_SIG = 'stack_sig';
const META_STACK = 'stack';
const META_LOCKFILES = 'lockfiles';
const META_MOUNTS = 'mounts_v1';
const META_IMPORTED_HASH = 'imported_hash';

const sha1 = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex');
const STACK_FILE = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|Gemfile|[^/]+\.csproj|Makefile|[^/]+\.prisma|[^/]+\.sql)$/;
const SCRIPT_LANGS = new Set(['typescript', 'tsx', 'javascript']);

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) await fn(items[i]);
  }));
}

function languageCounts(files: readonly FileRecord[]): StackInfo['languages'] {
  const counts = new Map<FileRecord['lang'], { lang: FileRecord['lang']; files: number; loc: number }>();
  for (const f of files) {
    const c = counts.get(f.lang) ?? { lang: f.lang, files: 0, loc: 0 };
    c.files++;
    c.loc += f.loc;
    counts.set(f.lang, c);
  }
  return [...counts.values()].sort((a, b) => a.lang.localeCompare(b.lang));
}

interface IngestResult {
  added: string[];
  modified: string[];
  deleted: string[];
  stale: string[];
  extractions: number;
}

class FileIndexer implements Indexer {
  private queue: Promise<unknown> = Promise.resolve();
  private statCache = new Map<string, { size: number; mtimeMs: number }>();
  private mounts: Map<string, Mount[]>;
  private mountsDirty = false;
  private lockfiles: Set<string>;
  private cachedStack: StackInfo | undefined;

  constructor(private readonly store: MemoryStore) {
    this.mounts = new Map(Object.entries(this.readJson<Record<string, Mount[]>>(META_MOUNTS) ?? {}));
    this.lockfiles = new Set(this.readJson<string[]>(META_LOCKFILES) ?? []);
    this.cachedStack = this.readJson<StackInfo>(META_STACK);
  }

  stack(): StackInfo | undefined {
    return this.cachedStack;
  }

  sync(onProgress?: (p: IndexProgress) => void): Promise<ChangeSet> {
    return this.serial(() => this.runSync(onProgress));
  }

  apply(paths: string[], meta?: Meta): Promise<ChangeSet> {
    return this.serial(() => this.runApply(paths, meta ?? { source: 'external' }));
  }

  watch(onChange: (cs: ChangeSet) => void, meta?: () => Meta): () => void {
    const root = this.store.root;
    let pending = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    let firstAt = 0;
    let stopped = false;
    let ig: { ignores(path: string): boolean } = { ignores: () => false };
    void loadIgnore(root).then((loaded) => { ig = loaded; });

    const rel = (abs: string): string | undefined => {
      const r = relative(root, abs).replaceAll('\\', '/');
      return r === '' || r.startsWith('..') || isAbsolute(r) ? undefined : r;
    };
    const flush = (): void => {
      timer = undefined;
      const batch = [...pending];
      pending = new Set();
      firstAt = 0;
      if (batch.length === 0 || stopped) return;
      this.apply(batch, meta?.() ?? { source: 'external' }).then(
        (cs) => { if (!stopped && cs.files.length > 0) onChange(cs); },
        () => { /* a failed pass must not kill the watcher; the next event retries */ },
      );
    };
    const push = (abs: string): void => {
      const path = rel(abs);
      if (!path || path.split('/').some((s) => SKIP_DIRS.has(s)) || ig.ignores(path)) return;
      pending.add(path);
      const now = Date.now();
      if (!firstAt) firstAt = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, Math.max(0, Math.min(DEBOUNCE_MS, firstAt + MAX_WAIT_MS - now)));
    };

    const watcher = chokidarWatch(root, {
      ignoreInitial: true,
      ignored: (path) => {
        const r = rel(path);
        return r !== undefined && (r.split('/').some((s) => SKIP_DIRS.has(s)) || ig.ignores(r));
      },
    });
    watcher.on('add', push).on('change', push).on('unlink', push).on('unlinkDir', push).on('error', () => { /* transient fs errors */ });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      void watcher.close();
    };
  }

  // ── orchestration ───────────────────────────────────────────────────────

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runSync(onProgress?: (p: IndexProgress) => void): Promise<ChangeSet> {
    const started = performance.now();
    onProgress?.({ phase: 'scan', done: 0, total: 0 });
    const { files, lockfiles } = await scan(this.store.root);
    this.setLockfiles(lockfiles);
    onProgress?.({ phase: 'scan', done: files.length, total: files.length });

    const stored = this.store.fileHashes();
    const present = new Set(files.map((f) => f.path));
    const known = new Set(present);
    const removed = [...stored.keys()].filter((p) => !present.has(p));
    let done = 0;
    const result = await this.ingest(files, removed, known, true, (n) => {
      done = n;
      onProgress?.({ phase: 'extract', done, total: files.length });
    });
    return this.finish('index', {}, result, performance.now() - started, onProgress);
  }

  private async runApply(inputPaths: string[], meta: Meta): Promise<ChangeSet> {
    const started = performance.now();
    const root = this.store.root;
    const ig = await loadIgnore(root);
    const stored = this.store.fileHashes();
    const wanted = new Set<string>();
    const gone = new Set<string>();
    for (const input of inputPaths) {
      const path = this.normalize(input);
      if (path === undefined) continue;
      if (isLockfile(path)) {
        this.touchLockfile(path, await exists(join(root, path)));
        continue;
      }
      const ignored = path.split('/').some((s) => SKIP_DIRS.has(s)) || ig.ignores(path);
      let kind: 'file' | 'dir' | 'missing' = 'missing';
      try {
        kind = (await stat(join(root, path))).isDirectory() ? 'dir' : 'file';
      } catch {
        // missing
      }
      if (kind === 'file' && !ignored) wanted.add(path);
      else if (kind === 'dir' && !ignored) {
        for (const p of stored.keys()) if (p.startsWith(`${path}/`)) wanted.add(p);
        for (const e of (await scan(root)).files) if (e.path.startsWith(`${path}/`)) wanted.add(e.path);
      } else {
        for (const p of stored.keys()) if (p === path || p.startsWith(`${path}/`)) gone.add(p);
      }
    }
    const entries = (await statEntries(root, [...wanted].filter((p) => !isIgnoredPath(p)))).filter((e) => !ig.ignores(e.path));
    for (const p of wanted) if (!entries.some((e) => e.path === p) && stored.has(p)) gone.add(p); // became ignored / too large
    const known = new Set(stored.keys());
    for (const p of gone) known.delete(p);
    for (const e of entries) known.add(e.path);
    const result = await this.ingest(entries, [...gone], known, false);
    return this.finish(meta.source, meta, result, performance.now() - started);
  }

  /** Hash `entries`, extract the ones whose content changed, drop `removed`, mark anchored nodes stale. */
  private async ingest(
    entries: readonly ScanEntry[],
    removed: readonly string[],
    known: ReadonlySet<string>,
    useStatCache: boolean,
    onExtracted?: (n: number) => void,
  ): Promise<IngestResult> {
    const stored = this.store.fileHashes();
    const out: IngestResult = { added: [], modified: [], deleted: [], stale: [], extractions: 0 };
    const reread = async (e: ScanEntry, force: boolean): Promise<void> => {
      const cached = this.statCache.get(e.path);
      if (!force && useStatCache && cached && cached.size === e.size && cached.mtimeMs === e.mtimeMs && stored.has(e.path)) return;
      let buffer: Buffer;
      try {
        buffer = await readFile(join(this.store.root, e.path));
      } catch {
        return; // vanished mid-scan; the next pass sees it as removed
      }
      if (buffer.subarray(0, 8000).includes(0)) {
        if (stored.has(e.path)) removedBinary.push(e.path);
        return;
      }
      const hash = sha1(buffer);
      this.statCache.set(e.path, { size: e.size, mtimeMs: e.mtimeMs });
      if (!force && stored.get(e.path) === hash) return;
      await this.extract(e.path, buffer.toString('utf8'), hash, buffer.length, known);
      out.extractions++;
      onExtracted?.(out.extractions);
      if (force) return;
      (stored.has(e.path) ? out.modified : out.added).push(e.path);
      out.stale.push(...this.store.markStaleForFile(e.path, hash));
    };
    const removedBinary: string[] = [];
    await pool(entries, CONCURRENCY, (e) => reread(e, false));

    const gone = [...new Set([...removed, ...removedBinary])].filter((p) => stored.has(p));
    // files whose resolved imports pointed at a removed file / could now resolve to an added one
    const refresh = new Set<string>();
    for (const p of gone) for (const i of this.store.imports({ resolved: p })) refresh.add(i.from);
    if (out.added.length > 0) for (const i of this.store.imports()) if (!i.resolved && !i.external) refresh.add(i.from);
    for (const p of gone) {
      this.store.removeFile(p);
      this.statCache.delete(p);
      if (this.mounts.delete(p)) this.mountsDirty = true;
      out.deleted.push(p);
      out.stale.push(...this.store.markStaleForFile(p, null));
    }
    const changed = new Set([...out.added, ...out.modified]);
    const goneSet = new Set(gone);
    const wantedRefresh = [...refresh].filter((p) => !changed.has(p) && !goneSet.has(p) && known.has(p));
    const byPath = new Map(entries.map((e) => [e.path, e]));
    for (const e of await statEntries(this.store.root, wantedRefresh.filter((p) => !byPath.has(p)))) byPath.set(e.path, e);
    await pool(wantedRefresh.filter((p) => byPath.has(p)), CONCURRENCY, (p) => reread(byPath.get(p)!, true));
    return out;
  }

  private async extract(path: string, content: string, hash: string, size: number, known: ReadonlySet<string>): Promise<void> {
    const { lang, isTest, ...rest } = await extractFile(path, content, known);
    const loc = content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    this.store.upsertExtraction({ file: { path, hash, lang, loc, size, isTest }, ...rest });
    const mounts = SCRIPT_LANGS.has(lang) ? parseMounts(content) : [];
    if (mounts.length > 0) this.mounts.set(path, mounts);
    else this.mounts.delete(path);
    this.mountsDirty = true;
  }

  private async finish(
    source: ChangeSet['source'],
    meta: Partial<Meta>,
    ingest: IngestResult,
    elapsedBase: number,
    onProgress?: (p: IndexProgress) => void,
  ): Promise<ChangeSet> {
    const store = this.store;
    const started = performance.now();
    const files: FileChange[] = [
      ...ingest.added.map((path) => ({ path, status: 'added' as const })),
      ...ingest.modified.map((path) => ({ path, status: 'modified' as const })),
      ...ingest.deleted.map((path) => ({ path, status: 'deleted' as const })),
    ];
    onProgress?.({ phase: 'derive', done: 0, total: 1 });
    const stackChanged = await this.refreshStack();
    if (this.mountsDirty) {
      store.setMeta(META_MOUNTS, JSON.stringify(Object.fromEntries(this.mounts)));
      this.mountsDirty = false;
    }
    const derived = files.length > 0 || stackChanged || store.getMeta('derived_once') === undefined;
    let layerChanged = false;
    if (derived) {
      layerChanged = applyLayer(store, deriveLayer(store, this.mounts)).changed;
      store.setMeta('derived_once', '1');
    }
    onProgress?.({ phase: 'derive', done: 1, total: 1 });

    onProgress?.({ phase: 'import', done: 0, total: 1 });
    const touchesDocs = source === 'index' || files.some((f) => !/\.(?:[cm]?[jt]sx?|py|go|java|rs|cs|php|rb)$/.test(f.path));
    const importedChanged = touchesDocs ? await this.refreshImported() : false;
    this.linkGoverned();
    onProgress?.({ phase: 'import', done: 1, total: 1 });

    const stale = [...new Set(ingest.stale)].filter((id) => store.getNode(id)?.status === 'stale');
    const cs: ChangeSet = {
      id: randomUUID(),
      at: new Date().toISOString(),
      source,
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta.agentId ? { agentId: meta.agentId } : {}),
      files,
      affectedNodes: this.affectedNodes(files.map((f) => f.path)),
      staleNodes: stale,
    };
    const anythingChanged = files.length > 0 || importedChanged || (source === 'index' && layerChanged);
    if (anythingChanged) store.recordChange(cs);
    if (source === 'index') {
      store.setMeta('last_indexed_at', cs.at);
      store.setMeta('last_index_ms', String(Math.round(elapsedBase + performance.now() - started)));
    }
    onProgress?.({ phase: 'done', done: 1, total: 1 });
    return cs;
  }

  // ── stack, imported layer, governs edges ────────────────────────────────

  private async refreshStack(): Promise<boolean> {
    const store = this.store;
    const files = store.listFiles();
    const sig = sha1([
      ...files.filter((f) => STACK_FILE.test(f.path)).map((f) => `${f.path}:${f.hash}`),
      ...[...this.lockfiles].map((l) => `lock:${l}`),
    ].sort().join('\n'));
    if (this.cachedStack && store.getMeta(META_STACK_SIG) === sig) {
      this.cachedStack = { ...this.cachedStack, languages: languageCounts(files) };
      return false;
    }
    // lockfiles are not indexed; hand detectStack stand-ins so it can tell the package manager
    const lockStubs: FileRecord[] = [...this.lockfiles].map((path) => ({ path, hash: '', lang: 'other', loc: 0, size: 0, isTest: false }));
    const stack = await detectStack(store.root, [...files, ...lockStubs]);
    stack.languages = languageCounts(files);
    store.setSchemaEntities(stack.entities);
    store.setIntegrations(stack.integrations);
    store.setMeta(META_STACK, JSON.stringify(stack));
    store.setMeta(META_STACK_SIG, sig);
    this.cachedStack = stack;
    return true;
  }

  private async refreshImported(): Promise<boolean> {
    const store = this.store;
    const sources = await importAiConfig(store.root);
    const hash = sha1(sources.map((s) => `${s.path}:${s.hash}`).sort().join('\n'));
    if (store.getMeta(META_IMPORTED_HASH) === hash) return false;
    const nodes = sourcesToNodes(sources);
    store.transaction(() => {
      const keep = new Set(nodes.map((n) => n.id));
      for (const stale of store.listNodes({ origin: ['imported'] })) if (!keep.has(stale.id)) store.deleteNode(stale.id);
      for (const n of nodes) store.upsertNode(n);
      store.setMeta(META_IMPORTED_HASH, hash);
    });
    return true;
  }

  /** Imported instructions that live inside a module directory govern that module. */
  private linkGoverned(): void {
    const store = this.store;
    const modules = new Set(store.listNodes({ kinds: ['module'] }).map((n) => n.id));
    const wanted = new Map<string, KnowledgeEdge>();
    for (const n of store.listNodes({ origin: ['imported'], kinds: ['instruction', 'rule', 'convention'] })) {
      const path = n.anchors[0]?.path;
      if (!path) continue;
      for (let dir = posix.dirname(path); dir !== '.' && dir !== '/'; dir = posix.dirname(dir)) {
        if (!modules.has(`module:${dir}`)) continue;
        wanted.set(`${n.id}\0module:${dir}`, { from: n.id, to: `module:${dir}`, rel: 'governs', origin: 'imported' });
        break;
      }
    }
    store.transaction(() => {
      for (const e of store.edges({ rel: 'governs' })) {
        if (e.origin === 'imported' && e.to.startsWith('module:') && !wanted.has(`${e.from}\0${e.to}`)) {
          store.deleteEdges({ from: e.from, to: e.to, rel: 'governs', origin: 'imported' });
        }
      }
      for (const e of wanted.values()) store.upsertEdge(e);
    });
  }

  private affectedNodes(paths: readonly string[]): string[] {
    if (paths.length === 0) return [];
    const pathSet = new Set(paths);
    const modules = new Set(paths.map((p) => moduleOf(p)).filter((m): m is string => m !== undefined));
    const out = new Set<string>();
    for (const n of this.store.listNodes()) {
      if (n.origin !== 'deterministic') {
        if (n.anchors.some((a) => pathSet.has(a.path))) out.add(n.id);
        continue;
      }
      const data = n.data ?? {};
      const evidence = (data.evidence as { path: string }[] | undefined) ?? [];
      const sources = (data.sources as { path: string }[] | undefined) ?? [];
      if (
        modules.has(n.id)
        || (typeof data.path === 'string' && pathSet.has(data.path))
        || sources.some((s) => pathSet.has(s.path))
        || evidence.some((e) => pathSet.has(e.path))
      ) out.add(n.id);
    }
    return [...out].sort();
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private normalize(input: string): string | undefined {
    let path = input.replaceAll('\\', '/');
    if (isAbsolute(input)) path = relative(this.store.root, input).replaceAll('\\', '/');
    path = posix.normalize(path).replace(/^\.\//, '');
    return path === '.' || path === '' || path.startsWith('..') ? undefined : path;
  }

  private setLockfiles(list: readonly string[]): void {
    const next = [...list].sort();
    if (next.join('\0') === [...this.lockfiles].sort().join('\0')) return;
    this.lockfiles = new Set(next);
    this.store.setMeta(META_LOCKFILES, JSON.stringify(next));
  }

  private touchLockfile(path: string, present: boolean): void {
    const next = new Set(this.lockfiles);
    if (present) next.add(path);
    else next.delete(path);
    this.setLockfiles([...next]);
  }

  private readJson<T>(key: string): T | undefined {
    const raw = this.store.getMeta(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export const createIndexer: CreateIndexer = (store) => new FileIndexer(store);
