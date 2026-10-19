import type { ReactNode } from 'react';
import type { NodeKind, NodeOrigin, NodeStatus } from '@atomic/core/types';

export const KIND_LABEL: Record<NodeKind, string> = {
  capability: 'Capability', module: 'Module', flow: 'Flow', rule: 'Rule', entity: 'Entity', integration: 'Integration',
  route: 'Route', component: 'Component', test_suite: 'Tests', convention: 'Convention', decision: 'Decision',
  instruction: 'Instruction', note: 'Note',
};
export const ORIGIN_LABEL: Record<NodeOrigin, string> = {
  deterministic: 'code', imported: 'imported', agent: 'agent', user: 'you',
};
export const STATUS_LABEL: Record<NodeStatus, string> = { fresh: 'fresh', stale: 'stale', unverified: 'unverified' };

export const kindColor = (k: NodeKind) => `var(--k-${k})`;

export function KindBadge({ kind }: { kind: NodeKind }) {
  return (
    <span className="sys-badge sys-kind" style={{ ['--c' as string]: kindColor(kind) }}>
      <i className="sys-dot" />{KIND_LABEL[kind]}
    </span>
  );
}

export function OriginBadge({ origin }: { origin: NodeOrigin }) {
  return <span className={`sys-badge sys-origin sys-origin-${origin}`} title={`Origin: ${origin}`}>{ORIGIN_LABEL[origin]}</span>;
}

export function StatusBadge({ status }: { status: NodeStatus }) {
  return <span className={`sys-badge sys-status sys-status-${status}`} title={`Status: ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Confidence({ value }: { value: number }) {
  return <span className="sys-badge" title="Confidence">{Math.round(value * 100)}%</span>;
}

export function Chip({ children, onClick, title, active }: { children: ReactNode; onClick?: () => void; title?: string; active?: boolean }) {
  return onClick
    ? <button type="button" className={`sys-chip sys-chip-btn${active ? ' on' : ''}`} onClick={onClick} title={title}>{children}</button>
    : <span className="sys-chip" title={title}>{children}</span>;
}

export function FileChip({ path, line, onOpen }: { path: string; line?: number; onOpen(path: string, line?: number): void }) {
  return (
    <button type="button" className="sys-chip sys-chip-btn sys-file" onClick={() => onOpen(path, line)} title="Open in code viewer">
      {path}{line ? `:${line}` : ''}
    </button>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="sys-empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export const relTime = (iso: string): string => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
};
