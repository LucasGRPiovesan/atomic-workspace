import type { BuildOverview, MemoryStore } from '../contracts.js';
import type { ContextPack, KnowledgeNode, StackInfo } from '../types.js';
import { findUnmapped } from './coverage.js';
import { clip, estimateTokens, fitToBudget, statusTag } from './util.js';

const DEFAULT_BUDGET = 800;
const TOOLS_LINE = 'Tools: atomic_context{task} for a task; atomic_search; atomic_node{id}; atomic_symbol; atomic_impact{paths}; atomic_record{items} to save knowledge; atomic_stale/verify; atomic_unmapped.';

interface Section {
  title: string;
  lines: string[];
  /** lower number = dropped first when over budget */
  dropOrder: number;
}

/** The indexer may persist its StackInfo under meta `stack`; otherwise languages are derived from files. */
function readStack(store: MemoryStore): Partial<StackInfo> {
  const raw = store.getMeta('stack');
  if (raw) {
    try {
      return JSON.parse(raw) as StackInfo;
    } catch {
      // fall through to derived
    }
  }
  const byLang = new Map<string, { files: number; loc: number }>();
  for (const f of store.listFiles()) {
    const cur = byLang.get(f.lang) ?? { files: 0, loc: 0 };
    cur.files++;
    cur.loc += f.loc;
    byLang.set(f.lang, cur);
  }
  return { languages: [...byLang].map(([lang, v]) => ({ lang: lang as StackInfo['languages'][number]['lang'], ...v })) };
}

const more = (shown: number, total: number): string[] => (total > shown ? [`+${total - shown} more`] : []);

export const buildOverview: BuildOverview = (store, opts) => {
  const budget = opts?.budgetTokens ?? DEFAULT_BUDGET;
  const stack = readStack(store);
  const nodes = store.listNodes();
  const byKind = (k: KnowledgeNode['kind']): KnowledgeNode[] => nodes.filter((n) => n.kind === k);
  const stats = store.stats();
  const unmapped = findUnmapped(store);
  const sections: Section[] = [];

  const proj: string[] = [];
  const langs = [...(stack.languages ?? [])].sort((a, b) => b.loc - a.loc).slice(0, 4);
  if (langs.length) proj.push(`Languages: ${langs.map((l) => `${l.lang} ${l.files}f`).join(', ')}`);
  if (stack.frameworks?.length) proj.push(`Frameworks: ${stack.frameworks.slice(0, 10).join(', ')}`);
  if (stack.packageManagers?.length) proj.push(`Package managers: ${stack.packageManagers.join(', ')}`);
  const scripts = (stack.scripts ?? []).filter((s) => ['dev', 'start', 'test', 'build'].includes(s.name)).slice(0, 4);
  if (scripts.length) proj.push(`Scripts: ${scripts.map((s) => `${s.name}=\`${clip(s.command, 50)}\``).join(' ')}`);
  proj.push(`Index: ${stats.files} files, ${stats.symbols} symbols, ${stats.routes} routes`);
  sections.push({ title: 'Project', lines: proj, dropOrder: 99 });

  const routeCount = new Map<string, number>();
  for (const e of store.edges({ rel: 'exposes' })) routeCount.set(e.from, (routeCount.get(e.from) ?? 0) + 1);
  const modules = byKind('module');
  const topModules = [...modules]
    .sort((a, b) => ((b.data?.files as number) ?? 0) - ((a.data?.files as number) ?? 0))
    .slice(0, 12);
  if (modules.length) {
    sections.push({
      title: 'Modules',
      dropOrder: 3,
      lines: [
        ...topModules.map((m) => `${m.id.replace(/^module:/, '')} · ${(m.data?.files as number) ?? '?'}f · ${routeCount.get(m.id) ?? 0}r`),
        ...more(topModules.length, modules.length),
      ],
    });
  }

  const caps = byKind('capability');
  if (caps.length) {
    const shown = caps.slice(0, 15);
    sections.push({
      title: 'Capabilities',
      dropOrder: 4,
      lines: [...shown.map((c) => `${c.title}${statusTag(c)} — ${clip(c.summary, 90)}`), ...more(shown.length, caps.length)],
    });
  }

  const integrations = store.integrations();
  if (integrations.length) {
    sections.push({ title: 'Integrations', dropOrder: 2, lines: [integrations.slice(0, 12).map((i) => i.key).join(', ')] });
  }

  const entities = store.entities();
  if (entities.length) {
    const names = [...new Set(entities.map((e) => e.name))];
    sections.push({ title: 'Entities', dropOrder: 1, lines: [`${names.slice(0, 20).join(', ')}${names.length > 20 ? ` +${names.length - 20}` : ''}`] });
  }

  const rules = [...byKind('rule'), ...byKind('convention'), ...byKind('decision')];
  if (rules.length) {
    const shown = rules.slice(0, 15);
    sections.push({
      title: 'Rules & conventions',
      dropOrder: 5,
      lines: [...shown.map((r) => `${r.title}${statusTag(r)}`), ...more(shown.length, rules.length)],
    });
  }

  const instructions = byKind('instruction').length;
  const agentCount = stats.nodesByOrigin.agent ?? 0;
  sections.push({
    title: 'Memory',
    dropOrder: 98,
    lines: [`agent knowledge ${agentCount}, stale ${stats.stale}, unmapped modules ${unmapped.modules.length}${instructions ? `, imported instructions ${instructions} (see their own files)` : ''}`],
  });
  sections.push({ title: 'Tools', dropOrder: 97, lines: [TOOLS_LINE] });

  const render = (secs: Section[]): string =>
    secs.map((s) => (s.title === 'Tools' ? s.lines.join('\n') : `## ${s.title}\n${s.lines.join('\n')}`)).join('\n');

  let used = sections.slice();
  while (estimateTokens(render(used)) > budget && used.length > 1) {
    const victim = used.reduce((a, b) => (b.dropOrder < a.dropOrder ? b : a));
    if (victim.dropOrder >= 97) break;
    used = used.filter((s) => s !== victim);
  }
  const text = fitToBudget(render(used), budget);

  const pack: ContextPack = {
    task: 'overview',
    budgetTokens: budget,
    estimatedTokens: estimateTokens(text),
    nodeIds: [...caps, ...rules].map((n) => n.id),
    files: [],
    sections: used.map((s) => s.title),
    text,
  };
  return pack;
};
