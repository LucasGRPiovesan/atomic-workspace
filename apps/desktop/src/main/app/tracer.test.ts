import { describe, expect, it } from 'vitest';
import type { HttpMethod, RouteRecord } from '@atomic/core/types';
import type { TraceEvent } from '../../shared/ipc';
import { Tracer, isTracedRequest, matchRoute } from './tracer';

const route = (method: HttpMethod, pattern: string): RouteRecord => ({
  id: `route:${method} ${pattern}`, path: 'src/routes.ts', line: 1, method, pattern, framework: 'express',
});

const ROUTES = [
  route('GET', '/api/orders/:id'),
  route('GET', '/api/orders/new'),
  route('POST', '/api/orders'),
  route('ANY', '/api/health'),
  route('GET', '/'),
];

describe('matchRoute', () => {
  it('prefers static segments over params', () => {
    expect(matchRoute('GET', '/api/orders/new', ROUTES)?.pattern).toBe('/api/orders/new');
    expect(matchRoute('GET', '/api/orders/42', ROUTES)?.pattern).toBe('/api/orders/:id');
  });
  it('static wins regardless of registration order', () => {
    expect(matchRoute('GET', '/api/orders/new', [...ROUTES].reverse())?.pattern).toBe('/api/orders/new');
  });
  it('requires the method to match, ANY matches any', () => {
    expect(matchRoute('DELETE', '/api/orders', ROUTES)).toBeUndefined();
    expect(matchRoute('POST', '/api/orders', ROUTES)?.id).toBe('route:POST /api/orders');
    expect(matchRoute('PATCH', '/api/health', ROUTES)?.method).toBe('ANY');
  });
  it('an exact method beats ANY on the same pattern', () => {
    const rs = [route('ANY', '/x'), route('GET', '/x')];
    expect(matchRoute('GET', '/x', rs)?.method).toBe('GET');
    expect(matchRoute('PUT', '/x', rs)?.method).toBe('ANY');
  });
  it('ignores trailing slash, query and hash', () => {
    expect(matchRoute('post', '/api/orders/', ROUTES)?.pattern).toBe('/api/orders');
    expect(matchRoute('GET', '/api/orders/7?expand=items#top', ROUTES)?.pattern).toBe('/api/orders/:id');
    expect(matchRoute('GET', '/?x=1', ROUTES)?.pattern).toBe('/');
  });
  it('does not match a different segment count or an unknown path', () => {
    expect(matchRoute('GET', '/api/orders/1/items', ROUTES)).toBeUndefined();
    expect(matchRoute('GET', '/nope', ROUTES)).toBeUndefined();
  });
  it('wildcard routes lose to anything more specific', () => {
    const rs = [route('GET', '/api/*'), route('GET', '/api/:id')];
    expect(matchRoute('GET', '/api/abc', rs)?.pattern).toBe('/api/:id');
    expect(matchRoute('GET', '/api/a/b', rs)?.pattern).toBe('/api/*');
  });
});

describe('isTracedRequest', () => {
  it('skips static assets by resource type and extension', () => {
    expect(isTracedRequest('http://localhost:1/app.js', 'script')).toBe(false);
    expect(isTracedRequest('http://localhost:1/a.css', 'stylesheet')).toBe(false);
    expect(isTracedRequest('http://localhost:1/logo.png', 'image')).toBe(false);
    expect(isTracedRequest('http://localhost:1/f.woff2')).toBe(false);
    expect(isTracedRequest('http://localhost:1/main.js.map')).toBe(false);
    expect(isTracedRequest('http://localhost:1/api/x', 'xhr')).toBe(true);
    expect(isTracedRequest('http://localhost:1/', 'mainFrame')).toBe(true);
  });
});

function makeTracer(origin = 'http://localhost:4310') {
  const emitted: TraceEvent[] = [];
  let now = 1_000_000;
  const tracer = new Tracer({
    routes: () => ROUTES,
    related: (id) => (id === 'route:POST /api/orders' ? [{ id: 'capability:checkout', kind: 'capability', title: 'Checkout' }] : []),
    handlerOf: (r) => ({ path: r.path, line: r.line }),
    emit: (_c, e) => emitted.push(e),
    appOrigin: () => origin,
    now: () => now,
  });
  return { tracer, emitted, setNow: (n: number) => { now = n; } };
}

const req = (over: Partial<Parameters<Tracer['onRequest']>[0]> = {}) => ({
  method: 'POST', url: 'http://localhost:4310/api/orders', statusCode: 201, startedAt: 1_000_200, durationMs: 34,
  resourceType: 'xhr', ...over,
});

describe('Tracer', () => {
  it('traces matched requests with handler and related nodes', () => {
    const { tracer } = makeTracer();
    const ev = tracer.onRequest(req())!;
    expect(ev.kind).toBe('request');
    expect(ev.pathname).toBe('/api/orders');
    expect(ev.match?.pattern).toBe('POST /api/orders');
    expect(ev.match?.handler).toEqual({ path: 'src/routes.ts', line: 1 });
    expect(ev.match?.related[0].id).toBe('capability:checkout');
  });
  it('keeps unmatched requests without a match', () => {
    const { tracer } = makeTracer();
    expect(tracer.onRequest(req({ url: 'http://localhost:4310/api/unknown' }))?.match).toBeUndefined();
  });
  it('ignores other origins and static assets', () => {
    const { tracer, emitted } = makeTracer();
    expect(tracer.onRequest(req({ url: 'https://api.stripe.com/v1/charges' }))).toBeUndefined();
    expect(tracer.onRequest(req({ url: 'http://localhost:4310/assets/app.js', resourceType: 'script' }))).toBeUndefined();
    expect(tracer.onRequest(req({ url: 'http://localhost:4310/x.png', resourceType: 'xhr' }))).toBeUndefined();
    expect(emitted).toHaveLength(0);
  });
  it('correlates requests within 1500 ms after an interaction, not after', () => {
    const { tracer, setNow } = makeTracer();
    setNow(1_000_000);
    const click = tracer.onInteraction({ kind: 'click', text: 'Checkout' });
    const inside = tracer.onRequest(req({ startedAt: 1_001_400 }))!;
    const outside = tracer.onRequest(req({ startedAt: 1_001_600 }))!;
    expect(click.interactionId).toBe(click.id);
    expect(inside.interactionId).toBe(click.id);
    expect(outside.interactionId).toBeUndefined();
  });
  it('tags a request that arrived just before the click report and re-emits it', () => {
    const { tracer, emitted, setNow } = makeTracer();
    const early = tracer.onRequest(req({ startedAt: 999_900 }))!;
    setNow(1_000_000);
    const click = tracer.onInteraction({ kind: 'click', text: 'Pay' });
    expect(early.interactionId).toBe(click.id);
    expect(emitted.filter((e) => e.id === early.id)).toHaveLength(2);
  });
  it('keeps only the last 500 events', () => {
    const { tracer } = makeTracer();
    for (let i = 0; i < 520; i++) tracer.onRequest(req({ startedAt: 1_000_000 + i }));
    expect(tracer.events()).toHaveLength(500);
    tracer.clear();
    expect(tracer.events()).toHaveLength(0);
  });
});
