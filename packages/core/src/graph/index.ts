import type { BuildGraph, MemoryStore } from '../contracts.js';
import { moduleOf } from '../indexer/modules.js';
import type { FlowStep, GraphEdge, GraphNode, GraphView, KnowledgeEdge, KnowledgeNode, NodeKind, RelKind } from '../types.js';

export const MAX_SYSTEM_NODES = 300;
export const MAX_NEIGHBORHOOD_NODES = 60;
const NEIGHBORHOOD_HOPS = 2;

const SYSTEM_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['capability', 'module', 'integration', 'entity', 'flow']);
const SYSTEM_RELS: ReadonlySet<RelKind> = new Set<RelKind>(['contains', 'depends_on', 'uses', 'reads', 'writes', 'implements', 'relates', 'calls', 'step_of']);

const data = (n: KnowledgeNode): Record<string, unknown> => n.data ?? {};

function sublabel(n: KnowledgeNode): string | undefined {
  const d = data(n);
  switch (n.kind) {
    case 'module':
      return typeof d.path === 'string' ? d.path : n.id.slice('module:'.length);
    case 'route':
      return typeof d.method === 'string' && typeof d.pattern === 'string' ? `${d.method} ${d.pattern}` : n.title;
    case 'entity': {
      const count = Array.isArray(d.fields) ? d.fields.length : 0;
      return `${count} ${count === 1 ? 'field' : 'fields'}`;
    }
    case 'integration':
      return typeof d.category === 'string' ? d.category : undefined;
    case 'test_suite':
    case 'component':
      return typeof d.path === 'string' ? d.path : undefined;
    case 'flow': {
      const steps = Array.isArray(d.steps) ? d.steps.length : 0;
      return `${steps} ${steps === 1 ? 'step' : 'steps'}`;
    }
    default:
      return undefined;
  }
}

class Projection {
  readonly nodes: Map<string, KnowledgeNode>;
  readonly edges: KnowledgeEdge[];
  private readonly changed: ReadonlySet<string>;

  constructor(store: MemoryStore, changedNodeIds: readonly string[] | undefined) {
    this.nodes = new Map(store.listNodes().map((n) => [n.id, n]));
    this.edges = store.edges().filter((e) => this.nodes.has(e.from) && this.nodes.has(e.to));
    this.changed = new Set(changedNodeIds);
  }

  graphNode(n: KnowledgeNode, extra?: Partial<GraphNode>): GraphNode {
    const sub = sublabel(n);
    return {
      id: n.id, kind: n.kind, label: n.title, ...(sub !== undefined ? { sublabel: sub } : {}),
      status: n.status, origin: n.origin, changed: this.changed.has(n.id), ...extra,
    };
  }

  /** Edges (deduplicated) whose both ends are in `ids`, optionally restricted to some relations. */
  among(ids: ReadonlySet<string>, rels?: ReadonlySet<RelKind>): GraphEdge[] {
    const seen = new Set<string>();
    const out: GraphEdge[] = [];
    for (const e of this.edges) {
      if (!ids.has(e.from) || !ids.has(e.to) || (rels && !rels.has(e.rel))) continue;
      // `relates` is symmetric and usually stored both ways: draw one edge per pair
      const [a, b] = e.rel === 'relates' && e.to < e.from ? [e.to, e.from] : [e.from, e.to];
      const key = `${a}\0${e.rel}\0${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: e.from, to: e.to, rel: e.rel });
    }
    return out;
  }
}

/** import counts collapsed to module → module, used as `weight` of depends_on edges */
function moduleImportWeights(store: MemoryStore): Map<string, number> {
  const weights = new Map<string, number>();
  for (const i of store.imports()) {
    const from = moduleOf(i.from);
    const to = i.resolved ? moduleOf(i.resolved) : undefined;
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  return weights;
}

function systemGraph(store: MemoryStore, p: Projection): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let ids = new Set([...p.nodes.values()].filter((n) => SYSTEM_KINDS.has(n.kind)).map((n) => n.id));
  const degree = (id: string, within: ReadonlySet<string>): number =>
    p.edges.reduce((sum, e) => sum + (SYSTEM_RELS.has(e.rel) && within.has(e.from) && within.has(e.to) && (e.from === id || e.to === id) ? 1 : 0), 0);

  let hidden = 0;
  if (ids.size > MAX_SYSTEM_NODES) {
    const droppable = [...ids]
      .filter((id) => p.nodes.get(id)?.kind === 'module')
      .map((id) => ({ id, degree: degree(id, ids) }))
      .sort((a, b) => a.degree - b.degree || a.id.localeCompare(b.id));
    for (const { id } of droppable) {
      if (ids.size <= MAX_SYSTEM_NODES) break;
      ids.delete(id);
      hidden++;
    }
    ids = new Set(ids);
  }

  const edges = p.among(ids, SYSTEM_RELS);
  const weights = moduleImportWeights(store);
  for (const e of edges) if (e.rel === 'depends_on') e.weight = weights.get(`${e.from}\0${e.to}`) ?? 1;

  // badges are counted over ALL edges: routes/tests/components are not drawn but still summarised
  const counts = new Map<string, Record<string, Set<string>>>();
  const bump = (id: string, badge: string, other: string): void => {
    const entry = counts.get(id) ?? {};
    (entry[badge] ??= new Set()).add(other);
    counts.set(id, entry);
  };
  const parentOf = new Map<string, string>();
  for (const e of p.edges) {
    const from = p.nodes.get(e.from);
    const to = p.nodes.get(e.to);
    if (!from || !to) continue;
    if ((e.rel === 'contains' || e.rel === 'exposes') && from.kind === 'module') {
      if (to.kind === 'route') bump(from.id, 'routes', to.id);
      else if (to.kind === 'component') bump(from.id, 'components', to.id);
      else if (to.kind === 'test_suite') bump(from.id, 'tests', to.id);
    } else if (e.rel === 'tests' && from.kind === 'test_suite' && (to.kind === 'module' || to.kind === 'capability')) {
      bump(to.id, 'tests', from.id);
    } else if ((e.rel === 'reads' || e.rel === 'writes') && from.kind === 'module' && to.kind === 'entity') {
      bump(from.id, 'entities', to.id);
    } else if (e.rel === 'contains' && from.kind === 'capability' && ids.has(to.id) && !parentOf.has(to.id)) {
      parentOf.set(to.id, from.id);
    }
    // a capability's routes: the ones linked with it directly (any relation, usually route `implements` capability)
    if (from.kind === 'capability' && to.kind === 'route') bump(from.id, 'routes', to.id);
    else if (to.kind === 'capability' && from.kind === 'route') bump(to.id, 'routes', from.id);
  }
  // ...plus the routes of the modules it contains
  for (const e of p.edges) {
    if (e.rel !== 'contains' || p.nodes.get(e.from)?.kind !== 'capability' || p.nodes.get(e.to)?.kind !== 'module') continue;
    for (const route of counts.get(e.to)?.routes ?? []) bump(e.from, 'routes', route);
  }

  const nodes = [...ids].sort().map((id) => {
    const n = p.nodes.get(id) as KnowledgeNode;
    const badges: Record<string, number> = {};
    for (const [badge, set] of Object.entries(counts.get(id) ?? {})) if (set.size > 0) badges[badge] = set.size;
    const parent = parentOf.get(id);
    return p.graphNode(n, { ...(Object.keys(badges).length ? { badges } : {}), ...(parent && ids.has(parent) ? { parent } : {}) });
  });

  if (hidden > 0) {
    const roots = nodes.filter((n) => n.kind === 'capability');
    const pool = roots.length > 0 ? roots : nodes.filter((n) => n.kind === 'module');
    const root = pool.sort((a, b) => degree(b.id, ids) - degree(a.id, ids) || a.id.localeCompare(b.id))[0];
    if (root) root.badges = { ...root.badges, hidden };
  }
  return { nodes, edges };
}

function dataGraph(p: Projection): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const entities = [...p.nodes.values()].filter((n) => n.kind === 'entity').sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(entities.map((n) => n.id));
  return { nodes: entities.map((n) => p.graphNode(n)), edges: p.among(ids, new Set<RelKind>(['relates'])) };
}

function flowGraph(p: Projection, focus: string | undefined): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const flows = focus ? [p.nodes.get(focus)].filter((n): n is KnowledgeNode => n?.kind === 'flow') : [...p.nodes.values()].filter((n) => n.kind === 'flow');
  if (focus === undefined) {
    return { nodes: flows.sort((a, b) => a.id.localeCompare(b.id)).map((n) => p.graphNode(n)), edges: [] };
  }
  const flow = flows[0];
  if (!flow) return { nodes: [], edges: [] };
  const ids = new Set([flow.id]);
  const steps = (Array.isArray(data(flow).steps) ? data(flow).steps : []) as FlowStep[];
  for (const s of steps) if (s.nodeId && p.nodes.has(s.nodeId)) ids.add(s.nodeId);
  for (const e of p.edges) if (e.rel === 'step_of' && e.to === flow.id) ids.add(e.from);
  const edges = p.among(ids);
  for (const s of steps) {
    if (s.nodeId && ids.has(s.nodeId) && !edges.some((e) => e.rel === 'step_of' && e.from === s.nodeId && e.to === flow.id)) {
      edges.push({ from: s.nodeId, to: flow.id, rel: 'step_of' });
    }
  }
  const nodes = [...ids].map((id) => p.nodes.get(id) as KnowledgeNode);
  nodes.sort((a, b) => (a.id === flow.id ? -1 : b.id === flow.id ? 1 : a.id.localeCompare(b.id)));
  return { nodes: nodes.map((n) => p.graphNode(n)), edges };
}

function neighborhoodGraph(p: Projection, focus: string | undefined): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!focus || !p.nodes.has(focus)) return { nodes: [], edges: [] };
  const adjacency = new Map<string, Set<string>>();
  for (const e of p.edges) {
    (adjacency.get(e.from) ?? adjacency.set(e.from, new Set()).get(e.from)!).add(e.to);
    (adjacency.get(e.to) ?? adjacency.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  const ids = new Set([focus]);
  let frontier = [focus];
  for (let hop = 0; hop < NEIGHBORHOOD_HOPS && frontier.length > 0 && ids.size < MAX_NEIGHBORHOOD_NODES; hop++) {
    const next: string[] = [];
    // closer-to-hub nodes first so the cap keeps the most connected neighbours
    const candidates = new Set(frontier.flatMap((id) => [...(adjacency.get(id) ?? [])]).filter((id) => !ids.has(id)));
    const ordered = [...candidates].sort((a, b) => (adjacency.get(b)?.size ?? 0) - (adjacency.get(a)?.size ?? 0) || a.localeCompare(b));
    for (const id of ordered) {
      if (ids.size >= MAX_NEIGHBORHOOD_NODES) break;
      ids.add(id);
      next.push(id);
    }
    frontier = next;
  }
  const nodes = [...ids].map((id) => p.nodes.get(id) as KnowledgeNode);
  nodes.sort((a, b) => (a.id === focus ? -1 : b.id === focus ? 1 : a.id.localeCompare(b.id)));
  return { nodes: nodes.map((n) => p.graphNode(n)), edges: p.among(ids) };
}

export const buildGraph: BuildGraph = (store, view: GraphView, opts) => {
  const p = new Projection(store, opts?.changedNodeIds);
  const focus = opts?.focus;
  const body =
    view === 'system' ? systemGraph(store, p)
      : view === 'data' ? dataGraph(p)
        : view === 'flow' ? flowGraph(p, focus)
          : neighborhoodGraph(p, focus);
  return { view, ...(focus !== undefined ? { focus } : {}), ...body };
};
