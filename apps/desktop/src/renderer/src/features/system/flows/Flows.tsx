import { useEffect, useMemo, useState } from 'react';
import type { FlowStep, GraphData } from '@atomic/core/types';
import { useSystem } from '../data-context';
import { GraphCanvas } from '../map/GraphCanvas';
import { GroupNode, KindNode, nodeSizeFor } from '../map/KindNode';
import { Chip, Empty, FileChip, KindBadge, OriginBadge, StatusBadge } from '../ui';

const NODE_TYPES = { kind: KindNode, group: GroupNode };
const NO_DATA = () => ({});

interface Props {
  selectedId: string | null;
  onSelect(id: string | null): void;
  onOpenFile(path: string, line?: number): void;
}

const stepsOf = (data: Record<string, unknown> | undefined): FlowStep[] =>
  Array.isArray(data?.steps) ? [...(data.steps as FlowStep[])].sort((a, b) => a.order - b.order) : [];

export function Flows({ selectedId, onSelect, onOpenFile }: Props) {
  const { nodes, byId } = useSystem();
  const flows = useMemo(() => nodes.filter((n) => n.kind === 'flow'), [nodes]);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);

  const current = (flowId && byId.get(flowId)) || flows[0] || null;
  const currentId = current?.id;

  useEffect(() => {
    if (!currentId) { setGraph(null); return; }
    let live = true;
    void window.atomic.memory.graph('flow', currentId).then((g) => { if (live) setGraph(g); });
    return () => { live = false; };
  }, [currentId, nodes]);

  if (!flows.length) {
    return (
      <Empty title="No flows recorded yet">
        Flows are written by your coding agent. Use “Build understanding” in the Agent panel and it will record the ordered steps
        (route → service → data → integration) it finds.
      </Empty>
    );
  }
  const steps = stepsOf(current?.data);
  const trigger = typeof current?.data?.trigger === 'string' ? current.data.trigger : null;

  return (
    <div className="sys-flows">
      <aside className="sys-list">
        {flows.map((f) => (
          <button key={f.id} type="button" className={`sys-list-item${f.id === currentId ? ' on' : ''}`} onClick={() => { setFlowId(f.id); onSelect(f.id); }}>
            <span>{f.title}</span>
            <span className="sys-row"><StatusBadge status={f.status} /><OriginBadge origin={f.origin} /></span>
          </button>
        ))}
      </aside>
      {current ? (
        <section className="sys-flow-main">
          <header className="sys-flow-head">
            <h3>{current.title}</h3>
            <KindBadge kind="flow" /><StatusBadge status={current.status} /><OriginBadge origin={current.origin} />
            {trigger ? <Chip title="Trigger">⚡ {trigger}</Chip> : null}
            <p>{current.summary}</p>
          </header>
          <div className="sys-flow-body">
            <ol className="sys-steps">
              {steps.map((s) => {
                const target = s.nodeId ? byId.get(s.nodeId) : undefined;
                return (
                  <li key={s.order} className={s.nodeId && s.nodeId === selectedId ? 'on' : ''}>
                    <span className="sys-step-n">{s.order}</span>
                    <div>
                      <div className="sys-step-title">{s.title}</div>
                      <div className="sys-row">
                        {s.path ? <FileChip path={s.path} line={s.line} onOpen={onOpenFile} /> : null}
                        {s.symbol ? <Chip>{s.symbol}</Chip> : null}
                        {s.nodeId ? (
                          <Chip onClick={() => onSelect(s.nodeId!)} title="Open node detail">
                            {target ? `${target.kind}: ${target.title}` : s.nodeId}
                          </Chip>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
              {!steps.length ? <li className="sys-hint">This flow has no recorded steps.</li> : null}
            </ol>
            <div className="sys-flow-graph">
              {graph ? (
                <GraphCanvas
                  data={graph}
                  nodeTypes={NODE_TYPES}
                  nodeType="kind"
                  nodeSize={nodeSizeFor}
                  nodeData={NO_DATA}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  direction="LR"
                  emptyHint="No linked nodes for this flow."
                />
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
