import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store/index.js';
import type { MemoryStore } from '../../src/contracts.js';
import type { ChangeSet, EntityRecord, FileExtraction, KnowledgeNodeInput, SymbolRecord } from '../../src/types.js';

let root: string;
let store: MemoryStore;
const opened: MemoryStore[] = [];

const open = (): MemoryStore => {
  const s = openStore(root);
  opened.push(s);
  return s;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomic-store-'));
  store = open();
});

afterEach(async () => {
  for (const s of opened.splice(0)) s.close();
  await rm(root, { recursive: true, force: true });
});

const sym = (path: string, name: string, line: number, extra: Partial<SymbolRecord> = {}): SymbolRecord => ({
  id: `${path}#${name}@${line}`,
  path,
  name,
  kind: 'function',
  startLine: line,
  endLine: line + 5,
  exported: true,
  ...extra,
});

const entity = (name: string, path: string, source: EntityRecord['source'] = 'typeorm'): EntityRecord => ({
  id: `entity:${name}`,
  name,
  source,
  path,
  line: 1,
  fields: [{ name: 'id', type: 'string', isId: true }],
  relations: [],
});

function extraction(path: string, hash = 'h1', over: Partial<FileExtraction> = {}): FileExtraction {
  return {
    file: { path, hash, lang: 'typescript', loc: 40, size: 400, isTest: false },
    symbols: [sym(path, 'createOrder', 3, { signature: 'createOrder(input: OrderInput): Promise<Order>' })],
    imports: [
      { from: path, specifier: './repo', resolved: 'src/repo.ts', names: ['repo'], external: false, line: 1 },
      { from: path, specifier: 'express', names: [], external: true, line: 2 },
    ],
    routes: [{ id: 'route:GET /orders', path, line: 10, method: 'GET', pattern: '/orders', framework: 'express', handler: 'list' }],
    entities: [entity('Order', path)],
    tests: [{ path, line: 20, name: 'Orders > creates', framework: 'vitest' }],
    envVars: ['DB_URL', 'DB_URL', 'API_KEY'],
    ...over,
  };
}

const node = (id: string, over: Partial<KnowledgeNodeInput> = {}): KnowledgeNodeInput => ({
  id,
  kind: 'rule',
  title: `Rule ${id}`,
  summary: 'Orders must have at least one item',
  origin: 'agent',
  anchors: [],
  ...over,
});

describe('openStore', () => {
  it('creates .atomic/memory.db with WAL and the current schema version', () => {
    expect(existsSync(join(root, '.atomic', 'memory.db'))).toBe(true);
    expect(store.dbPath).toBe(join(root, '.atomic', 'memory.db'));
    expect(Number(store.getMeta('schema_version'))).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent when reopened', () => {
    store.setMeta('k', 'v');
    const again = open();
    expect(again.getMeta('k')).toBe('v');
  });

  it('rolls back a failed transaction and supports nesting', () => {
    expect(() => store.transaction(() => {
      store.setMeta('a', '1');
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.getMeta('a')).toBeUndefined();

    store.transaction(() => {
      store.setMeta('outer', '1');
      expect(() => store.transaction(() => {
        store.setMeta('inner', '1');
        throw new Error('inner');
      })).toThrow('inner');
    });
    expect(store.getMeta('outer')).toBe('1');
    expect(store.getMeta('inner')).toBeUndefined();
  });
});

describe('index tables', () => {
  it('upsertExtraction stores everything and replaces per-file rows on re-extract', () => {
    store.upsertExtraction(extraction('src/orders.ts'));
    expect(store.getFile('src/orders.ts')).toMatchObject({ hash: 'h1', lang: 'typescript', isTest: false, loc: 40, size: 400 });
    expect(store.symbolsInFile('src/orders.ts')).toHaveLength(1);
    expect(store.routes()).toHaveLength(1);
    expect(store.entities().map((e) => e.name)).toEqual(['Order']);
    expect(store.tests('src/orders.ts')).toHaveLength(1);
    expect(store.envVars()).toEqual([
      { name: 'API_KEY', path: 'src/orders.ts' },
      { name: 'DB_URL', path: 'src/orders.ts' },
    ]);

    store.upsertExtraction(extraction('src/orders.ts', 'h2', {
      symbols: [sym('src/orders.ts', 'cancelOrder', 7)],
      imports: [],
      routes: [],
      entities: [],
      tests: [],
      envVars: ['NEW_VAR'],
    }));
    expect(store.getFile('src/orders.ts')?.hash).toBe('h2');
    expect(store.symbolsInFile('src/orders.ts').map((s) => s.name)).toEqual(['cancelOrder']);
    expect(store.findSymbols('createOrder')).toEqual([]);
    expect(store.imports()).toEqual([]);
    expect(store.routes()).toEqual([]);
    expect(store.entities()).toEqual([]);
    expect(store.tests()).toEqual([]);
    expect(store.envVars()).toEqual([{ name: 'NEW_VAR', path: 'src/orders.ts' }]);
    expect(store.listFiles()).toHaveLength(1);
  });

  it('upsertExtraction does not touch other files', () => {
    store.upsertExtraction(extraction('src/a.ts'));
    store.upsertExtraction(extraction('src/b.ts', 'hb', { symbols: [sym('src/b.ts', 'other', 1)] }));
    store.upsertExtraction(extraction('src/a.ts', 'h9', { symbols: [] }));
    expect(store.symbolsInFile('src/b.ts')).toHaveLength(1);
    expect(store.fileHashes()).toEqual(new Map([['src/a.ts', 'h9'], ['src/b.ts', 'hb']]));
  });

  it('removeFile removes the file, its rows and its FTS entries', () => {
    store.upsertExtraction(extraction('src/orders.ts'));
    store.upsertExtraction(extraction('src/keep.ts', 'k', { symbols: [sym('src/keep.ts', 'keepMe', 1)] }));
    store.removeFile('src/orders.ts');
    expect(store.getFile('src/orders.ts')).toBeUndefined();
    expect(store.symbolsInFile('src/orders.ts')).toEqual([]);
    expect(store.imports({ from: 'src/orders.ts' })).toEqual([]);
    expect(store.entities().map((e) => e.path)).toEqual(['src/keep.ts']);
    expect(store.search('createOrder')).toEqual([]);
    expect(store.search('keepMe')).toHaveLength(1);
    store.removeFile('does/not/exist.ts');
  });

  it('findSymbols ranks exact > prefix > contains, case-insensitively, and honours limit', () => {
    store.upsertExtraction(extraction('src/s.ts', 'h', {
      symbols: [
        sym('src/s.ts', 'myOrderHelper', 1),
        sym('src/s.ts', 'OrderService', 10, { kind: 'class' }),
        sym('src/s.ts', 'order', 20),
        sym('src/s.ts', 'unrelated', 30),
        sym('src/s.ts', '100%_done', 40),
      ],
    }));
    expect(store.findSymbols('order').map((s) => s.name)).toEqual(['order', 'OrderService', 'myOrderHelper']);
    expect(store.findSymbols('order', 1)).toHaveLength(1);
    expect(store.findSymbols('%_')).toHaveLength(1);
    expect(store.getSymbol('src/s.ts#order@20')?.name).toBe('order');
    expect(store.getSymbol('nope')).toBeUndefined();
  });

  it('imports filter by importer and by resolved target', () => {
    store.upsertExtraction(extraction('src/a.ts'));
    store.upsertExtraction(extraction('src/b.ts', 'hb', {
      imports: [{ from: 'src/b.ts', specifier: './a', resolved: 'src/a.ts', names: ['x'], external: false, line: 1 }],
    }));
    expect(store.imports()).toHaveLength(3);
    expect(store.imports({ from: 'src/b.ts' })).toHaveLength(1);
    const toA = store.imports({ resolved: 'src/a.ts' });
    expect(toA).toHaveLength(1);
    expect(toA[0]).toMatchObject({ from: 'src/b.ts', names: ['x'], external: false });
    expect(store.imports({ from: 'src/a.ts' }).find((i) => i.external)?.resolved).toBeUndefined();
    expect(store.imports({ from: 'src/a.ts', resolved: 'src/repo.ts' })).toHaveLength(1);
  });

  it('setSchemaEntities replaces only schema-level entities', () => {
    store.upsertExtraction(extraction('src/orders.ts'));
    store.setSchemaEntities([entity('User', 'prisma/schema.prisma', 'prisma'), entity('Invoice', 'prisma/schema.prisma', 'prisma')]);
    expect(store.entities().map((e) => e.name).sort()).toEqual(['Invoice', 'Order', 'User']);
    store.setSchemaEntities([entity('User', 'prisma/schema.prisma', 'prisma')]);
    expect(store.entities().map((e) => e.name).sort()).toEqual(['Order', 'User']);
    store.removeFile('src/orders.ts');
    expect(store.entities().map((e) => e.name)).toEqual(['User']);
  });

  it('setIntegrations replaces the full set', () => {
    const mk = (key: string) => ({ id: `integration:${key}`, key, name: key, category: 'payment' as const, evidence: [{ path: 'package.json', detail: `dependency ${key}` }] });
    store.setIntegrations([mk('stripe'), mk('redis')]);
    expect(store.integrations().map((i) => i.key)).toEqual(['redis', 'stripe']);
    store.setIntegrations([mk('stripe')]);
    expect(store.integrations()).toEqual([mk('stripe')]);
  });
});

describe('search (FTS5)', () => {
  beforeEach(() => {
    store.upsertExtraction(extraction('src/orders.ts'));
    store.upsertNode(node('rule:min-items', { title: 'Minimum items', summary: 'An order must contain at least one item', tags: ['checkout'] }));
    store.upsertNode(node('note:other', { kind: 'note', title: 'Unrelated', summary: 'Nothing to see' }));
  });

  it('finds nodes and symbols, nodes ranked above symbols for equal matches', () => {
    const hits = store.search('order');
    const types = hits.map((h) => h.type);
    expect(types).toContain('node');
    expect(types).toContain('symbol');
    expect(hits[0].type).toBe('node');
    const symHit = hits.find((h) => h.type === 'symbol');
    expect(symHit).toMatchObject({ id: 'src/orders.ts#createOrder@3', path: 'src/orders.ts', line: 3, kind: 'function' });
    expect(symHit?.snippet).toContain('createOrder(');
    expect(hits.find((h) => h.type === 'node')?.snippet).toContain('at least one item');
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
  });

  it('matches by prefix on the last token, tags, and camelCase fragments', () => {
    expect(store.search('minim').map((h) => h.id)).toContain('rule:min-items');
    expect(store.search('checkout').map((h) => h.id)).toContain('rule:min-items');
    expect(store.search('create').map((h) => h.id)).toContain('src/orders.ts#createOrder@3');
  });

  it('is safe against hostile input', () => {
    for (const q of ['foo" OR bar*', '-x', '"', '*', 'NEAR(', 'a AND (b', "') ; DROP TABLE nodes; --", '', '   ', 'title:order', '^order']) {
      expect(() => store.search(q)).not.toThrow();
    }
    expect(store.search('foo" OR bar*')).toEqual([]);
    expect(store.search('-x')).toEqual([]);
    expect(store.search('-order').length).toBeGreaterThan(0);
    expect(store.search('title:order').length).toBeGreaterThan(0);
    expect(store.listNodes()).toHaveLength(2);
  });

  it('filters by kinds and limit', () => {
    expect(store.search('order', { kinds: ['function'] }).every((h) => h.type === 'symbol')).toBe(true);
    expect(store.search('order', { kinds: ['rule'] }).every((h) => h.type === 'node')).toBe(true);
    expect(store.search('order', { limit: 1 })).toHaveLength(1);
    expect(store.search('order', { kinds: [] })).toEqual([]);
  });

  it('stays in sync on node update and delete', () => {
    store.upsertNode(node('rule:min-items', { title: 'Zebra policy', summary: 'changed text' }));
    expect(store.search('minimum')).toEqual([]);
    expect(store.search('zebra').map((h) => h.id)).toEqual(['rule:min-items']);
    store.deleteNode('rule:min-items');
    expect(store.search('zebra')).toEqual([]);
  });
});

describe('knowledge nodes & edges', () => {
  it('applies defaults and preserves createdAt on update', async () => {
    const a = store.upsertNode(node('note:a'));
    expect(a).toMatchObject({ status: 'unverified', confidence: 0.7, tags: [], origin: 'agent' });
    expect(a.createdAt).toBe(a.updatedAt);

    await new Promise((r) => setTimeout(r, 5));
    const a2 = store.upsertNode(node('note:a', { summary: 'v2', tags: ['t'] }));
    expect(a2.createdAt).toBe(a.createdAt);
    expect(a2.updatedAt > a.updatedAt).toBe(true);
    expect(a2).toMatchObject({ summary: 'v2', tags: ['t'] });

    const anchored = store.upsertNode(node('note:b', { anchors: [{ path: 'src/x.ts', hash: 'h' }] }));
    expect(anchored.status).toBe('fresh');
    const imported = store.upsertNode(node('instruction:CLAUDE.md#1', { origin: 'imported', kind: 'instruction' }));
    expect(imported).toMatchObject({ status: 'fresh', confidence: 1 });
    const det = store.upsertNode(node('module:src', { origin: 'deterministic', kind: 'module', data: { files: 2, loc: 10 }, body: '# md' }));
    expect(det).toMatchObject({ confidence: 1, status: 'fresh', data: { files: 2, loc: 10 }, body: '# md' });
    expect(store.upsertNode(node('note:c', { confidence: 0.2, status: 'stale', author: 'claude' }))).toMatchObject({ confidence: 0.2, status: 'stale', author: 'claude' });
    expect(store.getNode('missing')).toBeUndefined();
  });

  it('listNodes filters by kind, status, origin, anchored path and limit', () => {
    store.upsertNode(node('rule:1', { anchors: [{ path: 'src/a.ts', hash: 'h' }] }));
    store.upsertNode(node('note:2', { kind: 'note' }));
    store.upsertNode(node('module:src', { kind: 'module', origin: 'deterministic' }));
    expect(store.listNodes()).toHaveLength(3);
    expect(store.listNodes({ kinds: ['note', 'module'] })).toHaveLength(2);
    expect(store.listNodes({ status: ['unverified'] }).map((n) => n.id)).toEqual(['note:2']);
    expect(store.listNodes({ origin: ['deterministic'] }).map((n) => n.id)).toEqual(['module:src']);
    expect(store.listNodes({ paths: ['src/a.ts'] }).map((n) => n.id)).toEqual(['rule:1']);
    expect(store.listNodes({ paths: ['nope'] })).toEqual([]);
    expect(store.listNodes({ kinds: [] })).toEqual([]);
    expect(store.listNodes({ limit: 2 })).toHaveLength(2);
  });

  it('edges are unique on (from,to,rel) and can be filtered/deleted', () => {
    store.upsertEdge({ from: 'a', to: 'b', rel: 'contains', origin: 'agent' });
    store.upsertEdge({ from: 'a', to: 'b', rel: 'contains', origin: 'deterministic' });
    store.upsertEdge({ from: 'a', to: 'b', rel: 'relates', origin: 'agent' });
    store.upsertEdge({ from: 'b', to: 'c', rel: 'calls', origin: 'deterministic' });
    expect(store.edges()).toHaveLength(3);
    expect(store.edges({ from: 'a', rel: 'contains' })).toEqual([{ from: 'a', to: 'b', rel: 'contains', origin: 'deterministic' }]);
    expect(store.edges({ to: 'c' })).toHaveLength(1);

    store.deleteEdges({});
    expect(store.edges()).toHaveLength(3);
    store.deleteEdges({ origin: 'deterministic' });
    expect(store.edges().map((e) => e.rel)).toEqual(['relates']);
    store.deleteEdges({ from: 'a', to: 'b', rel: 'relates' });
    expect(store.edges()).toEqual([]);
  });

  it('deleteNode and deleteNodesByOrigin remove edges touching the nodes', () => {
    store.upsertNode(node('module:a', { kind: 'module', origin: 'deterministic' }));
    store.upsertNode(node('route:GET /x', { kind: 'route', origin: 'deterministic' }));
    store.upsertNode(node('entity:E', { kind: 'entity', origin: 'deterministic' }));
    store.upsertNode(node('rule:keep', { origin: 'user' }));
    store.upsertNode(node('rule:agent'));
    store.upsertEdge({ from: 'module:a', to: 'route:GET /x', rel: 'exposes', origin: 'deterministic' });
    store.upsertEdge({ from: 'rule:keep', to: 'module:a', rel: 'governs', origin: 'user' });
    store.upsertEdge({ from: 'rule:keep', to: 'rule:agent', rel: 'relates', origin: 'user' });
    store.upsertEdge({ from: 'rule:agent', to: 'entity:E', rel: 'reads', origin: 'agent' });

    store.deleteNodesByOrigin('deterministic', ['module', 'route']);
    expect(store.listNodes().map((n) => n.id).sort()).toEqual(['entity:E', 'rule:agent', 'rule:keep']);
    expect(store.edges().map((e) => `${e.from}>${e.to}`).sort()).toEqual(['rule:agent>entity:E', 'rule:keep>rule:agent']);

    store.deleteNodesByOrigin('deterministic');
    expect(store.getNode('entity:E')).toBeUndefined();
    expect(store.edges().map((e) => e.rel)).toEqual(['relates']);

    store.deleteNode('rule:agent');
    expect(store.edges()).toEqual([]);
    expect(store.listNodes().map((n) => n.id)).toEqual(['rule:keep']);
  });
});

describe('staleness', () => {
  beforeEach(() => {
    store.upsertExtraction(extraction('src/a.ts', 'ha'));
    store.upsertExtraction(extraction('src/b.ts', 'hb', { symbols: [] }));
  });

  it('markStaleForFile flips only non-deterministic nodes with a mismatching hash and returns their ids', () => {
    store.upsertNode(node('rule:same', { anchors: [{ path: 'src/a.ts', hash: 'NEW' }] }));
    store.upsertNode(node('rule:old', { anchors: [{ path: 'src/a.ts', hash: 'ha' }] }));
    store.upsertNode(node('note:multi', { origin: 'user', anchors: [{ path: 'src/b.ts', hash: 'hb' }, { path: 'src/a.ts', hash: 'ha' }] }));
    store.upsertNode(node('module:src', { kind: 'module', origin: 'deterministic', anchors: [{ path: 'src/a.ts', hash: 'ha' }] }));
    store.upsertNode(node('instruction:x', { kind: 'instruction', origin: 'imported', anchors: [{ path: 'src/b.ts', hash: 'hb' }] }));
    store.upsertNode(node('note:noanchor'));

    const ids = store.markStaleForFile('src/a.ts', 'NEW').sort();
    expect(ids).toEqual(['note:multi', 'rule:old']);
    expect(store.getNode('rule:old')?.status).toBe('stale');
    expect(store.getNode('note:multi')?.status).toBe('stale');
    expect(store.getNode('rule:same')?.status).toBe('fresh');
    expect(store.getNode('module:src')?.status).toBe('fresh');
    expect(store.getNode('instruction:x')?.status).toBe('fresh');
    expect(store.getNode('note:noanchor')?.status).toBe('unverified');

    expect(store.markStaleForFile('src/a.ts', 'NEW')).toEqual([]);
    expect(store.stats().stale).toBe(2);
  });

  it('markStaleForFile(path, null) marks every non-deterministic anchored node (file deleted)', () => {
    store.upsertNode(node('rule:1', { anchors: [{ path: 'src/a.ts', hash: 'ha' }] }));
    store.upsertNode(node('module:src', { kind: 'module', origin: 'deterministic', anchors: [{ path: 'src/a.ts', hash: 'ha' }] }));
    expect(store.markStaleForFile('src/a.ts', null)).toEqual(['rule:1']);
    expect(store.getNode('module:src')?.status).toBe('fresh');
  });

  it('markVerified refreshes anchor hashes from the files table and sets fresh', () => {
    store.upsertNode(node('rule:1', { anchors: [{ path: 'src/a.ts', hash: 'ha', startLine: 1, endLine: 4 }, { path: 'src/b.ts', hash: 'hb' }] }));
    store.upsertExtraction(extraction('src/a.ts', 'ha2'));
    expect(store.markStaleForFile('src/a.ts', 'ha2')).toEqual(['rule:1']);

    const v = store.markVerified('rule:1');
    expect(v?.status).toBe('fresh');
    expect(v?.anchors).toEqual([{ path: 'src/a.ts', hash: 'ha2', startLine: 1, endLine: 4 }, { path: 'src/b.ts', hash: 'hb' }]);
    expect(store.markStaleForFile('src/a.ts', 'ha2')).toEqual([]);
    expect(store.markVerified('missing')).toBeUndefined();
  });

  it('markVerified drops anchors of vanished files and keeps stale when none remain', () => {
    store.upsertNode(node('rule:gone', { anchors: [{ path: 'src/a.ts', hash: 'ha' }] }));
    store.upsertNode(node('rule:partial', { anchors: [{ path: 'src/a.ts', hash: 'ha' }, { path: 'src/b.ts', hash: 'hb' }] }));
    store.upsertNode(node('note:free'));
    store.removeFile('src/a.ts');
    store.markStaleForFile('src/a.ts', null);

    const gone = store.markVerified('rule:gone');
    expect(gone?.status).toBe('stale');
    expect(gone?.anchors).toEqual([]);

    const partial = store.markVerified('rule:partial');
    expect(partial?.status).toBe('fresh');
    expect(partial?.anchors).toEqual([{ path: 'src/b.ts', hash: 'hb' }]);

    expect(store.markVerified('note:free')?.status).toBe('fresh');
  });
});

describe('changes, meta and stats', () => {
  const cs = (id: string, at: string, source: ChangeSet['source'] = 'agent'): ChangeSet => ({
    id, at, source, files: [{ path: 'a.ts', status: 'modified' }], affectedNodes: ['n'], staleNodes: [], summary: id,
  });

  it('records changes newest first with limit', () => {
    store.recordChange(cs('c1', '2026-01-01T00:00:00.000Z'));
    store.recordChange(cs('c3', '2026-01-03T00:00:00.000Z'));
    store.recordChange(cs('c2', '2026-01-02T00:00:00.000Z', 'index'));
    expect(store.listChanges().map((c) => c.id)).toEqual(['c3', 'c2', 'c1']);
    expect(store.listChanges(2).map((c) => c.id)).toEqual(['c3', 'c2']);
    expect(store.listChanges(1)[0]).toEqual(cs('c3', '2026-01-03T00:00:00.000Z'));
    expect(store.stats().lastIndexedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('stats counts rows, nodes by kind/origin, stale, tokens and context served', () => {
    expect(store.stats()).toMatchObject({ files: 0, estimatedRepoTokens: 0, stale: 0, contextServed: { count: 0, tokens: 0 } });
    store.upsertExtraction(extraction('src/a.ts', 'ha'));
    store.upsertExtraction(extraction('src/b.ts', 'hb', { file: { path: 'src/b.ts', hash: 'hb', lang: 'typescript', loc: 1, size: 201, isTest: true }, symbols: [], routes: [], entities: [], tests: [] }));
    store.upsertNode(node('rule:1', { anchors: [{ path: 'src/a.ts', hash: 'old' }] }));
    store.upsertNode(node('module:src', { kind: 'module', origin: 'deterministic' }));
    store.markStaleForFile('src/a.ts', 'ha');
    store.recordContextServed(120);
    store.recordContextServed(30);
    store.setMeta('last_index_ms', '42');

    expect(store.stats()).toEqual({
      files: 2,
      symbols: 1,
      routes: 1,
      entities: 1,
      tests: 1,
      nodesByKind: { rule: 1, module: 1 },
      nodesByOrigin: { agent: 1, deterministic: 1 },
      stale: 1,
      lastIndexMs: 42,
      estimatedRepoTokens: Math.ceil((400 + 201) / 4),
      contextServed: { count: 2, tokens: 150 },
    });
  });
});

describe('two store instances on the same DB (main process + MCP process)', () => {
  it('see each other\'s writes immediately, in both directions', () => {
    const mcp = open();
    expect(mcp.dbPath).toBe(store.dbPath);

    store.upsertExtraction(extraction('src/a.ts'));
    expect(mcp.getFile('src/a.ts')?.hash).toBe('h1');
    expect(mcp.search('createOrder')).toHaveLength(1);

    mcp.upsertNode(node('note:from-mcp', { summary: 'recorded by the agent' }));
    expect(store.getNode('note:from-mcp')?.summary).toBe('recorded by the agent');
    expect(store.search('recorded agent').map((h) => h.id)).toContain('note:from-mcp');

    mcp.recordContextServed(10);
    store.recordContextServed(5);
    expect(store.stats().contextServed).toEqual({ count: 2, tokens: 15 });
    expect(mcp.stats().contextServed).toEqual({ count: 2, tokens: 15 });

    store.removeFile('src/a.ts');
    expect(mcp.getFile('src/a.ts')).toBeUndefined();
  });

  it('interleaved short transactions from two instances do not lose updates', () => {
    const other = open();
    for (let i = 0; i < 25; i++) {
      (i % 2 ? store : other).recordContextServed(1);
      (i % 2 ? other : store).upsertNode(node(`note:${i}`));
    }
    expect(store.stats().contextServed).toEqual({ count: 25, tokens: 25 });
    expect(other.listNodes()).toHaveLength(25);
  });
});
