import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { GraphNode } from '@atomic/core/types';
import { kindColor } from '../ui';

export type KindNodeData = { node: GraphNode } & Record<string, unknown>;

export const KIND_NODE_SIZE = { width: 190, height: 56 };
/** kind nodes with count badges get a third line */
export const BADGED_NODE_SIZE = { width: 190, height: 74 };
export const ROUTE_NODE_SIZE = { width: 190, height: 34 };

export function nodeSizeFor(n: GraphNode) {
  if (n.kind === 'route') return ROUTE_NODE_SIZE;
  return Object.keys(n.badges ?? {}).length ? BADGED_NODE_SIZE : KIND_NODE_SIZE;
}

export function KindNode({ data, selected, sourcePosition = Position.Right, targetPosition = Position.Left }: NodeProps<Node<KindNodeData, 'kind'>>) {
  const n = data.node;
  const badges = Object.entries(n.badges ?? {});
  return (
    <div
      className={`sys-node${selected ? ' selected' : ''}${n.changed ? ' changed' : ''} status-${n.status}`}
      style={{ ['--c' as string]: kindColor(n.kind) }}
      title={`${n.label} · ${n.kind} · ${n.origin} · ${n.status}`}
    >
      <Handle type="target" position={targetPosition} isConnectable={false} />
      <div className="sys-node-title">
        <span className="sys-node-label">{n.label}</span>
        <span className={`sys-pip sys-pip-${n.status}`} />
      </div>
      {n.kind !== 'route' ? (
        <div className="sys-node-sub">
          <span>{n.sublabel ?? n.kind}</span>
          {n.origin !== 'deterministic' ? <span className={`sys-origin sys-origin-${n.origin}`}>{n.origin}</span> : null}
        </div>
      ) : null}
      {n.kind !== 'route' && badges.length ? (
        <div className="sys-node-badges">
          {badges.map(([k, v]) => <span key={k} className="sys-count">{v} {k}</span>)}
        </div>
      ) : null}
      <Handle type="source" position={sourcePosition} isConnectable={false} />
    </div>
  );
}

export function GroupNode({ data, selected, sourcePosition = Position.Right, targetPosition = Position.Left }: NodeProps<Node<KindNodeData, 'group'>>) {
  const n = data.node;
  return (
    <div
      className={`sys-group${selected ? ' selected' : ''}${n.changed ? ' changed' : ''}`}
      style={{ ['--c' as string]: kindColor(n.kind) }}
    >
      <Handle type="target" position={targetPosition} isConnectable={false} />
      <div className="sys-group-head">
        <span className="sys-node-label">{n.label}</span>
        <span className="sys-node-sub"><span>{n.sublabel ?? n.kind}</span></span>
        <span className={`sys-pip sys-pip-${n.status}`} />
      </div>
      <Handle type="source" position={sourcePosition} isConnectable={false} />
    </div>
  );
}
