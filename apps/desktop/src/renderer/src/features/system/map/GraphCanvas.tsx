import { useEffect, useMemo } from 'react';
import {
  Background, Controls, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphData, GraphEdge, GraphNode } from '@atomic/core/types';
import { layoutGraph, type Size } from '../graph-utils';

export interface GraphCanvasProps {
  data: GraphData;
  nodeTypes: NodeTypes;
  /** React Flow node type used for leaf nodes (groups always use "group") */
  nodeType: string;
  nodeSize(n: GraphNode): Size;
  nodeData(n: GraphNode): Record<string, unknown>;
  edgeLabel?(e: GraphEdge): string | undefined;
  direction?: 'LR' | 'TB';
  selectedId?: string | null;
  /** node to scroll into view */
  centerId?: string | null;
  onSelect(id: string | null): void;
  onOpen?(id: string): void;
  minimap?: boolean;
  emptyHint?: string;
}

const MAX_LABELLED_EDGES = 60;

function Canvas(p: GraphCanvasProps) {
  const { fitView } = useReactFlow();
  const { data, nodeSize, nodeData, edgeLabel, nodeType, direction } = p;

  // layout depends on structure only — selection/hover never trigger it
  const placed = useMemo(
    () => layoutGraph(data, { nodeSize, direction }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeSize is a stable per-view function
    [data, direction],
  );

  const baseNodes = useMemo<Node[]>(() => {
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    return placed.map((pl) => {
      const gn = byId.get(pl.id)!;
      return {
        id: pl.id,
        type: pl.isGroup ? 'group' : nodeType,
        position: { x: pl.x, y: pl.y },
        parentId: pl.parent,
        extent: pl.parent ? ('parent' as const) : undefined,
        width: pl.width,
        height: pl.height,
        style: { width: pl.width, height: pl.height },
        sourcePosition: pl.direction === 'TB' ? Position.Bottom : Position.Right,
        targetPosition: pl.direction === 'TB' ? Position.Top : Position.Left,
        data: { ...nodeData(gn), node: gn },
      };
    });
  }, [placed, data, nodeData, nodeType]);

  const nodes = useMemo(
    () => baseNodes.map((n) => (n.id === p.selectedId ? { ...n, selected: true } : n)),
    [baseNodes, p.selectedId],
  );

  const edges = useMemo<Edge[]>(() => {
    const label = data.edges.length <= MAX_LABELLED_EDGES;
    return data.edges.map((e, i) => ({
      id: `${e.from}>${e.to}>${e.rel}>${i}`,
      source: e.from,
      target: e.to,
      label: (label && (edgeLabel ? edgeLabel(e) : e.rel)) || undefined,
      className: `sys-edge sys-edge-${e.rel}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      data: { rel: e.rel },
    }));
  }, [data.edges, edgeLabel]);

  useEffect(() => {
    const t = requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 200 }));
    return () => cancelAnimationFrame(t);
  }, [placed, fitView]);

  useEffect(() => {
    if (!p.centerId || !baseNodes.some((n) => n.id === p.centerId)) return;
    void fitView({ nodes: [{ id: p.centerId }], duration: 300, maxZoom: 1.1, padding: 0.8 });
  }, [p.centerId, baseNodes, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={p.nodeTypes}
      colorMode="dark"
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.1}
      maxZoom={1.8}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => p.onSelect(n.id)}
      onNodeDoubleClick={(_, n) => p.onOpen?.(n.id)}
      onPaneClick={() => p.onSelect(null)}
    >
      <Background gap={20} />
      <Controls showInteractive={false} />
      {p.minimap ? (
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => ((n.data as { node?: GraphNode }).node ? `var(--k-${(n.data as { node: GraphNode }).node.kind})` : 'var(--border)')}
        />
      ) : null}
    </ReactFlow>
  );
}

export function GraphCanvas(p: GraphCanvasProps) {
  if (!p.data.nodes.length) {
    return <div className="sys-canvas sys-canvas-empty">{p.emptyHint ?? 'Nothing to show yet.'}</div>;
  }
  return (
    <div className="sys-canvas">
      <ReactFlowProvider>
        <Canvas {...p} />
      </ReactFlowProvider>
    </div>
  );
}
