import { describe, expect, it } from 'vitest';
import type { GraphData, GraphNode, KnowledgeNode } from '@atomic/core/types';
import {
  capabilityCards, coverage, edgesWithParents, filterGraph, filterNodes, layoutGraph, reach, routesByModule,
} from './graph-utils';

const gn = (id: string, kind: GraphNode['kind'], parent?: string): GraphNode => ({
  id, kind, label: id, status: 'fresh', origin: 'deterministic', parent,
});
const kn = (id: string, kind: KnowledgeNode['kind'], extra: Partial<KnowledgeNode> = {}): KnowledgeNode => ({
  id, kind, title: id, summary: `about ${id}`, origin: 'deterministic', status: 'fresh', confidence: 1,
  anchors: [], tags: [], createdAt: '', updatedAt: '', ...extra,
});

const data: GraphData = {
  view: 'system',
  nodes: [
    gn('capability:checkout', 'capability'),
    gn('module:orders', 'module'),
    gn('route:POST /orders', 'route', 'module:orders'),
    gn('route:GET /orders/:id', 'route', 'module:orders'),
    gn('entity:Order', 'entity'),
    gn('integration:stripe', 'integration'),
  ],
  edges: [
    { from: 'capability:checkout', to: 'module:orders', rel: 'contains' },
    { from: 'module:orders', to: 'route:POST /orders', rel: 'exposes' },
    { from: 'module:orders', to: 'route:GET /orders/:id', rel: 'exposes' },
    { from: 'module:orders', to: 'entity:Order', rel: 'writes' },
    { from: 'module:orders', to: 'integration:stripe', rel: 'uses' },
  ],
};

describe('filterGraph', () => {
  it('hides kinds, dangling edges and orphaned parents', () => {
    const out = filterGraph(data, { hiddenKinds: new Set(['module']) });
    expect(out.nodes.map((n) => n.id)).not.toContain('module:orders');
    expect(out.nodes.find((n) => n.id === 'route:POST /orders')?.parent).toBeUndefined();
    expect(out.edges).toEqual([]);
  });

  it('hides relations only', () => {
    const out = filterGraph(data, { hiddenRels: new Set(['uses', 'writes']) });
    expect(out.edges.map((e) => e.rel).sort()).toEqual(['contains', 'exposes', 'exposes']);
    expect(out.nodes).toHaveLength(data.nodes.length);
  });
});

describe('edgesWithParents', () => {
  it('adds a contains edge per compound child', () => {
    const e = edgesWithParents(data);
    expect(e).toHaveLength(data.edges.length + 2);
    expect(e).toContainEqual({ from: 'module:orders', to: 'route:POST /orders', rel: 'contains' });
  });
});

describe('layoutGraph', () => {
  const size = () => ({ width: 100, height: 40 });

  it('places every node once, parents first, children relative to their group', () => {
    const placed = layoutGraph(data, { nodeSize: size });
    expect(placed.map((p) => p.id).sort()).toEqual(data.nodes.map((n) => n.id).sort());
    const idx = (id: string) => placed.findIndex((p) => p.id === id);
    expect(idx('module:orders')).toBeLessThan(idx('route:POST /orders'));
    const group = placed.find((p) => p.id === 'module:orders')!;
    const child = placed.find((p) => p.id === 'route:POST /orders')!;
    expect(group.isGroup).toBe(true);
    expect(child.parent).toBe('module:orders');
    expect(child.x + child.width).toBeLessThanOrEqual(group.width);
    expect(child.y + child.height).toBeLessThanOrEqual(group.height);
  });

  it('ranks left to right along edges', () => {
    const placed = layoutGraph(data, { nodeSize: size, direction: 'LR' });
    const x = (id: string) => placed.find((p) => p.id === id)!.x;
    expect(x('capability:checkout')).toBeLessThan(x('module:orders'));
    expect(x('module:orders')).toBeLessThan(x('entity:Order'));
  });

  it('survives cycles, self edges, unknown endpoints and a parent cycle', () => {
    const odd: GraphData = {
      view: 'system',
      nodes: [gn('a', 'module', 'b'), gn('b', 'module', 'a'), gn('c', 'module', 'c')],
      edges: [{ from: 'a', to: 'a', rel: 'depends_on' }, { from: 'c', to: 'zzz', rel: 'calls' }, { from: 'c', to: 'a', rel: 'calls' }],
    };
    expect(() => layoutGraph(odd, { nodeSize: size })).not.toThrow();
  });

  it('stays fast for ~300 nodes', () => {
    const nodes = Array.from({ length: 300 }, (_, i) => gn(`n${i}`, 'component'));
    const edges = nodes.slice(1).map((n, i) => ({ from: `n${Math.floor(i / 3)}`, to: n.id, rel: 'calls' as const }));
    const t = performance.now();
    const placed = layoutGraph({ view: 'system', nodes, edges }, { nodeSize: size });
    expect(placed).toHaveLength(300);
    expect(performance.now() - t).toBeLessThan(3000);
  });
});

describe('capability coverage', () => {
  const nodes = [
    kn('capability:checkout', 'capability'),
    kn('module:orders', 'module'),
    kn('module:users', 'module'),
    kn('route:POST /orders', 'route'),
    kn('route:GET /me', 'route'),
    kn('entity:Order', 'entity'),
    kn('test_suite:t', 'test_suite'),
    kn('integration:stripe', 'integration'),
  ];
  const edges = [
    ...data.edges.filter((e) => e.to !== 'route:GET /orders/:id'),
    { from: 'module:users', to: 'route:GET /me', rel: 'exposes' as const },
    { from: 'test_suite:t', to: 'module:orders', rel: 'tests' as const },
  ];

  it('counts linked routes, entities, tests and integrations per capability', () => {
    const [card] = capabilityCards(nodes, edges);
    expect(card).toMatchObject({ routes: 1, entities: 1, tests: 1, integrations: 1 });
  });

  it('reports what no capability describes', () => {
    expect(coverage(nodes, edges)).toEqual({ modules: 2, routes: 2, undescribedModules: 1, undescribedRoutes: 1 });
  });

  it('does not cross into another capability', () => {
    const kinds = new Map<string, GraphNode['kind']>([['a', 'capability'], ['m', 'module'], ['b', 'capability'], ['x', 'route']]);
    const r = reach('a', [
      { from: 'a', to: 'm', rel: 'contains' }, { from: 'm', to: 'b', rel: 'implements' }, { from: 'b', to: 'x', rel: 'contains' },
    ], (id) => kinds.get(id), 3);
    expect([...r]).toEqual(['m']);
  });

  it('counts routes folded into module parents once (contains, with or without exposes)', () => {
    const folded = [
      { from: 'module:users', to: 'route:GET /me', rel: 'contains' as const },
      { from: 'module:users', to: 'route:GET /me', rel: 'exposes' as const },
      { from: 'module:orders', to: 'route:POST /orders', rel: 'contains' as const },
    ];
    expect(routesByModule(nodes, folded)).toEqual([{ module: 'module:users', routes: 1 }, { module: 'module:orders', routes: 1 }]);
  });

  it('covers a route through its capability but not its sibling modules', () => {
    const e = [
      { from: 'route:POST /orders', to: 'capability:checkout', rel: 'implements' as const },
      { from: 'module:orders', to: 'route:POST /orders', rel: 'contains' as const },
      { from: 'module:users', to: 'route:GET /me', rel: 'contains' as const },
    ];
    expect(coverage(nodes, e)).toEqual({ modules: 2, routes: 2, undescribedModules: 2, undescribedRoutes: 1 });
  });

  it('groups routes by module', () => {
    expect(routesByModule(nodes, edges)).toEqual([{ module: 'module:orders', routes: 1 }, { module: 'module:users', routes: 1 }]
      .sort((a, b) => b.routes - a.routes));
  });
});

describe('filterNodes', () => {
  const nodes = [
    kn('rule:a', 'rule', { origin: 'agent', status: 'stale', title: 'Cancel only within 24h' }),
    kn('note:b', 'note', { origin: 'user', tags: ['billing'] }),
  ];
  it('filters by text, kind, origin and status together', () => {
    expect(filterNodes(nodes, { text: 'CANCEL' }).map((n) => n.id)).toEqual(['rule:a']);
    expect(filterNodes(nodes, { text: 'billing' }).map((n) => n.id)).toEqual(['note:b']);
    expect(filterNodes(nodes, { statuses: new Set(['stale']), origins: new Set(['agent']) })).toHaveLength(1);
    expect(filterNodes(nodes, { kinds: new Set(['note']), statuses: new Set(['stale']) })).toHaveLength(0);
    expect(filterNodes(nodes, {})).toHaveLength(2);
  });
});
