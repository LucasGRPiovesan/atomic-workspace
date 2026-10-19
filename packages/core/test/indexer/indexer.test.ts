import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extractions: string[] = [];

vi.mock('../../src/extract/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/extract/index.js')>();
  return {
    ...actual,
    extractFile: ((path, content, known) => {
      extractions.push(path);
      return actual.extractFile(path, content, known);
    }) as typeof actual.extractFile,
  };
});

import { createIndexer } from '../../src/indexer/index.js';
import { openStore } from '../../src/store/index.js';
import type { Indexer, MemoryStore } from '../../src/contracts.js';
import type { ChangeSet } from '../../src/types.js';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/shop-app');

let root: string;
let store: MemoryStore;
let indexer: Indexer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomic-indexer-'));
  await cp(FIXTURE, root, { recursive: true, filter: (src) => !src.includes('node_modules') });
  store = openStore(root);
  indexer = createIndexer(store);
  extractions.length = 0;
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

const ids = (kind: string): string[] => store.listNodes({ kinds: [kind as never] }).map((n) => n.id);

describe('indexer.sync', () => {
  it('builds the deterministic layer from the fixture', async () => {
    const started = performance.now();
    const cs = await indexer.sync();
    const elapsed = Math.round(performance.now() - started);
    console.log(`[indexer] fixture sync: ${elapsed} ms, ${store.listFiles().length} files, ${extractions.length} extractions, ${store.listNodes().length} nodes`);

    expect(cs.source).toBe('index');
    expect(cs.files.length).toBeGreaterThan(10);

    const modules = ids('module');
    for (const m of ['module:src/catalog', 'module:src/cart', 'module:src/orders', 'module:src/payments']) expect(modules).toContain(m);

    const route = store.getNode('route:POST /api/orders');
    expect(route).toBeDefined();
    expect(route?.origin).toBe('deterministic');
    expect(store.edges({ from: 'module:src/orders', to: 'route:POST /api/orders' }).map((e) => e.rel)).toContain('contains');

    const entities = ids('entity');
    expect(entities.length).toBeGreaterThan(2);
    expect(store.edges({ rel: 'relates' }).length).toBeGreaterThan(0);

    expect(ids('integration')).toContain('integration:stripe');

    const suites = ids('test_suite');
    expect(suites.length).toBeGreaterThan(0);
    expect(store.edges({ rel: 'tests' }).length).toBeGreaterThan(0);

    expect(store.listNodes({ origin: ['imported'] }).length).toBeGreaterThan(0);
    expect(indexer.stack()).toBeDefined();
  });

  it('reports progress through the phases', async () => {
    const phases = new Set<string>();
    await indexer.sync((p) => phases.add(p.phase));
    expect(phases.has('scan')).toBe(true);
    expect(phases.has('extract')).toBe(true);
    expect(phases.has('done')).toBe(true);
  });

  it('second sync extracts nothing and changes nothing', async () => {
    await indexer.sync();
    extractions.length = 0;
    const nodesBefore = store.listNodes().length;
    const cs = await indexer.sync();
    expect(extractions).toEqual([]);
    expect(cs.files).toEqual([]);
    expect(store.listNodes().length).toBe(nodesBefore);
  });

  it('persists the detected stack under meta "stack" and serves it after a reopen without sync', async () => {
    await indexer.sync();
    const stack = indexer.stack();
    expect(stack).toBeDefined();
    expect(JSON.parse(store.getMeta('stack') ?? 'null')).toEqual(stack);
    store.close();
    store = openStore(root);
    expect(createIndexer(store).stack()).toEqual(stack);
  });

  it('gives route nodes the data the desktop tracer needs', async () => {
    await indexer.sync();
    const data = store.getNode('route:POST /api/orders')?.data ?? {};
    expect(data).toMatchObject({ method: 'POST', pattern: '/api/orders', framework: expect.any(String), path: 'src/orders/routes.ts' });
    expect(data.line).toEqual(expect.any(Number));
    // inline handlers have neither (RouteRecord.handler/handlerSymbolId are optional), so the keys are absent
    const route = store.routes().find((r) => r.method === 'POST' && r.path === 'src/orders/routes.ts');
    expect(data.handler).toEqual(route?.handler);
    expect(data.handlerSymbolId).toEqual(route?.handlerSymbolId);
  });

  it('survives a reopened store without re-extracting', async () => {
    await indexer.sync();
    store.close();
    store = openStore(root);
    indexer = createIndexer(store);
    extractions.length = 0;
    await indexer.sync();
    expect(extractions).toEqual([]);
  });
});

describe('indexer.apply', () => {
  it('re-extracts only the edited file and stales anchored agent nodes', async () => {
    await indexer.sync();
    const file = store.getFile('src/orders/pricing.ts');
    expect(file).toBeDefined();
    store.upsertNode({
      id: 'decision:pricing-rounding', kind: 'decision', title: 'Pricing rounds half up', summary: 'agent note',
      origin: 'agent', confidence: 0.8, anchors: [{ path: 'src/orders/pricing.ts', hash: file!.hash }],
    });
    expect(store.getNode('decision:pricing-rounding')?.status).toBe('fresh');

    await appendFile(join(root, 'src/orders/pricing.ts'), '\nexport const EDITED_MARKER = 1;\n');
    extractions.length = 0;
    const cs = await indexer.apply(['src/orders/pricing.ts'], { source: 'agent', agentId: 'claude' });

    expect(extractions).toContain('src/orders/pricing.ts');
    expect(extractions.filter((p) => p !== 'src/orders/pricing.ts').every((p) => p.startsWith('src/orders'))).toBe(true);
    expect(extractions.length).toBeLessThan(6);
    expect(cs.source).toBe('agent');
    expect(cs.agentId).toBe('claude');
    expect(cs.files).toEqual([{ path: 'src/orders/pricing.ts', status: 'modified' }]);
    expect(cs.staleNodes).toContain('decision:pricing-rounding');
    expect(cs.affectedNodes).toContain('decision:pricing-rounding');
    expect(store.getNode('decision:pricing-rounding')?.status).toBe('stale');
    expect(store.symbolsInFile('src/orders/pricing.ts').map((s) => s.name)).toContain('EDITED_MARKER');
    expect(store.listChanges(1)[0]?.id).toBe(cs.id);
  });

  it('keeps agent nodes and edges when the deterministic layer is rebuilt', async () => {
    await indexer.sync();
    store.upsertNode({ id: 'decision:keep', kind: 'decision', title: 'Keep me', summary: 's', origin: 'agent', confidence: 0.5, anchors: [] });
    store.upsertEdge({ from: 'decision:keep', to: 'module:src/orders', rel: 'governs', origin: 'agent' });
    await appendFile(join(root, 'src/orders/routes.ts'), '\n// touched\n');
    await indexer.apply(['src/orders/routes.ts']);
    expect(store.getNode('decision:keep')).toBeDefined();
    expect(store.edges({ from: 'decision:keep', to: 'module:src/orders', rel: 'governs' })).toHaveLength(1);
  });

  it('removes rows and nodes of a deleted file', async () => {
    await indexer.sync();
    expect(store.getNode('test_suite:src/orders/orders.test.ts') ?? store.getNode('test_suite:test/orders.test.ts')).toBeDefined();
    const target = store.listFiles().find((f) => f.path.endsWith('orders.test.ts'))!.path;
    await rm(join(root, target));
    const cs = await indexer.apply([target]);
    expect(cs.files).toEqual([{ path: target, status: 'deleted' }]);
    expect(store.getFile(target)).toBeUndefined();
    expect(store.symbolsInFile(target)).toEqual([]);
    expect(store.getNode(`test_suite:${target}`)).toBeUndefined();
  });

  it('picks up a brand new file', async () => {
    await indexer.sync();
    await writeFile(join(root, 'src/orders/refund.ts'), 'export function refundOrder(id: string) { return id; }\n');
    const cs = await indexer.apply(['src/orders/refund.ts']);
    expect(cs.files).toEqual([{ path: 'src/orders/refund.ts', status: 'added' }]);
    expect(store.symbolsInFile('src/orders/refund.ts').map((s) => s.name)).toContain('refundOrder');
  });

  it('ignores paths that are skipped (node_modules, .atomic)', async () => {
    await indexer.sync();
    extractions.length = 0;
    const cs = await indexer.apply(['node_modules/x/index.js', '.atomic/memory.db']);
    expect(cs.files).toEqual([]);
    expect(extractions).toEqual([]);
  });
});

describe('indexer.watch', () => {
  it('reports a written file within 2s', async () => {
    await indexer.sync();
    const seen: ChangeSet[] = [];
    const stop = indexer.watch((cs) => seen.push(cs));
    try {
      await new Promise((r) => setTimeout(r, 600));
      const wrote = performance.now();
      await writeFile(join(root, 'src/orders/watched.ts'), 'export const watched = true;\n');
      await vi.waitFor(() => expect(seen.some((cs) => cs.files.some((f) => f.path === 'src/orders/watched.ts'))).toBe(true), { timeout: 2000, interval: 50 });
      console.log(`[indexer] watch latency: ${Math.round(performance.now() - wrote)} ms`);
      expect(seen[0]?.source).toBe('external');
    } finally {
      stop();
    }
  });
});
