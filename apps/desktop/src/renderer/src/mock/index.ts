// Browser-only stand-in for window.atomic (Electron preload absent), so the renderer can be developed and
// verified with `npm run preview:web -w @atomic/desktop`. Each slice is owned by the feature worker that
// consumes it; this file only composes them.
import type { AtomicApi, EventPayloads } from '../../../shared/ipc';
import { createProjectMock } from './project';
import { createMemoryMock } from './memory';
import { createAgentsMock } from './agents';
import { createAppMock } from './app';

export type Emit = <K extends keyof EventPayloads>(channel: K, payload: EventPayloads[K]) => void;

export function installMock(): void {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit: Emit = (channel, payload) => listeners.get(channel)?.forEach((cb) => cb(payload));
  const api: AtomicApi = {
    project: createProjectMock(emit),
    memory: createMemoryMock(emit),
    agents: createAgentsMock(emit),
    app: createAppMock(emit),
    on(channel, cb) {
      const set = listeners.get(channel) ?? new Set();
      set.add(cb as (p: unknown) => void);
      listeners.set(channel, set);
      return () => set.delete(cb as (p: unknown) => void);
    },
  };
  (window as { atomic?: AtomicApi }).atomic = api;
}
