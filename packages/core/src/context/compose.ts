import type { BuildContext, MemoryStore } from '../contracts.js';
import type { ContextPack, FlowStep, KnowledgeNode, NodeKind } from '../types.js';
import { clip, estimateTokens, fitToBudget, fmtLoc, statusTag } from './util.js';

const DEFAULT_BUDGET = 1500;
const MAX_SEEDS_EXPANDED = 12;
const MAX_NEIGHBOURS_PER_SEED = 8;
const MAX_FILES = 8;
const STOP = new Set(['this', 'that', 'with', 'from', 'when', 'what', 'should', 'would', 'could', 'have', 'into', 'then', 'than', 'will', 'does', 'make', 'need', 'want', 'file', 'code', 'task', 'please']);

const KIND_WEIGHT: Partial<Record<NodeKind, number>> = {
  rule: 1, flow: 1, capability: 1, decision: 0.8,
  module: 0.6, entity: 0.6, route: 0.6, component: 0.6,
  convention: 0.4, test_suite: 0.3, integration: 0.3, instruction: 0.2, note: 0.2,
};

const norm = (s: string): string => s.replace(/[_\-]/g, '').toLowerCase();
const camel = (s: string): string => s.replace(/[_-]+([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

interface FileRef { path: string; startLine?: number; endLine?: number; reason: string }

/** Does a concrete request path (/orders/123) fit a route pattern (/orders/:id)? */
function routeMatches(pattern: string, requested: string): boolean {
  const a = pattern.split('/');
  const b = requested.split('?')[0].replace(/\/+$/, '').split('/');
  return a.length === b.length && a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

function renderNode(n: KnowledgeNode): string {
  const anchors = n.anchors.slice(0, 3).map(fmtLoc).join(', ');
  let line = `- [${n.kind}] ${n.title}${statusTag(n)} — ${clip(n.summary, 220)}`;
  if (anchors) line += ` · ${anchors}`;
  line += ` · id ${n.id}`;
  const steps = n.kind === 'flow' ? ((n.data?.steps as FlowStep[] | undefined) ?? []) : [];
  if (steps.length) {
    const s = steps
      .slice(0, 8)
      .map((st) => `${st.order}.${clip(st.title, 40)}${st.path ? `@${st.path}${st.line ? `:${st.line}` : ''}` : ''}`)
      .join(' → ');
    line += `\n  steps: ${s}${steps.length > 8 ? ' …' : ''}`;
  }
  return line;
}

function moduleIdFor(store: MemoryStore, path: string): string | undefined {
  let dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  while (dir) {
    const id = `module:${dir}`;
    if (store.getNode(id)) return id;
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }
  return undefined;
}

export const buildContext: BuildContext = (store, task, opts) => {
  const budget = opts?.budgetTokens ?? DEFAULT_BUDGET;
  const exclude = new Set(opts?.excludeNodeIds ?? []);
  const seedScore = new Map<string, number>();
  const fileRefs: FileRef[] = [];
  const bump = (id: string, score: number): void => {
    if (score > (seedScore.get(id) ?? 0)) seedScore.set(id, score);
  };

  // (a) seeds ─ FTS
  const hits = store.search(task, { limit: 30 });
  const top = hits.reduce((m, h) => Math.max(m, h.score), 0) || 1;
  for (const h of hits) {
    const s = 0.5 + (h.score / top) * 2;
    if (h.type === 'node') bump(h.id, s);
    else {
      fileRefs.push({ path: h.path ?? '', startLine: h.line, reason: `symbol ${h.title}` });
      const mod = h.path ? moduleIdFor(store, h.path) : undefined;
      if (mod) bump(mod, s * 0.6);
    }
  }

  // (a) seeds ─ literal file paths
  for (const m of task.matchAll(/[\w@.\-]+(?:\/[\w@.\-]+)+|\b[\w\-]+\.[a-z]{1,5}\b/g)) {
    const p = m[0].replace(/^\.\//, '');
    if (!store.getFile(p)) continue;
    fileRefs.push({ path: p, reason: 'mentioned' });
    for (const n of store.listNodes({ paths: [p], limit: 20 })) bump(n.id, 3);
    const mod = moduleIdFor(store, p);
    if (mod) bump(mod, 2);
  }

  // (a) seeds ─ literal symbol names
  const idents = [...new Set(task.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [])].filter((t) => !STOP.has(t.toLowerCase())).slice(0, 20);
  for (const tok of idents) {
    const variants = [...new Set([tok, camel(tok), snake(tok)])];
    const found = new Map<string, ReturnType<MemoryStore['findSymbols']>[number]>();
    for (const v of variants) for (const s of store.findSymbols(v, 8)) if (norm(s.name) === norm(tok)) found.set(s.id, s);
    for (const s of found.values()) {
      // the exact match carries the full line range; supersede the FTS hit for the same location
      const dup = fileRefs.findIndex((f) => f.path === s.path && f.startLine === s.startLine);
      if (dup >= 0) fileRefs.splice(dup, 1);
      fileRefs.push({ path: s.path, startLine: s.startLine, endLine: s.endLine, reason: `symbol ${s.name}` });
      const mod = moduleIdFor(store, s.path);
      if (mod) bump(mod, 2);
      for (const n of store.listNodes({ paths: [s.path], limit: 10 })) bump(n.id, 1.5);
    }
  }

  // (a) seeds ─ route mentions
  const routeMentions = [...task.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s,;)'"]*)/gi)];
  if (routeMentions.length) {
    const routes = store.routes();
    for (const m of routeMentions) {
      const method = m[1].toUpperCase();
      for (const r of routes) {
        if ((r.method === method || r.method === 'ANY') && routeMatches(r.pattern, m[2])) {
          bump(r.id, 3);
          fileRefs.push({ path: r.path, startLine: r.line, reason: `route ${r.method} ${r.pattern}` });
        }
      }
    }
  }

  // (a) seeds ─ entity names
  const lower = task.toLowerCase();
  for (const e of store.entities()) {
    if (e.name.length >= 3 && new RegExp(`\\b${e.name.replace(/[^\w]/g, '\\$&')}\\b`, 'i').test(lower)) {
      bump(e.id, 2);
      fileRefs.push({ path: e.path, startLine: e.line, reason: `entity ${e.name}` });
    }
  }

  if (seedScore.size === 0) {
    const text = 'No stored knowledge matches this task. Use atomic_search / atomic_overview, or explore the code and save findings with atomic_record.';
    return { task, budgetTokens: budget, estimatedTokens: estimateTokens(text), nodeIds: [], files: [], sections: [], text };
  }

  // (b) expand 1 hop
  const score = new Map(seedScore);
  const expandFrom = [...seedScore].sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEDS_EXPANDED);
  for (const [id, s] of expandFrom) {
    const neighbours = new Set<string>();
    for (const e of store.edges({ from: id })) neighbours.add(e.to);
    for (const e of store.edges({ to: id })) neighbours.add(e.from);
    const node = store.getNode(id);
    if (node?.kind === 'flow') for (const st of (node.data?.steps as FlowStep[] | undefined) ?? []) if (st.nodeId) neighbours.add(st.nodeId);
    let n = 0;
    for (const nb of neighbours) {
      if (n++ >= MAX_NEIGHBOURS_PER_SEED) break;
      const v = s * 0.45;
      if (v > (score.get(nb) ?? 0)) score.set(nb, v);
    }
  }

  // (c) score
  const ranked: { node: KnowledgeNode; score: number }[] = [];
  for (const [id, s] of score) {
    if (exclude.has(id)) continue;
    const node = store.getNode(id);
    if (!node) continue;
    const total = s + (KIND_WEIGHT[node.kind] ?? 0.3) + (node.status === 'fresh' ? 0.3 : node.status === 'stale' ? -0.5 : 0) + (node.origin === 'deterministic' ? 0 : 0.1);
    ranked.push({ node, score: total });
  }
  ranked.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));

  // (d) pack
  const header = `Context for: ${clip(task, 100)}`;
  const nodeBudget = Math.floor(budget * 0.8);
  const lines: string[] = [];
  const included: KnowledgeNode[] = [];
  let used = estimateTokens(header) + 4;
  for (const { node } of ranked) {
    const line = renderNode(node);
    const cost = estimateTokens(line) + 1;
    if (used + cost > nodeBudget) continue;
    lines.push(line);
    included.push(node);
    used += cost;
  }

  const files: FileRef[] = [];
  const seen = new Set<string>();
  const addFile = (f: FileRef): void => {
    const key = `${f.path}:${f.startLine ?? ''}`;
    if (!f.path || seen.has(key) || files.length >= MAX_FILES) return;
    seen.add(key);
    files.push(f);
  };
  for (const f of fileRefs) addFile(f);
  for (const n of included) for (const a of n.anchors.slice(0, 2)) addFile({ path: a.path, startLine: a.startLine, endLine: a.endLine, reason: `anchor of ${n.id}` });

  const sections: string[] = [];
  let text = header;
  if (lines.length) {
    sections.push('Knowledge');
    text += `\n## Knowledge\n${lines.join('\n')}`;
  }
  const fileLines: string[] = [];
  for (const f of files) {
    const line = `- ${fmtLoc(f)} — ${f.reason}`;
    if (estimateTokens(`${text}\n## Files\n${[...fileLines, line].join('\n')}`) > budget) break;
    fileLines.push(line);
  }
  const keptFiles = files.slice(0, fileLines.length);
  if (fileLines.length) {
    sections.push('Files');
    text += `\n## Files\n${fileLines.join('\n')}`;
  }
  text = fitToBudget(text, budget);

  const pack: ContextPack = {
    task,
    budgetTokens: budget,
    estimatedTokens: estimateTokens(text),
    nodeIds: included.map((n) => n.id),
    files: keptFiles,
    sections,
    text,
  };
  return pack;
};
