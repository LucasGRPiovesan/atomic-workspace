import { useEffect, useState } from 'react';
import type { MemoryStats } from '@atomic/core/types';
import { compact, timeAgo } from './format';

export function StatusBar({ initial, projectRoot }: { initial: MemoryStats; projectRoot: string }) {
  const [stats, setStats] = useState<MemoryStats>(initial);
  const [error, setError] = useState(false);

  useEffect(() => setStats(initial), [initial]);

  useEffect(() => {
    const refresh = () => {
      window.atomic.memory.stats().then((s) => { setStats(s); setError(false); }).catch(() => setError(true));
    };
    refresh();
    const offs = [window.atomic.on('memory:changed', refresh), window.atomic.on('project:changed', refresh)];
    return () => offs.forEach((off) => off());
  }, [projectRoot]);

  const nodes = Object.values(stats.nodesByKind).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <footer className="statusbar">
      <span>{stats.files} files</span>
      <span>{stats.symbols} symbols</span>
      <span>{stats.routes} routes</span>
      <span>{stats.entities} entities</span>
      <span>{nodes} knowledge nodes</span>
      {stats.stale > 0 && <span className="status-warn">{stats.stale} stale</span>}
      <span className="status-spacer" />
      {error && <span className="status-warn">stats unavailable</span>}
      <span>context served: {compact(stats.contextServed.tokens)} tok of ~{compact(stats.estimatedRepoTokens)} repo tok</span>
      <span>indexed {timeAgo(stats.lastIndexedAt)}</span>
    </footer>
  );
}
