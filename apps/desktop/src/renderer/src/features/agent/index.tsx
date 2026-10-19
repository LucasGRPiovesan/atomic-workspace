// Seam owned by the "agent panel" worker. Keep the export name and props stable.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AgentInfo, AgentSessionInfo, ProjectSummary, PromptTemplate } from '../../../../shared/ipc';
import { PlanView, TimelineRow, type Actions } from './parts';
import { emptySession, pendingPermissions, reduce, type SessionView } from './reducer';
import './agent.css';

export interface AgentPanelProps {
  project: ProjectSummary;
  /** open a knowledge node in the main area (e.g. a node listed in attached context) */
  onFocusNode(id: string): void;
  /** open a file location in the main area */
  onOpenFile(path: string, line?: number): void;
}

const STATE_LABEL: Record<SessionView['state'], string> = {
  starting: 'starting', ready: 'ready', prompting: 'working', error: 'error', closed: 'closed',
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function AgentPanel({ project, onFocusNode, onOpenFile }: AgentPanelProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = useState('');
  const [session, setSession] = useState<AgentSessionInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachContext, setAttachContext] = useState(true);
  const [sessions, dispatch] = useReducer(reduce, {});

  useEffect(() => {
    let alive = true;
    window.atomic.agents.list().then((list) => {
      if (!alive) return;
      setAgents(list);
      setAgentId((cur) => cur || list.find((a) => a.available)?.id || '');
    }).catch((e) => alive && setError(msg(e)));
    const off = window.atomic.on('agent:event', dispatch);
    return () => { alive = false; off(); };
  }, []);

  const view = session ? sessions[session.sessionId] ?? emptySession() : null;
  const sid = session?.sessionId ?? null;

  const start = useCallback(async () => {
    if (!agentId) return;
    setStarting(true);
    setError(null);
    try {
      const info = await window.atomic.agents.start(agentId);
      setSession(info);
      // the main process normally announces 'ready'; make sure the composer never stays locked without it
      dispatch({ type: 'state', sessionId: info.sessionId, state: 'ready' });
      if (info.modes) dispatch({ type: 'update', sessionId: info.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: info.modes.currentModeId } });
    } catch (e) {
      setError(msg(e));
    } finally {
      setStarting(false);
    }
  }, [agentId]);

  const send = useCallback(async (text: string, attach: boolean) => {
    if (!sid) return;
    setError(null);
    try {
      await window.atomic.agents.prompt(sid, text, { attachContext: attach });
    } catch (e) {
      setError(msg(e));
    }
  }, [sid]);

  const sendTemplate = useCallback(async (kind: PromptTemplate) => {
    try {
      // the deep layer is empty for a bootstrap, so there is nothing useful to attach
      await send(await window.atomic.agents.template(kind), kind === 'bootstrap' ? false : attachContext);
    } catch (e) {
      setError(msg(e));
    }
  }, [send, attachContext]);

  const closeSession = useCallback(async () => {
    if (!sid) return;
    try { await window.atomic.agents.close(sid); } catch (e) { setError(msg(e)); }
    setSession(null);
  }, [sid]);

  const actions: Actions = useMemo(() => ({
    onOpenFile, onFocusNode,
    onRespond: (requestId, optionId) => {
      window.atomic.agents.respondPermission(requestId, optionId).catch((e) => setError(msg(e)));
    },
  }), [onOpenFile, onFocusNode]);

  // auto-scroll, unless the user scrolled up
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [view]);

  const ready = view?.state === 'ready';
  const pendingPerms = view ? pendingPermissions(view).length : 0;

  return (
    <section className="ag">
      <header className="ag-header">
        {!session ? (
          <>
            <select
              className="ag-select" aria-label="Agent" value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {agents.length === 0 && <option value="">No agents</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.available} title={a.detail}>
                  {a.name}{a.available ? '' : ` — ${a.detail}`}
                </option>
              ))}
            </select>
            <button type="button" className="ag-btn ag-btn-primary" disabled={!agentId || starting} onClick={start}>
              {starting ? 'Starting…' : 'Start session'}
            </button>
          </>
        ) : (
          <>
            <strong className="ag-name">{session.agentName}</strong>
            <span className={`ag-pill ag-pill-${view?.state}`}>{view ? STATE_LABEL[view.state] : ''}</span>
            {session.modes && (
              <select
                className="ag-select" aria-label="Mode" value={view?.modeId ?? session.modes.currentModeId}
                onChange={(e) => {
                  const modeId = e.target.value;
                  window.atomic.agents.setMode(session.sessionId, modeId)
                    .then(() => dispatch({ type: 'update', sessionId: session.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } }))
                    .catch((err) => setError(msg(err)));
                }}
              >
                {session.modes.availableModes.map((m) => (
                  <option key={m.id} value={m.id} title={m.description ?? undefined}>{m.name}</option>
                ))}
              </select>
            )}
            {view?.usage && view.usage.size > 0 && (
              <span
                className="ag-usage"
                title={`${view.usage.used} / ${view.usage.size} tokens${view.usage.cost ? ` · ${view.usage.cost.amount.toFixed(2)} ${view.usage.cost.currency}` : ''}`}
              >
                <span className="ag-usage-bar"><span style={{ width: `${Math.min(100, (view.usage.used / view.usage.size) * 100)}%` }} /></span>
                {formatTokens(view.usage.used)}/{formatTokens(view.usage.size)}
              </span>
            )}
            <span className="ag-spacer" />
            {view?.state === 'prompting' && (
              <button type="button" className="ag-btn ag-btn-reject_once" onClick={() => window.atomic.agents.cancel(session.sessionId).catch((e) => setError(msg(e)))}>
                Stop
              </button>
            )}
            <button type="button" className="ag-btn ag-btn-ghost" onClick={closeSession}>Close</button>
          </>
        )}
      </header>

      {error && <div className="ag-error" role="alert">{error} <button type="button" className="ag-link" onClick={() => setError(null)}>dismiss</button></div>}
      {view?.state === 'error' && view.error && <div className="ag-error" role="alert">{view.error}</div>}

      {ready && project.needsBootstrap && (
        <div className="ag-banner">
          <span>The project has no deep understanding yet.</span>
          <button type="button" className="ag-btn ag-btn-primary" onClick={() => sendTemplate('bootstrap')}>Build project understanding</button>
        </div>
      )}
      {ready && !project.needsBootstrap && project.stats.stale > 0 && (
        <div className="ag-banner">
          <span>{project.stats.stale} items may be out of date.</span>
          <button type="button" className="ag-btn" onClick={() => sendTemplate('refresh-stale')}>Refresh {project.stats.stale} stale items</button>
        </div>
      )}

      <div className="ag-timeline" ref={scroller} onScroll={onScroll}>
        {!session && <div className="ag-empty">Pick an agent and start a session. The agent edits your project; everything it does shows up here.</div>}
        {view && view.items.length === 0 && view.state !== 'starting' && (
          <div className="ag-empty">Ready. Ask for something, or use / for the agent’s commands.</div>
        )}
        {view?.items.map((item) => <TimelineRow key={item.id} item={item} actions={actions} />)}
        {view?.plan && view.plan.length > 0 && <PlanView plan={view.plan} />}
        {view?.state === 'prompting' && <div className="ag-working">{pendingPerms > 0 ? 'Waiting for your permission…' : 'Working…'}</div>}
        {view?.stopReason && view.state === 'ready' && view.stopReason !== 'end_turn' && (
          <div className="ag-generic">Stopped: {view.stopReason}</div>
        )}
        {view && view.stderr.length > 0 && (
          <details className="ag-stderr"><summary>Agent log ({view.stderr.length})</summary><pre>{view.stderr.join('\n')}</pre></details>
        )}
      </div>

      <Composer
        disabled={!ready}
        placeholder={!session ? 'Start a session to talk to your agent' : ready ? 'Message the agent…  (Enter sends, Shift+Enter newline)' : 'Waiting for the agent…'}
        commands={view?.commands ?? []}
        attach={attachContext}
        onAttach={setAttachContext}
        onSend={(t) => send(t, attachContext)}
      />
    </section>
  );
}

function Composer(props: {
  disabled: boolean;
  placeholder: string;
  commands: { name: string; description: string }[];
  attach: boolean;
  onAttach(v: boolean): void;
  onSend(text: string): void;
}) {
  const [text, setText] = useState('');
  const slash = /^\/(\S*)$/.exec(text);
  const suggestions = slash ? props.commands.filter((c) => c.name.startsWith(slash[1]!)).slice(0, 6) : [];

  const submit = () => {
    const t = text.trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText('');
  };

  return (
    <div className="ag-composer">
      {suggestions.length > 0 && (
        <ul className="ag-suggest" role="listbox">
          {suggestions.map((c) => (
            <li key={c.name}>
              <button type="button" onClick={() => setText(`/${c.name} `)}>
                <span className="ag-cmd">/{c.name}</span> <span className="ag-muted">{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="ag-input" rows={3} value={text} disabled={props.disabled} placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="ag-composer-bar">
        <label className="ag-check">
          <input type="checkbox" checked={props.attach} onChange={(e) => props.onAttach(e.target.checked)} />
          Attach project context
        </label>
        <button type="button" className="ag-btn ag-btn-primary" disabled={props.disabled || !text.trim()} onClick={submit}>Send</button>
      </div>
    </div>
  );
}
