import { useEffect, useRef, useState } from 'react';
import type { FileContent } from '../../../shared/ipc';
import { EmptyState, IconButton, InlineError, Spinner } from '../components';

export interface CodeViewerProps {
  path: string;
  line?: number;
  onClose(): void;
}

export function CodeViewer({ path, line, onClose }: CodeViewerProps) {
  const [file, setFile] = useState<FileContent | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const hit = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    setFile(undefined);
    setError(null);
    window.atomic.memory.readFile(path).then((f) => { if (live) setFile(f); }, (e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [path]);

  useEffect(() => {
    hit.current?.scrollIntoView({ block: 'center' });
  }, [file, line]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the search palette handles its own Esc
      if (e.key === 'Escape' && !document.querySelector('.palette')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const crumbs = path.split('/');
  const lines = file ? file.content.split('\n') : [];

  return (
    <aside className="code-viewer" aria-label={`Code viewer: ${path}`}>
      <header className="code-head">
        <nav className="breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i} className={i === crumbs.length - 1 ? 'crumb-last' : 'crumb'}>{c}</span>
          ))}
          {line != null && <span className="crumb-line">:{line}</span>}
        </nav>
        <IconButton label="Close (Esc)" onClick={onClose}>✕</IconButton>
      </header>
      <div className="code-body">
        {error != null && <InlineError error={error} />}
        {file === undefined && error == null && <div className="code-loading"><Spinner /> Loading…</div>}
        {file === null && <EmptyState title="File not available" hint={path} />}
        {file && (
          <div className="code-lines">
            {lines.map((text, i) => {
              const n = i + 1;
              const on = n === line;
              return (
                <div key={n} ref={on ? hit : undefined} className={`code-line ${on ? 'is-hit' : ''}`}>
                  <span className="code-no">{n}</span>
                  <span className="code-text">{text || ' '}</span>
                </div>
              );
            })}
            {!file.complete && <div className="code-trunc">File truncated: too large for the viewer.</div>}
          </div>
        )}
      </div>
    </aside>
  );
}
