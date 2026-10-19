import type { RouteRecord } from '@atomic/core/types';
import type { TraceEvent, TraceMatch } from '../../shared/ipc';

export const CORRELATION_WINDOW_MS = 1500;
/** a request can reach main slightly before the webview's click report does */
const LATE_REPORT_SLACK_MS = 400;
const MAX_EVENTS = 500;
const TRACED_TYPES = new Set(['document', 'mainframe', 'subframe', 'xhr', 'fetch']);
const STATIC_EXT = /\.(?:m?[jt]sx?|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot)$/i;

export interface TracerOptions {
  routes(): RouteRecord[];
  related(routeId: string): TraceMatch['related'];
  handlerOf(route: RouteRecord): TraceMatch['handler'];
  /** `app:trace` push; also re-sent when an event gets its interactionId late */
  emit(channel: 'app:trace', event: TraceEvent): void;
  /** only requests to this origin are traced (e.g. "http://localhost:4310") */
  appOrigin?(): string | undefined;
  now?(): number;
}

export interface RequestInfo {
  method: string;
  url: string;
  statusCode?: number;
  /** epoch ms */
  startedAt: number;
  durationMs?: number;
  /** Electron resourceType: mainFrame | subFrame | xhr | script | stylesheet | image | ... */
  resourceType?: string;
}

function normalizePath(p: string): string {
  const path = p.split(/[?#]/, 1)[0] || '/';
  const norm = ('/' + path).replace(/\/{2,}/g, '/');
  return norm.length > 1 ? norm.replace(/\/$/, '') : norm;
}

function segments(p: string): string[] {
  const n = normalizePath(p);
  return n === '/' ? [] : n.slice(1).split('/');
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** per-segment specificity: static 3 > param 2 > wildcard 1; null when the route does not match */
function score(routeSegs: string[], pathSegs: string[]): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < routeSegs.length; i++) {
    const r = routeSegs[i];
    if (r === '*' || r === '**') { out.push(1); return pathSegs.length >= i ? out : null; }
    if (i >= pathSegs.length) return null;
    if (r.startsWith(':')) { out.push(2); continue; }
    if (safeDecode(r) !== safeDecode(pathSegs[i])) return null;
    out.push(3);
  }
  return routeSegs.length === pathSegs.length ? out : null;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// contract spells the wildcard method 'ANY'; tolerate 'ALL' from other extractors
const isAnyMethod = (m: string): boolean => m === 'ANY' || m === 'ALL';

/** Best route for a request: static segments beat params, exact method beats ALL, longer pattern wins. */
export function matchRoute(method: string, pathname: string, routes: RouteRecord[]): RouteRecord | undefined {
  const m = method.toUpperCase();
  const pathSegs = segments(pathname);
  let best: { route: RouteRecord; sc: number[]; exact: number } | undefined;
  for (const route of routes) {
    if (!isAnyMethod(route.method) && route.method !== m) continue;
    const sc = score(segments(route.pattern), pathSegs);
    if (!sc) continue;
    const exact = isAnyMethod(route.method) ? 0 : 1;
    if (!best || (compare(sc, best.sc) || exact - best.exact) > 0) best = { route, sc, exact };
  }
  return best?.route;
}

export function isTracedRequest(url: string, resourceType?: string): boolean {
  if (resourceType && !TRACED_TYPES.has(resourceType.toLowerCase())) return false;
  try { return !STATIC_EXT.test(new URL(url).pathname); } catch { return false; }
}

export class Tracer {
  private buffer: { event: TraceEvent; ms: number }[] = [];
  private seq = 0;
  private interaction?: { id: string; ms: number };

  constructor(private readonly opts: TracerOptions) {}

  events(): TraceEvent[] { return this.buffer.map((b) => b.event); }

  clear(): void { this.buffer = []; this.interaction = undefined; }

  onRequest(r: RequestInfo): TraceEvent | undefined {
    let u: URL;
    try { u = new URL(r.url); } catch { return undefined; }
    const origin = this.opts.appOrigin?.();
    if (origin && u.origin !== origin) return undefined;
    if (!isTracedRequest(r.url, r.resourceType)) return undefined;

    const method = r.method.toUpperCase();
    const route = matchRoute(method, u.pathname, this.opts.routes());
    const ev: TraceEvent = {
      id: this.nextId(),
      at: new Date(r.startedAt).toISOString(),
      kind: 'request',
      method,
      url: r.url,
      pathname: u.pathname,
      status: r.statusCode,
      durationMs: r.durationMs,
    };
    const it = this.interaction;
    if (it && r.startedAt >= it.ms && r.startedAt - it.ms <= CORRELATION_WINDOW_MS) ev.interactionId = it.id;
    if (route) {
      ev.match = {
        routeNodeId: route.id,
        pattern: `${route.method} ${route.pattern}`,
        handler: this.opts.handlerOf(route),
        related: this.opts.related(route.id),
      };
    }
    this.push(ev, r.startedAt);
    this.opts.emit('app:trace', ev);
    return ev;
  }

  onInteraction(i: { kind: 'click' | 'navigation'; text?: string; url?: string }): TraceEvent {
    const ms = this.opts.now?.() ?? Date.now();
    const ev: TraceEvent = { id: this.nextId(), at: new Date(ms).toISOString(), kind: i.kind, text: i.text, url: i.url };
    ev.interactionId = ev.id;
    this.interaction = { id: ev.id, ms };
    // the click's own requests may have been seen just before this report arrived
    for (const b of this.buffer) {
      if (b.event.kind === 'request' && !b.event.interactionId && b.ms <= ms && ms - b.ms <= LATE_REPORT_SLACK_MS) {
        b.event.interactionId = ev.id;
        this.opts.emit('app:trace', b.event);
      }
    }
    this.push(ev, ms);
    this.opts.emit('app:trace', ev);
    return ev;
  }

  private nextId(): string { return `tr${++this.seq}`; }

  private push(event: TraceEvent, ms: number): void {
    this.buffer.push({ event, ms });
    if (this.buffer.length > MAX_EVENTS) this.buffer.splice(0, this.buffer.length - MAX_EVENTS);
  }
}
