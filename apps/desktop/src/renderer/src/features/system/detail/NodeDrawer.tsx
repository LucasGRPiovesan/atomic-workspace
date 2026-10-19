import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { KnowledgeNode, TestRecord } from '@atomic/core/types';
import type { NodeDetail } from '../../../../../shared/ipc';
import { useSystem } from '../data-context';
import { groupBy } from '../graph-utils';
import { Chip, Confidence, FileChip, KindBadge, OriginBadge, StatusBadge, relTime } from '../ui';

interface Props {
  nodeId: string;
  onClose(): void;
  /** focus another node (updates the drawer, and centers it in the map when visible) */
  onFocus(id: string): void;
  onOpenFile(path: string, line?: number): void;
}

type Related = { id: string; kind: KnowledgeNode['kind']; title: string; status: KnowledgeNode['status'] };

export function NodeDrawer({ nodeId, onClose, onFocus, onOpenFile }: Props) {
  const { nodes, reload } = useSystem();
  const [detail, setDetail] = useState<NodeDetail | null | undefined>(undefined);
  const [impact, setImpact] = useState<{ nodes: KnowledgeNode[]; tests: TestRecord[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setImpact(null); }, [nodeId]);
  useEffect(() => {
    let live = true;
    void window.atomic.memory.getNode(nodeId).then((d) => { if (live) setDetail(d); });
    return () => { live = false; };
  }, [nodeId, nodes]);

  if (detail === undefined) return <aside className="sys-drawer"><div className="sys-hint pad">Loading…</div></aside>;
  if (detail === null) {
    return (
      <aside className="sys-drawer">
        <Header onClose={onClose} />
        <div className="sys-hint pad">This node is no longer in memory.</div>
      </aside>
    );
  }

  const { node } = detail;
  const out = groupBy(detail.outgoing.map((e) => ({ rel: e.rel, other: e.target, id: e.to })), (e) => e.rel);
  const inc = groupBy(detail.incoming.map((e) => ({ rel: e.rel, other: e.source, id: e.from })), (e) => e.rel);

  const verify = async () => {
    setBusy(true);
    try { await window.atomic.memory.markVerified(node.id); reload(); } finally { setBusy(false); }
  };
  const runImpact = async () => {
    const paths = [...new Set(node.anchors.map((a) => a.path))];
    setImpact(await window.atomic.memory.impact(paths));
  };

  const relGroup = (title: string, groups: Map<string, { other?: Related; id: string }[]>) =>
    groups.size ? (
      <section>
        <h4>{title}</h4>
        {[...groups].map(([rel, items]) => (
          <div key={rel} className="sys-row">
            <span className="sys-label">{rel}</span>
            {items.map((it, i) => (
              <Chip key={`${it.id}${i}`} onClick={() => onFocus(it.id)} title={it.id}>
                {it.other ? `${it.other.title}` : it.id}
                {it.other?.status === 'stale' ? ' ⚠' : ''}
              </Chip>
            ))}
          </div>
        ))}
      </section>
    ) : null;

  return (
    <aside className="sys-drawer" aria-label="Node detail">
      <Header onClose={onClose} />
      <div className="sys-drawer-body">
        <h3>{node.title}</h3>
        <div className="sys-row">
          <KindBadge kind={node.kind} /><OriginBadge origin={node.origin} /><StatusBadge status={node.status} /><Confidence value={node.confidence} />
          {node.author ? <Chip title="Recorded by">by {node.author}</Chip> : null}
        </div>
        <p className="sys-summary">{node.summary}</p>
        <div className="sys-hint">Updated {relTime(node.updatedAt)} · <code>{node.id}</code></div>

        {node.status !== 'fresh' ? (
          <div className={`sys-callout ${node.status}`}>
            <span>{node.status === 'stale' ? 'An anchored file changed since this was recorded.' : 'Recorded without code anchors — not verifiable yet.'}</span>
            {node.status === 'stale' ? <button type="button" className="sys-btn" disabled={busy} onClick={() => void verify()}>Verify</button> : null}
          </div>
        ) : null}

        {node.body ? (
          <section className="sys-md">
            <Markdown remarkPlugins={[remarkGfm]}>{node.body}</Markdown>
          </section>
        ) : null}

        {node.anchors.length ? (
          <section>
            <h4>Code</h4>
            <div className="sys-col">
              {node.anchors.map((a, i) => (
                <FileChip key={i} path={a.path} line={a.startLine} onOpen={onOpenFile} />
              ))}
            </div>
          </section>
        ) : null}

        {relGroup('Depends on / outgoing', out)}
        {relGroup('Used by / incoming', inc)}

        {detail.symbols.length ? (
          <section>
            <h4>Symbols</h4>
            <ul className="sys-plain">
              {detail.symbols.slice(0, 12).map((s) => (
                <li key={s.id}>
                  <button type="button" className="sys-link mono" onClick={() => onOpenFile(s.path, s.startLine)}>{s.signature ?? s.name}</button>
                  <span className="sys-hint"> {s.path}:{s.startLine}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {detail.tests.length ? (
          <section>
            <h4>Tests ({detail.tests.length})</h4>
            <ul className="sys-plain">
              {detail.tests.map((t) => (
                <li key={`${t.path}:${t.line}`}>
                  <button type="button" className="sys-link" onClick={() => onOpenFile(t.path, t.line)}>{t.name}</button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {detail.changes.length ? (
          <section>
            <h4>Recent changes</h4>
            <ul className="sys-plain">
              {detail.changes.map((c) => (
                <li key={c.id}>
                  <span className="sys-hint">{relTime(c.at)} · {c.source}</span> {c.summary ?? `${c.files.length} files`}
                  {c.staleNodes.includes(node.id) ? <span className="sys-status-stale sys-badge"> made stale</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {node.anchors.length ? (
          <section>
            <h4>Impact</h4>
            {impact ? (
              <>
                <div className="sys-row">
                  {impact.nodes.filter((n) => n.id !== node.id).map((n) => (
                    <Chip key={n.id} onClick={() => onFocus(n.id)} title={n.id}>{n.kind}: {n.title}</Chip>
                  ))}
                  {!impact.nodes.some((n) => n.id !== node.id) ? <span className="sys-hint">No other knowledge depends on these files.</span> : null}
                </div>
                {impact.tests.length ? <div className="sys-hint">Tests to run: {impact.tests.map((t) => t.name).join(' · ')}</div> : null}
              </>
            ) : (
              <button type="button" className="sys-btn" onClick={() => void runImpact()}>What does changing this affect?</button>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function Header({ onClose }: { onClose(): void }) {
  return (
    <div className="sys-drawer-head">
      <span>Node detail</span>
      <button type="button" className="sys-icon" onClick={onClose} aria-label="Close detail">✕</button>
    </div>
  );
}
