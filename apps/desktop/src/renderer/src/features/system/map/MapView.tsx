import { useEffect, useMemo, useState } from 'react';
import type { GraphData, NodeKind, RelKind } from '@atomic/core/types';
import { useSystem } from '../data-context';
import { filterGraph, kindsIn, relsIn } from '../graph-utils';
import { Empty, KIND_LABEL, kindColor } from '../ui';
import { GraphCanvas } from './GraphCanvas';
import { GroupNode, KindNode, nodeSizeFor } from './KindNode';

const NODE_TYPES = { kind: KindNode, group: GroupNode };
const NO_DATA = () => ({});
// structural noise is off by default; the toggles bring it back
const DEFAULT_HIDDEN_RELS: RelKind[] = ['tests'];

interface Props {
  selectedId: string | null;
  centerId: string | null;
  onSelect(id: string | null): void;
}

export function MapView({ selectedId, centerId, onSelect }: Props) {
  const { system, changedIds, byId, loading } = useSystem();
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<NodeKind>>(new Set());
  const [hiddenRels, setHiddenRels] = useState<ReadonlySet<RelKind>>(new Set(DEFAULT_HIDDEN_RELS));
  const [focus, setFocus] = useState<string | null>(null);
  const [focusData, setFocusData] = useState<GraphData | null>(null);

  useEffect(() => {
    if (!focus) { setFocusData(null); return; }
    let live = true;
    void window.atomic.memory.graph('neighborhood', focus).then((g) => { if (live) setFocusData(g); });
    return () => { live = false; };
  }, [focus]);

  const base = focus ? focusData : system;
  const withChanged = useMemo<GraphData | null>(
    () => (base ? { ...base, nodes: base.nodes.map((n) => (changedIds.has(n.id) && !n.changed ? { ...n, changed: true } : n)) } : null),
    [base, changedIds],
  );
  const filtered = useMemo(() => (withChanged ? filterGraph(withChanged, { hiddenKinds, hiddenRels }) : null), [withChanged, hiddenKinds, hiddenRels]);
  const kinds = useMemo(() => (withChanged ? kindsIn(withChanged.nodes) : []), [withChanged]);
  const rels = useMemo(() => (withChanged ? relsIn(withChanged.edges) : []), [withChanged]);

  const toggle = <T,>(set: ReadonlySet<T>, v: T, apply: (s: ReadonlySet<T>) => void) => {
    const next = new Set(set);
    if (!next.delete(v)) next.add(v);
    apply(next);
  };

  if (loading && !system.nodes.length) return <Empty title="Loading the system map…" />;
  if (!system.nodes.length) {
    return (
      <Empty title="The map is empty">
        Index the project, then ask your agent to build understanding from the Agent panel — the map only shows what memory knows.
      </Empty>
    );
  }

  return (
    <div className="sys-map">
      <div className="sys-toolbar">
        {focus ? (
          <div className="sys-crumb">
            <button type="button" className="sys-link" onClick={() => setFocus(null)}>System map</button>
            <span>›</span>
            <strong>Focus: {byId.get(focus)?.title ?? focus}</strong>
          </div>
        ) : <span className="sys-hint">Double-click a node to focus its neighborhood</span>}
        <div className="sys-filters" role="group" aria-label="Kinds">
          {kinds.map((k) => (
            <button
              key={k} type="button" className={`sys-toggle${hiddenKinds.has(k) ? '' : ' on'}`}
              style={{ ['--c' as string]: kindColor(k) }} onClick={() => toggle(hiddenKinds, k, setHiddenKinds)}
            >{KIND_LABEL[k]}</button>
          ))}
        </div>
        <div className="sys-filters" role="group" aria-label="Edges">
          {rels.map((r) => (
            <button key={r} type="button" className={`sys-toggle edge${hiddenRels.has(r) ? '' : ' on'}`} onClick={() => toggle(hiddenRels, r, setHiddenRels)}>
              {r}
            </button>
          ))}
        </div>
      </div>
      {filtered ? (
        <GraphCanvas
          data={filtered}
          nodeTypes={NODE_TYPES}
          nodeType="kind"
          nodeSize={nodeSizeFor}
          nodeData={NO_DATA}
          selectedId={selectedId}
          centerId={centerId}
          onSelect={onSelect}
          onOpen={setFocus}
          minimap
          emptyHint="Everything is filtered out."
        />
      ) : <Empty title="Loading neighborhood…" />}
    </div>
  );
}
