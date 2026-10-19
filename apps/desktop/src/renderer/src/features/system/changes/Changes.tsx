import { useSystem } from '../data-context';
import { Chip, Empty, FileChip, relTime } from '../ui';

interface Props {
  onSelect(id: string): void;
  onOpenFile(path: string, line?: number): void;
}

const SOURCE_LABEL = { agent: 'Agent session', external: 'Outside an agent', index: 'Re-index' } as const;

export function Changes({ onSelect, onOpenFile }: Props) {
  const { changes, byId } = useSystem();
  if (!changes.length) {
    return <Empty title="No changes recorded yet">Changes appear here as your agent or an editor modifies files in the project.</Empty>;
  }
  const chip = (id: string, tone?: 'stale') => (
    <button key={id} type="button" className={`sys-chip sys-chip-btn${tone ? ` sys-chip-${tone}` : ''}`} onClick={() => onSelect(id)} title={id}>
      {byId.get(id)?.title ?? id}
    </button>
  );
  return (
    <ol className="sys-timeline">
      {changes.map((c, i) => (
        <li key={c.id} className={i === 0 ? 'latest' : ''}>
          <div className="sys-tl-head">
            <strong>{SOURCE_LABEL[c.source]}{c.agentId ? ` · ${c.agentId}` : ''}</strong>
            <span className="sys-hint">{relTime(c.at)}</span>
            {i === 0 ? <Chip title="Highlighted in the system map">latest</Chip> : null}
          </div>
          {c.summary ? <p>{c.summary}</p> : null}
          {c.files.length ? (
            <div className="sys-row">
              {c.files.map((f) => (
                <span key={f.path} className={`sys-fc sys-fc-${f.status}`}>
                  <span className="sys-fc-s">{f.status === 'added' ? '+' : f.status === 'deleted' ? '−' : '~'}</span>
                  <FileChip path={f.path} onOpen={onOpenFile} />
                </span>
              ))}
            </div>
          ) : null}
          {c.affectedNodes.length ? <div className="sys-row"><span className="sys-label">affects</span>{c.affectedNodes.map((id) => chip(id))}</div> : null}
          {c.staleNodes.length ? <div className="sys-row"><span className="sys-label stale">went stale</span>{c.staleNodes.map((id) => chip(id, 'stale'))}</div> : null}
        </li>
      ))}
    </ol>
  );
}
