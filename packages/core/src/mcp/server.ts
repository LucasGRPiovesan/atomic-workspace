import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { MemoryStore, StartMcpServer } from '../contracts.js';
import { buildContext, buildOverview, findUnmapped, impactOf } from '../context/index.js';
import { clip, fmtLoc } from '../context/util.js';
import { openStore } from '../store/index.js';
import type { Anchor, FlowStep, KnowledgeEdge, KnowledgeNodeInput, NodeKind, RelKind } from '../types.js';

const REL_KINDS = ['contains', 'depends_on', 'implements', 'calls', 'reads', 'writes', 'tests', 'uses', 'exposes', 'step_of', 'governs', 'relates'] as const;
const RECORD_KINDS = ['capability', 'flow', 'rule', 'entity', 'decision', 'convention', 'component', 'note'] as const;
const BODY_CAP = 2000;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Wraps a handler so a thrown error becomes an MCP tool error instead of a protocol failure. */
const safe = <A>(fn: (args: A) => ToolResult) => (args: A): ToolResult => {
  try {
    return fn(args);
  } catch (e) {
    return fail(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
};

export const slug = (title: string): string =>
  title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';

/** Every write bumps meta `rev` so the desktop app can notice writes made by this (other) process. */
const bumpRev = (store: MemoryStore): void => {
  store.setMeta('rev', String(Number(store.getMeta('rev') ?? 0) + 1));
};

// bounds keep one runaway call from bloating the shared memory db or holding its write lock for long
const anchorSchema = z.object({
  path: z.string().max(500),
  symbol: z.string().max(200).optional(),
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
});

const itemSchema = z.object({
  kind: z.enum(RECORD_KINDS),
  id: z.string().max(200).optional(),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  body: z.string().max(20000).optional(),
  anchors: z.array(anchorSchema).max(50).default([]),
  relations: z.array(z.object({ rel: z.enum(REL_KINDS), to: z.string() })).max(50).optional(),
  steps: z.array(z.object({
    title: z.string().max(200),
    path: z.string().optional(),
    line: z.number().int().optional(),
    symbol: z.string().optional(),
    nodeId: z.string().optional(),
  })).max(100).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
type RecordItem = z.infer<typeof itemSchema>;

/** Validates under the write lock: the desktop indexer may update file hashes in between otherwise, and
 * an anchor hash read before its commit would leave the node "fresh" against code it never saw. */
function recordItems(store: MemoryStore, agentId: string | undefined, items: RecordItem[]): string[] {
  return store.transaction(() => recordItemsLocked(store, agentId, items));
}

function recordItemsLocked(store: MemoryStore, agentId: string | undefined, items: RecordItem[]): string[] {
  const out: string[] = new Array(items.length).fill('');
  const ids = items.map((it) => it.id ?? `${it.kind}:${slug(it.title)}`);
  const accepted = new Set<string>();
  const prepared = new Map<number, { input: KnowledgeNodeInput; edges: KnowledgeEdge[]; existed: boolean }>();

  // validation: per-item errors never block the other items
  const batchIds = new Set(ids);
  items.forEach((it, i) => {
    const id = ids[i];
    const problems: string[] = [];
    const anchors: Anchor[] = [];
    const current = store.getNode(id);
    // ids are namespaced by kind, so an agent cannot squat ids the indexer will create later (route:, module:, ...)
    if (!id.startsWith(`${it.kind}:`)) problems.push(`id must start with "${it.kind}:"`);
    // deterministic/imported nodes are owned by the indexer; agents link to them instead of overwriting
    if (current && current.origin !== 'agent') problems.push(`${id} is ${current.origin} knowledge and cannot be overwritten; record a new item that relates to it`);
    for (const a of it.anchors) {
      const f = store.getFile(a.path);
      if (!f) problems.push(`unknown path ${a.path}`);
      else anchors.push({ ...a, hash: f.hash });
    }
    for (const r of it.relations ?? []) {
      if (!store.getNode(r.to) && !batchIds.has(r.to)) problems.push(`unknown relation target ${r.to}`);
    }
    for (const s of it.steps ?? []) {
      if (s.nodeId && !store.getNode(s.nodeId) && !batchIds.has(s.nodeId)) problems.push(`unknown step node ${s.nodeId}`);
      if (s.path && !store.getFile(s.path)) problems.push(`unknown step path ${s.path}`);
    }
    if (problems.length) {
      out[i] = `error ${id}: ${problems.join('; ')}`;
      return;
    }
    const steps: FlowStep[] | undefined = it.steps?.map((s, n) => ({ order: n + 1, ...s }));
    const edges: KnowledgeEdge[] = (it.relations ?? []).map((r) => ({ from: id, to: r.to, rel: r.rel as RelKind, origin: 'agent' }));
    for (const s of steps ?? []) if (s.nodeId) edges.push({ from: s.nodeId, to: id, rel: 'step_of', origin: 'agent' });
    prepared.set(i, {
      existed: !!store.getNode(id),
      edges,
      input: {
        id,
        kind: it.kind as NodeKind,
        title: it.title,
        summary: it.summary,
        body: it.body,
        data: steps ? { steps } : undefined,
        origin: 'agent',
        status: 'fresh',
        confidence: it.confidence,
        anchors,
        tags: it.tags,
        author: agentId,
      },
    });
    accepted.add(id);
  });

  if (prepared.size === 0) return out;

  store.transaction(() => {
    for (const [i, p] of prepared) {
      store.deleteEdges({ from: p.input.id, origin: 'agent' });
      store.deleteEdges({ to: p.input.id, rel: 'step_of', origin: 'agent' });
      store.upsertNode(p.input);
      out[i] = `${p.existed ? 'updated' : 'created'} ${p.input.id}`;
    }
    // edges after all nodes exist so relations can target other items of the same call
    // an edge whose in-batch endpoint failed validation would dangle: drop it
    const exists = (nodeId: string) => accepted.has(nodeId) || !!store.getNode(nodeId);
    for (const p of prepared.values()) for (const e of p.edges) if (exists(e.from) && exists(e.to)) store.upsertEdge(e);
    store.recordChange({
      id: `chg_${randomUUID()}`,
      at: new Date().toISOString(),
      source: 'agent',
      agentId,
      files: [],
      affectedNodes: [...accepted],
      staleNodes: [],
      summary: `recorded ${prepared.size} knowledge items`,
    });
    bumpRev(store);
  });
  return out;
}

export function createMcpServer(store: MemoryStore, agentId?: string): McpServer {
  const server = new McpServer({ name: 'atomic', version: '0.1.0' });
  const READ = { readOnlyHint: true } as const;

  server.registerTool('atomic_overview', {
    description: 'Compact project brief (stack, modules, capabilities, rules, memory status). Call first in a new session instead of exploring the repo.',
    annotations: READ,
  }, safe(() => ok(buildOverview(store).text)));

  server.registerTool('atomic_context', {
    description: 'Get the stored knowledge relevant to a task (rules, flows, modules, code locations). Call before starting work; cheaper than reading files.',
    inputSchema: { task: z.string(), budget_tokens: z.number().int().positive().optional() },
    annotations: READ,
  }, safe(({ task, budget_tokens }: { task: string; budget_tokens?: number }) => {
    const pack = buildContext(store, task, { budgetTokens: budget_tokens });
    store.recordContextServed(pack.estimatedTokens);
    return ok(pack.text);
  }));

  server.registerTool('atomic_search', {
    description: 'Full-text search over knowledge nodes and code symbols. Use to find an id or location by keyword.',
    inputSchema: { query: z.string(), kinds: z.array(z.string()).optional(), limit: z.number().int().positive().max(50).optional() },
    annotations: READ,
  }, safe(({ query, kinds, limit }: { query: string; kinds?: string[]; limit?: number }) => {
    const hits = store.search(query, { kinds, limit: limit ?? 15 });
    if (!hits.length) return ok('no results');
    return ok(hits.map((h) => {
      const loc = h.type === 'symbol' && h.path ? ` · ${fmtLoc({ path: h.path, startLine: h.line })}` : '';
      const nodePath = h.type === 'node' ? store.getNode(h.id)?.anchors[0]?.path : undefined;
      return `${h.id} · ${h.kind} · ${h.title}${loc}${nodePath ? ` · ${nodePath}` : ''}`;
    }).join('\n'));
  }));

  server.registerTool('atomic_node', {
    description: 'Full detail of one knowledge node by id: summary, body, anchors and related nodes.',
    inputSchema: { id: z.string() },
    annotations: READ,
  }, safe(({ id }: { id: string }) => {
    const n = store.getNode(id);
    if (!n) return fail(`no node ${id}`);
    const lines = [`[${n.kind}] ${n.title} (${n.status}, ${n.origin}, conf ${n.confidence})`, n.summary];
    if (n.body) lines.push(n.body.length > BODY_CAP ? `${n.body.slice(0, BODY_CAP)}… [truncated]` : n.body);
    if (n.anchors.length) lines.push(`anchors: ${n.anchors.map(fmtLoc).join(', ')}`);
    if (n.tags.length) lines.push(`tags: ${n.tags.join(', ')}`);
    const steps = (n.data?.steps as FlowStep[] | undefined) ?? [];
    for (const s of steps) lines.push(`step ${s.order}: ${s.title}${s.path ? ` @ ${fmtLoc({ path: s.path, startLine: s.line })}` : ''}${s.nodeId ? ` → ${s.nodeId}` : ''}`);
    const group = (edges: KnowledgeEdge[], pick: (e: KnowledgeEdge) => string, prefix: string): void => {
      const byRel = new Map<string, string[]>();
      for (const e of edges) byRel.set(e.rel, [...(byRel.get(e.rel) ?? []), pick(e)]);
      for (const [rel, list] of byRel) lines.push(`${prefix}${rel}: ${list.slice(0, 15).join(', ')}${list.length > 15 ? ` +${list.length - 15}` : ''}`);
    };
    group(store.edges({ from: id }), (e) => e.to, '');
    group(store.edges({ to: id }), (e) => e.from, '← ');
    return ok(lines.join('\n'));
  }));

  server.registerTool('atomic_symbol', {
    description: 'Locate a code symbol (function/class/type) by name: file, lines, signature.',
    inputSchema: { name: z.string() },
    annotations: READ,
  }, safe(({ name }: { name: string }) => {
    const syms = store.findSymbols(name, 20);
    if (!syms.length) return ok('no symbols');
    return ok(syms.map((s) => `${s.name} · ${s.kind}${s.exported ? '' : ' (private)'} · ${s.path}:${s.startLine}-${s.endLine}${s.signature ? ` · ${clip(s.signature, 160)}` : ''}`).join('\n'));
  }));

  server.registerTool('atomic_impact', {
    description: 'What is affected by changing these files: capabilities, flows, rules, routes, entities and tests. Use before editing.',
    inputSchema: { paths: z.array(z.string()).min(1) },
    annotations: READ,
  }, safe(({ paths }: { paths: string[] }) => {
    const { nodes, tests } = impactOf(store, paths);
    const lines: string[] = [];
    for (const n of nodes) lines.push(`[${n.kind}] ${n.title}${n.status === 'fresh' ? '' : ` (${n.status})`} · id ${n.id}`);
    if (tests.length) {
      lines.push('tests:');
      for (const t of tests.slice(0, 30)) lines.push(`- ${t.path}:${t.line} ${clip(t.name, 80)}`);
      if (tests.length > 30) lines.push(`+${tests.length - 30} more`);
    }
    return ok(lines.length ? lines.join('\n') : 'no known impact');
  }));

  server.registerTool('atomic_record', {
    description: 'Save what you learned (capabilities, flows, rules, entities, decisions, conventions) anchored to code paths so future sessions skip re-exploring. Same title updates the same node.',
    inputSchema: { items: z.array(itemSchema).min(1).max(50) },
  }, safe(({ items }: { items: RecordItem[] }) => ok(recordItems(store, agentId, items).join('\n'))));

  server.registerTool('atomic_stale', {
    description: 'List recorded knowledge whose anchored code changed. Re-read the code, update with atomic_record or confirm with atomic_verify.',
    annotations: READ,
  }, safe(() => {
    const stale = store.listNodes({ status: ['stale'], limit: 30 });
    if (!stale.length) return ok('nothing stale');
    return ok(stale.map((n) => {
      const why = n.anchors.map((a) => {
        const f = store.getFile(a.path);
        return `${fmtLoc(a)} ${!f ? 'deleted' : f.hash !== a.hash ? 'changed' : 'unchanged'}`;
      }).join(', ');
      return `${n.id} · ${n.title} · ${why || 'no anchors'}`;
    }).join('\n'));
  }));

  server.registerTool('atomic_verify', {
    description: 'Mark nodes as still correct after re-checking them against the current code (refreshes anchor hashes).',
    inputSchema: { ids: z.array(z.string()).min(1) },
  }, safe(({ ids }: { ids: string[] }) => {
    const lines = store.transaction(() => {
      const res = ids.map((id) => {
        const n = store.markVerified(id);
        return n ? `${id}: ${n.status}` : `${id}: not found`;
      });
      bumpRev(store);
      return res;
    });
    return ok(lines.join('\n'));
  }));

  server.registerTool('atomic_unmapped', {
    description: 'Modules, routes and entities not yet covered by any capability or flow. Worklist for bootstrapping project knowledge.',
    annotations: READ,
  }, safe(() => {
    const u = findUnmapped(store);
    const lines: string[] = [];
    const group = (label: string, ids: string[]): void => {
      if (ids.length) lines.push(`${label} (${ids.length}):`, ...ids.map((i) => `- ${i}`));
    };
    group('modules', u.modules.map((n) => n.id));
    group('routes', u.routes.map((n) => n.id));
    group('entities', u.entities.map((n) => n.id));
    if (!lines.length) return ok('everything is mapped');
    return ok(lines.length > 60 ? [...lines.slice(0, 60), `… ${lines.length - 60} more lines`].join('\n') : lines.join('\n'));
  }));

  return server;
}

export const startMcpServer: StartMcpServer = async ({ root, agentId }) => {
  const store = openStore(root);
  const server = createMcpServer(store, agentId);
  const transport = new StdioServerTransport();
  transport.onclose = () => store.close();
  // stdout carries MCP frames only; anything diagnostic goes to stderr
  await server.connect(transport);
};
