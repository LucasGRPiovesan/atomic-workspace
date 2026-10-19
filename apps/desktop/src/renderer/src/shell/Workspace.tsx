import { useCallback, useEffect, useRef, useState } from 'react';
import type { IndexProgressEvent, ProjectSummary } from '../../../shared/ipc';
import { Button, IconButton, InlineError, Spinner } from '../components';
import { SystemWorkspace } from '../features/system';
import { AgentPanel } from '../features/agent';
import { ApplicationMode } from '../features/app';
import { SearchPalette } from './SearchPalette';
import { CodeViewer } from './CodeViewer';
import { StatusBar } from './StatusBar';

type Mode = 'development' | 'application';

const PANEL_KEY = 'atomic.agentPanel';
const MIN_W = 300;
const MAX_W = 900;

function loadPanel(): { width: number; collapsed: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(PANEL_KEY) ?? '{}') as { width?: number; collapsed?: boolean };
    return { width: Math.min(MAX_W, Math.max(MIN_W, v.width ?? 400)), collapsed: !!v.collapsed };
  } catch {
    return { width: 400, collapsed: false };
  }
}

export function Workspace({ initial }: { initial: ProjectSummary }) {
  const [project, setProject] = useState(initial);
  const [mode, setMode] = useState<Mode>('development');
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [file, setFile] = useState<{ path: string; line?: number } | null>(null);
  const [panel, setPanel] = useState(loadPanel);
  const [progress, setProgress] = useState<IndexProgressEvent | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dragging = useRef(false);

  useEffect(() => setProject(initial), [initial]);

  useEffect(() => {
    try { localStorage.setItem(PANEL_KEY, JSON.stringify(panel)); } catch { /* storage unavailable */ }
  }, [panel]);

  useEffect(() => {
    const offs = [
      window.atomic.on('index:progress', (p) => setProgress(p.phase === 'done' ? null : p)),
      window.atomic.on('project:changed', setProject),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key === 'k') { e.preventDefault(); setSearchOpen(true); }
      else if (e.key === '1') { e.preventDefault(); setMode('development'); }
      else if (e.key === '2') { e.preventDefault(); setMode('application'); }
      else if (e.key === 'j') { e.preventDefault(); setPanel((p) => ({ ...p, collapsed: !p.collapsed })); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const focusNode = useCallback((id: string | null) => {
    setFocusNodeId(id);
    setMode('development');
    setFile(null);
  }, []);
  const openFile = useCallback((path: string, line?: number) => setFile({ path, line }), []);
  const closeFile = useCallback(() => setFile(null), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  const reindex = async () => {
    setReindexing(true);
    setError(null);
    try {
      setProject(await window.atomic.project.reindex());
    } catch (e) {
      setError(e);
    } finally {
      setReindexing(false);
      setProgress(null);
    }
  };

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const width = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX));
    setPanel({ width, collapsed: false });
  };
  const endDrag = () => { dragging.current = false; };

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="topbar-project">
          <span className="project-name">{project.name}</span>
          <span className="project-root" title={project.root}>{project.root}</span>
        </div>
        <div className="segmented" role="group" aria-label="Mode">
          <button type="button" className={mode === 'development' ? 'is-active' : ''} onClick={() => setMode('development')} title="Ctrl+1">
            Development
          </button>
          <button type="button" className={mode === 'application' ? 'is-active' : ''} onClick={() => setMode('application')} title="Ctrl+2">
            Application
          </button>
        </div>
        <button type="button" className="search-box" onClick={() => setSearchOpen(true)}>
          <span>Search…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="topbar-spacer" />
        {(progress || reindexing) && (
          <span className="index-progress" title={progress?.message}>
            <Spinner />
            {progress ? `${progress.phase}${pct != null ? ` ${pct}%` : ''}` : 'indexing'}
          </span>
        )}
        <Button onClick={reindex} disabled={reindexing}>Reindex</Button>
        <IconButton
          label={panel.collapsed ? 'Show agent panel (Ctrl+J)' : 'Hide agent panel (Ctrl+J)'}
          active={!panel.collapsed}
          onClick={() => setPanel((p) => ({ ...p, collapsed: !p.collapsed }))}
        >
          ◧
        </IconButton>
      </header>
      {error != null && <InlineError error={error} />}

      <div className="workspace-body">
        <main className="main-area">
          <section className="mode-pane" hidden={mode !== 'development'}>
            <SystemWorkspace project={project} focusNodeId={focusNodeId} onFocusNode={setFocusNodeId} onOpenFile={openFile} />
          </section>
          <section className="mode-pane" hidden={mode !== 'application'}>
            <ApplicationMode project={project} onFocusNode={focusNode} />
          </section>
          {file && <CodeViewer path={file.path} line={file.line} onClose={closeFile} />}
        </main>
        {!panel.collapsed && (
          <div
            className="resize-handle"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startDrag}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        )}
        <aside className="agent-area" style={{ width: panel.width }} hidden={panel.collapsed}>
          <AgentPanel project={project} onFocusNode={focusNode} onOpenFile={openFile} />
        </aside>
      </div>

      <StatusBar initial={project.stats} projectRoot={project.root} />
      {searchOpen && <SearchPalette onClose={closeSearch} onFocusNode={focusNode} onOpenFile={openFile} />}
    </div>
  );
}
