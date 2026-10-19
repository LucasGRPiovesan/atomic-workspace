// Pure helpers for the system views: graph filtering, dagre layout wrapper, coverage maths. No React, no DOM.
import dagre from '@dagrejs/dagre';
import type {
  GraphData, GraphEdge, GraphNode, KnowledgeNode, NodeKind, RelKind,
} from '@atomic/core/types';

export interface GraphFilter {
  /** kinds to hide */
  hiddenKinds?: ReadonlySet<NodeKind>;
  /** relations to hide */
  hiddenRels?: ReadonlySet<RelKind>;
}

/** Drops hidden kinds/rels; edges with a missing endpoint go; children of a dropped parent become top level. */
export function filterGraph(data: GraphData, filter: GraphFilter): GraphData {
  const { hiddenKinds, hiddenRels } = filter;
  const nodes = data.nodes.filter((n) => !hiddenKinds?.has(n.kind));
  const ids = new Set(nodes.map((n) => n.id));
  const kept = nodes.map((n) => (n.parent && !ids.has(n.parent) ? { ...n, parent: undefined } : n));
  const edges = data.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && !hiddenRels?.has(e.rel));
  return { ...data, nodes: kept, edges };
}

export interface Size { width: number; height: number }

export interface LayoutOptions {
  direction?: 'LR' | 'TB';
  nodeSize(n: GraphNode): Size;
  /** space between rank levels / siblings */
  rankSep?: number;
  nodeSep?: number;
  /** compound parents: header height and inner padding */
  groupHeader?: number;
  groupPadding?: number;
  /** width/height the auto direction aims for (default 1.4) */
  targetAspect?: number;
}

export interface PlacedNode {
  id: string;
  /** relative to `parent` when set, absolute otherwise */
  x: number;
  y: number;
  width: number;
  height: number;
  parent?: string;
  /** true for nodes that contain children */
  isGroup: boolean;
  /** rank direction the layout used: edges should leave/enter on its axis */
  direction: 'LR' | 'TB';
}

/**
 * Lays out a graph. Compound nodes (those referenced as `parent` by another node) are sized from a grid of their
 * children; dagre only ever sees the top level, with edges lifted to the top-level ancestors.
 * Returned nodes are ordered parents-first, as React Flow requires.
 */
export function layoutGraph(data: GraphData, opts: LayoutOptions): PlacedNode[] {
  const header = opts.groupHeader ?? 30;
  const pad = opts.groupPadding ?? 12;
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const parentOf = (n: GraphNode) => (n.parent && byId.has(n.parent) && n.parent !== n.id ? n.parent : undefined);

  const children = new Map<string, GraphNode[]>();
  for (const n of data.nodes) {
    const p = parentOf(n);
    if (p) children.set(p, [...(children.get(p) ?? []), n]);
  }

  const topOf = (id: string): string => {
    const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const p = parentOf(cur);
      if (!p) return cur.id;
      cur = byId.get(p);
    }
    return id;
  };

  // groups: grid of direct children (nested groups are laid out as plain boxes of their own size)
  const sizes = new Map<string, Size>();
  const inner = new Map<string, Omit<PlacedNode, 'direction'>[]>();
  const sizeOf = (n: GraphNode): Size => {
    const cached = sizes.get(n.id);
    if (cached) return cached;
    const kids = children.get(n.id);
    let size: Size;
    if (!kids?.length) {
      size = opts.nodeSize(n);
    } else {
      const kidSizes = kids.map((k) => sizeOf(k));
      const cols = Math.max(1, Math.ceil(Math.sqrt(kids.length)));
      const cellW = Math.max(...kidSizes.map((s) => s.width));
      const cellH = Math.max(...kidSizes.map((s) => s.height));
      const rows = Math.ceil(kids.length / cols);
      inner.set(n.id, kids.map((k, i) => ({
        id: k.id,
        x: pad + (i % cols) * (cellW + pad),
        y: header + pad + Math.floor(i / cols) * (cellH + pad),
        width: kidSizes[i]!.width,
        height: kidSizes[i]!.height,
        parent: n.id,
        isGroup: children.has(k.id),
      })));
      size = { width: pad + cols * (cellW + pad), height: header + pad + rows * (cellH + pad) };
    }
    sizes.set(n.id, size);
    return size;
  };

  const top = data.nodes.filter((n) => !parentOf(n));
  const place = (rankdir: 'LR' | 'TB'): PlacedNode[] => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir,
      ranksep: opts.rankSep ?? 70,
      nodesep: opts.nodeSep ?? 28,
      marginx: 20,
      marginy: 20,
    });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of top) g.setNode(n.id, { ...sizeOf(n) });
    const seen = new Set<string>();
    for (const e of data.edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      const a = topOf(e.from);
      const b = topOf(e.to);
      const key = `${a}\u0000${b}`;
      if (a === b || seen.has(key)) continue;
      seen.add(key);
      g.setEdge(a, b);
    }
    dagre.layout(g);

    const out: PlacedNode[] = [];
    const emit = (n: GraphNode, x: number, y: number, parent?: string): void => {
      const size = sizeOf(n);
      out.push({ id: n.id, x, y, width: size.width, height: size.height, parent, isGroup: children.has(n.id), direction: rankdir });
      for (const c of inner.get(n.id) ?? []) emit(byId.get(c.id)!, c.x, c.y, n.id);
    };
    for (const n of top) {
      const p = g.node(n.id) as { x: number; y: number };
      const size = sizeOf(n);
      emit(n, Math.round(p.x - size.width / 2), Math.round(p.y - size.height / 2));
    }
    return out;
  };
  if (opts.direction) return place(opts.direction);
  // a long dependency chain laid out left-to-right becomes a thin strip that fit-to-view shrinks unreadably:
  // keep whichever direction gives a shape closer to the canvas
  const aspect = (ps: PlacedNode[]) => {
    const w = Math.max(...ps.map((q) => q.x + q.width)) - Math.min(...ps.map((q) => q.x));
    const h = Math.max(...ps.map((q) => q.y + q.height)) - Math.min(...ps.map((q) => q.y));
    return Math.abs(Math.log(Math.max(w, 1) / Math.max(h, 1) / (opts.targetAspect ?? 1.4)));
  };
  const lr = place('LR');
  if (lr.length < 2) return lr;
  const tb = place('TB');
  return aspect(tb) < aspect(lr) ? tb : lr;
}

/** Edges plus an implicit `contains` edge for every compound parent, so grouping counts as a relation. */
export function edgesWithParents(data: GraphData): GraphEdge[] {
  const ids = new Set(data.nodes.map((n) => n.id));
  const implicit = data.nodes
    .filter((n) => n.parent && ids.has(n.parent))
    .map((n): GraphEdge => ({ from: n.parent!, to: n.id, rel: 'contains' }));
  return [...data.edges, ...implicit];
}

/** Distinct relations present in a graph, for the edge toggles. */
export function relsIn(edges: readonly GraphEdge[]): RelKind[] {
  return [...new Set(edges.map((e) => e.rel))].sort();
}

export function kindsIn(nodes: readonly GraphNode[]): NodeKind[] {
  return [...new Set(nodes.map((n) => n.kind))].sort();
}

// ───────────────────────────── coverage / counts ─────────────────────────────

/** Nodes reachable from `start` over undirected edges within `depth` hops, never crossing another capability. */
export function reach(
  start: string,
  edges: readonly GraphEdge[],
  kindOf: (id: string) => NodeKind | undefined,
  depth = 2,
): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
  }
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (seen.has(nb)) continue;
        const k = kindOf(nb);
        if (k === 'capability' || k === 'instruction') continue;
        seen.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  seen.delete(start);
  return seen;
}

export interface CapabilityCard {
  node: KnowledgeNode;
  routes: number;
  entities: number;
  tests: number;
  integrations: number;
}

export function capabilityCards(
  nodes: readonly KnowledgeNode[],
  edges: readonly GraphEdge[],
  graphNodes: readonly GraphNode[] = [],
): CapabilityCard[] {
  const kinds = new Map(nodes.map((n) => [n.id, n.kind]));
  const lookup = (id: string) => kinds.get(id);
  // the system view folds routes into badges instead of drawing them
  const badges = new Map(graphNodes.map((n) => [n.id, n.badges]));
  return nodes
    .filter((n) => n.kind === 'capability')
    .map((node) => {
      const r = [...reach(node.id, edges, lookup)];
      const count = (k: NodeKind) => r.filter((id) => lookup(id) === k).length;
      const routes = Math.max(count('route'), badges.get(node.id)?.routes ?? 0);
      return { node, routes, entities: count('entity'), tests: count('test_suite'), integrations: count('integration') };
    });
}

export interface Coverage {
  modules: number;
  routes: number;
  undescribedModules: number;
  undescribedRoutes: number;
}

/** How much of the deterministic structure is explained by some capability. */
const COVERED_HOPS = new Set<RelKind>(['exposes', 'contains', 'reads', 'writes']);

export function coverage(nodes: readonly KnowledgeNode[], edges: readonly GraphEdge[]): Coverage {
  // same rule as core findUnmapped: directly linked with a capability/flow, or one exposes/contains/reads/writes hop below one
  const kinds = new Map(nodes.map((n) => [n.id, n.kind]));
  const covering = (id: string) => { const k = kinds.get(id); return k === 'capability' || k === 'flow'; };
  const covered = new Set<string>();
  for (const e of edges) {
    if (covering(e.from)) covered.add(e.to);
    if (covering(e.to)) covered.add(e.from);
  }
  for (const e of edges) if (COVERED_HOPS.has(e.rel) && covered.has(e.from)) covered.add(e.to);
  const mods = nodes.filter((n) => n.kind === 'module');
  const routes = nodes.filter((n) => n.kind === 'route');
  return {
    modules: mods.length,
    routes: routes.length,
    undescribedModules: mods.filter((n) => !covered.has(n.id)).length,
    undescribedRoutes: routes.filter((n) => !covered.has(n.id)).length,
  };
}

/** Routes grouped by the module that exposes them (module title → count), largest first. */
export function routesByModule(
  nodes: readonly KnowledgeNode[],
  edges: readonly GraphEdge[],
  graphNodes: readonly GraphNode[] = [],
): { module: string; routes: number }[] {
  const titles = new Map(nodes.map((n) => [n.id, n]));
  const counts = new Map<string, number>();
  // the system view folds module routes into badges; drawn route nodes (and their edges) are the fallback
  for (const g of graphNodes) if (g.kind === 'module' && g.badges?.routes) counts.set(titles.get(g.id)?.title ?? g.label, g.badges.routes);
  if (counts.size) return [...counts].map(([module, routes]) => ({ module, routes })).sort((a, b) => b.routes - a.routes);
  const seen = new Set<string>();
  for (const e of edges) {
    // the indexer emits both exposes and contains for module→route, and the system view folds exposes into parents
    if (e.rel !== 'exposes' && e.rel !== 'contains') continue;
    const m = titles.get(e.from);
    if (m?.kind !== 'module' || titles.get(e.to)?.kind !== 'route' || seen.has(`${e.from}>${e.to}`)) continue;
    seen.add(`${e.from}>${e.to}`);
    counts.set(m.title, (counts.get(m.title) ?? 0) + 1);
  }
  return [...counts].map(([module, routes]) => ({ module, routes })).sort((a, b) => b.routes - a.routes);
}

/** Text + kind/origin/status filter used by the memory table. */
export interface NodeQuery {
  text?: string;
  kinds?: ReadonlySet<NodeKind>;
  origins?: ReadonlySet<KnowledgeNode['origin']>;
  statuses?: ReadonlySet<KnowledgeNode['status']>;
}

export function filterNodes(nodes: readonly KnowledgeNode[], q: NodeQuery): KnowledgeNode[] {
  const t = q.text?.trim().toLowerCase();
  return nodes.filter((n) => {
    if (q.kinds?.size && !q.kinds.has(n.kind)) return false;
    if (q.origins?.size && !q.origins.has(n.origin)) return false;
    if (q.statuses?.size && !q.statuses.has(n.status)) return false;
    if (t && !`${n.title} ${n.summary} ${n.id} ${n.tags.join(' ')}`.toLowerCase().includes(t)) return false;
    return true;
  });
}

export function groupBy<T, K extends string>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}
