// Mock slice for window.atomic.app — owned by the feature worker that consumes it.
import type { RunScript } from '@atomic/core/types';
import type { AppLogLine, AppRunStatus, AtomicApi, TraceEvent, TraceMatch } from '../../../shared/ipc';
import type { Emit } from './index';

const SCRIPTS: RunScript[] = [
  { name: 'dev', command: 'node src/server.ts', source: 'package.json', cwd: '' },
  { name: 'start', command: 'node src/server.ts', source: 'package.json', cwd: '' },
  { name: 'test', command: 'vitest run', source: 'package.json', cwd: '' },
];

const URL = 'http://localhost:4310';

const cap = (id: string, title: string): TraceMatch['related'][number] => ({ id: `capability:${id}`, kind: 'capability', title });
const flow = (id: string, title: string): TraceMatch['related'][number] => ({ id: `flow:${id}`, kind: 'flow', title });
const ent = (id: string, title: string): TraceMatch['related'][number] => ({ id: `entity:${id}`, kind: 'entity', title });
const integ = (id: string, title: string): TraceMatch['related'][number] => ({ id: `integration:${id}`, kind: 'integration', title });

interface MockRoute { method: string; pattern: string; path: string; line: number; symbol: string; related: TraceMatch['related'] }
const ROUTES: Record<string, MockRoute> = {
  products: { method: 'GET', pattern: '/api/products', path: 'src/catalog/routes.ts', line: 8, symbol: 'listProducts', related: [cap('catalog', 'Catalog'), ent('product', 'Product')] },
  cart: { method: 'GET', pattern: '/api/cart', path: 'src/cart/routes.ts', line: 10, symbol: 'getCart', related: [cap('cart', 'Shopping cart'), ent('cart', 'Cart')] },
  addItem: { method: 'POST', pattern: '/api/cart/items', path: 'src/cart/routes.ts', line: 22, symbol: 'addItem', related: [cap('cart', 'Shopping cart'), ent('cartitem', 'CartItem')] },
  order: { method: 'POST', pattern: '/api/orders', path: 'src/orders/routes.ts', line: 12, symbol: 'checkout', related: [cap('checkout', 'Checkout'), flow('checkout', 'Checkout flow'), ent('order', 'Order'), integ('payments', 'Payments gateway')] },
  getOrder: { method: 'GET', pattern: '/api/orders/:id', path: 'src/orders/routes.ts', line: 31, symbol: 'getOrder', related: [cap('checkout', 'Checkout'), ent('order', 'Order')] },
  cancel: { method: 'POST', pattern: '/api/orders/:id/cancel', path: 'src/orders/routes.ts', line: 44, symbol: 'cancelOrder', related: [flow('cancel-order', 'Cancel order'), ent('order', 'Order')] },
};

type Step = { route?: string; concrete?: string; method?: string; status: number; ms: number };
const SCENARIOS: { click: string; steps: Step[] }[] = [
  { click: 'Add to cart', steps: [{ route: 'addItem', status: 201, ms: 21 }, { route: 'cart', status: 200, ms: 9 }] },
  { click: 'Checkout', steps: [{ route: 'order', status: 201, ms: 34 }, { route: 'getOrder', concrete: '/api/orders/ord_1042', status: 200, ms: 11 }] },
  { click: 'Cancel order', steps: [{ route: 'cancel', concrete: '/api/orders/ord_1042/cancel', status: 409, ms: 18 }] },
  { click: 'Shop', steps: [{ route: 'products', status: 200, ms: 14 }, { method: 'GET', concrete: '/api/recommendations', status: 200, ms: 40 }] },
];

export function createAppMock(emit: Emit): AtomicApi['app'] {
  let status: AppRunStatus = { state: 'stopped' };
  let seq = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let ticker: ReturnType<typeof setInterval> | undefined;
  let scenario = 0;

  const setStatus = (s: AppRunStatus) => { status = s; emit('app:status', s); };
  const log = (stream: AppLogLine['stream'], text: string) => emit('app:log', { stream, text, at: new Date().toISOString() });
  const later = (ms: number, fn: () => void) => { timers.push(setTimeout(fn, ms)); };
  const clearAll = () => { timers.forEach(clearTimeout); timers = []; if (ticker) clearInterval(ticker); ticker = undefined; };

  function playScenario() {
    const sc = SCENARIOS[scenario++ % SCENARIOS.length];
    const click: TraceEvent = { id: `m${++seq}`, at: new Date().toISOString(), kind: 'click', text: sc.click, url: URL };
    click.interactionId = click.id;
    emit('app:trace', click);
    sc.steps.forEach((step, i) => later(120 + i * 140, () => {
      const r = step.route ? ROUTES[step.route] : undefined;
      const method = r?.method ?? step.method ?? 'GET';
      const pathname = step.concrete ?? r?.pattern ?? '/';
      emit('app:trace', {
        id: `m${++seq}`, at: new Date().toISOString(), kind: 'request', method, pathname, url: URL + pathname,
        status: step.status, durationMs: step.ms, interactionId: click.id,
        match: r ? {
          routeNodeId: `route:${r.method} ${r.pattern}`, pattern: `${r.method} ${r.pattern}`,
          handler: { path: r.path, line: r.line, symbol: r.symbol }, related: r.related,
        } : undefined,
      });
      log('stdout', `${method} ${pathname} ${step.status} ${step.ms}ms`);
      if (step.status >= 400) log('stderr', `warn: ${method} ${pathname} responded ${step.status}`);
    }));
  }

  return {
    scripts: async () => SCRIPTS,
    async start(name) {
      const script = SCRIPTS.find((s) => s.name === name) ?? SCRIPTS[0];
      clearAll();
      setStatus({ state: 'starting', script, pid: 4242 });
      log('system', `$ npm run ${script.name}`);
      log('stdout', `> shop-app@1.0.0 ${script.name}`);
      if (script.name === 'test') {
        later(900, () => { log('stdout', 'Tests  12 passed'); setStatus({ state: 'exited', script, exitCode: 0 }); });
        return status;
      }
      later(900, () => {
        log('stdout', `shop-app listening on ${URL}`);
        setStatus({ state: 'running', script, pid: 4242, url: URL });
        later(1500, playScenario);
        ticker = setInterval(playScenario, 5000);
      });
      return status;
    },
    async stop() {
      clearAll();
      if (status.state === 'starting' || status.state === 'running') {
        log('system', 'Process exited with code 0');
        setStatus({ state: 'stopped', script: status.script, exitCode: 0 });
      }
      return status;
    },
    status: async () => status,
    async reportInteraction(e) {
      const ev: TraceEvent = { id: `m${++seq}`, at: new Date().toISOString(), ...e };
      ev.interactionId = ev.id;
      emit('app:trace', ev);
      return ev;
    },
    webviewPreloadPath: async () => '',
  };
}
