import { useCallback, useEffect, useMemo, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { EntityField, EntityRelation, GraphData, GraphEdge, GraphNode } from '@atomic/core/types';
import { useSystem } from '../data-context';
import { GraphCanvas } from '../map/GraphCanvas';
import { Empty } from '../ui';

type EntityData = { node: GraphNode; fields: EntityField[]; changed: boolean } & Record<string, unknown>;

const HEADER = 30;
const ROW = 20;

function EntityNode({ data, selected }: NodeProps<Node<EntityData, 'entity'>>) {
  return (
    <div className={`sys-entity${selected ? ' selected' : ''}${data.changed ? ' changed' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="sys-entity-head">
        <span>{data.node.label}</span>
        <span className={`sys-pip sys-pip-${data.node.status}`} />
      </div>
      <ul>
        {data.fields.map((f) => (
          <li key={f.name} className={f.isId ? 'id' : ''}>
            <span>{f.name}{f.optional ? '?' : ''}</span>
            <span className="type">{f.type}</span>
          </li>
        ))}
        {!data.fields.length ? <li className="type">no fields recorded</li> : null}
      </ul>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { entity: EntityNode };

const asFields = (v: unknown): EntityField[] => (Array.isArray(v) ? (v as EntityField[]) : []);
const asRelations = (v: unknown): EntityRelation[] => (Array.isArray(v) ? (v as EntityRelation[]) : []);

export function DataModel({ selectedId, onSelect }: { selectedId: string | null; onSelect(id: string | null): void }) {
  const { byId, changedIds, changes } = useSystem();
  const [graph, setGraph] = useState<GraphData | null>(null);

  // reload when the memory changes (changes list identity changes on every memory:changed)
  useEffect(() => {
    let live = true;
    void window.atomic.memory.graph('data').then((g) => { if (live) setGraph(g); });
    return () => { live = false; };
  }, [changes]);

  const relationKind = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of byId.values()) {
      if (n.kind !== 'entity') continue;
      for (const r of asRelations(n.data?.relations)) m.set(`${n.id}>entity:${r.target}`, r.kind === 'unknown' ? 'relates' : r.kind);
    }
    return m;
  }, [byId]);

  const nodeData = useCallback((n: GraphNode) => ({
    fields: asFields(byId.get(n.id)?.data?.fields),
    changed: !!n.changed || changedIds.has(n.id),
  }), [byId, changedIds]);
  const nodeSize = useCallback((n: GraphNode) => ({
    width: 210, height: HEADER + 8 + ROW * Math.max(1, asFields(byId.get(n.id)?.data?.fields).length),
  }), [byId]);
  const edgeLabel = useCallback((e: GraphEdge) => relationKind.get(`${e.from}>${e.to}`) ?? e.rel, [relationKind]);

  if (!graph) return <Empty title="Loading data model…" />;
  if (!graph.nodes.length) {
    return <Empty title="No entities found">Entities come from schema files (Prisma, SQL, ORM models). None were detected in this project.</Empty>;
  }
  return (
    <GraphCanvas
      data={graph}
      nodeTypes={NODE_TYPES}
      nodeType="entity"
      nodeSize={nodeSize}
      nodeData={nodeData}
      edgeLabel={edgeLabel}
      selectedId={selectedId}
      onSelect={onSelect}
      direction="LR"
    />
  );
}
