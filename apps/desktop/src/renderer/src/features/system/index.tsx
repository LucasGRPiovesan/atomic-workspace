// Development mode: the project as software. Left sub-navigation + content + right node-detail drawer.
import { useCallback, useEffect, useState } from 'react';
import type { ProjectSummary } from '../../../../shared/ipc';
import './system.css';
import { Changes } from './changes/Changes';
import { SystemProvider, useSystem } from './data-context';
import { DataModel } from './data/DataModel';
import { NodeDrawer } from './detail/NodeDrawer';
import { Flows } from './flows/Flows';
import { MapView } from './map/MapView';
import { MemoryTable } from './memory/MemoryTable';
import { Overview } from './overview/Overview';

export interface SystemWorkspaceProps {
  project: ProjectSummary;
  /** node id focused from elsewhere (search, agent context, app trace) */
  focusNodeId?: string | null;
  onFocusNode(id: string | null): void;
  /** open a file location (shell shows the code viewer) */
  onOpenFile(path: string, line?: number): void;
}

type Section = 'overview' | 'map' | 'data' | 'flows' | 'changes' | 'memory';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'map', label: 'System map' },
  { id: 'data', label: 'Data model' },
  { id: 'flows', label: 'Flows' },
  { id: 'changes', label: 'Changes' },
  { id: 'memory', label: 'Memory' },
];

export function SystemWorkspace(props: SystemWorkspaceProps) {
  return (
    <SystemProvider>
      <Shell {...props} />
    </SystemProvider>
  );
}

function Shell({ project, focusNodeId, onFocusNode, onOpenFile }: SystemWorkspaceProps) {
  const { error, changes, stats } = useSystem();
  const [section, setSection] = useState<Section>('overview');
  const [selected, setSelected] = useState<string | null>(focusNodeId ?? null);
  const [centerId, setCenterId] = useState<string | null>(null);

  // focus coming from search / agent / app trace: open the drawer and show the node in the map
  useEffect(() => {
    if (!focusNodeId) return;
    setSelected(focusNodeId);
    setCenterId(focusNodeId);
    setSection((s) => (s === 'overview' ? 'map' : s));
  }, [focusNodeId]);

  const select = useCallback((id: string | null) => {
    setSelected(id);
    onFocusNode(id);
  }, [onFocusNode]);

  const focusNode = useCallback((id: string) => {
    setSelected(id);
    setCenterId(id);
    onFocusNode(id);
  }, [onFocusNode]);

  const staleCount = stats?.stale ?? project.stats.stale;

  return (
    <div className="sys-root">
      <nav className="sys-nav" aria-label="System views">
        <div className="sys-nav-title">{project.name}</div>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={`sys-nav-item${section === s.id ? ' on' : ''}`} onClick={() => setSection(s.id)}>
            <span>{s.label}</span>
            {s.id === 'memory' && staleCount ? <span className="sys-count warn" title="Stale knowledge">{staleCount}</span> : null}
            {s.id === 'changes' && changes.length ? <span className="sys-count">{changes.length}</span> : null}
          </button>
        ))}
      </nav>

      <main className="sys-content">
        {error ? <div className="sys-callout stale"><span>Could not read project memory: {error}</span></div> : null}
        {section === 'overview' ? <div className="sys-scroll"><Overview project={project} onSelect={focusNode} /></div> : null}
        {section === 'map' ? <MapView selectedId={selected} centerId={centerId} onSelect={select} /> : null}
        {section === 'data' ? <DataModel selectedId={selected} onSelect={select} /> : null}
        {section === 'flows' ? <Flows selectedId={selected} onSelect={focusNode} onOpenFile={onOpenFile} /> : null}
        {section === 'changes' ? <div className="sys-scroll"><Changes onSelect={focusNode} onOpenFile={onOpenFile} /></div> : null}
        {section === 'memory' ? <MemoryTable selectedId={selected} onSelect={focusNode} /> : null}
      </main>

      {selected ? (
        <NodeDrawer nodeId={selected} onClose={() => select(null)} onFocus={focusNode} onOpenFile={onOpenFile} />
      ) : null}
    </div>
  );
}
