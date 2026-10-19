import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store/index.js';
import type { MemoryStore } from '../../src/contracts.js';
import type { FileExtraction, KnowledgeNodeInput } from '../../src/types.js';

export interface Fixture {
  root: string;
  store: MemoryStore;
  cleanup(): Promise<void>;
}

const file = (path: string, hash: string, isTest = false): FileExtraction['file'] => ({ path, hash, lang: 'typescript', loc: 50, size: 800, isTest });

export const det = (id: string, kind: KnowledgeNodeInput['kind'], title: string, data?: Record<string, unknown>): KnowledgeNodeInput => ({
  id, kind, title, summary: title, origin: 'deterministic', anchors: [], data,
});

/** A small shop-like project: orders (with a cancellation rule + flow), billing, payments. */
export async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'atomic-ctx-'));
  const store = openStore(root);

  store.upsertExtraction({
    file: file('src/orders/service.ts', 'h-service'),
    symbols: [
      { id: 'src/orders/service.ts#cancelOrder@10', path: 'src/orders/service.ts', name: 'cancelOrder', kind: 'function', startLine: 10, endLine: 30, exported: true, signature: 'cancelOrder(id: string): Promise<Order>' },
      { id: 'src/orders/service.ts#create_order_item@40', path: 'src/orders/service.ts', name: 'create_order_item', kind: 'function', startLine: 40, endLine: 50, exported: true },
    ],
    imports: [], routes: [], entities: [], tests: [], envVars: [],
  });
  store.upsertExtraction({
    file: file('src/orders/routes.ts', 'h-routes'),
    symbols: [],
    imports: [{ from: 'src/orders/routes.ts', specifier: './service', resolved: 'src/orders/service.ts', names: ['cancelOrder'], external: false, line: 1 }],
    routes: [{ id: 'route:POST /api/orders/:id/cancel', path: 'src/orders/routes.ts', line: 12, method: 'POST', pattern: '/api/orders/:id/cancel', framework: 'express', handler: 'cancelOrder' }],
    entities: [{ id: 'entity:Order', name: 'Order', source: 'typeorm', path: 'src/orders/routes.ts', line: 3, fields: [], relations: [] }],
    tests: [], envVars: [],
  });
  store.upsertExtraction({
    file: file('src/orders/service.test.ts', 'h-test', true),
    symbols: [],
    imports: [{ from: 'src/orders/service.test.ts', specifier: './service', resolved: 'src/orders/service.ts', names: ['cancelOrder'], external: false, line: 1 }],
    routes: [], entities: [],
    tests: [{ path: 'src/orders/service.test.ts', line: 5, name: 'cancelOrder > rejects after 24h', framework: 'vitest' }],
    envVars: [],
  });
  store.upsertExtraction({ file: file('src/billing/invoice.ts', 'h-invoice'), symbols: [], imports: [], routes: [], entities: [], tests: [], envVars: [] });
  store.upsertExtraction({ file: file('src/payments/stripe.ts', 'h-stripe'), symbols: [], imports: [], routes: [], entities: [], tests: [], envVars: [] });

  for (const m of [['src/orders', 3], ['src/billing', 1], ['src/payments', 1]] as const) {
    store.upsertNode(det(`module:${m[0]}`, 'module', m[0], { files: m[1], loc: 100 }));
  }
  store.upsertNode(det('route:POST /api/orders/:id/cancel', 'route', 'POST /api/orders/:id/cancel'));
  store.upsertNode(det('entity:Order', 'entity', 'Order'));
  store.upsertNode(det('test_suite:src/orders/service.test.ts', 'test_suite', 'service.test.ts'));

  store.upsertNode({
    id: 'capability:order-management', kind: 'capability', title: 'Order management',
    summary: 'Create, pay and cancel customer orders.', origin: 'agent', anchors: [{ path: 'src/orders/service.ts', hash: 'h-service' }],
  });
  store.upsertNode({
    id: 'rule:cancellation-window', kind: 'rule', title: 'Cancellation window',
    summary: 'An order can only be cancelled within 24h of creation; afterwards support must refund manually.',
    origin: 'agent', anchors: [{ path: 'src/orders/service.ts', hash: 'h-service', startLine: 10, endLine: 30 }],
  });
  store.upsertNode({
    id: 'flow:cancel-order', kind: 'flow', title: 'Cancel order flow',
    summary: 'Customer cancels an order: validate window, release stock, refund.',
    origin: 'agent', anchors: [{ path: 'src/orders/routes.ts', hash: 'h-routes', startLine: 12 }],
    data: { steps: [
      { order: 1, title: 'POST cancel route', path: 'src/orders/routes.ts', line: 12, nodeId: 'route:POST /api/orders/:id/cancel' },
      { order: 2, title: 'check 24h window', path: 'src/orders/service.ts', line: 15 },
    ] },
  });
  store.upsertNode({
    id: 'note:invoice-numbering', kind: 'note', title: 'Invoice numbering', summary: 'Invoices are numbered per fiscal year.',
    origin: 'agent', anchors: [{ path: 'src/billing/invoice.ts', hash: 'h-invoice' }],
  });
  store.upsertNode({
    id: 'instruction:CLAUDE.md#1', kind: 'instruction', title: 'CLAUDE.md: Style', summary: 'Use 2 spaces. A very long imported instruction body that must never be repeated.',
    origin: 'imported', anchors: [],
  });

  store.upsertEdge({ from: 'capability:order-management', to: 'module:src/orders', rel: 'contains', origin: 'agent' });
  store.upsertEdge({ from: 'capability:order-management', to: 'rule:cancellation-window', rel: 'implements', origin: 'agent' });
  store.upsertEdge({ from: 'capability:order-management', to: 'flow:cancel-order', rel: 'implements', origin: 'agent' });
  store.upsertEdge({ from: 'module:src/orders', to: 'route:POST /api/orders/:id/cancel', rel: 'exposes', origin: 'deterministic' });
  store.upsertEdge({ from: 'route:POST /api/orders/:id/cancel', to: 'flow:cancel-order', rel: 'step_of', origin: 'agent' });
  store.upsertEdge({ from: 'rule:cancellation-window', to: 'module:src/orders', rel: 'governs', origin: 'agent' });
  store.upsertEdge({ from: 'module:src/orders', to: 'entity:Order', rel: 'reads', origin: 'deterministic' });
  store.setIntegrations([{ id: 'integration:stripe', key: 'stripe', name: 'Stripe', category: 'payment', evidence: [] }]);

  return { root, store, cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}
