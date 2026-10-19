import type { MemoryStore } from '../contracts.js';
import type { KnowledgeNode } from '../types.js';

const COVERING = new Set(['capability', 'flow']);
const COVERED_HOPS = new Set(['exposes', 'contains', 'reads', 'writes']);

export interface Unmapped {
  modules: KnowledgeNode[];
  routes: KnowledgeNode[];
  entities: KnowledgeNode[];
}

/**
 * Deterministic modules/routes/entities that no capability or flow reaches. A node is covered when an edge
 * links it directly with a capability/flow, or when a covered node `exposes`/`contains` it (one hop).
 */
export function findUnmapped(store: MemoryStore): Unmapped {
  const kindOf = new Map<string, string>();
  const deterministic = store.listNodes({ origin: ['deterministic'], kinds: ['module', 'route', 'entity'] });
  for (const n of deterministic) kindOf.set(n.id, n.kind);
  for (const n of store.listNodes({ kinds: ['capability', 'flow'] })) kindOf.set(n.id, n.kind);

  const edges = store.edges();
  const covered = new Set<string>();
  for (const e of edges) {
    if (COVERING.has(kindOf.get(e.from) ?? '')) covered.add(e.to);
    if (COVERING.has(kindOf.get(e.to) ?? '')) covered.add(e.from);
  }
  for (const e of edges) {
    if (COVERED_HOPS.has(e.rel) && covered.has(e.from)) covered.add(e.to);
  }
  const open = (kind: string): KnowledgeNode[] => deterministic.filter((n) => n.kind === kind && !covered.has(n.id));
  return { modules: open('module'), routes: open('route'), entities: open('entity') };
}
