import { useEffect, useState } from 'react';
import type { ProjectSummary } from '../../shared/ipc';
import { InlineError, Spinner } from './components';
import { Welcome } from './shell/Welcome';
import { Workspace } from './shell/Workspace';

export function App() {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    // subscribe first: a project opened at launch (--project) may finish after current() answered null
    const off = window.atomic.on('project:changed', (p) => { setProject((prev) => prev ?? p); setLoading(false); });
    window.atomic.project.current().then((p) => setProject((prev) => prev ?? p), setError).finally(() => setLoading(false));
    return off;
  }, []);

  if (loading) return <div className="boot"><Spinner size={18} /></div>;
  return (
    <>
      {error != null && <InlineError error={error} />}
      {project ? <Workspace initial={project} /> : <Welcome onOpened={setProject} />}
    </>
  );
}
