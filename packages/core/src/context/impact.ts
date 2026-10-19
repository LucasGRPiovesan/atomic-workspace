import type { ImpactOf, MemoryStore } from '../contracts.js';
import type { KnowledgeNode, RelKind, TestRecord } from '../types.js';

const MAX_HOPS = 2;
/** parent → child direction edges: impact flows from the child up to whoever contains/implements/governs it */
const UP_RELS = new Set<RelKind>(['contains', 'implements', 'governs']);
const REPORTED_KINDS = new Set(['capability', 'flow', 'rule']);

function moduleFor(store: MemoryStore, path: string): KnowledgeNode | undefined {
  let dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  while (dir) {
    const m = store.getNode(`module:${dir}`);
    if (m) return m;
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }
  return undefined;
}

export const impactOf: ImpactOf = (store, paths) => {
  const pathSet = new Set(paths);
  const found = new Map<string, KnowledgeNode>();
  const add = (n: KnowledgeNode | undefined): void => {
    if (n && !found.has(n.id)) found.set(n.id, n);
  };

  // direct: anchored nodes + deterministic nodes of those files
  if (paths.length) for (const n of store.listNodes({ paths: [...pathSet] })) add(n);
  for (const p of pathSet) {
    add(moduleFor(store, p));
    add(store.getNode(`test_suite:${p}`));
  }
  for (const r of store.routes()) if (pathSet.has(r.path)) add(store.getNode(r.id));
  for (const e of store.entities()) if (pathSet.has(e.path)) add(store.getNode(e.id));

  // traversal ≤ 2 hops towards capabilities / flows / rules
  const direct = [...found.values()];
  let frontier = direct.map((n) => n.id);
  const visited = new Set(frontier);
  for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      const reached: string[] = [];
      for (const e of store.edges({ to: id })) if (UP_RELS.has(e.rel)) reached.push(e.from);
      for (const e of store.edges({ from: id })) if (e.rel === 'step_of') reached.push(e.to);
      for (const rid of reached) {
        if (visited.has(rid)) continue;
        visited.add(rid);
        next.push(rid);
        const n = store.getNode(rid);
        if (n && REPORTED_KINDS.has(n.kind)) add(n);
      }
    }
    frontier = next;
  }

  // tests: test files among the paths + test files importing them
  const testFiles = new Set<string>();
  for (const p of pathSet) {
    if (store.getFile(p)?.isTest) testFiles.add(p);
    for (const imp of store.imports({ resolved: p })) if (store.getFile(imp.from)?.isTest) testFiles.add(imp.from);
  }
  const tests: TestRecord[] = [];
  for (const f of [...testFiles].sort()) tests.push(...store.tests(f));

  return { nodes: [...found.values()], tests };
};
