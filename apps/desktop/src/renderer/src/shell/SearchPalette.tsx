import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { SearchHit } from '@atomic/core/types';
import { InlineError, KindDot, Spinner } from '../components';

export interface SearchPaletteProps {
  onClose(): void;
  onFocusNode(id: string): void;
  onOpenFile(path: string, line?: number): void;
}

export function SearchPalette({ onClose, onFocusNode, onOpenFile }: SearchPaletteProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setBusy(false); setError(null); return; }
    setBusy(true);
    let live = true;
    const t = setTimeout(() => {
      window.atomic.memory.search(q).then(
        (r) => { if (live) { setHits(r); setError(null); setCursor(0); setBusy(false); } },
        (e) => { if (live) { setError(e); setHits([]); setBusy(false); } },
      );
    }, 160);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  // Nodes first, then symbols; the flat order drives keyboard navigation.
  const groups = useMemo(() => {
    const nodes = hits.filter((h) => h.type === 'node');
    const symbols = hits.filter((h) => h.type === 'symbol');
    return [{ label: 'Nodes', items: nodes }, { label: 'Symbols', items: symbols }].filter((g) => g.items.length);
  }, [hits]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    listRef.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, flat]);

  const choose = (h: SearchHit) => {
    onClose();
    if (h.type === 'node') onFocusNode(h.id);
    else if (h.path) onOpenFile(h.path, h.line);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter' && flat[cursor]) { e.preventDefault(); choose(flat[cursor]); }
  };

  let index = -1;
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="palette-input-row">
          <input
            autoFocus
            className="palette-input"
            placeholder="Search nodes and symbols…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {busy && <Spinner />}
        </div>
        <div className="palette-list" ref={listRef}>
          {error != null && <InlineError error={error} />}
          {!busy && query.trim() && flat.length === 0 && error == null && <div className="palette-empty">No results</div>}
          {!query.trim() && <div className="palette-empty">Type to search the project memory</div>}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="section-label">{g.label}</div>
              {g.items.map((h) => {
                index += 1;
                const i = index;
                const where = h.type === 'symbol' && h.path ? `${h.path}${h.line ? `:${h.line}` : ''}` : h.snippet;
                return (
                  <div
                    key={`${h.type}:${h.id}`}
                    className={`palette-item ${i === cursor ? 'is-cursor' : ''}`}
                    onMouseMove={() => setCursor(i)}
                    onClick={() => choose(h)}
                  >
                    <KindDot kind={h.kind} />
                    <span className="palette-title">{h.title}</span>
                    <span className="palette-kind">{h.kind}</span>
                    <span className="palette-snippet">{where}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
