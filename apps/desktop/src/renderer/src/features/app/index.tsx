import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunScript } from '@atomic/core/types';
import { APP_PARTITION } from '../../../../shared/ipc';
import type { AppLogLine, AppRunStatus, ProjectSummary, TraceEvent } from '../../../../shared/ipc';
import { groupTrace, upsertTrace, type TraceGroup } from './trace';
import './app.css';

export interface ApplicationModeProps {
  project: ProjectSummary;
  /** jump to the Development view focused on a node (route/capability/flow/entity) */
  onFocusNode(id: string): void;
}

/** the subset of Electron's <webview> element used here */
interface WebviewElement extends HTMLElement {
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

type Orientation = 'right' | 'bottom';
type Tab = 'behavior' | 'logs';

const MAX_LOGS = 2000;
const STATE_LABEL: Record<AppRunStatus['state'], string> = {
  stopped: 'Stopped', starting: 'Starting…', running: 'Running', exited: 'Exited', error: 'Error',
};
const STATE_CLASS: Record<AppRunStatus['state'], string> = {
  stopped: '', starting: 'badge-warn', running: 'badge-ok', exited: '', error: 'badge-danger',
};

function defaultScript(scripts: RunScript[]): string {
  return (scripts.find((s) => s.name === 'dev') ?? scripts.find((s) => s.name === 'start') ?? scripts[0])?.name ?? '';
}

function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
}

export function ApplicationMode({ onFocusNode }: ApplicationModeProps) {
  const api = window.atomic.app;
  const [scripts, setScripts] = useState<RunScript[]>([]);
  const [script, setScript] = useState('');
  const [status, setStatus] = useState<AppRunStatus>({ state: 'stopped' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preloadPath, setPreloadPath] = useState<string>();
  const [override, setOverride] = useState<string>();
  const [address, setAddress] = useState('');
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [logs, setLogs] = useState<AppLogLine[]>([]);
  const [tab, setTab] = useState<Tab>('behavior');
  const [orientation, setOrientation] = useState<Orientation>('right');
  const [size, setSize] = useState(380);
  const [dragging, setDragging] = useState(false);
  const webview = useRef<WebviewElement | null>(null);
  const body = useRef<HTMLDivElement>(null);

  const active = status.state === 'starting' || status.state === 'running';
  const src = override ?? status.url;
  const inElectron = !!preloadPath;

  useEffect(() => {
    let alive = true;
    void api.scripts().then((s) => {
      if (!alive) return;
      setScripts(s);
      setScript((cur) => cur || defaultScript(s));
    }).catch((e: Error) => setError(e.message));
    void api.status().then((s) => alive && setStatus(s));
    void api.webviewPreloadPath().then((p) => alive && setPreloadPath(p || undefined)).catch(() => undefined);
    const offs = [
      window.atomic.on('app:status', setStatus),
      window.atomic.on('app:log', (l) => setLogs((cur) => [...cur, l].slice(-MAX_LOGS))),
      window.atomic.on('app:trace', (e) => setTrace((cur) => upsertTrace(cur, e))),
    ];
    return () => { alive = false; offs.forEach((off) => off()); };
  }, [api]);

  // a fresh run starts with a clean slate; a detected URL replaces any manual one
  useEffect(() => {
    if (status.state === 'starting') { setLogs([]); setOverride(undefined); }
  }, [status.state, status.pid]);
  useEffect(() => { setAddress(src ?? ''); }, [src]);

  // wire the <webview>: it is created imperatively-by-props, so listeners attach through the ref
  const attachWebview = useCallback((el: HTMLElement | null) => {
    webview.current = el as WebviewElement | null;
  }, []);
  useEffect(() => {
    const wv = webview.current;
    if (!wv || !src || !inElectron) return;
    const onIpc = (e: Event) => {
      const m = e as Event & { channel: string; args: unknown[] };
      if (m.channel !== 'atomic-interaction') return;
      const payload = m.args[0] as { kind: 'click' | 'navigation'; text?: string; url?: string };
      void api.reportInteraction(payload).then((ev) => setTrace((cur) => upsertTrace(cur, ev))).catch(() => undefined);
    };
    const onNav = (e: Event) => {
      const url = (e as Event & { url?: string }).url;
      if (url) setAddress(url);
    };
    wv.addEventListener('ipc-message', onIpc);
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    return () => {
      wv.removeEventListener('ipc-message', onIpc);
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-navigate-in-page', onNav);
    };
  }, [api, src, inElectron]);

  const run = async () => {
    setBusy(true); setError(undefined);
    try { setStatus(await (active ? api.stop() : api.start(script))); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const go = () => {
    const url = normalizeUrl(address);
    if (!url) return;
    if (url !== src) setOverride(url);
    else void webview.current?.loadURL(url).catch(() => undefined);
  };

  const startDrag = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onDrag = (e: React.PointerEvent) => {
    if (!dragging || !body.current) return;
    const r = body.current.getBoundingClientRect();
    const next = orientation === 'right' ? r.right - e.clientX : r.bottom - e.clientY;
    const max = (orientation === 'right' ? r.width : r.height) - 160;
    setSize(Math.max(200, Math.min(max, next)));
  };

  const groups = useMemo(() => groupTrace(trace), [trace]);
  const clear = () => { setTrace([]); setLogs([]); };

  return (
    <div className="appmode">
      <div className="appmode-toolbar">
        <select className="appmode-select" value={script} onChange={(e) => setScript(e.target.value)} disabled={active || !scripts.length} aria-label="Script">
          {scripts.map((s) => <option key={`${s.source}:${s.name}`} value={s.name}>{s.name}</option>)}
          {!scripts.length && <option value="">No scripts</option>}
        </select>
        <button className={`btn ${active ? '' : 'btn-primary'}`} onClick={() => void run()} disabled={busy || (!active && !script)}>
          {active ? '■ Stop' : '▶ Run'}
        </button>
        <span className={`badge ${STATE_CLASS[status.state]}`} title={status.exitCode != null ? `exit code ${status.exitCode}` : undefined}>
          {status.state === 'starting' && <span className="spinner" style={{ width: 9, height: 9 }} />}
          {STATE_LABEL[status.state]}
        </span>
        <div className="appmode-nav">
          <button className="icon-btn" title="Back" disabled={!inElectron || !src} onClick={() => webview.current?.goBack()}>←</button>
          <button className="icon-btn" title="Forward" disabled={!inElectron || !src} onClick={() => webview.current?.goForward()}>→</button>
          <button className="icon-btn" title="Reload" disabled={!inElectron || !src} onClick={() => webview.current?.reload()}>⟳</button>
        </div>
        <form className="appmode-address" onSubmit={(e) => { e.preventDefault(); go(); }}>
          <input
            value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false}
            placeholder="http://localhost:3000 — type a URL to override" aria-label="Address"
          />
        </form>
        <button className={`icon-btn ${orientation === 'right' ? 'is-active' : ''}`} title="Behavior panel on the right" onClick={() => setOrientation('right')}>▯</button>
        <button className={`icon-btn ${orientation === 'bottom' ? 'is-active' : ''}`} title="Behavior panel at the bottom" onClick={() => setOrientation('bottom')}>▭</button>
      </div>
      {error && <div className="inline-error">{error}</div>}

      <div ref={body} className={`appmode-body is-${orientation}`}>
        <div className={`appmode-view ${dragging ? 'is-dragging' : ''}`}>
          {src && inElectron ? createElement('webview', {
            key: src, ref: attachWebview, src, partition: APP_PARTITION, preload: `file://${preloadPath}`, className: 'appmode-webview',
          }) : (
            <div className="empty-state">
              <div className="empty-title">{src ? 'App preview runs in the desktop app' : 'Nothing running'}</div>
              <div className="empty-hint">
                {src
                  ? <>The embedded browser is only available inside Electron. The app is at <code>{src}</code>; behavior and logs still stream on the right.</>
                  : 'Pick a script and press Run, or type a URL above.'}
              </div>
            </div>
          )}
        </div>
        <div
          className="appmode-split" role="separator" aria-orientation={orientation === 'right' ? 'vertical' : 'horizontal'}
          onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)}
        />
        <div className="appmode-panel" style={orientation === 'right' ? { width: size } : { height: size }}>
          <div className="tabs appmode-tabs">
            <button className={`tab ${tab === 'behavior' ? 'is-active' : ''}`} onClick={() => setTab('behavior')}>Behavior</button>
            <button className={`tab ${tab === 'logs' ? 'is-active' : ''}`} onClick={() => setTab('logs')}>Logs</button>
            <span className="appmode-spacer" />
            <button className="btn btn-ghost" onClick={clear} disabled={!trace.length && !logs.length}>Clear</button>
          </div>
          {tab === 'behavior'
            ? <BehaviorTab groups={groups} onFocusNode={onFocusNode} running={active} />
            : <LogsTab logs={logs} />}
        </div>
      </div>
    </div>
  );
}

function BehaviorTab({ groups, onFocusNode, running }: { groups: TraceGroup[]; onFocusNode(id: string): void; running: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const last = groups[groups.length - 1]?.requests.length;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [groups.length, last]);
  if (!groups.length) {
    return (
      <div className="empty-state">
        <div className="empty-title">No activity yet</div>
        <div className="empty-hint">{running ? 'Click around in the app — each action shows the requests, routes and code behind it.' : 'Run the app to map its behavior to code.'}</div>
      </div>
    );
  }
  return (
    <div className="appmode-scroll">
      {groups.map((g) => (
        <section key={g.key} className="trace-group">
          <header className="trace-head">
            {g.interaction
              ? <><span className="trace-kind">{g.interaction.kind === 'click' ? 'Click' : 'Go to'}</span><span className="trace-text">{g.interaction.kind === 'click' ? `‘${g.interaction.text ?? 'element'}’` : g.interaction.text ?? g.interaction.url}</span></>
              : <span className="trace-kind">Background requests</span>}
          </header>
          {g.requests.map((r) => <RequestRow key={r.id} ev={r} onFocusNode={onFocusNode} />)}
        </section>
      ))}
      <div ref={end} />
    </div>
  );
}

function RequestRow({ ev, onFocusNode }: { ev: TraceEvent; onFocusNode(id: string): void }) {
  const m = ev.match;
  const bad = (ev.status ?? 0) >= 400;
  return (
    <div className="trace-req">
      <div className="trace-line">
        <span className="trace-method">{ev.method}</span>
        <span className="trace-path" title={ev.url}>{ev.pathname}</span>
        <span className={`trace-status ${bad ? 'is-bad' : ''}`}>{ev.status ?? '…'}</span>
        {ev.durationMs != null && <span className="trace-ms">{Math.round(ev.durationMs)} ms</span>}
      </div>
      {m ? (
        <div className="trace-chips">
          <button className="chip chip-route" onClick={() => onFocusNode(m.routeNodeId)} title="Open route">{m.pattern}</button>
          {m.handler && (
            <button className="chip chip-handler" onClick={() => onFocusNode(m.routeNodeId)} title={m.handler.symbol ? `${m.handler.symbol}()` : 'Handler'}>
              {m.handler.path}:{m.handler.line}
            </button>
          )}
          {m.related.map((n) => (
            <button key={n.id} className="chip" onClick={() => onFocusNode(n.id)} title={n.kind}>
              <span className="kind-dot" style={{ background: `var(--k-${n.kind})` }} />{n.title}
            </button>
          ))}
        </div>
      ) : (
        <div className="trace-chips"><span className="badge badge-warn">not in memory</span></div>
      )}
    </div>
  );
}

function LogsTab({ logs }: { logs: AppLogLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);
  if (!logs.length) {
    return <div className="empty-state"><div className="empty-hint">No output yet.</div></div>;
  }
  return (
    <div ref={box} className="appmode-scroll log-list">
      {logs.map((l, i) => <div key={i} className={`log-line is-${l.stream}`}>{l.text}</div>)}
    </div>
  );
}
