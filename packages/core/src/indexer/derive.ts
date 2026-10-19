import { posix } from 'node:path';
import type { MemoryStore } from '../contracts.js';
import type {
  EntityRecord, FileRecord, ImportRecord, KnowledgeEdge, KnowledgeNode, KnowledgeNodeInput, RelKind,
} from '../types.js';
import { joinPattern, type Mount } from './mounts.js';
import { moduleDir, moduleOf, moduleTitle } from './modules.js';

export interface Layer {
  nodes: KnowledgeNodeInput[];
  edges: KnowledgeEdge[];
}

const COMPONENT_FILE = /\.(?:tsx|jsx|vue|svelte)$/;
const COMPONENT_KINDS = new Set(['function', 'class', 'component', 'variable']);
const PASCAL_CASE = /^[A-Z][a-z0-9]\w*$/;
const TEST_FILE_NAME = /(?:\.test|\.spec)\.[^/]+$|_test\.go$|(?:^|\/)test_[^/]+\.py$/;

const det = (node: Omit<KnowledgeNodeInput, 'origin' | 'anchors'>): KnowledgeNodeInput => ({ ...node, origin: 'deterministic', anchors: [] });

function packageOfSpecifier(detail: string): string | undefined {
  const dep = detail.match(/^dependency\s+(\S+)/)?.[1] ?? detail.match(/^import\s+['"]([^'"]+)['"]/)?.[1];
  if (!dep) return undefined;
  const at = dep.indexOf('@', dep.startsWith('@') ? 1 : 0);
  return at > 0 ? dep.slice(0, at) : dep;
}

/** Router file → the (parent file, prefix) pairs that mount it, resolved through the parent's imports. */
function resolveMounts(
  mounts: ReadonlyMap<string, Mount[]>,
  importsByFrom: ReadonlyMap<string, ImportRecord[]>,
): Map<string, { parent: string; prefix: string }[]> {
  const parents = new Map<string, { parent: string; prefix: string }[]>();
  for (const [file, list] of mounts) {
    const imports = importsByFrom.get(file) ?? [];
    for (const { prefix, ident } of list) {
      const target = imports.find((i) => i.resolved && i.names.includes(ident))?.resolved;
      if (!target || target === file) continue;
      const bucket = parents.get(target) ?? [];
      if (!bucket.some((p) => p.parent === file && p.prefix === prefix)) bucket.push({ parent: file, prefix });
      parents.set(target, bucket);
    }
  }
  return parents;
}

function prefixesOf(
  file: string,
  parents: ReadonlyMap<string, { parent: string; prefix: string }[]>,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const mountedBy = (parents.get(file) ?? []).filter((p) => !seen.has(p.parent));
  if (mountedBy.length === 0) return [''];
  const next = new Set(seen).add(file);
  const out = new Set<string>();
  for (const { parent, prefix } of mountedBy) {
    for (const outer of prefixesOf(parent, parents, next)) out.add(joinPattern(outer, prefix) === '/' ? '' : joinPattern(outer, prefix));
  }
  return [...out];
}

function mergeEntities(records: EntityRecord[]): EntityRecord & { sources: { source: string; path: string; line: number }[] } {
  // schema-first: prisma/sql definitions are the most complete
  const ordered = [...records].sort((a, b) => Number(/^(prisma|sql)$/.test(b.source)) - Number(/^(prisma|sql)$/.test(a.source)));
  const fields = new Map<string, EntityRecord['fields'][number]>();
  const relations = new Map<string, EntityRecord['relations'][number]>();
  for (const r of ordered) {
    for (const f of r.fields) if (!fields.has(f.name)) fields.set(f.name, f);
    for (const rel of r.relations) if (!relations.has(`${rel.field}>${rel.target}`)) relations.set(`${rel.field}>${rel.target}`, rel);
  }
  const first = ordered[0];
  return {
    ...first,
    fields: [...fields.values()],
    relations: [...relations.values()],
    sources: ordered.map((r) => ({ source: r.source, path: r.path, line: r.line })),
  };
}

/** Pure computation of the deterministic node/edge layer from the index tables. */
export function deriveLayer(store: MemoryStore, mounts: ReadonlyMap<string, Mount[]>): Layer {
  const nodes: KnowledgeNodeInput[] = [];
  const edges = new Map<string, KnowledgeEdge>();
  const addEdge = (from: string, to: string, rel: RelKind): void => {
    if (from === to) return;
    edges.set(`${from}\0${rel}\0${to}`, { from, to, rel, origin: 'deterministic' });
  };

  const files = store.listFiles();
  const fileByPath = new Map<string, FileRecord>(files.map((f) => [f.path, f]));
  const importsByFrom = new Map<string, ImportRecord[]>();
  for (const i of store.imports()) {
    const bucket = importsByFrom.get(i.from) ?? [];
    bucket.push(i);
    importsByFrom.set(i.from, bucket);
  }

  // ── modules ────────────────────────────────────────────────────────────
  const moduleFiles = new Map<string, FileRecord[]>();
  for (const f of files) {
    const id = moduleOf(f.path);
    if (!id) continue;
    const bucket = moduleFiles.get(id) ?? [];
    bucket.push(f);
    moduleFiles.set(id, bucket);
  }
  const moduleIds = new Set(moduleFiles.keys());
  const moduleOfFile = (path: string): string | undefined => {
    const id = moduleOf(path);
    return id && moduleIds.has(id) ? id : undefined;
  };
  const symbolsOf = new Map<string, number>();
  const signatureWords = new Map<string, Set<string>>();
  const symbolsByFile = new Map<string, ReturnType<MemoryStore['symbolsInFile']>>();
  for (const [id, list] of moduleFiles) {
    let count = 0;
    const words = new Set<string>();
    for (const f of list) {
      const symbols = store.symbolsInFile(f.path);
      symbolsByFile.set(f.path, symbols);
      count += symbols.length;
      for (const s of symbols) for (const w of (s.signature ?? '').match(/[A-Za-z_]\w*/g) ?? []) words.add(w);
    }
    symbolsOf.set(id, count);
    signatureWords.set(id, words);
  }

  // ── routes (with cross-file mount prefixes) ───────────────────────────
  const parents = resolveMounts(mounts, importsByFrom);
  const routeCount = new Map<string, number>();
  const routeNodes = new Map<string, KnowledgeNodeInput>();
  for (const r of store.routes()) {
    for (const prefix of prefixesOf(r.path, parents)) {
      const pattern = joinPattern(prefix, r.pattern);
      const id = `route:${r.method} ${pattern}`;
      if (routeNodes.has(id)) continue;
      const mod = moduleOfFile(r.path);
      routeNodes.set(id, det({
        id, kind: 'route', title: `${r.method} ${pattern}`,
        summary: `${r.method} ${pattern}${r.handler ? ` → ${r.handler}` : ''} (${r.path}:${r.line})`,
        data: {
          method: r.method, pattern, localPattern: r.pattern, framework: r.framework, path: r.path, line: r.line,
          handler: r.handler, handlerSymbolId: r.handlerSymbolId,
        },
      }));
      if (mod) {
        routeCount.set(mod, (routeCount.get(mod) ?? 0) + 1);
        addEdge(mod, id, 'contains');
        addEdge(mod, id, 'exposes');
      }
      // handler imported from another module → the route calls that module
      const handlerRoot = r.handler?.split('.')[0];
      if (handlerRoot && !r.handlerSymbolId) {
        const target = importsByFrom.get(r.path)?.find((i) => i.resolved && i.names.includes(handlerRoot))?.resolved;
        const targetModule = target && moduleOfFile(target);
        if (targetModule && targetModule !== mod) addEdge(id, targetModule, 'calls');
      }
    }
  }

  for (const [id, list] of moduleFiles) {
    const languages = new Map<string, number>();
    let loc = 0;
    for (const f of list) {
      languages.set(f.lang, (languages.get(f.lang) ?? 0) + 1);
      loc += f.loc;
    }
    const dir = id.slice('module:'.length);
    nodes.push(det({
      id, kind: 'module', title: moduleTitle(dir),
      summary: `${list.length} files · ${symbolsOf.get(id) ?? 0} symbols · ${routeCount.get(id) ?? 0} routes`,
      data: { path: dir, files: list.length, loc, languages: [...languages].sort((a, b) => b[1] - a[1]).map(([l]) => l) },
    }));
  }
  nodes.push(...routeNodes.values());

  // ── module → module dependencies ──────────────────────────────────────
  for (const [from, list] of importsByFrom) {
    const fromModule = moduleOfFile(from);
    if (!fromModule) continue;
    for (const i of list) {
      const toModule = i.resolved ? moduleOfFile(i.resolved) : undefined;
      if (toModule) addEdge(fromModule, toModule, 'depends_on');
    }
  }

  // ── entities ──────────────────────────────────────────────────────────
  const byName = new Map<string, EntityRecord[]>();
  for (const e of store.entities()) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  const entityNodes = new Map<string, ReturnType<typeof mergeEntities>>();
  for (const [name, records] of byName) {
    const merged = mergeEntities(records);
    const id = `entity:${name}`;
    entityNodes.set(id, merged);
    const related = [...new Set(merged.relations.map((r) => r.target))];
    nodes.push(det({
      id, kind: 'entity', title: name,
      summary: `${merged.fields.length} fields (${merged.source})${related.length ? ` · relates to ${related.join(', ')}` : ''}`,
      data: { fields: merged.fields, relations: merged.relations, source: merged.source, path: merged.path, line: merged.line, sources: merged.sources },
    }));
  }
  for (const [id, e] of entityNodes) {
    for (const rel of e.relations) if (entityNodes.has(`entity:${rel.target}`)) addEdge(id, `entity:${rel.target}`, 'relates');
  }
  for (const [moduleId, list] of moduleFiles) {
    const paths = new Set(list.map((f) => f.path));
    const words = signatureWords.get(moduleId) ?? new Set<string>();
    for (const [entityId, e] of entityNodes) {
      const definedHere = e.sources.some((s) => paths.has(s.path));
      const importsDefiner = list.some((f) => (importsByFrom.get(f.path) ?? []).some((i) => i.resolved && e.sources.some((s) => s.path === i.resolved)));
      if (definedHere || importsDefiner || words.has(e.name)) addEdge(moduleId, entityId, 'reads');
    }
  }

  // ── integrations ──────────────────────────────────────────────────────
  const packageToKey = new Map<string, string>();
  for (const integration of store.integrations()) {
    nodes.push(det({
      id: integration.id, kind: 'integration', title: integration.name,
      summary: `${integration.category} · ${integration.evidence.length} evidence`,
      data: { key: integration.key, category: integration.category, evidence: integration.evidence },
    }));
    for (const ev of integration.evidence) {
      const pkg = packageOfSpecifier(ev.detail);
      if (pkg) packageToKey.set(pkg, integration.id);
      const mod = moduleOfFile(ev.path);
      if (mod) addEdge(mod, integration.id, 'uses');
    }
  }
  for (const [moduleId, list] of moduleFiles) {
    for (const f of list) {
      for (const i of importsByFrom.get(f.path) ?? []) {
        // matched on the specifier itself, so a bare package import counts whatever the resolver decided
        if (i.specifier.startsWith('.') || i.specifier.startsWith('/')) continue;
        for (const [pkg, integrationId] of packageToKey) {
          const scope = pkg.startsWith('@') ? `${pkg.split('/')[0]}/` : undefined;
          if (i.specifier === pkg || i.specifier.startsWith(`${pkg}/`) || (scope && i.specifier.startsWith(scope))) addEdge(moduleId, integrationId, 'uses');
        }
      }
    }
  }

  // ── test suites ───────────────────────────────────────────────────────
  const testsByPath = new Map<string, ReturnType<MemoryStore['tests']>>();
  for (const t of store.tests()) testsByPath.set(t.path, [...(testsByPath.get(t.path) ?? []), t]);
  for (const f of files) {
    const tests = testsByPath.get(f.path) ?? [];
    if (!f.isTest || (tests.length === 0 && !TEST_FILE_NAME.test(f.path))) continue;
    const id = `test_suite:${f.path}`;
    const framework = tests.find((t) => t.framework)?.framework;
    nodes.push(det({
      id, kind: 'test_suite', title: posix.basename(f.path),
      summary: `${tests.length} tests${framework ? ` (${framework})` : ''} in ${f.path}`,
      data: { path: f.path, tests: tests.length, framework },
    }));
    const home = moduleDir(f.path);
    if (home && moduleIds.has(`module:${home}`)) addEdge(`module:${home}`, id, 'contains');
    for (const i of importsByFrom.get(f.path) ?? []) {
      const target = i.resolved ? moduleOfFile(i.resolved) : undefined;
      if (target) addEdge(id, target, 'tests');
    }
  }

  // ── components ────────────────────────────────────────────────────────
  for (const f of files) {
    const mod = moduleOfFile(f.path);
    if (!mod || !COMPONENT_FILE.test(f.path)) continue;
    for (const s of symbolsByFile.get(f.path) ?? []) {
      if (!s.exported || !COMPONENT_KINDS.has(s.kind) || s.parent || !PASCAL_CASE.test(s.name)) continue;
      const id = `component:${f.path}#${s.name}`;
      nodes.push(det({
        id, kind: 'component', title: s.name,
        summary: `${s.signature ?? s.name} (${f.path}:${s.startLine})`,
        data: { path: f.path, line: s.startLine, symbolId: s.id },
      }));
      addEdge(mod, id, 'contains');
    }
  }

  return { nodes, edges: [...edges.values()] };
}

const sameNode = (cur: KnowledgeNode, next: KnowledgeNodeInput): boolean =>
  cur.kind === next.kind && cur.title === next.title && cur.summary === next.summary
  && JSON.stringify(cur.data ?? null) === JSON.stringify(next.data ?? null);

const edgeKey = (e: KnowledgeEdge): string => `${e.from}\0${e.rel}\0${e.to}`;

/**
 * Brings the stored deterministic layer in line with `layer` inside one transaction. Only
 * origin='deterministic' rows are ever removed; agent/imported/user nodes and edges are untouched
 * (an edge that also exists with another origin keeps that origin).
 */
export function applyLayer(store: MemoryStore, layer: Layer): { changed: boolean } {
  return store.transaction(() => {
    let changed = false;
    const existing = new Map(store.listNodes().map((n) => [n.id, n]));
    const keep = new Set<string>();
    for (const next of layer.nodes) {
      const cur = existing.get(next.id);
      if (cur && cur.origin !== 'deterministic') continue; // never clobber a human/agent/imported node
      keep.add(next.id);
      if (!cur || !sameNode(cur, next)) {
        store.upsertNode(next);
        changed = true;
      }
    }
    for (const cur of existing.values()) {
      if (cur.origin === 'deterministic' && !keep.has(cur.id)) {
        store.deleteNode(cur.id);
        changed = true;
      }
    }

    const have = new Map(store.edges().map((e) => [edgeKey(e), e]));
    const alive = (id: string): boolean => keep.has(id) || (existing.get(id)?.origin ?? 'deterministic') !== 'deterministic';
    const want = new Map(layer.edges.filter((e) => alive(e.from) && alive(e.to)).map((e) => [edgeKey(e), e]));
    for (const [key, e] of have) {
      if (e.origin === 'deterministic' && !want.has(key)) {
        store.deleteEdges({ from: e.from, to: e.to, rel: e.rel, origin: 'deterministic' });
        changed = true;
      }
    }
    for (const [key, e] of want) {
      if (have.has(key)) continue;
      store.upsertEdge(e);
      changed = true;
    }
    return { changed };
  });
}
