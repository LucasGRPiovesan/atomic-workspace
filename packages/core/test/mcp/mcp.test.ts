import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/index.js';
import { createFixture, type Fixture } from '../context/seed.js';

let fx: Fixture;
let client: Client;

beforeEach(async () => {
  fx = await createFixture();
  const server = createMcpServer(fx.store, 'claude');
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  await fx.cleanup();
});

const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text: string }[];
  return { text: content.map((c) => c.text).join('\n'), isError: res.isError === true };
};
const rev = (): number => Number(fx.store.getMeta('rev') ?? 0);

describe('tools', () => {
  it('lists the atomic_* tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'atomic_context', 'atomic_impact', 'atomic_node', 'atomic_overview', 'atomic_record',
      'atomic_search', 'atomic_stale', 'atomic_symbol', 'atomic_unmapped', 'atomic_verify',
    ]);
    expect(tools.every((t) => (t.description ?? '').length > 20)).toBe(true);
  });

  it('atomic_overview and atomic_context return compact text; context records served tokens', async () => {
    expect((await call('atomic_overview')).text).toContain('Order management');
    const before = fx.store.stats().contextServed;
    const ctx = await call('atomic_context', { task: 'cancel order within 24h', budget_tokens: 400 });
    expect(ctx.text).toContain('Cancellation window');
    const after = fx.store.stats().contextServed;
    expect(after.count).toBe(before.count + 1);
    expect(after.tokens).toBeGreaterThan(before.tokens);
  });

  it('atomic_search, atomic_symbol, atomic_node, atomic_impact', async () => {
    const s = await call('atomic_search', { query: 'cancellation', limit: 5 });
    expect(s.text).toContain('rule:cancellation-window · rule · Cancellation window');
    expect((await call('atomic_search', { query: 'zzzz' })).text).toBe('no results');
    expect((await call('atomic_search', { query: 'cancel', kinds: ['function'] })).text).toContain('src/orders/service.ts:10');

    const sym = await call('atomic_symbol', { name: 'cancelOrder' });
    expect(sym.text).toContain('cancelOrder · function · src/orders/service.ts:10-30 · cancelOrder(id: string)');

    const node = await call('atomic_node', { id: 'capability:order-management' });
    expect(node.text).toContain('contains: module:src/orders');
    expect(node.text).toMatch(/implements: .*rule:cancellation-window/);
    expect(node.text).toMatch(/implements: .*flow:cancel-order/);
    const flow = await call('atomic_node', { id: 'flow:cancel-order' });
    expect(flow.text).toContain('step 1: POST cancel route');
    expect(flow.text).toContain('← implements: capability:order-management');
    expect((await call('atomic_node', { id: 'nope' })).isError).toBe(true);

    const imp = await call('atomic_impact', { paths: ['src/orders/service.ts'] });
    expect(imp.text).toContain('capability:order-management');
    expect(imp.text).toContain('src/orders/service.test.ts:5');
  });

  it('atomic_node caps long bodies', async () => {
    fx.store.upsertNode({ id: 'note:big', kind: 'note', title: 'Big', summary: 's', body: 'x'.repeat(5000), origin: 'user', anchors: [] });
    const r = await call('atomic_node', { id: 'note:big' });
    expect(r.text.length).toBeLessThan(2300);
    expect(r.text).toContain('[truncated]');
  });
});

describe('atomic_record', () => {
  it('creates nodes with hashes, author, edges and a change set; bumps rev', async () => {
    const r0 = rev();
    const res = await call('atomic_record', {
      items: [
        {
          kind: 'capability', title: 'Billing', summary: 'Invoices and numbering.',
          anchors: [{ path: 'src/billing/invoice.ts', startLine: 1, endLine: 20 }],
          relations: [{ rel: 'contains', to: 'module:src/billing' }, { rel: 'relates', to: 'rule:billing-vat' }],
          tags: ['money'],
        },
        { kind: 'rule', title: 'Billing VAT', summary: 'VAT is added at invoice time.', anchors: [{ path: 'src/billing/invoice.ts' }] },
        {
          kind: 'flow', title: 'Pay invoice', summary: 'Pay flow.', anchors: [],
          steps: [{ title: 'start', nodeId: 'module:src/payments' }, { title: 'charge', path: 'src/payments/stripe.ts', line: 3 }],
        },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.text.split('\n')).toEqual(['created capability:billing', 'created rule:billing-vat', 'created flow:pay-invoice']);

    const cap = fx.store.getNode('capability:billing');
    expect(cap).toMatchObject({ origin: 'agent', author: 'claude', status: 'fresh', tags: ['money'], confidence: 0.7 });
    expect(cap?.anchors).toEqual([{ path: 'src/billing/invoice.ts', startLine: 1, endLine: 20, hash: 'h-invoice' }]);
    expect(fx.store.edges({ from: 'capability:billing' })).toEqual([
      { from: 'capability:billing', to: 'module:src/billing', rel: 'contains', origin: 'agent' },
      { from: 'capability:billing', to: 'rule:billing-vat', rel: 'relates', origin: 'agent' },
    ]);
    expect(fx.store.getNode('flow:pay-invoice')?.data?.steps).toHaveLength(2);
    expect(fx.store.edges({ rel: 'step_of', to: 'flow:pay-invoice' })).toEqual([
      { from: 'module:src/payments', to: 'flow:pay-invoice', rel: 'step_of', origin: 'agent' },
    ]);
    const change = fx.store.listChanges(1)[0];
    expect(change).toMatchObject({ source: 'agent', agentId: 'claude', summary: 'recorded 3 knowledge items' });
    expect(rev()).toBe(r0 + 1);
  });

  it('reports unknown paths per item and still saves the others', async () => {
    const r0 = rev();
    const res = await call('atomic_record', {
      items: [
        { kind: 'rule', title: 'Bad anchor', summary: 'x', anchors: [{ path: 'src/ghost.ts' }] },
        { kind: 'rule', title: 'Bad relation', summary: 'x', anchors: [], relations: [{ rel: 'governs', to: 'module:ghost' }] },
        { kind: 'note', title: 'Good one', summary: 'saved', anchors: [{ path: 'src/payments/stripe.ts' }] },
      ],
    });
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('error rule:bad-anchor: unknown path src/ghost.ts');
    expect(lines[1]).toContain('unknown relation target module:ghost');
    expect(lines[2]).toBe('created note:good-one');
    expect(fx.store.getNode('rule:bad-anchor')).toBeUndefined();
    expect(fx.store.getNode('note:good-one')).toBeDefined();
    expect(rev()).toBe(r0 + 1);

    const allBad = await call('atomic_record', { items: [{ kind: 'note', title: 'x', summary: 'y', anchors: [{ path: 'nope' }] }] });
    expect(allBad.text).toContain('error');
    expect(rev()).toBe(r0 + 1);
  });

  it('re-recording the same title updates in place (no duplicate)', async () => {
    const item = { kind: 'rule', title: 'Refund policy', summary: 'v1', anchors: [{ path: 'src/payments/stripe.ts' }], relations: [{ rel: 'governs', to: 'module:src/payments' }] };
    expect((await call('atomic_record', { items: [item] })).text).toBe('created rule:refund-policy');
    const before = fx.store.getNode('rule:refund-policy');
    const again = await call('atomic_record', { items: [{ ...item, summary: 'v2', relations: [{ rel: 'governs', to: 'module:src/billing' }] }] });
    expect(again.text).toBe('updated rule:refund-policy');
    expect(fx.store.listNodes({ kinds: ['rule'] }).filter((n) => n.title === 'Refund policy')).toHaveLength(1);
    const after = fx.store.getNode('rule:refund-policy');
    expect(after?.summary).toBe('v2');
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(fx.store.edges({ from: 'rule:refund-policy' }).map((e) => e.to)).toEqual(['module:src/billing']);
  });

  it('honours an explicit id', async () => {
    await call('atomic_record', { items: [{ kind: 'note', id: 'note:order-docs', title: 'Order docs', summary: 'documented', anchors: [] }] });
    expect(fx.store.getNode('note:order-docs')?.summary).toBe('documented');
  });

  it('rejects ids outside the item kind namespace and oversized input', async () => {
    const res = await call('atomic_record', { items: [{ kind: 'rule', id: 'route:GET /later', title: 'Squat', summary: 's', anchors: [] }] });
    expect(res.text).toContain('error route:GET /later: id must start with "rule:"');
    expect(fx.store.getNode('route:GET /later')).toBeFalsy();
    const big = await call('atomic_record', { items: [{ kind: 'note', title: 'Big', summary: 's', body: 'x'.repeat(20001), anchors: [] }] });
    expect(big.isError).toBe(true);
    expect(fx.store.getNode('note:big')).toBeFalsy();
  });

  it('refuses to overwrite deterministic knowledge and drops edges to rejected items', async () => {
    const before = fx.store.getNode('entity:Order');
    const res = await call('atomic_record', { items: [
      { kind: 'entity', id: 'entity:Order', title: 'Order', summary: 'overwrite', anchors: [] },
      { kind: 'note', title: 'Order lifecycle', summary: 'links to the rejected item', anchors: [], relations: [{ rel: 'relates', to: 'entity:Order' }] },
      { kind: 'note', title: 'Dangling', summary: 'targets a failed item', anchors: [], relations: [{ rel: 'relates', to: 'note:bad' }] },
      { kind: 'note', id: 'note:bad', title: 'Bad', summary: 'unknown anchor', anchors: [{ path: 'nope.ts' }] },
    ] });
    expect(res.text).toMatch(/error entity:Order: .*cannot be overwritten/);
    expect(fx.store.getNode('entity:Order')).toEqual(before);
    expect(fx.store.getNode('note:order-lifecycle')).toBeTruthy();
    expect(fx.store.getNode('note:bad')).toBeFalsy();
    expect(fx.store.edges({ from: 'note:dangling' })).toEqual([]);
  });
});

describe('stale / verify loop and unmapped', () => {
  it('lists stale nodes with what changed, then verifies them', async () => {
    expect((await call('atomic_stale')).text).toBe('nothing stale');
    fx.store.upsertExtraction({ file: { path: 'src/orders/service.ts', hash: 'h-new', lang: 'typescript', loc: 1, size: 1, isTest: false }, symbols: [], imports: [], routes: [], entities: [], tests: [], envVars: [] });
    const stale = fx.store.markStaleForFile('src/orders/service.ts', 'h-new');
    expect(stale.sort()).toEqual(['capability:order-management', 'rule:cancellation-window']);

    const list = await call('atomic_stale');
    expect(list.text).toContain('rule:cancellation-window · Cancellation window · src/orders/service.ts:10-30 changed');
    expect(list.text).toContain('capability:order-management');

    const r0 = rev();
    const v = await call('atomic_verify', { ids: ['rule:cancellation-window', 'ghost'] });
    expect(v.text).toBe('rule:cancellation-window: fresh\nghost: not found');
    expect(fx.store.getNode('rule:cancellation-window')?.anchors[0].hash).toBe('h-new');
    expect(rev()).toBe(r0 + 1);
    expect((await call('atomic_stale')).text).not.toContain('rule:cancellation-window');
  });

  it('lists unmapped modules/routes/entities and shrinks as knowledge is recorded', async () => {
    const first = (await call('atomic_unmapped')).text;
    expect(first).toContain('modules (2):');
    expect(first).toContain('- module:src/billing');
    expect(first).toContain('- module:src/payments');
    expect(first).not.toContain('module:src/orders');
    expect(first).not.toContain('route:POST');
    expect(first).not.toContain('entity:Order');

    await call('atomic_record', { items: [{ kind: 'capability', title: 'Billing', summary: 's', anchors: [], relations: [{ rel: 'contains', to: 'module:src/billing' }] }] });
    const second = (await call('atomic_unmapped')).text;
    expect(second).toContain('modules (1):');
    expect(second).not.toContain('module:src/billing');

    await call('atomic_record', { items: [{ kind: 'capability', title: 'Payments', summary: 's', anchors: [], relations: [{ rel: 'contains', to: 'module:src/payments' }] }] });
    expect((await call('atomic_unmapped')).text).toBe('everything is mapped');
  });

  it('caps the unmapped worklist at 60 lines', async () => {
    fx.store.transaction(() => {
      for (let i = 0; i < 100; i++) fx.store.upsertNode({ id: `module:src/gen${i}`, kind: 'module', title: `gen${i}`, summary: 'g', origin: 'deterministic', anchors: [] });
    });
    const lines = (await call('atomic_unmapped')).text.split('\n');
    expect(lines.length).toBe(61);
    expect(lines[60]).toMatch(/more lines/);
  });
});
