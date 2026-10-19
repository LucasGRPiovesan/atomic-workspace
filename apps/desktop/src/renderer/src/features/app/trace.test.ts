import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../../../../shared/ipc';
import { groupTrace, upsertTrace } from './trace';

const ev = (id: string, kind: TraceEvent['kind'], over: Partial<TraceEvent> = {}): TraceEvent => ({ id, at: '2026-01-01T00:00:00Z', kind, ...over });

describe('trace grouping', () => {
  it('groups requests under their interaction and keeps the rest as background', () => {
    const groups = groupTrace([
      ev('a', 'request', { method: 'GET', pathname: '/api/cart' }),
      ev('c1', 'click', { text: 'Checkout', interactionId: 'c1' }),
      ev('r1', 'request', { interactionId: 'c1' }),
      ev('r2', 'request', { interactionId: 'c1' }),
    ]);
    expect(groups.map((g) => [g.key, g.requests.length])).toEqual([['c1', 2], ['background', 1]]);
    expect(groups[0].interaction?.text).toBe('Checkout');
  });

  it('upsert replaces a re-sent event instead of duplicating it', () => {
    const first = [ev('r1', 'request')];
    const next = upsertTrace(first, ev('r1', 'request', { interactionId: 'c1' }));
    expect(next).toHaveLength(1);
    expect(next[0].interactionId).toBe('c1');
  });
});
