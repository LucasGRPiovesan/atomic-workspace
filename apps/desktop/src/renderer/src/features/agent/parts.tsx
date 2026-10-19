// Presentational pieces of the agent timeline. Everything here is a pure function of reducer output.
import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { diffStats, lineDiff } from './diff';
import type { PlanEntryView, TimelineItem, ToolContent, ToolKindName } from './reducer';

type Of<K extends TimelineItem['kind']> = Extract<TimelineItem, { kind: K }>;

export interface Actions {
  onOpenFile(path: string, line?: number): void;
  onFocusNode(id: string): void;
  onRespond(requestId: string, optionId: string | null): void;
}

const KIND_ICON: Record<ToolKindName, string> = {
  read: '▤', edit: '✎', delete: '⌫', move: '⇄', search: '⌕', execute: '▶',
  think: '✦', fetch: '⇩', switch_mode: '⇋', other: '•',
};

const MAX_TEXT = 4000;

export function Markdown({ text, onOpenFile }: { text: string; onOpenFile(path: string, line?: number): void }) {
  return (
    <div className="ag-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // never navigate the app window: web links are inert, anything else is treated as a project path
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) onOpenFile(href.replace(/^\.\//, ''));
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function FileChip({ path, line, onOpenFile }: { path: string; line?: number; onOpenFile: Actions['onOpenFile'] }) {
  return (
    <button type="button" className="ag-chip ag-chip-file" title={`Open ${path}`} onClick={() => onOpenFile(path, line)}>
      {path}{line ? `:${line}` : ''}
    </button>
  );
}

function DiffView({ c, onOpenFile }: { c: Extract<ToolContent, { type: 'diff' }>; onOpenFile: Actions['onOpenFile'] }) {
  const lines = useMemo(() => lineDiff(c.oldText, c.newText), [c.oldText, c.newText]);
  const { added, removed } = diffStats(lines);
  return (
    <div className="ag-diff">
      <div className="ag-diff-head">
        <FileChip path={c.path} onOpenFile={onOpenFile} />
        <span className="ag-add">+{added}</span>
        <span className="ag-del">−{removed}</span>
        {c.oldText === null && <span className="ag-muted">new file</span>}
      </div>
      <pre className="ag-diff-body">
        {lines.map((l, i) => (
          <div key={i} className={`ag-dl ag-dl-${l.op === '+' ? 'add' : l.op === '-' ? 'del' : l.op === '…' ? 'gap' : 'ctx'}`}>
            <span className="ag-dl-op">{l.op === ' ' ? '' : l.op}</span>{l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function ToolCard({ item, actions }: { item: Of<'tool'>; actions: Actions }) {
  const hasDiff = item.content.some((c) => c.type === 'diff');
  const [open, setOpen] = useState(hasDiff);
  const expandable = item.content.length > 0;
  return (
    <div className={`ag-tool ag-st-${item.status}`}>
      <div className="ag-tool-head">
        <span className="ag-tool-icon" title={item.toolKind}>{KIND_ICON[item.toolKind] ?? KIND_ICON.other}</span>
        {/* some agents prefix MCP tools with the server name: "atomic_atomic_overview" reads as "atomic_overview" */}
        <span className="ag-tool-title" title={item.title}>{item.title.replace(/^(\w+?)_\1_/, '$1_')}</span>
        <span className={`ag-status ag-status-${item.status}`}>{item.status.replace('_', ' ')}</span>
        {expandable && (
          <button type="button" className="ag-link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'hide' : 'details'}
          </button>
        )}
      </div>
      {item.locations.length > 0 && (
        <div className="ag-tool-locs">
          {item.locations.map((l, i) => (
            <FileChip key={`${l.path}:${l.line ?? ''}:${i}`} path={l.path} line={l.line} onOpenFile={actions.onOpenFile} />
          ))}
        </div>
      )}
      {open && item.content.map((c, i) => {
        if (c.type === 'diff') return <DiffView key={i} c={c} onOpenFile={actions.onOpenFile} />;
        if (c.type === 'terminal') return <div key={i} className="ag-muted">terminal {c.terminalId}</div>;
        return (
          <pre key={i} className="ag-pre">
            {c.text.length > MAX_TEXT ? `${c.text.slice(0, MAX_TEXT)}\n… (${c.text.length - MAX_TEXT} more chars)` : c.text}
          </pre>
        );
      })}
    </div>
  );
}

export function PlanView({ plan }: { plan: PlanEntryView[] }) {
  const done = plan.filter((p) => p.status === 'completed').length;
  return (
    <div className="ag-plan">
      <div className="ag-plan-head">Plan <span className="ag-muted">{done}/{plan.length}</span></div>
      <ul>
        {plan.map((p, i) => (
          <li key={i} className={`ag-plan-${p.status}`}>
            <span className="ag-plan-box" aria-hidden>{p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '›' : ''}</span>
            {p.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ContextChip({ item, actions }: { item: Of<'context'>; actions: Actions }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ag-context">
      <button type="button" className="ag-chip ag-chip-ctx" aria-expanded={open} onClick={() => setOpen(!open)}>
        Context attached: ~{item.estimatedTokens} tokens · {item.nodeIds.length} {item.nodeIds.length === 1 ? 'item' : 'items'}
        <span aria-hidden> {open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="ag-context-body">
          {item.sections.length > 0 && <div className="ag-muted">Sections: {item.sections.join(' · ')}</div>}
          {item.nodeIds.length > 0 && (
            <div className="ag-tool-locs">
              {item.nodeIds.map((id) => (
                <button key={id} type="button" className="ag-chip ag-chip-node" onClick={() => actions.onFocusNode(id)}>{id}</button>
              ))}
            </div>
          )}
          <pre className="ag-pre">{item.text}</pre>
        </div>
      )}
    </div>
  );
}

export function PermissionCard({ item, actions }: { item: Of<'permission'>; actions: Actions }) {
  const pending = item.resolution === undefined;
  const chosen = item.options.find((o) => o.optionId === item.resolution);
  return (
    <div className={`ag-perm ${pending ? 'ag-perm-pending' : ''}`} role={pending ? 'alert' : undefined}>
      <div className="ag-perm-title"><span className="ag-muted">Permission</span> {item.title}</div>
      {pending ? (
        <div className="ag-perm-actions">
          {item.options.map((o) => (
            <button key={o.optionId} type="button" className={`ag-btn ag-btn-${o.kind}`} onClick={() => actions.onRespond(item.requestId, o.optionId)}>
              {o.name}
            </button>
          ))}
          <button type="button" className="ag-btn ag-btn-ghost" onClick={() => actions.onRespond(item.requestId, null)}>Dismiss</button>
        </div>
      ) : (
        <div className="ag-muted">{chosen ? `→ ${chosen.name}` : '→ cancelled'}</div>
      )}
    </div>
  );
}

export function TimelineRow({ item, actions }: { item: TimelineItem; actions: Actions }) {
  switch (item.kind) {
    case 'user': return <div className="ag-msg ag-user">{item.text}</div>;
    case 'agent': return <div className="ag-msg ag-agent"><Markdown text={item.text} onOpenFile={actions.onOpenFile} /></div>;
    case 'thought':
      return (
        <details className="ag-thought">
          <summary>Thinking…</summary>
          <div className="ag-thought-body">{item.text}</div>
        </details>
      );
    case 'tool': return <ToolCard item={item} actions={actions} />;
    case 'context': return <ContextChip item={item} actions={actions} />;
    case 'permission': return <PermissionCard item={item} actions={actions} />;
    default: return <div className="ag-generic">{item.label}</div>;
  }
}
