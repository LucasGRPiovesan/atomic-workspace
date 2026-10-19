import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, MAX_NEIGHBORHOOD_NODES, MAX_SYSTEM_NODES } from '../../src/graph/index.js';
import { createIndexer } from '../../src/indexer/index.js';
import { openStore } from '../../src/store/index.js';
import type { MemoryStore } from '../../src/contracts.js';
import type { FlowStep, KnowledgeNodeInput, NodeKind } from '../../src/types.js';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/shop-app');

let root: string;
let store: MemoryStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomic-graph-'));
  store = openStore(root);
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

const node = (id: string, kind: NodeKind, extra: Partial<KnowledgeNodeInput> = {}): KnowledgeNodeInput => ({
  id, kind, title: id, summary: id, origin: 'deterministic', confidence: 1, anchors: [], ...extra,
});

describe('buildGraph on the indexed fixture', () => {
  beforeEach(async () => {
    await cp(FIXTURE, root, { recursive: true, filter: (src) => !src.includes('node_modules') });
    await createIndexer(store).sync();
  });

  it('system view: modules and integrations, routes folded into badges', () => {
    const g = buildGraph(store, 'system');
    expect(g.view).toBe('system');
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.has('module:src/orders')).toBe(true);
    expect(byId.has('integration:stripe')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'route' || n.kind === 'test_suite')).toBe(false);

    const orders = byId.get('module:src/orders')!;
    expect(orders.label).toBeTruthy();
    expect(orders.sublabel).toBe('src/orders');
    expect(orders.origin).toBe('deterministic');
    expect(orders.badges?.routes).toBeGreaterThan(0);
    expect(orders.badges?.tests).toBeGreaterThan(0);

    for (const e of g.edges) {
      expect(byId.has(e.from)).toBe(true);
      expect(byId.has(e.to)).toBe(true);
    }
    expect(g.edges.some((e) => e.rel === 'depends_on' && (e.weight ?? 0) >= 1)).toBe(true);
    expect(g.edges.some((e) => e.rel === 'uses' && e.to === 'integration:stripe')).toBe(true);
  });

  it('badges a capability with its direct routes and the routes of modules it contains', () => {
    const routes = store.listNodes({ kinds: ['route'] });
    const ordersRoutes = buildGraph(store, 'system').nodes.find((n) => n.id === 'module:src/orders')!.badges!.routes!;
    const outside = routes.find((r) => !r.id.includes('/orders'))!;
    store.upsertNode(node('capability:checkout', 'capability', { origin: 'agent' }));
    store.upsertEdge({ from: 'capability:checkout', to: 'module:src/orders', rel: 'contains', origin: 'agent' });
    store.upsertEdge({ from: outside.id, to: 'capability:checkout', rel: 'implements', origin: 'agent' });
    const cap = buildGraph(store, 'system').nodes.find((n) => n.id === 'capability:checkout')!;
    expect(cap.badges?.routes).toBe(ordersRoutes + 1);
  });

  it('marks changed nodes', () => {
    const g = buildGraph(store, 'system', { changedNodeIds: ['module:src/orders'] });
    expect(g.nodes.find((n) => n.id === 'module:src/orders')?.changed).toBe(true);
    expect(g.nodes.find((n) => n.id === 'module:src/cart')?.changed).toBe(false);
  });

  it('data view: entities and relates edges with field-count sublabel', () => {
    const g = buildGraph(store, 'data');
    expect(g.nodes.length).toBeGreaterThan(2);
    expect(g.nodes.every((n) => n.kind === 'entity')).toBe(true);
    expect(g.nodes.every((n) => /^\d+ fields?$/.test(n.sublabel ?? ''))).toBe(true);
    expect(g.edges.length).toBeGreaterThan(0);
    expect(g.edges.every((e) => e.rel === 'relates')).toBe(true);
    const pairs = g.edges.map((e) => [e.from, e.to].sort().join('|'));
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('neighborhood view: route reaches its module within two hops', () => {
    const g = buildGraph(store, 'neighborhood', { focus: 'route:POST /api/orders' });
    expect(g.focus).toBe('route:POST /api/orders');
    expect(g.nodes[0]?.id).toBe('route:POST /api/orders');
    expect(g.nodes[0]?.sublabel).toBe('POST /api/orders');
    expect(g.nodes.map((n) => n.id)).toContain('module:src/orders');
  });

  it('shows agent nodes with their origin and status', () => {
    store.upsertNode(node('decision:x', 'decision', { origin: 'agent' }));
    store.upsertEdge({ from: 'decision:x', to: 'module:src/orders', rel: 'governs', origin: 'agent' });
    const g = buildGraph(store, 'neighborhood', { focus: 'module:src/orders' });
    const x = g.nodes.find((n) => n.id === 'decision:x');
    expect(x?.origin).toBe('agent');
    expect(x?.status).toBe('unverified');
  });
});

describe('buildGraph on synthetic stores', () => {
  it('flow view: flow node plus the nodes its steps pass through', () => {
    store.upsertNode(node('module:a', 'module'));
    store.upsertNode(node('module:b', 'module'));
    store.upsertNode(node('module:unrelated', 'module'));
    const steps: FlowStep[] = [
      { order: 1, title: 'a', nodeId: 'module:a' },
      { order: 2, title: 'b', nodeId: 'module:b' },
      { order: 3, title: 'ghost', nodeId: 'module:missing' },
    ];
    store.upsertNode(node('flow:checkout', 'flow', { origin: 'agent', data: { steps } }));
    store.upsertEdge({ from: 'module:a', to: 'flow:checkout', rel: 'step_of', origin: 'agent' });

    const g = buildGraph(store, 'flow', { focus: 'flow:checkout' });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['flow:checkout', 'module:a', 'module:b']);
    expect(g.nodes[0]?.id).toBe('flow:checkout');
    expect(g.edges.filter((e) => e.rel === 'step_of').map((e) => e.from).sort()).toEqual(['module:a', 'module:b']);
  });

  it('flow view: unknown or non-flow focus yields an empty graph', () => {
    store.upsertNode(node('module:a', 'module'));
    expect(buildGraph(store, 'flow', { focus: 'module:a' }).nodes).toEqual([]);
    expect(buildGraph(store, 'flow', { focus: 'flow:nope' }).nodes).toEqual([]);
  });

  it('system view: nodes contained by a capability get a parent', () => {
    store.upsertNode(node('capability:billing', 'capability', { origin: 'agent' }));
    store.upsertNode(node('module:pay', 'module'));
    store.upsertEdge({ from: 'capability:billing', to: 'module:pay', rel: 'contains', origin: 'agent' });
    const g = buildGraph(store, 'system');
    expect(g.nodes.find((n) => n.id === 'module:pay')?.parent).toBe('capability:billing');
    expect(g.nodes.find((n) => n.id === 'capability:billing')?.parent).toBeUndefined();
  });

  it('system view: caps at 300 nodes, dropping the lowest-degree modules and flagging the root', () => {
    store.transaction(() => {
      store.upsertNode(node('capability:root', 'capability', { origin: 'agent' }));
      for (let i = 0; i < 350; i++) store.upsertNode(node(`module:m${String(i).padStart(3, '0')}`, 'module'));
      // m000..m099 are connected; the other 250 are isolated and should go first
      for (let i = 0; i < 100; i++) {
        const id = `module:m${String(i).padStart(3, '0')}`;
        store.upsertEdge({ from: 'capability:root', to: id, rel: 'contains', origin: 'agent' });
        if (i > 0) store.upsertEdge({ from: id, to: 'module:m000', rel: 'depends_on', origin: 'deterministic' });
      }
    });
    const g = buildGraph(store, 'system');
    expect(g.nodes.length).toBe(MAX_SYSTEM_NODES);
    const kept = new Set(g.nodes.map((n) => n.id));
    for (let i = 0; i < 100; i++) expect(kept.has(`module:m${String(i).padStart(3, '0')}`)).toBe(true);
    expect(g.nodes.find((n) => n.id === 'capability:root')?.badges?.hidden).toBe(51);
    for (const e of g.edges) expect(kept.has(e.from) && kept.has(e.to)).toBe(true);
  });

  it('neighborhood view: two hops, all relations, capped at 60 nodes', () => {
    store.upsertNode(node('module:hub', 'module'));
    store.upsertNode(node('module:far', 'module'));
    store.upsertNode(node('module:too-far', 'module'));
    store.upsertEdge({ from: 'module:hub', to: 'module:far', rel: 'depends_on', origin: 'deterministic' });
    store.upsertEdge({ from: 'module:far', to: 'module:too-far', rel: 'depends_on', origin: 'deterministic' });
    store.upsertNode(node('integration:x', 'integration'));
    store.upsertNode(node('module:near', 'module'));
    store.upsertEdge({ from: 'module:near', to: 'module:hub', rel: 'depends_on', origin: 'deterministic' });
    store.upsertEdge({ from: 'module:hub', to: 'integration:x', rel: 'uses', origin: 'deterministic' });

    let g = buildGraph(store, 'neighborhood', { focus: 'module:hub' });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['integration:x', 'module:far', 'module:hub', 'module:near', 'module:too-far']);
    store.deleteNode('module:too-far');
    g = buildGraph(store, 'neighborhood', { focus: 'module:near' });
    expect(g.nodes.map((n) => n.id)).not.toContain('module:too-far');

    for (let i = 0; i < 100; i++) {
      store.upsertNode(node(`module:leaf${i}`, 'module'));
      store.upsertEdge({ from: 'module:hub', to: `module:leaf${i}`, rel: 'depends_on', origin: 'deterministic' });
    }
    g = buildGraph(store, 'neighborhood', { focus: 'module:hub' });
    expect(g.nodes.length).toBe(MAX_NEIGHBORHOOD_NODES);
    expect(g.nodes[0]?.id).toBe('module:hub');
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });

  it('neighborhood view: unknown focus is empty; empty store gives empty graphs', () => {
    expect(buildGraph(store, 'neighborhood', { focus: 'module:nope' }).nodes).toEqual([]);
    expect(buildGraph(store, 'neighborhood').nodes).toEqual([]);
    expect(buildGraph(store, 'system')).toMatchObject({ view: 'system', nodes: [], edges: [] });
    expect(buildGraph(store, 'data')).toMatchObject({ view: 'data', nodes: [], edges: [] });
  });
});
