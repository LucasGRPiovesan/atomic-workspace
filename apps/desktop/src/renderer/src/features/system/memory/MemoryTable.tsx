import { useMemo, useState, type FormEvent } from 'react';
import type { KnowledgeNode, NodeKind, NodeOrigin, NodeStatus } from '@atomic/core/types';
import { useSystem } from '../data-context';
import { filterNodes } from '../graph-utils';
import { Confidence, Empty, KIND_LABEL, KindBadge, ORIGIN_LABEL, OriginBadge, STATUS_LABEL, StatusBadge, relTime } from '../ui';

interface Props {
  selectedId: string | null;
  onSelect(id: string): void;
}

type NoteKind = 'note' | 'rule' | 'decision' | 'convention';
const NOTE_KINDS: NoteKind[] = ['note', 'rule', 'decision', 'convention'];

function toggle<T>(set: ReadonlySet<T>, v: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(v)) next.add(v);
  return next;
}

export function MemoryTable({ selectedId, onSelect }: Props) {
  const { nodes, reload } = useSystem();
  const [text, setText] = useState('');
  const [kinds, setKinds] = useState<ReadonlySet<NodeKind>>(new Set());
  const [origins, setOrigins] = useState<ReadonlySet<NodeOrigin>>(new Set());
  const [statuses, setStatuses] = useState<ReadonlySet<NodeStatus>>(new Set());
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const present = useMemo(() => [...new Set(nodes.map((n) => n.kind))].sort(), [nodes]);
  const rows = useMemo(() => filterNodes(nodes, { text, kinds, origins, statuses })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [nodes, text, kinds, origins, statuses]);
  const stale = rows.filter((n) => n.status === 'stale');
  const chosen = stale.filter((n) => picked.has(n.id));

  const verify = async (list: KnowledgeNode[]) => {
    setBusy(true);
    try {
      await Promise.all(list.map((n) => window.atomic.memory.markVerified(n.id)));
      setPicked(new Set());
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sys-memory">
      <div className="sys-toolbar">
        <input className="sys-input" placeholder="Filter by text…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="sys-filters" role="group" aria-label="Status">
          {(['fresh', 'stale', 'unverified'] as const).map((s) => (
            <button key={s} type="button" className={`sys-toggle${statuses.has(s) ? ' on' : ''}`} onClick={() => setStatuses(toggle(statuses, s))}>{STATUS_LABEL[s]}</button>
          ))}
        </div>
        <div className="sys-filters" role="group" aria-label="Origin">
          {(['deterministic', 'imported', 'agent', 'user'] as const).map((o) => (
            <button key={o} type="button" className={`sys-toggle${origins.has(o) ? ' on' : ''}`} onClick={() => setOrigins(toggle(origins, o))}>{ORIGIN_LABEL[o]}</button>
          ))}
        </div>
        <div className="sys-filters" role="group" aria-label="Kind">
          {present.map((k) => (
            <button key={k} type="button" className={`sys-toggle${kinds.has(k) ? ' on' : ''}`} style={{ ['--c' as string]: `var(--k-${k})` }} onClick={() => setKinds(toggle(kinds, k))}>{KIND_LABEL[k]}</button>
          ))}
        </div>
        <span className="sys-spacer" />
        {stale.length ? (
          <button type="button" className="sys-btn" disabled={busy} onClick={() => void verify(chosen.length ? chosen : stale)}>
            {chosen.length ? `Mark ${chosen.length} verified` : `Mark all ${stale.length} stale verified`}
          </button>
        ) : null}
        <button type="button" className="sys-btn primary" onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : 'Add note / rule / decision'}</button>
      </div>

      {adding ? <AddNote onDone={() => { setAdding(false); reload(); }} /> : null}

      {rows.length ? (
        <div className="sys-table-wrap">
          <table className="sys-table">
            <thead>
              <tr><th /><th>Title</th><th>Kind</th><th>Origin</th><th>Status</th><th>Conf.</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id} className={n.id === selectedId ? 'on' : ''} onClick={() => onSelect(n.id)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    {n.status === 'stale' ? (
                      <input type="checkbox" aria-label={`Select ${n.title}`} checked={picked.has(n.id)} onChange={() => setPicked(toggle(picked, n.id))} />
                    ) : null}
                  </td>
                  <td><div className="sys-cell-title">{n.title}</div><div className="sys-cell-sub">{n.summary}</div></td>
                  <td><KindBadge kind={n.kind} /></td>
                  <td><OriginBadge origin={n.origin} /></td>
                  <td><StatusBadge status={n.status} /></td>
                  <td><Confidence value={n.confidence} /></td>
                  <td className="sys-hint">{relTime(n.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title={nodes.length ? 'No knowledge matches these filters' : 'Memory is empty'}>
          {nodes.length ? undefined : 'Index the project first. Deeper knowledge (capabilities, flows, rules) is recorded by your agent.'}
        </Empty>
      )}
    </div>
  );
}

function AddNote({ onDone }: { onDone(): void }) {
  const [kind, setKind] = useState<NoteKind>('note');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [path, setPath] = useState('');
  const [line, setLine] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !summary.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const n = Number.parseInt(line, 10);
      const anchors = path.trim() ? [{ path: path.trim().replace(/\\/g, '/'), ...(Number.isFinite(n) ? { startLine: n } : {}) }] : undefined;
      await window.atomic.memory.addNote({ kind, title: title.trim(), summary: summary.trim(), anchors });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="sys-form" onSubmit={(e) => void submit(e)}>
      <select className="sys-input" value={kind} onChange={(e) => setKind(e.target.value as NoteKind)} aria-label="Kind">
        {NOTE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <input className="sys-input grow" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      <textarea className="sys-input full" placeholder="What should every agent know?" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} required />
      <input className="sys-input grow" placeholder="Anchor file (optional) e.g. src/orders/service.ts" value={path} onChange={(e) => setPath(e.target.value)} />
      <input className="sys-input narrow" placeholder="Line" inputMode="numeric" value={line} onChange={(e) => setLine(e.target.value)} />
      <button type="submit" className="sys-btn primary" disabled={saving || !title.trim() || !summary.trim()}>Save to memory</button>
      {error ? <span className="sys-error">{error}</span> : null}
    </form>
  );
}
