import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContext, buildOverview, estimateTokens, impactOf } from '../../src/context/index.js';
import { createFixture, det, type Fixture } from './seed.js';

let fx: Fixture;
beforeEach(async () => { fx = await createFixture(); });
afterEach(async () => { await fx.cleanup(); });

describe('buildOverview', () => {
  it('summarises the project within the default budget', () => {
    const p = buildOverview(fx.store);
    expect(p.estimatedTokens).toBeLessThanOrEqual(800);
    expect(p.estimatedTokens).toBe(estimateTokens(p.text));
    expect(p.text).toContain('src/orders');
    expect(p.text).toContain('Order management');
    expect(p.text).toContain('Cancellation window');
    expect(p.text).toContain('stripe');
    expect(p.text).toContain('Order');
    expect(p.text).toContain('atomic_context');
    expect(p.text).toMatch(/unmapped modules 2/);
    // instruction bodies are never repeated
    expect(p.text).not.toContain('very long imported instruction');
  });

  it('hard-caps at a small budget, dropping low-priority sections first', () => {
    for (let i = 0; i < 60; i++) fx.store.upsertNode(det(`module:src/m${i}`, 'module', `m${i}`, { files: i }));
    const small = buildOverview(fx.store, { budgetTokens: 120 });
    expect(small.estimatedTokens).toBeLessThanOrEqual(120);
    expect(small.sections).not.toContain('Entities');
    expect(small.sections).toContain('Project');
    const tiny = buildOverview(fx.store, { budgetTokens: 30 });
    expect(tiny.estimatedTokens).toBeLessThanOrEqual(30);
  });

  it('uses the stack stored by the indexer when present', () => {
    fx.store.setMeta('stack', JSON.stringify({ languages: [{ lang: 'typescript', files: 5, loc: 10 }], frameworks: ['express'], packageManagers: ['npm'], scripts: [{ name: 'test', command: 'vitest', source: 'package.json', cwd: '' }] }));
    const t = buildOverview(fx.store).text;
    expect(t).toContain('express');
    expect(t).toContain('test=`vitest`');
  });
});

describe('buildContext', () => {
  it('ranks the rule, flow and orders module for a natural-language task', () => {
    const p = buildContext(fx.store, 'cancel order within 24h');
    const top5 = p.nodeIds.slice(0, 5);
    expect(top5).toContain('rule:cancellation-window');
    expect(top5).toContain('flow:cancel-order');
    expect(top5).toContain('module:src/orders');
    expect(p.nodeIds).not.toContain('note:invoice-numbering');
    expect(p.text).toContain('steps: 1.POST cancel route@src/orders/routes.ts:12');
    expect(p.sections).toContain('Knowledge');
    expect(p.files.length).toBeGreaterThan(0);
    expect(p.files.every((f) => f.reason.length > 0)).toBe(true);
    expect(p.estimatedTokens).toBe(estimateTokens(p.text));
  });

  it('respects the token budget and excludeNodeIds', () => {
    const small = buildContext(fx.store, 'cancel order within 24h', { budgetTokens: 90 });
    expect(small.estimatedTokens).toBeLessThanOrEqual(90);
    expect(small.budgetTokens).toBe(90);

    const ex = buildContext(fx.store, 'cancel order within 24h', { excludeNodeIds: ['rule:cancellation-window'] });
    expect(ex.nodeIds).not.toContain('rule:cancellation-window');
    expect(ex.text).not.toContain('Cancellation window');
    expect(ex.nodeIds).toContain('flow:cancel-order');
  });

  it('never embeds source code or instruction bodies', () => {
    const p = buildContext(fx.store, 'CLAUDE.md style spaces');
    expect(p.text).not.toContain('must never be repeated'.repeat(2));
  });

  it('seeds from literal file paths', () => {
    const p = buildContext(fx.store, 'please look at src/billing/invoice.ts');
    expect(p.nodeIds).toContain('note:invoice-numbering');
    expect(p.nodeIds).toContain('module:src/billing');
    expect(p.files.some((f) => f.path === 'src/billing/invoice.ts' && f.reason === 'mentioned')).toBe(true);
  });

  it('seeds from literal symbol names (camel and snake aware)', () => {
    const camel = buildContext(fx.store, 'why does cancelOrder throw?');
    expect(camel.files.some((f) => f.reason === 'symbol cancelOrder' && f.startLine === 10 && f.endLine === 30)).toBe(true);
    expect(camel.nodeIds).toContain('module:src/orders');
    const snake = buildContext(fx.store, 'rename createOrderItem everywhere');
    expect(snake.files.some((f) => f.path === 'src/orders/service.ts' && f.startLine === 40)).toBe(true);
    const snake2 = buildContext(fx.store, 'fix create_order_item');
    expect(snake2.files.some((f) => f.startLine === 40)).toBe(true);
  });

  it('seeds from route mentions (with concrete ids) and entity names', () => {
    const r = buildContext(fx.store, 'POST /api/orders/123/cancel returns 500');
    expect(r.nodeIds).toContain('route:POST /api/orders/:id/cancel');
    expect(r.files.some((f) => f.reason.startsWith('route POST'))).toBe(true);
    const wrong = buildContext(fx.store, 'GET /api/orders/123/cancel');
    expect(wrong.files.some((f) => f.reason.startsWith('route'))).toBe(false);
    const e = buildContext(fx.store, 'add a field to the Order model');
    expect(e.nodeIds).toContain('entity:Order');
  });

  it('flags stale nodes and returns a hint when nothing matches', () => {
    fx.store.markStaleForFile('src/orders/service.ts', 'changed');
    const p = buildContext(fx.store, 'cancel order within 24h');
    expect(p.text).toContain('Cancellation window (stale)');
    const none = buildContext(fx.store, 'zzzqqq');
    expect(none.nodeIds).toEqual([]);
    expect(none.text).toContain('No stored knowledge');
  });

  it('is fast on a few thousand nodes', () => {
    fx.store.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        fx.store.upsertNode({ id: `note:n${i}`, kind: 'note', title: `Note ${i} widget`, summary: `widget behaviour ${i} order`, origin: 'agent', anchors: [] });
      }
    });
    buildContext(fx.store, 'warm up');
    const t = performance.now();
    buildContext(fx.store, 'cancel order within 24h');
    expect(performance.now() - t).toBeLessThan(150);
  });
});

describe('impactOf', () => {
  it('finds anchored, deterministic and capability-level nodes plus importing tests', () => {
    const { nodes, tests } = impactOf(fx.store, ['src/orders/service.ts']);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('rule:cancellation-window');
    expect(ids).toContain('module:src/orders');
    expect(ids).toContain('capability:order-management');
    expect(tests.map((t) => t.name)).toEqual(['cancelOrder > rejects after 24h']);
  });

  it('reaches a capability through two hops (route → flow → capability)', () => {
    const { nodes } = impactOf(fx.store, ['src/orders/routes.ts']);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('route:POST /api/orders/:id/cancel');
    expect(ids).toContain('entity:Order');
    expect(ids).toContain('flow:cancel-order');
    expect(ids).toContain('capability:order-management');
  });

  it('includes tests of a test file given directly, and is empty for unknown paths', () => {
    const { nodes, tests } = impactOf(fx.store, ['src/orders/service.test.ts']);
    expect(nodes.map((n) => n.id)).toContain('test_suite:src/orders/service.test.ts');
    expect(tests).toHaveLength(1);
    expect(impactOf(fx.store, ['nope.ts'])).toEqual({ nodes: [], tests: [] });
    expect(impactOf(fx.store, [])).toEqual({ nodes: [], tests: [] });
  });
});
