// Mock slice for window.atomic.memory — shop-app fixture (see .work/tasks/D-fixture.md).
// Graph views are derived from the same node/edge arrays, so the UI is always internally consistent.
import type {
  Anchor, ChangeSet, ContextPack, EntityField, EntityRelation, FlowStep, GraphData, GraphEdge, GraphNode,
  GraphView, ImportedSource, KnowledgeEdge, KnowledgeNode, MemoryStats, NodeFilter, NodeKind, NodeOrigin,
  RelKind, SearchHit, SymbolRecord, TestRecord,
} from '@atomic/core/types';
import type { AtomicApi, FileContent, NodeDetail } from '../../../shared/ipc';
import type { Emit } from './index';

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334';
const anchor = (path: string, startLine?: number, endLine?: number, symbol?: string): Anchor =>
  ({ path, startLine, endLine, symbol, hash: HASH });

interface NodeSpec {
  kind: NodeKind;
  key: string;
  title: string;
  summary: string;
  origin?: NodeOrigin;
  status?: KnowledgeNode['status'];
  confidence?: number;
  body?: string;
  data?: Record<string, unknown>;
  anchors?: Anchor[];
  tags?: string[];
  author?: string;
  age?: number;
}

const mk = (s: NodeSpec): KnowledgeNode => ({
  id: `${s.kind}:${s.key}`,
  kind: s.kind,
  title: s.title,
  summary: s.summary,
  body: s.body,
  data: s.data,
  origin: s.origin ?? 'deterministic',
  status: s.status ?? 'fresh',
  confidence: s.confidence ?? (s.origin === 'agent' ? 0.82 : 1),
  anchors: s.anchors ?? [],
  tags: s.tags ?? [],
  author: s.author,
  createdAt: ago((s.age ?? 600) + 30),
  updatedAt: ago(s.age ?? 600),
});

// ───────────────────────────── modules ─────────────────────────────
const MODULES: [string, string, number, number, string][] = [
  ['catalog', 'Catalog', 3, 120, 'Product listing and detail lookups.'],
  ['cart', 'Cart', 4, 160, 'Per-user shopping cart: add, remove, list items.'],
  ['orders', 'Orders', 5, 310, 'Checkout, order lookup and cancellation. Owns pricing.'],
  ['payments', 'Payments', 2, 90, 'Charges through Stripe, or a deterministic fake charge offline.'],
  ['users', 'Users', 2, 70, 'Current user lookup behind the fake auth middleware.'],
  ['notifications', 'Notifications', 1, 45, 'Order confirmation e-mails.'],
];

const modules = MODULES.map(([dir, title, files, loc, summary]) =>
  mk({
    kind: 'module', key: `src/${dir}`, title, summary, data: { files, loc },
    anchors: [anchor(`src/${dir}/service.ts`)],
  }));

// ───────────────────────────── routes ─────────────────────────────
const ROUTES: [string, string, string, string, number][] = [
  // module, method, pattern, file, line
  ['catalog', 'GET', '/api/products', 'src/catalog/routes.ts', 8],
  ['catalog', 'GET', '/api/products/:id', 'src/catalog/routes.ts', 14],
  ['cart', 'GET', '/api/cart', 'src/cart/routes.ts', 9],
  ['cart', 'POST', '/api/cart/items', 'src/cart/routes.ts', 15],
  ['cart', 'DELETE', '/api/cart/items/:productId', 'src/cart/routes.ts', 24],
  ['orders', 'POST', '/api/orders', 'src/orders/routes.ts', 11],
  ['orders', 'GET', '/api/orders/:id', 'src/orders/routes.ts', 22],
  ['orders', 'POST', '/api/orders/:id/cancel', 'src/orders/routes.ts', 31],
  ['users', 'GET', '/api/me', 'src/users/routes.ts', 7],
  ['payments', 'POST', '/api/payments/webhook', 'src/payments/routes.ts', 6],
  ['catalog', 'GET', '/api/health', 'src/api/index.ts', 12],
];
const routes = ROUTES.map(([, method, pattern, path, line]) =>
  mk({
    kind: 'route', key: `${method} ${pattern}`, title: `${method} ${pattern}`,
    summary: `${method} handler registered in ${path}.`, data: { method, pattern, framework: 'express' },
    anchors: [anchor(path, line, line + 6)],
  }));
const routeId = (method: string, pattern: string) => `route:${method} ${pattern}`;

// ───────────────────────────── entities ─────────────────────────────
interface EntitySpec { name: string; fields: EntityField[]; relations: EntityRelation[] }
const f = (name: string, type: string, extra: Partial<EntityField> = {}): EntityField => ({ name, type, ...extra });
const ENTITIES: EntitySpec[] = [
  { name: 'User', fields: [f('id', 'String', { isId: true }), f('email', 'String'), f('name', 'String', { optional: true })],
    relations: [{ field: 'orders', target: 'Order', kind: '1-n' }, { field: 'cart', target: 'Cart', kind: '1-1' }] },
  { name: 'Product', fields: [f('id', 'String', { isId: true }), f('name', 'String'), f('priceCents', 'Int'), f('stock', 'Int')], relations: [] },
  { name: 'Cart', fields: [f('id', 'String', { isId: true }), f('userId', 'String')],
    relations: [{ field: 'items', target: 'CartItem', kind: '1-n' }] },
  { name: 'CartItem', fields: [f('id', 'String', { isId: true }), f('cartId', 'String'), f('productId', 'String'), f('quantity', 'Int')],
    relations: [{ field: 'product', target: 'Product', kind: 'n-1' }] },
  { name: 'Order', fields: [f('id', 'String', { isId: true }), f('userId', 'String'), f('status', 'String'), f('totalCents', 'Int'), f('paidAt', 'DateTime', { optional: true })],
    relations: [{ field: 'items', target: 'OrderItem', kind: '1-n' }, { field: 'payment', target: 'Payment', kind: '1-1' }] },
  { name: 'OrderItem', fields: [f('id', 'String', { isId: true }), f('orderId', 'String'), f('productId', 'String'), f('quantity', 'Int'), f('unitCents', 'Int')],
    relations: [{ field: 'product', target: 'Product', kind: 'n-1' }] },
  { name: 'Payment', fields: [f('id', 'String', { isId: true }), f('orderId', 'String'), f('providerRef', 'String'), f('amountCents', 'Int')], relations: [] },
];
const entities = ENTITIES.map((e, i) =>
  mk({
    kind: 'entity', key: e.name, title: e.name, summary: `${e.name} model (${e.fields.length} fields).`,
    data: { fields: e.fields, relations: e.relations, source: 'prisma' },
    anchors: [anchor('prisma/schema.prisma', 10 + i * 12, 20 + i * 12)],
  }));

// ───────────────────────────── integrations, tests, instructions ─────────────────────────────
const integrations = [
  mk({ kind: 'integration', key: 'stripe', title: 'Stripe', summary: 'Payment provider (category payment). Used when STRIPE_SECRET_KEY is set.',
    data: { category: 'payment' }, anchors: [anchor('src/payments/stripe.ts', 1, 40)] }),
  mk({ kind: 'integration', key: 'smtp', title: 'SMTP', summary: 'Outgoing mail (category email). Configured through SMTP_URL.',
    data: { category: 'email' }, anchors: [anchor('src/notifications/email.ts', 1, 25)] }),
];

const TEST_RECORDS: Record<string, TestRecord[]> = {
  'test/orders.test.ts': [
    { path: 'test/orders.test.ts', line: 8, name: 'OrderService > creates an order from the cart', framework: 'node:test' },
    { path: 'test/orders.test.ts', line: 21, name: 'OrderService > rejects an empty cart', framework: 'node:test' },
    { path: 'test/orders.test.ts', line: 34, name: 'OrderService > cancels a paid order within 24h', framework: 'node:test' },
    { path: 'test/orders.test.ts', line: 47, name: 'OrderService > refuses to cancel after 24h', framework: 'node:test' },
  ],
  'test/pricing.test.ts': [
    { path: 'test/pricing.test.ts', line: 6, name: 'pricing > applies tax per line', framework: 'node:test' },
    { path: 'test/pricing.test.ts', line: 15, name: 'pricing > rounds each line before summing', framework: 'node:test' },
  ],
  'test/cart.test.ts': [
    { path: 'test/cart.test.ts', line: 7, name: 'CartService > adds and merges items', framework: 'node:test' },
    { path: 'test/cart.test.ts', line: 18, name: 'CartService > removes an item', framework: 'node:test' },
  ],
};
const suites = Object.keys(TEST_RECORDS).map((p) =>
  mk({ kind: 'test_suite', key: p, title: p.replace('test/', '').replace('.test.ts', ''), summary: `${TEST_RECORDS[p]!.length} tests in ${p}.`,
    data: { tests: TEST_RECORDS[p]!.length }, anchors: [anchor(p)] }));

const instructions = [
  mk({ kind: 'instruction', key: 'CLAUDE.md#1', title: 'CLAUDE.md — Project overview', origin: 'imported',
    summary: 'Small shop backend: Express 5 API, static vanilla frontend, in-memory store.', anchors: [anchor('CLAUDE.md', 1, 12)] }),
  mk({ kind: 'instruction', key: 'CLAUDE.md#2', title: 'CLAUDE.md — Commands', origin: 'imported',
    summary: 'npm run dev starts the server on 4310; npm test runs node:test suites.', anchors: [anchor('CLAUDE.md', 13, 24)] }),
  mk({ kind: 'instruction', key: 'CLAUDE.md#3', title: 'CLAUDE.md — Conventions', origin: 'imported',
    summary: 'Services never import express; routes stay thin; ESM with .ts import extensions.', anchors: [anchor('CLAUDE.md', 25, 40)] }),
  mk({ kind: 'instruction', key: '.cursor/rules/api-conventions.mdc#1', title: 'Cursor rule — API conventions', origin: 'imported',
    summary: 'JSON errors as { error: string }; validate input at the route; 4xx for client mistakes.',
    anchors: [anchor('.cursor/rules/api-conventions.mdc', 1, 20)] }),
];

// ───────────────────────────── agent knowledge ─────────────────────────────
const step = (order: number, title: string, path?: string, line?: number, symbol?: string, nodeId?: string): FlowStep =>
  ({ order, title, path, line, symbol, nodeId });

const checkoutSteps: FlowStep[] = [
  step(1, 'Shopper presses Checkout in the SPA', 'public/app.js', 88, 'checkout'),
  step(2, 'POST /api/orders reaches the orders route', 'src/orders/routes.ts', 11, 'createOrderHandler', routeId('POST', '/api/orders')),
  step(3, 'Cart must be non-empty and stock available', 'src/orders/service.ts', 24, 'OrderService.create', 'module:src/orders'),
  step(4, 'Total is computed with tax per line', 'src/orders/pricing.ts', 9, 'computeTotal', 'rule:tax-per-line'),
  step(5, 'Payment is charged through Stripe (or fake charge)', 'src/payments/stripe.ts', 18, 'charge', 'integration:stripe'),
  step(6, 'Order row is stored and stock decremented', 'src/orders/repository.ts', 31, 'save', 'entity:Order'),
  step(7, 'Confirmation e-mail is sent', 'src/notifications/email.ts', 12, 'sendOrderConfirmation', 'integration:smtp'),
];
const cancelSteps: FlowStep[] = [
  step(1, 'Shopper presses Cancel order', 'public/app.js', 131, 'cancelOrder'),
  step(2, 'POST /api/orders/:id/cancel reaches the orders route', 'src/orders/routes.ts', 31, 'cancelOrderHandler', routeId('POST', '/api/orders/:id/cancel')),
  step(3, 'Order must be paid and younger than 24h', 'src/orders/service.ts', 62, 'OrderService.cancel', 'rule:cancel-24h'),
  step(4, 'Order status becomes cancelled, stock restored', 'src/orders/repository.ts', 44, 'markCancelled', 'entity:Order'),
];

const agentNodes = [
  mk({ kind: 'capability', key: 'catalog-browsing', title: 'Catalog browsing', origin: 'agent', author: 'claude', age: 180,
    summary: 'Shoppers list products and open a product detail page.',
    body: '## What it does\nShoppers browse the **product list** and open a detail page.\n\n- Read-only; no auth needed.\n- Data comes from the in-memory store (`src/db/memory.ts`).\n\n| Route | Purpose |\n|---|---|\n| `GET /api/products` | list |\n| `GET /api/products/:id` | detail |',
    anchors: [anchor('src/catalog/service.ts', 1, 30), anchor('src/catalog/routes.ts', 8, 20)], tags: ['storefront'] }),
  mk({ kind: 'capability', key: 'checkout-payment', title: 'Checkout & payment', origin: 'agent', author: 'claude', age: 180,
    summary: 'Turns a cart into a paid order: validation, tax pricing, Stripe charge, stock decrement, confirmation e-mail.',
    body: '## Checkout & payment\nA cart becomes a **paid order** in a single request.\n\n1. Validate cart and stock\n2. Compute totals (tax per line)\n3. Charge the payment provider\n4. Persist order, decrement stock\n5. E-mail the confirmation\n\nSee the *Checkout* flow for the exact steps.',
    anchors: [anchor('src/orders/service.ts', 1, 70), anchor('src/payments/stripe.ts', 1, 40)], tags: ['revenue'] }),
  mk({ kind: 'capability', key: 'order-cancellation', title: 'Order cancellation', origin: 'agent', author: 'claude', age: 300, status: 'stale',
    summary: 'Customers can cancel a paid order for 24 hours after payment; stock is restored.',
    anchors: [anchor('src/orders/service.ts', 55, 90)], tags: ['orders'] }),
  mk({ kind: 'flow', key: 'checkout', title: 'Checkout', origin: 'agent', author: 'claude', age: 180,
    summary: 'From the Checkout button to a stored, paid order and a confirmation e-mail.',
    data: { trigger: 'POST /api/orders', steps: checkoutSteps },
    anchors: [anchor('src/orders/service.ts', 20, 60), anchor('src/orders/routes.ts', 11, 20)] }),
  mk({ kind: 'flow', key: 'cancel-order', title: 'Cancel order', origin: 'agent', author: 'claude', age: 300,
    summary: 'Cancelling a paid order inside the 24h window.',
    data: { trigger: 'POST /api/orders/:id/cancel', steps: cancelSteps },
    anchors: [anchor('src/orders/service.ts', 55, 90)] }),
  mk({ kind: 'rule', key: 'cancel-24h', title: 'Cancel only within 24h of payment', origin: 'agent', author: 'claude', age: 300,
    summary: 'An order can only be cancelled while status is paid and less than 24 hours have passed since paidAt.',
    data: { enforcedAt: 'src/orders/service.ts:62' }, anchors: [anchor('src/orders/service.ts', 62, 74, 'OrderService.cancel')] }),
  mk({ kind: 'rule', key: 'tax-per-line', title: 'Tax computed per line', origin: 'agent', author: 'claude', age: 180,
    summary: 'Tax is applied to each order line and rounded per line before summing, never on the grand total.',
    data: { enforcedAt: 'src/orders/pricing.ts:9' }, anchors: [anchor('src/orders/pricing.ts', 9, 22, 'computeTotal')] }),
];

// ───────────────────────────── edges ─────────────────────────────
const edges: KnowledgeEdge[] = [];
const link = (from: string, to: string, rel: RelKind, origin: NodeOrigin = 'deterministic') => edges.push({ from, to, rel, origin });
const M = (d: string) => `module:src/${d}`;
const CAP = { catalog: 'capability:catalog-browsing', checkout: 'capability:checkout-payment', cancel: 'capability:order-cancellation' };

ROUTES.forEach(([mod, method, pattern]) => link(M(mod), routeId(method, pattern), 'exposes'));
link(CAP.catalog, M('catalog'), 'contains', 'agent');
for (const m of ['cart', 'orders', 'payments', 'notifications']) link(CAP.checkout, M(m), 'contains', 'agent');
link(CAP.cancel, M('orders'), 'contains', 'agent');
link(routeId('GET', '/api/products'), CAP.catalog, 'implements', 'agent');
link(routeId('GET', '/api/products/:id'), CAP.catalog, 'implements', 'agent');
link(routeId('POST', '/api/orders'), CAP.checkout, 'implements', 'agent');
link(routeId('POST', '/api/orders/:id/cancel'), CAP.cancel, 'implements', 'agent');
for (const [a, b] of [['cart', 'catalog'], ['orders', 'cart'], ['orders', 'payments'], ['orders', 'notifications'], ['orders', 'catalog'], ['cart', 'users']]) {
  link(M(a!), M(b!), 'depends_on');
}
link(M('catalog'), 'entity:Product', 'reads');
link(M('cart'), 'entity:Cart', 'writes');
link(M('cart'), 'entity:CartItem', 'writes');
link(M('orders'), 'entity:Order', 'writes');
link(M('orders'), 'entity:OrderItem', 'writes');
link(M('orders'), 'entity:Product', 'writes');
link(M('payments'), 'entity:Payment', 'writes');
link(M('users'), 'entity:User', 'reads');
link(M('payments'), 'integration:stripe', 'uses');
link(M('notifications'), 'integration:smtp', 'uses');
link('test_suite:test/orders.test.ts', M('orders'), 'tests');
link('test_suite:test/pricing.test.ts', M('orders'), 'tests');
link('test_suite:test/cart.test.ts', M('cart'), 'tests');
link('test_suite:test/orders.test.ts', CAP.checkout, 'tests', 'agent');
for (const fl of [checkoutSteps, cancelSteps]) {
  const flowId = fl === checkoutSteps ? 'flow:checkout' : 'flow:cancel-order';
  for (const s of fl) if (s.nodeId) link(s.nodeId, flowId, 'step_of', 'agent');
}
link('flow:checkout', CAP.checkout, 'implements', 'agent');
link('flow:cancel-order', CAP.cancel, 'implements', 'agent');
link('rule:cancel-24h', M('orders'), 'governs', 'agent');
link('rule:cancel-24h', CAP.cancel, 'governs', 'agent');
link('rule:tax-per-line', M('orders'), 'governs', 'agent');
link('instruction:CLAUDE.md#3', M('orders'), 'governs', 'imported');
link('instruction:.cursor/rules/api-conventions.mdc#1', M('catalog'), 'governs', 'imported');
link('instruction:.cursor/rules/api-conventions.mdc#1', M('orders'), 'governs', 'imported');
for (const e of ENTITIES) for (const r of e.relations) link(`entity:${e.name}`, `entity:${r.target}`, 'relates');

const nodes: KnowledgeNode[] = [
  ...agentNodes.filter((n) => n.kind === 'capability'), ...modules, ...routes, ...entities, ...integrations, ...suites,
  ...agentNodes.filter((n) => n.kind === 'flow' || n.kind === 'rule'), ...instructions,
];

// ───────────────────────────── change sets ─────────────────────────────
const changes: ChangeSet[] = [
  { id: 'chg_2', at: ago(12), source: 'agent', sessionId: 'sess_1', agentId: 'claude',
    files: [{ path: 'src/orders/service.ts', status: 'modified' }, { path: 'src/orders/pricing.ts', status: 'modified' }, { path: 'test/pricing.test.ts', status: 'added' }],
    affectedNodes: ['module:src/orders', 'rule:tax-per-line', 'flow:checkout', 'test_suite:test/pricing.test.ts'],
    staleNodes: ['capability:order-cancellation'],
    summary: 'Rounded tax per line in computeTotal and added a pricing test.' },
  { id: 'chg_1', at: ago(240), source: 'external',
    files: [{ path: 'src/cart/routes.ts', status: 'modified' }, { path: 'public/app.js', status: 'modified' }],
    affectedNodes: ['module:src/cart', routeId('POST', '/api/cart/items')], staleNodes: [],
    summary: 'Edited outside an agent session.' },
];

const sources: ImportedSource[] = [
  { path: 'CLAUDE.md', tool: 'claude', kind: 'instructions', hash: HASH, title: 'Shop App', sections: [
    { heading: 'Project overview', text: 'Small shop backend…', startLine: 1, endLine: 12 },
    { heading: 'Commands', text: 'npm run dev…', startLine: 13, endLine: 24 },
    { heading: 'Conventions', text: 'Services never import express…', startLine: 25, endLine: 40 },
  ] },
  { path: '.cursor/rules/api-conventions.mdc', tool: 'cursor', kind: 'rules', hash: HASH, title: 'API conventions', sections: [
    { heading: 'API conventions', text: 'JSON errors…', startLine: 1, endLine: 20 },
  ] },
  { path: 'docs/adr/0001-in-memory-store.md', tool: 'generic', kind: 'adr', hash: HASH, title: 'In-memory store', sections: [
    { heading: 'Decision', text: 'Use an in-memory store…', startLine: 1, endLine: 30 },
  ] },
];

// ───────────────────────────── helpers ─────────────────────────────
const byId = new Map(nodes.map((n) => [n.id, n]));
const brief = (n: KnowledgeNode) => ({ id: n.id, kind: n.kind, title: n.title, status: n.status });
const latestChanged = () => new Set(changes[0]?.affectedNodes ?? []);

const graphNode = (n: KnowledgeNode, parent?: string): GraphNode => {
  const out = edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => byId.get(e.from === n.id ? e.to : e.from)).filter(Boolean) as KnowledgeNode[];
  const count = (k: NodeKind) => out.filter((o) => o.kind === k).length;
  const badges: Record<string, number> = {};
  for (const [label, k] of [['routes', 'route'], ['entities', 'entity'], ['tests', 'test_suite']] as const) {
    if (count(k) && (n.kind === 'capability' || n.kind === 'module')) badges[label] = count(k);
  }
  return {
    id: n.id, kind: n.kind, label: n.title,
    sublabel: n.kind === 'module' ? `${(n.data?.files as number) ?? 0} files` : n.kind === 'route' ? undefined : n.kind,
    status: n.status, origin: n.origin, badges: Object.keys(badges).length ? badges : undefined,
    changed: latestChanged().has(n.id), parent,
  };
};

const toEdge = (e: KnowledgeEdge): GraphEdge => ({ from: e.from, to: e.to, rel: e.rel });

function graph(view: GraphView, focus?: string): GraphData {
  const pick = (ids: Set<string>, parents = new Map<string, string>()): GraphData => ({
    view, focus,
    nodes: [...ids].map((id) => byId.get(id)).filter((n): n is KnowledgeNode => !!n).map((n) => graphNode(n, parents.get(n.id))),
    edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map(toEdge),
  });
  if (view === 'system') {
    const kinds = new Set<NodeKind>(['capability', 'module', 'route', 'entity', 'integration', 'test_suite']);
    const ids = new Set(nodes.filter((n) => kinds.has(n.kind)).map((n) => n.id));
    const parents = new Map(edges.filter((e) => e.rel === 'exposes').map((e) => [e.to, e.from]));
    const g = pick(ids, parents);
    g.edges = g.edges.filter((e) => e.rel !== 'exposes' && e.rel !== 'relates');
    return g;
  }
  if (view === 'data') return pick(new Set(nodes.filter((n) => n.kind === 'entity').map((n) => n.id)));
  if (view === 'flow') {
    const flow = focus ? byId.get(focus) : undefined;
    const steps = ((flow?.data?.steps as FlowStep[] | undefined) ?? []).filter((s) => s.nodeId && byId.has(s.nodeId));
    const g = pick(new Set([focus ?? '', ...steps.map((s) => s.nodeId!)]));
    g.edges = g.edges.filter((e) => e.rel === 'step_of');
    return g;
  }
  const around = new Set<string>(focus ? [focus] : []);
  for (const e of edges) {
    if (e.from === focus) around.add(e.to);
    if (e.to === focus) around.add(e.from);
  }
  return pick(around);
}

const symbolsFor = (n: KnowledgeNode): SymbolRecord[] =>
  n.anchors.filter((a) => a.path.endsWith('.ts')).flatMap((a) => {
    const base = a.symbol ?? a.path.split('/').pop()!.replace(/\.ts$/, '');
    const name = base.split('.').pop()!;
    return [{ id: `${a.path}#${name}@${a.startLine ?? 1}`, path: a.path, name, kind: 'function' as const, startLine: a.startLine ?? 1,
      endLine: a.endLine ?? (a.startLine ?? 1) + 12, exported: true, signature: `${name}(input: unknown): Promise<unknown>` }];
  });

function testsFor(id: string): TestRecord[] {
  const suites = edges.filter((e) => e.rel === 'tests' && (e.to === id || e.from === id))
    .map((e) => (e.from === id ? e.to : e.from)).filter((s) => s.startsWith('test_suite:'));
  if (id.startsWith('test_suite:')) suites.push(id);
  return suites.flatMap((s) => TEST_RECORDS[s.slice('test_suite:'.length)] ?? []);
}

function detail(id: string): NodeDetail | null {
  const node = byId.get(id);
  if (!node) return null;
  return {
    node,
    outgoing: edges.filter((e) => e.from === id).map((e) => ({ ...e, target: byId.has(e.to) ? brief(byId.get(e.to)!) : undefined })),
    incoming: edges.filter((e) => e.to === id).map((e) => ({ ...e, source: byId.has(e.from) ? brief(byId.get(e.from)!) : undefined })),
    symbols: symbolsFor(node),
    tests: testsFor(id),
    changes: changes.filter((c) => c.affectedNodes.includes(id) || c.staleNodes.includes(id)).slice(0, 10),
  };
}

function stats(): MemoryStats {
  const nodesByKind: MemoryStats['nodesByKind'] = {};
  const nodesByOrigin: MemoryStats['nodesByOrigin'] = {};
  for (const n of nodes) {
    nodesByKind[n.kind] = (nodesByKind[n.kind] ?? 0) + 1;
    nodesByOrigin[n.origin] = (nodesByOrigin[n.origin] ?? 0) + 1;
  }
  return {
    files: 31, symbols: 148, routes: routes.length, entities: entities.length, tests: Object.values(TEST_RECORDS).flat().length,
    nodesByKind, nodesByOrigin, stale: nodes.filter((n) => n.status === 'stale').length,
    lastIndexedAt: ago(12), lastIndexMs: 840, estimatedRepoTokens: 18400, contextServed: { count: 3, tokens: 2100 },
  };
}

const FILES: Record<string, string> = {
  'src/orders/pricing.ts': `import type { CartLine } from '../cart/types.ts';

const TAX_RATE = 0.08;

export interface PricedLine { productId: string; quantity: number; subtotalCents: number; taxCents: number }

/** Tax is rounded per line, then summed (see rule "Tax computed per line"). */
export function computeTotal(lines: CartLine[]): { lines: PricedLine[]; totalCents: number } {
  const priced = lines.map((l) => {
    const subtotalCents = l.unitCents * l.quantity;
    return { productId: l.productId, quantity: l.quantity, subtotalCents, taxCents: Math.round(subtotalCents * TAX_RATE) };
  });
  return { lines: priced, totalCents: priced.reduce((sum, l) => sum + l.subtotalCents + l.taxCents, 0) };
}
`,
  'src/orders/service.ts': `import { computeTotal } from './pricing.ts';
import type { PaymentGateway } from '../payments/stripe.ts';

const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;

export class OrderService {
  constructor(private readonly deps: { payments: PaymentGateway }) {}

  async create(userId: string) {
    // validates the cart, prices it, charges, stores the order
    throw new Error('not shown');
  }

  cancel(order: { status: string; paidAt?: Date }) {
    if (order.status !== 'paid') throw new Error('Only paid orders can be cancelled');
    if (!order.paidAt || Date.now() - order.paidAt.getTime() > CANCEL_WINDOW_MS) throw new Error('Cancellation window closed');
  }
}
`,
};

function readFile(path: string): FileContent | null {
  const content = FILES[path] ?? (path.endsWith('.ts')
    ? `// ${path}\nexport function placeholder(): string {\n  return '${path}';\n}\n`
    : path.endsWith('.md') ? `# ${path}\n\nProject notes.\n` : null);
  return content === null ? null : { path, content, lang: path.endsWith('.ts') ? 'typescript' : 'markdown', complete: true };
}

export function createMemoryMock(emit: Emit): AtomicApi['memory'] {
  const delay = <T,>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  const touch = (affected: string[], summary: string) => {
    const cs: ChangeSet = { id: `chg_${changes.length + 1}`, at: new Date().toISOString(), source: 'index', files: [], affectedNodes: affected, staleNodes: [], summary };
    changes.unshift(cs);
    emit('memory:changed', cs);
  };

  return {
    stats: () => delay(stats()),
    listNodes: (filter?: NodeFilter) => delay(nodes.filter((n) =>
      (!filter?.kinds?.length || filter.kinds.includes(n.kind)) &&
      (!filter?.status?.length || filter.status.includes(n.status)) &&
      (!filter?.origin?.length || filter.origin.includes(n.origin)) &&
      (!filter?.paths?.length || n.anchors.some((a) => filter.paths!.includes(a.path)))).slice(0, filter?.limit ?? 1000)),
    getNode: (id) => delay(detail(id)),
    search(query) {
      const q = query.trim().toLowerCase();
      const hits: SearchHit[] = q ? nodes.filter((n) => `${n.title} ${n.summary}`.toLowerCase().includes(q)).map((n) => ({
        type: 'node' as const, id: n.id, kind: n.kind, title: n.title, snippet: n.summary, path: n.anchors[0]?.path, line: n.anchors[0]?.startLine,
        score: n.title.toLowerCase().includes(q) ? 2 : 1,
      })).sort((a, b) => b.score - a.score) : [];
      return delay(hits);
    },
    graph: (view, focus) => delay(graph(view, focus)),
    changes: (limit = 50) => delay(changes.slice(0, limit)),
    readFile: (path) => delay(readFile(path)),
    async previewContext(task, budgetTokens = 2000): Promise<ContextPack> {
      const picked = nodes.filter((n) => ['capability:checkout-payment', 'rule:tax-per-line', 'module:src/orders'].includes(n.id));
      const text = `# Task\n${task}\n\n${picked.map((n) => `## ${n.title}\n${n.summary}`).join('\n\n')}`;
      return delay({
        task, budgetTokens, estimatedTokens: Math.ceil(text.length / 4), nodeIds: picked.map((n) => n.id),
        files: [{ path: 'src/orders/pricing.ts', startLine: 9, endLine: 22, reason: 'rule anchor' }],
        sections: picked.map((n) => n.title), text,
      });
    },
    impact(paths) {
      const direct = nodes.filter((n) => n.anchors.some((a) => paths.includes(a.path)) && n.kind !== 'instruction');
      const ids = new Set(direct.map((n) => n.id));
      for (const e of edges) {
        if (ids.has(e.from) && e.rel !== 'governs') ids.add(e.to);
        if (ids.has(e.to) && (e.rel === 'tests' || e.rel === 'implements')) ids.add(e.from);
      }
      const hit = [...ids].map((id) => byId.get(id)).filter((n): n is KnowledgeNode => !!n);
      return delay({ nodes: hit, tests: hit.flatMap((n) => testsFor(n.id)).filter((t, i, a) => a.findIndex((x) => x.name === t.name) === i) });
    },
    sources: () => delay(sources),
    async addNote(input) {
      const key = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || String(nodes.length);
      const node = mk({
        kind: input.kind, key, title: input.title, summary: input.summary, origin: 'user', age: 0,
        status: input.anchors?.length ? 'fresh' : 'unverified', confidence: 1,
        anchors: (input.anchors ?? []).map((a) => anchor(a.path, a.startLine, a.endLine)),
      });
      nodes.push(node);
      byId.set(node.id, node);
      touch([node.id], `Added ${input.kind}: ${input.title}`);
      return delay(node);
    },
    async markVerified(id) {
      const node = byId.get(id);
      if (!node) return delay(null);
      node.status = 'fresh';
      node.updatedAt = new Date().toISOString();
      touch([id], `Verified ${node.title}`);
      return delay(node);
    },
  };
}
