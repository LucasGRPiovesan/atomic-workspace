import { useEffect, useState } from 'react';
import type { ProjectSummary, RecentProject } from '../../../shared/ipc';
import { Button, InlineError, Spinner } from '../components';
import { timeAgo } from './format';

export function Welcome({ onOpened }: { onOpened(p: ProjectSummary): void }) {
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    window.atomic.project.recent().then(setRecent).catch(() => setRecent([]));
  }, []);

  const open = async (root: string) => {
    setBusy(true);
    setError(null);
    try {
      onOpened(await window.atomic.project.open(root));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    setError(null);
    try {
      const root = await window.atomic.project.pickFolder();
      if (root) await open(root);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Atomic Workspace</h1>
        <p className="welcome-tag">Your coding agent, with a memory of your software.</p>
        <ul className="welcome-points">
          <li>Work through your own coding agent (Claude, Codex, OpenCode…) in the side panel.</li>
          <li>A local project memory keeps capabilities, flows, routes and entities, served to the agent as small context packs.</li>
          <li>Understand the system in Development mode, or run and trace the real app in Application mode.</li>
        </ul>
        <div className="welcome-actions">
          <Button variant="primary" onClick={pick} disabled={busy}>
            {busy ? <Spinner /> : null} Open project folder
          </Button>
        </div>
        {error != null && <InlineError error={error} />}
        {recent.length > 0 && (
          <div className="recent">
            <div className="section-label">Recent projects</div>
            {recent.map((r) => (
              <button key={r.root} type="button" className="recent-item" disabled={busy} onClick={() => open(r.root)}>
                <span className="recent-name">{r.name}</span>
                <span className="recent-path">{r.root}</span>
                <span className="recent-when">{timeAgo(r.openedAt)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
