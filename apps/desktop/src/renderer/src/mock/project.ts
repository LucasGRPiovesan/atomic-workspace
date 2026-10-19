// Mock slice for window.atomic.project — shop-app fixture.
import type { AtomicApi, ProjectSummary, RecentProject } from '../../../shared/ipc';
import type { Emit } from './index';

const ROOT = 'C:/dev/shop-app';

const summary = (indexedAt: string): ProjectSummary => ({
  root: ROOT,
  name: 'shop-app',
  isGit: true,
  stack: {
    languages: [
      { lang: 'typescript', files: 24, loc: 1480 },
      { lang: 'javascript', files: 1, loc: 210 },
      { lang: 'prisma', files: 1, loc: 96 },
    ],
    frameworks: ['express', 'prisma', 'stripe'],
    packageManagers: ['npm'],
    manifests: ['package.json', 'prisma/schema.prisma'],
    scripts: [
      { name: 'dev', command: 'node --watch src/server.ts', source: 'package.json', cwd: '' },
      { name: 'start', command: 'node src/server.ts', source: 'package.json', cwd: '' },
      { name: 'test', command: 'node --test test/', source: 'package.json', cwd: '' },
    ],
    integrations: [
      {
        id: 'integration:stripe', key: 'stripe', name: 'Stripe', category: 'payment',
        evidence: [{ path: 'package.json', detail: 'dependency stripe@^17' }],
      },
    ],
    entities: [],
  },
  stats: {
    files: 31, symbols: 148, routes: 9, entities: 7, tests: 18,
    nodesByKind: { capability: 5, module: 8, flow: 3, route: 9, entity: 7, integration: 2, rule: 2 },
    nodesByOrigin: { deterministic: 34, imported: 2 },
    stale: 0,
    lastIndexedAt: indexedAt,
    lastIndexMs: 840,
    estimatedRepoTokens: 18400,
    contextServed: { count: 0, tokens: 0 },
  },
  needsBootstrap: true,
  aiSources: [
    { path: 'CLAUDE.md', tool: 'claude', kind: 'instructions', title: 'Shop App' },
    { path: '.cursor/rules/api-conventions.mdc', tool: 'cursor', kind: 'rules', title: 'API conventions' },
    { path: 'docs/adr/0001-in-memory-store.md', tool: 'generic', kind: 'adr', title: 'In-memory store' },
  ],
});

export function createProjectMock(emit: Emit): AtomicApi['project'] {
  let current: ProjectSummary | null = null;
  const recent: RecentProject[] = [
    { root: ROOT, name: 'shop-app', openedAt: new Date(Date.now() - 86_400_000).toISOString() },
    { root: 'C:/dev/billing-service', name: 'billing-service', openedAt: new Date(Date.now() - 6 * 86_400_000).toISOString() },
  ];
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    async pickFolder() {
      await delay(120);
      return ROOT;
    },
    async open(root) {
      await delay(200);
      current = { ...summary(new Date().toISOString()), root, name: root.split(/[\\/]/).pop() || 'project' };
      return current;
    },
    async current() {
      return current;
    },
    async recent() {
      return recent;
    },
    async reindex() {
      const phases = ['scan', 'extract', 'derive', 'import'] as const;
      for (const phase of phases) {
        for (let done = 1; done <= 3; done++) {
          await delay(150);
          emit('index:progress', { phase, done: done * 10, total: 30, message: `${phase} ${done * 10}/30` });
        }
      }
      emit('index:progress', { phase: 'done', done: 30, total: 30 });
      current = summary(new Date().toISOString());
      emit('project:changed', current);
      return current;
    },
  };
}
