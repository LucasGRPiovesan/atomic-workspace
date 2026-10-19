import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChangeSet, GraphData, ImportedSource, KnowledgeNode, MemoryStats } from '@atomic/core/types';

export interface SystemData {
  nodes: KnowledgeNode[];
  byId: Map<string, KnowledgeNode>;
  system: GraphData;
  changes: ChangeSet[];
  sources: ImportedSource[];
  stats: MemoryStats | null;
  /** nodes touched by the most recent change set */
  changedIds: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  reload(): void;
}

const empty: GraphData = { view: 'system', nodes: [], edges: [] };
const Ctx = createContext<SystemData | null>(null);

export function useSystem(): SystemData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSystem outside <SystemProvider>');
  return v;
}

/** Loads the memory snapshot once and re-loads (coalesced) on memory:changed / project:changed. */
export function SystemProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<SystemData, 'byId' | 'changedIds' | 'reload'>>({
    nodes: [], system: empty, changes: [], sources: [], stats: null, loading: true, error: null,
  });
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    const m = window.atomic.memory;
    Promise.all([m.listNodes(), m.graph('system'), m.changes(50), m.sources(), m.stats()])
      .then(([nodes, system, changes, sources, stats]) => {
        if (mine === seq.current) setState({ nodes, system, changes, sources, stats, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      });
  }, []);

  useEffect(() => {
    load();
    const offs = [window.atomic.on('memory:changed', load), window.atomic.on('project:changed', load)];
    return () => offs.forEach((off) => off());
  }, [load]);

  const value = useMemo<SystemData>(() => ({
    ...state,
    byId: new Map(state.nodes.map((n) => [n.id, n])),
    // a full re-index touches everything, so only highlight the latest real (agent/external) change
    changedIds: new Set(state.changes.find((c) => c.source !== 'index')?.affectedNodes ?? []),
    reload: load,
  }), [state, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
