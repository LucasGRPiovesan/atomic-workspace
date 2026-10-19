import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MemoryStore } from '../contracts.js';
import type {
  Anchor, ChangeSet, EntityRecord, FileExtraction, FileRecord, ImportRecord, IntegrationRecord,
  KnowledgeEdge, KnowledgeNode, KnowledgeNodeInput, MemoryStats, NodeFilter, NodeKind, NodeOrigin,
  RelKind, RouteRecord, SearchHit, SymbolRecord, TestRecord,
} from '../types.js';
import { MIGRATIONS } from './schema.js';

type Row = Record<string, string | number | null>;
type Param = string | number | null;

const META_CTX_COUNT = 'context_served_count';
const META_CTX_TOKENS = 'context_served_tokens';
const META_LAST_INDEXED_AT = 'last_indexed_at';
const META_LAST_INDEX_MS = 'last_index_ms';

const MAX_QUERY_TOKENS = 12;
const NODE_SEARCH_BOOST = 2;
const SNIPPET_MAX = 160;

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** "createOrderItem" → "create Order Item" so FTS can match word fragments of identifiers. */
const splitIdentifier = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_\-.]+/g, ' ');

const truncate = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * Turns free user text into a safe FTS5 MATCH expression: every token is a quoted phrase (so FTS
 * operators/syntax chars are inert), tokens are OR-ed, and the last one is a prefix match.
 */
export function buildMatchQuery(text: string): string | undefined {
  const tokens = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, MAX_QUERY_TOKENS);
  if (tokens.length === 0) return undefined;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' OR ');
}

const fileFromRow = (r: Row): FileRecord => ({
  path: r.path as string,
  hash: r.hash as string,
  lang: r.lang as FileRecord['lang'],
  loc: r.loc as number,
  size: r.size as number,
  isTest: r.is_test === 1,
});

const symbolFromRow = (r: Row): SymbolRecord => {
  const s: SymbolRecord = {
    id: r.id as string,
    path: r.path as string,
    name: r.name as string,
    kind: r.kind as SymbolRecord['kind'],
    startLine: r.start_line as number,
    endLine: r.end_line as number,
    exported: r.exported === 1,
  };
  if (r.signature != null) s.signature = r.signature as string;
  if (r.parent != null) s.parent = r.parent as string;
  return s;
};

const importFromRow = (r: Row): ImportRecord => {
  const i: ImportRecord = {
    from: r.from_path as string,
    specifier: r.specifier as string,
    names: parse<string[]>(r.names, []),
    external: r.external === 1,
    line: r.line as number,
  };
  if (r.resolved != null) i.resolved = r.resolved as string;
  return i;
};

const routeFromRow = (r: Row): RouteRecord => {
  const o: RouteRecord = {
    id: r.id as string,
    path: r.path as string,
    line: r.line as number,
    method: r.method as RouteRecord['method'],
    pattern: r.pattern as string,
    framework: r.framework as RouteRecord['framework'],
  };
  if (r.handler != null) o.handler = r.handler as string;
  if (r.handler_symbol_id != null) o.handlerSymbolId = r.handler_symbol_id as string;
  return o;
};

const entityFromRow = (r: Row): EntityRecord => ({
  id: r.id as string,
  name: r.name as string,
  source: r.source as EntityRecord['source'],
  path: r.path as string,
  line: r.line as number,
  fields: parse(r.fields, []),
  relations: parse(r.relations, []),
});

const testFromRow = (r: Row): TestRecord => {
  const t: TestRecord = { path: r.path as string, line: r.line as number, name: r.name as string };
  if (r.framework != null) t.framework = r.framework as string;
  return t;
};

const nodeFromRow = (r: Row): KnowledgeNode => {
  const n: KnowledgeNode = {
    id: r.id as string,
    kind: r.kind as KnowledgeNode['kind'],
    title: r.title as string,
    summary: r.summary as string,
    origin: r.origin as KnowledgeNode['origin'],
    status: r.status as KnowledgeNode['status'],
    confidence: r.confidence as number,
    anchors: parse<Anchor[]>(r.anchors, []),
    tags: parse<string[]>(r.tags, []),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
  if (r.body != null) n.body = r.body as string;
  if (r.data != null) n.data = parse<Record<string, unknown>>(r.data, {});
  if (r.author != null) n.author = r.author as string;
  return n;
};

export class SqliteMemoryStore implements MemoryStore {
  readonly root: string;
  readonly dbPath: string;

  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;
  private closed = false;

  constructor(root: string) {
    this.root = resolve(root);
    const dir = join(this.root, '.atomic');
    mkdirSync(dir, { recursive: true });
    this.dbPath = join(dir, 'memory.db');
    this.db = new DatabaseSync(this.dbPath);
    // busy_timeout first: the main process and the agent's MCP process open this file concurrently.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private run(sql: string, ...p: Param[]): void {
    this.stmt(sql).run(...p);
  }

  private all(sql: string, ...p: Param[]): Row[] {
    return this.stmt(sql).all(...p) as unknown as Row[];
  }

  private get(sql: string, ...p: Param[]): Row | undefined {
    return this.stmt(sql).get(...p) as unknown as Row | undefined;
  }

  /** Synchronous transaction (BEGIN IMMEDIATE so concurrent writers queue on busy_timeout, no upgrade deadlocks). Nested calls use savepoints. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      const sp = `sp_${this.depth}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const out = fn();
        this.db.exec(`RELEASE ${sp}`);
        return out;
      } catch (e) {
        this.db.exec(`ROLLBACK TO ${sp}`);
        this.db.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // connection already rolled back (e.g. SQLITE_FULL); keep the original error
      }
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.db.close();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.transaction(() => {
      // re-read under the write lock: another process may have migrated while we waited
      const current = Number(this.getMeta('schema_version') ?? 0);
      for (let v = current; v < MIGRATIONS.length; v++) {
        this.db.exec(MIGRATIONS[v]);
        this.setMeta('schema_version', String(v + 1));
      }
    });
  }

  // ── index ───────────────────────────────────────────────────────────────

  upsertExtraction(ex: FileExtraction): void {
    const path = ex.file.path;
    this.transaction(() => {
      this.clearFile(path);
      const f = ex.file;
      this.run('INSERT INTO files(path, hash, lang, loc, size, is_test) VALUES (?,?,?,?,?,?)',
        path, f.hash, f.lang, f.loc, f.size, f.isTest ? 1 : 0);

      const seen = new Set<string>();
      for (const s of ex.symbols) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const res = this.stmt(
          'INSERT INTO symbols(id, path, name, kind, start_line, end_line, exported, signature, parent) VALUES (?,?,?,?,?,?,?,?,?)',
        ).run(s.id, path, s.name, s.kind, s.startLine, s.endLine, s.exported ? 1 : 0, s.signature ?? null, s.parent ?? null);
        this.run('INSERT INTO symbols_fts(rowid, name, path, signature) VALUES (?,?,?,?)',
          Number(res.lastInsertRowid), `${s.name} ${splitIdentifier(s.name)}`, path, s.signature ?? '');
      }
      for (const i of ex.imports) {
        this.run('INSERT INTO imports(from_path, specifier, resolved, names, external, line) VALUES (?,?,?,?,?,?)',
          path, i.specifier, i.resolved ?? null, json(i.names), i.external ? 1 : 0, i.line);
      }
      for (const r of ex.routes) {
        this.run('INSERT INTO routes(id, path, line, method, pattern, framework, handler, handler_symbol_id) VALUES (?,?,?,?,?,?,?,?)',
          r.id, path, r.line, r.method, r.pattern, r.framework, r.handler ?? null, r.handlerSymbolId ?? null);
      }
      for (const e of ex.entities) this.insertEntity(e, 'file', path);
      for (const t of ex.tests) {
        this.run('INSERT INTO tests(path, line, name, framework) VALUES (?,?,?,?)', path, t.line, t.name, t.framework ?? null);
      }
      for (const name of new Set(ex.envVars)) {
        this.run('INSERT INTO env_vars(name, path) VALUES (?,?)', name, path);
      }
    });
  }

  /** Remove the file row and everything extracted from it (children cascade; FTS and file-scope entities are explicit). */
  private clearFile(path: string): void {
    this.run('DELETE FROM symbols_fts WHERE rowid IN (SELECT rowid FROM symbols WHERE path = ?)', path);
    this.run("DELETE FROM entities WHERE scope = 'file' AND path = ?", path);
    this.run('DELETE FROM files WHERE path = ?', path);
  }

  removeFile(path: string): void {
    this.transaction(() => this.clearFile(path));
  }

  getFile(path: string): FileRecord | undefined {
    const r = this.get('SELECT * FROM files WHERE path = ?', path);
    return r && fileFromRow(r);
  }

  listFiles(): FileRecord[] {
    return this.all('SELECT * FROM files ORDER BY path').map(fileFromRow);
  }

  fileHashes(): Map<string, string> {
    return new Map(this.all('SELECT path, hash FROM files').map((r) => [r.path as string, r.hash as string]));
  }

  symbolsInFile(path: string): SymbolRecord[] {
    return this.all('SELECT * FROM symbols WHERE path = ? ORDER BY start_line, name', path).map(symbolFromRow);
  }

  findSymbols(name: string, limit = 50): SymbolRecord[] {
    const like = `%${escapeLike(name)}%`;
    const prefix = `${escapeLike(name)}%`;
    return this.all(
      `SELECT * FROM symbols
       WHERE name = ? COLLATE NOCASE OR name LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN name = ? THEN 0 WHEN name = ? COLLATE NOCASE THEN 1 WHEN name LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END,
                exported DESC, length(name), path, start_line
       LIMIT ?`,
      name, like, name, name, prefix, limit,
    ).map(symbolFromRow);
  }

  getSymbol(id: string): SymbolRecord | undefined {
    const r = this.get('SELECT * FROM symbols WHERE id = ?', id);
    return r && symbolFromRow(r);
  }

  imports(filter?: { from?: string; resolved?: string }): ImportRecord[] {
    const where: string[] = [];
    const params: Param[] = [];
    if (filter?.from !== undefined) {
      where.push('from_path = ?');
      params.push(filter.from);
    }
    if (filter?.resolved !== undefined) {
      where.push('resolved = ?');
      params.push(filter.resolved);
    }
    const sql = `SELECT * FROM imports${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY from_path, line, id`;
    return this.all(sql, ...params).map(importFromRow);
  }

  routes(): RouteRecord[] {
    return this.all('SELECT * FROM routes ORDER BY pattern, method, path, line').map(routeFromRow);
  }

  entities(): EntityRecord[] {
    return this.all('SELECT * FROM entities ORDER BY name, path, line').map(entityFromRow);
  }

  private insertEntity(e: EntityRecord, scope: 'file' | 'schema', pathOverride?: string): void {
    this.run('INSERT INTO entities(id, name, source, path, line, fields, relations, scope) VALUES (?,?,?,?,?,?,?,?)',
      e.id, e.name, e.source, pathOverride ?? e.path, e.line, json(e.fields), json(e.relations), scope);
  }

  setSchemaEntities(entities: EntityRecord[]): void {
    this.transaction(() => {
      this.run("DELETE FROM entities WHERE scope = 'schema'");
      for (const e of entities) this.insertEntity(e, 'schema');
    });
  }

  tests(path?: string): TestRecord[] {
    const rows = path === undefined
      ? this.all('SELECT * FROM tests ORDER BY path, line, rowid_')
      : this.all('SELECT * FROM tests WHERE path = ? ORDER BY line, rowid_', path);
    return rows.map(testFromRow);
  }

  integrations(): IntegrationRecord[] {
    return this.all('SELECT * FROM integrations ORDER BY key').map((r) => ({
      id: r.id as string,
      key: r.key as string,
      name: r.name as string,
      category: r.category as IntegrationRecord['category'],
      evidence: parse(r.evidence, []),
    }));
  }

  setIntegrations(items: IntegrationRecord[]): void {
    this.transaction(() => {
      this.run('DELETE FROM integrations');
      for (const i of items) {
        this.run('INSERT INTO integrations(id, key, name, category, evidence) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET key = excluded.key, name = excluded.name, category = excluded.category, evidence = excluded.evidence',
          i.id, i.key, i.name, i.category, json(i.evidence));
      }
    });
  }

  envVars(): { name: string; path: string }[] {
    return this.all('SELECT name, path FROM env_vars ORDER BY name, path').map((r) => ({ name: r.name as string, path: r.path as string }));
  }

  // ── knowledge ───────────────────────────────────────────────────────────

  upsertNode(input: KnowledgeNodeInput): KnowledgeNode {
    const now = new Date().toISOString();
    const status = input.status ?? (input.origin === 'agent' && input.anchors.length === 0 ? 'unverified' : 'fresh');
    const confidence = input.confidence ?? (input.origin === 'agent' ? 0.7 : 1);
    const tags = input.tags ?? [];
    this.transaction(() => {
      this.run(
        `INSERT INTO nodes(id, kind, title, summary, body, data, origin, status, confidence, anchors, tags, author, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, summary = excluded.summary,
           body = excluded.body, data = excluded.data, origin = excluded.origin, status = excluded.status,
           confidence = excluded.confidence, anchors = excluded.anchors, tags = excluded.tags,
           author = excluded.author, updated_at = excluded.updated_at`,
        input.id, input.kind, input.title, input.summary, input.body ?? null,
        input.data === undefined ? null : json(input.data),
        input.origin, status, confidence, json(input.anchors), json(tags), input.author ?? null, now, now,
      );
      this.syncAnchors(input.id, input.anchors);
    });
    return this.getNode(input.id) as KnowledgeNode;
  }

  private syncAnchors(id: string, anchors: readonly Anchor[]): void {
    this.run('DELETE FROM node_anchors WHERE node_id = ?', id);
    for (const p of new Set(anchors.map((a) => a.path))) {
      this.run('INSERT INTO node_anchors(node_id, path) VALUES (?,?)', id, p);
    }
  }

  getNode(id: string): KnowledgeNode | undefined {
    const r = this.get('SELECT * FROM nodes WHERE id = ?', id);
    return r && nodeFromRow(r);
  }

  listNodes(filter?: NodeFilter): KnowledgeNode[] {
    const where: string[] = [];
    const params: Param[] = [];
    const inList = (col: string, values: readonly string[] | undefined): void => {
      if (!values) return;
      if (values.length === 0) {
        where.push('0');
        return;
      }
      where.push(`${col} IN (${placeholders(values.length)})`);
      params.push(...values);
    };
    inList('kind', filter?.kinds);
    inList('status', filter?.status);
    inList('origin', filter?.origin);
    if (filter?.paths) {
      if (filter.paths.length === 0) where.push('0');
      else {
        where.push(`id IN (SELECT node_id FROM node_anchors WHERE path IN (${placeholders(filter.paths.length)}))`);
        params.push(...filter.paths);
      }
    }
    let sql = `SELECT * FROM nodes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id`;
    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    return this.all(sql, ...params).map(nodeFromRow);
  }

  deleteNode(id: string): void {
    this.transaction(() => {
      this.run('DELETE FROM edges WHERE from_id = ? OR to_id = ?', id, id);
      this.run('DELETE FROM nodes WHERE id = ?', id);
    });
  }

  deleteNodesByOrigin(origin: NodeOrigin, kinds?: NodeKind[]): void {
    if (kinds && kinds.length === 0) return;
    const sel = `SELECT id FROM nodes WHERE origin = ?${kinds ? ` AND kind IN (${placeholders(kinds.length)})` : ''}`;
    const params: Param[] = [origin, ...(kinds ?? [])];
    this.transaction(() => {
      this.run(`DELETE FROM edges WHERE from_id IN (${sel}) OR to_id IN (${sel})`, ...params, ...params);
      this.run(`DELETE FROM nodes WHERE id IN (${sel})`, ...params);
    });
  }

  upsertEdge(edge: KnowledgeEdge): void {
    this.run('INSERT INTO edges(from_id, to_id, rel, origin) VALUES (?,?,?,?) ON CONFLICT(from_id, to_id, rel) DO UPDATE SET origin = excluded.origin',
      edge.from, edge.to, edge.rel, edge.origin);
  }

  /** An empty filter deletes nothing (guard against wiping every edge by accident). */
  deleteEdges(filter: { from?: string; to?: string; rel?: RelKind; origin?: NodeOrigin }): void {
    const { where, params } = this.edgeWhere(filter);
    if (where.length === 0) return;
    this.run(`DELETE FROM edges WHERE ${where.join(' AND ')}`, ...params);
  }

  edges(filter?: { from?: string; to?: string; rel?: RelKind }): KnowledgeEdge[] {
    const { where, params } = this.edgeWhere(filter ?? {});
    const sql = `SELECT * FROM edges${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY from_id, rel, to_id`;
    return this.all(sql, ...params).map((r) => ({
      from: r.from_id as string,
      to: r.to_id as string,
      rel: r.rel as RelKind,
      origin: r.origin as NodeOrigin,
    }));
  }

  private edgeWhere(f: { from?: string; to?: string; rel?: RelKind; origin?: NodeOrigin }): { where: string[]; params: Param[] } {
    const where: string[] = [];
    const params: Param[] = [];
    if (f.from !== undefined) { where.push('from_id = ?'); params.push(f.from); }
    if (f.to !== undefined) { where.push('to_id = ?'); params.push(f.to); }
    if (f.rel !== undefined) { where.push('rel = ?'); params.push(f.rel); }
    if (f.origin !== undefined) { where.push('origin = ?'); params.push(f.origin); }
    return { where, params };
  }

  search(query: string, opts?: { kinds?: string[]; limit?: number }): SearchHit[] {
    const match = buildMatchQuery(query);
    if (!match) return [];
    const limit = opts?.limit ?? 20;
    const kinds = opts?.kinds;
    if (kinds && kinds.length === 0) return [];
    const kindSql = kinds ? ` AND x.kind IN (${placeholders(kinds.length)})` : '';
    const kindParams = kinds ?? [];

    try {
      const nodes = this.all(
        `SELECT x.id, x.kind, x.title, x.summary, bm25(nodes_fts, 10.0, 4.0, 1.0, 5.0) AS rank
         FROM nodes_fts JOIN nodes x ON x.rowid = nodes_fts.rowid
         WHERE nodes_fts MATCH ?${kindSql}
         ORDER BY rank LIMIT ?`,
        match, ...kindParams, limit,
      ).map((r): SearchHit => ({
        type: 'node',
        id: r.id as string,
        kind: r.kind as SearchHit['kind'],
        title: r.title as string,
        snippet: truncate(r.summary as string, SNIPPET_MAX),
        score: -(r.rank as number) * NODE_SEARCH_BOOST,
      }));

      const symbols = this.all(
        `SELECT x.id, x.kind, x.name, x.path, x.start_line, x.signature, bm25(symbols_fts, 10.0, 2.0, 3.0) AS rank
         FROM symbols_fts JOIN symbols x ON x.rowid = symbols_fts.rowid
         WHERE symbols_fts MATCH ?${kindSql}
         ORDER BY rank LIMIT ?`,
        match, ...kindParams, limit,
      ).map((r): SearchHit => ({
        type: 'symbol',
        id: r.id as string,
        kind: r.kind as SearchHit['kind'],
        title: r.name as string,
        snippet: truncate((r.signature as string | null) ?? `${r.kind as string} ${r.name as string}`, SNIPPET_MAX),
        path: r.path as string,
        line: r.start_line as number,
        score: -(r.rank as number),
      }));

      return [...nodes, ...symbols].sort((a, b) => b.score - a.score).slice(0, limit);
    } catch {
      // a malformed expression must never break callers (the agent-facing MCP tools pass raw text)
      return [];
    }
  }

  markStaleForFile(path: string, newHash: string | null): string[] {
    return this.transaction(() => {
      const changed: string[] = [];
      const rows = this.all(
        `SELECT n.id, n.anchors FROM nodes n
         WHERE n.origin != 'deterministic' AND n.status != 'stale'
           AND n.id IN (SELECT node_id FROM node_anchors WHERE path = ?)`,
        path,
      );
      for (const r of rows) {
        const anchors = parse<Anchor[]>(r.anchors, []);
        if (anchors.some((a) => a.path === path && a.hash !== newHash)) {
          this.run("UPDATE nodes SET status = 'stale', updated_at = ? WHERE id = ?", new Date().toISOString(), r.id as string);
          changed.push(r.id as string);
        }
      }
      return changed;
    });
  }

  markVerified(id: string): KnowledgeNode | undefined {
    return this.transaction(() => {
      const node = this.getNode(id);
      if (!node) return undefined;
      const hashes = this.fileHashes();
      const anchors: Anchor[] = [];
      for (const a of node.anchors) {
        const h = hashes.get(a.path);
        if (h !== undefined) anchors.push({ ...a, hash: h });
      }
      const status = node.anchors.length > 0 && anchors.length === 0 ? 'stale' : 'fresh';
      this.run('UPDATE nodes SET status = ?, anchors = ?, updated_at = ? WHERE id = ?',
        status, json(anchors), new Date().toISOString(), id);
      this.syncAnchors(id, anchors);
      return this.getNode(id);
    });
  }

  // ── changes & sessions ──────────────────────────────────────────────────

  recordChange(cs: ChangeSet): void {
    this.transaction(() => {
      this.run('INSERT INTO changes(id, at, data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, data = excluded.data',
        cs.id, cs.at, json(cs));
      if (cs.source === 'index') this.setMeta(META_LAST_INDEXED_AT, cs.at);
    });
  }

  listChanges(limit = 50): ChangeSet[] {
    return this.all('SELECT data FROM changes ORDER BY at DESC, rowid DESC LIMIT ?', limit)
      .map((r) => parse<ChangeSet | undefined>(r.data, undefined))
      .filter((c): c is ChangeSet => c !== undefined);
  }

  recordContextServed(tokens: number): void {
    const bump = 'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT)';
    this.transaction(() => {
      this.run(bump, META_CTX_COUNT, '1');
      this.run(bump, META_CTX_TOKENS, String(Math.max(0, Math.round(tokens))));
    });
  }

  // ── meta ────────────────────────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const r = this.get('SELECT value FROM meta WHERE key = ?', key);
    return r ? (r.value as string) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  stats(): MemoryStats {
    const count = (table: string): number => this.get(`SELECT count(*) AS c FROM ${table}`)?.c as number;
    const group = <K extends string>(col: string): Partial<Record<K, number>> => {
      const out: Partial<Record<K, number>> = {};
      for (const r of this.all(`SELECT ${col} AS k, count(*) AS c FROM nodes GROUP BY ${col}`)) out[r.k as K] = r.c as number;
      return out;
    };
    const size = (this.get('SELECT coalesce(sum(size), 0) AS s FROM files')?.s as number) ?? 0;
    const lastAt = this.getMeta(META_LAST_INDEXED_AT);
    const lastMs = this.getMeta(META_LAST_INDEX_MS);
    const stats: MemoryStats = {
      files: count('files'),
      symbols: count('symbols'),
      routes: count('routes'),
      entities: count('entities'),
      tests: count('tests'),
      nodesByKind: group<NodeKind>('kind'),
      nodesByOrigin: group<NodeOrigin>('origin'),
      stale: this.get("SELECT count(*) AS c FROM nodes WHERE status = 'stale'")?.c as number,
      estimatedRepoTokens: Math.ceil(size / 4),
      contextServed: {
        count: Number(this.getMeta(META_CTX_COUNT) ?? 0),
        tokens: Number(this.getMeta(META_CTX_TOKENS) ?? 0),
      },
    };
    if (lastAt !== undefined) stats.lastIndexedAt = lastAt;
    if (lastMs !== undefined && Number.isFinite(Number(lastMs))) stats.lastIndexMs = Number(lastMs);
    return stats;
  }
}
