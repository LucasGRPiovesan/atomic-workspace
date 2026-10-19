import type { TraceEvent } from '../../../../shared/ipc';

export const MAX_TRACE = 500;

/** Insert or replace by id (main re-sends a request when it is correlated to a click after the fact). */
export function upsertTrace(list: TraceEvent[], ev: TraceEvent): TraceEvent[] {
  const i = list.findIndex((e) => e.id === ev.id);
  const next = i >= 0 ? list.map((e, j) => (j === i ? ev : e)) : [...list, ev];
  return next.length > MAX_TRACE ? next.slice(next.length - MAX_TRACE) : next;
}

export interface TraceGroup {
  key: string;
  /** the click / navigation that caused the requests; absent for background requests */
  interaction?: TraceEvent;
  requests: TraceEvent[];
}

/** Group requests under the interaction that caused them; uncorrelated ones go to one trailing "background" group. */
export function groupTrace(events: TraceEvent[]): TraceGroup[] {
  const groups = new Map<string, TraceGroup>();
  const background: TraceEvent[] = [];
  for (const ev of events) {
    if (ev.kind === 'click' || ev.kind === 'navigation') {
      const g = groups.get(ev.id) ?? { key: ev.id, requests: [] };
      g.interaction = ev;
      groups.set(ev.id, g);
    } else if (ev.kind === 'request' && ev.interactionId) {
      const g = groups.get(ev.interactionId) ?? { key: ev.interactionId, requests: [] };
      g.requests.push(ev);
      groups.set(ev.interactionId, g);
    } else if (ev.kind === 'request') {
      background.push(ev);
    }
  }
  const out = [...groups.values()];
  if (background.length) out.push({ key: 'background', requests: background });
  return out;
}
