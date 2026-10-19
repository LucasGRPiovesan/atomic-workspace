import { useMemo } from 'react';
import type { NodeKind } from '@atomic/core/types';
import type { ProjectSummary } from '../../../../../shared/ipc';
import { useSystem } from '../data-context';
import { capabilityCards, coverage, edgesWithParents, routesByModule } from '../graph-utils';
import { Chip, Empty, KindBadge, OriginBadge, StatusBadge } from '../ui';

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

interface Props {
  project: ProjectSummary;
  onSelect(id: string): void;
}

export function Overview({ project, onSelect }: Props) {
  const { nodes, system, sources, stats } = useSystem();
  const edges = useMemo(() => edgesWithParents(system), [system]);
  const cards = useMemo(() => capabilityCards(nodes, edges, system.nodes), [nodes, edges, system.nodes]);
  const cov = useMemo(() => {
    const local = coverage(nodes, edges);
    // the host computes it over every edge (routes are not drawn in the system view); local is the fallback
    const u = stats?.unmapped;
    return u ? { ...local, undescribedModules: u.modules, undescribedRoutes: u.routes } : local;
  }, [nodes, edges, stats]);
  const entry = useMemo(() => routesByModule(nodes, edges, system.nodes), [nodes, edges, system.nodes]);
  const integrations = nodes.filter((n) => n.kind === 'integration');
  const stack = project.stack;

  const byOrigin = stats?.nodesByOrigin ?? project.stats.nodesByOrigin;
  const agentKnowledge = (byOrigin.agent ?? 0) + (byOrigin.user ?? 0);
  const staleCount = stats?.stale ?? project.stats.stale;
  const bootstrap = project.needsBootstrap && !cards.length;

  return (
    <div className="sys-overview">
      {bootstrap ? (
        <div className="sys-callout unverified">
          <span>
            Only code-derived structure is known so far. Open the <strong>Agent</strong> panel and choose “Build understanding” — your own
            agent will record capabilities, flows and rules here, anchored to code.
          </span>
        </div>
      ) : null}

      <section className="sys-card wide">
        <h3>Stack</h3>
        {stack ? (
          <div className="sys-row">
            {stack.languages.map((l) => <Chip key={l.lang} title={`${l.loc} lines`}>{l.lang} · {n(l.files, 'file')}</Chip>)}
            {stack.frameworks.map((f) => <Chip key={f}>{f}</Chip>)}
            {stack.packageManagers.map((p) => <Chip key={p}>pkg: {p}</Chip>)}
          </div>
        ) : <span className="sys-hint">Stack not detected yet.</span>}
      </section>

      <section className="sys-card wide">
        <h3>Capabilities</h3>
        {cards.length ? (
          <div className="sys-cards">
            {cards.map((c) => (
              <button key={c.node.id} type="button" className="sys-cap" onClick={() => onSelect(c.node.id)}>
                <div className="sys-cap-title">{c.node.title}</div>
                <div className="sys-row"><StatusBadge status={c.node.status} /><OriginBadge origin={c.node.origin} /></div>
                <p>{c.node.summary}</p>
                <div className="sys-row">
                  <span className="sys-count">{n(c.routes, 'route')}</span>
                  <span className="sys-count">{n(c.entities, 'entity', 'entities')}</span>
                  <span className="sys-count">{n(c.tests, 'test suite')}</span>
                  {c.integrations ? <span className="sys-count">{n(c.integrations, 'integration')}</span> : null}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <Empty title="No capabilities recorded yet">
            Capabilities (“Checkout”, “Authentication”…) are the business view of the code. Your agent writes them — use “Build understanding” in the Agent panel.
          </Empty>
        )}
      </section>

      <section className="sys-card">
        <h3>Memory coverage</h3>
        <dl className="sys-dl">
          <dt>Derived from code</dt><dd>{byOrigin.deterministic ?? 0}</dd>
          <dt>Imported from AI config</dt><dd>{byOrigin.imported ?? 0}</dd>
          <dt>Recorded by agents / you</dt><dd>{agentKnowledge}</dd>
          <dt>Stale</dt><dd className={staleCount ? 'warn' : ''}>{staleCount}</dd>
        </dl>
        {cov.modules + cov.routes > 0 ? (
          <p className={cov.undescribedModules + cov.undescribedRoutes ? 'sys-hint warn' : 'sys-hint'}>
            {cov.undescribedModules} of {cov.modules} modules and {cov.undescribedRoutes} of {cov.routes} routes are not yet described by a capability.
          </p>
        ) : null}
      </section>

      <section className="sys-card">
        <h3>Entry points</h3>
        {entry.length ? (
          <ul className="sys-plain">
            {entry.map((e) => <li key={e.module}>{e.module} <span className="sys-count">{n(e.routes, 'route')}</span></li>)}
          </ul>
        ) : <span className="sys-hint">No routes detected.</span>}
      </section>

      <section className="sys-card">
        <h3>Integrations</h3>
        {integrations.length ? (
          <div className="sys-row">
            {integrations.map((n) => (
              <Chip key={n.id} onClick={() => onSelect(n.id)} title={n.summary}>{n.title}</Chip>
            ))}
          </div>
        ) : <span className="sys-hint">No external services detected.</span>}
      </section>

      <section className="sys-card">
        <h3>AI sources imported</h3>
        {sources.length ? (
          <ul className="sys-plain">
            {sources.map((s) => (
              <li key={s.path}>
                <span className="sys-badge">{s.tool}</span> {s.title} <span className="sys-hint">{s.path} · {n(s.sections.length, 'section')}</span>
              </li>
            ))}
          </ul>
        ) : <span className="sys-hint">No CLAUDE.md, AGENTS.md or rules found.</span>}
      </section>

      <section className="sys-card wide">
        <h3>Knowledge by kind</h3>
        <div className="sys-row">
          {(Object.entries(stats?.nodesByKind ?? project.stats.nodesByKind) as [NodeKind, number][]).map(([k, n]) => (
            <span key={k} className="sys-row"><KindBadge kind={k} /><span className="sys-count">{n}</span></span>
          ))}
        </div>
      </section>
    </div>
  );
}
