// Pure fold of AgentEvents (ACP stream) into a per-session timeline. No React, no window access.
import type {
  AcpSessionUpdate, AgentEvent, AgentSessionState,
} from '../../../../shared/ipc';

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type ToolKindName =
  'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

export interface ToolLocation { path: string; line?: number }

export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export type TimelineItem =
  | { kind: 'user' | 'agent' | 'thought'; id: string; text: string }
  | {
    kind: 'tool'; id: string; toolCallId: string; title: string; toolKind: ToolKindName;
    status: ToolStatus; locations: ToolLocation[]; content: ToolContent[];
  }
  | {
    kind: 'context'; id: string; estimatedTokens: number; nodeIds: string[];
    sections: string[]; text: string;
  }
  | {
    kind: 'permission'; id: string; requestId: string; toolCallId: string | null; title: string;
    options: PermissionOptionView[];
    /** undefined = still pending; null = cancelled/no option chosen */
    resolution?: string | null;
  }
  | { kind: 'generic'; id: string; label: string };

export interface PlanEntryView { content: string; status: 'pending' | 'in_progress' | 'completed' }
export interface CommandView { name: string; description: string }
export interface UsageView { used: number; size: number; cost?: { amount: number; currency: string } }

export interface SessionView {
  items: TimelineItem[];
  plan: PlanEntryView[] | null;
  commands: CommandView[];
  modeId: string | null;
  title: string | null;
  usage: UsageView | null;
  state: AgentSessionState;
  stopReason: string | null;
  error: string | null;
  /** last few stderr lines of the agent process */
  stderr: string[];
  seq: number;
}

export type AgentsState = Record<string, SessionView>;

export const STDERR_TAIL = 20;

export function emptySession(): SessionView {
  return {
    items: [], plan: null, commands: [], modeId: null, title: null, usage: null,
    state: 'starting', stopReason: null, error: null, stderr: [], seq: 0,
  };
}

type Loose = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Text shown for any ACP ContentBlock. */
export function blockText(block: unknown): string {
  const b = (block ?? {}) as Loose;
  switch (b.type) {
    case 'text': return str(b.text) ?? '';
    case 'image': return '[image]';
    case 'audio': return '[audio]';
    case 'resource_link': return `[${str(b.name) ?? str(b.uri) ?? 'resource'}](${str(b.uri) ?? ''})`;
    case 'resource': {
      const r = (b.resource ?? {}) as Loose;
      return str(r.text) ?? `[resource ${str(r.uri) ?? ''}]`;
    }
    default: return '';
  }
}

function pushItem(s: SessionView, item: TimelineItem): SessionView {
  return { ...s, items: [...s.items, item], seq: s.seq + 1 };
}

function appendChunk(s: SessionView, kind: 'user' | 'agent' | 'thought', text: string): SessionView {
  const last = s.items[s.items.length - 1];
  if (last && last.kind === kind) {
    const items = s.items.slice(0, -1);
    items.push({ ...last, text: last.text + text });
    return { ...s, items };
  }
  return pushItem(s, { kind, id: `i${s.seq}`, text });
}

function toolContent(raw: unknown): ToolContent[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolContent[] = [];
  for (const c of raw as Loose[]) {
    if (c.type === 'diff' && typeof c.path === 'string') {
      out.push({
        type: 'diff', path: c.path,
        oldText: typeof c.oldText === 'string' ? c.oldText : null,
        newText: str(c.newText) ?? '',
      });
    } else if (c.type === 'terminal' && typeof c.terminalId === 'string') {
      out.push({ type: 'terminal', terminalId: c.terminalId });
    } else if (c.type === 'content') {
      const text = blockText(c.content);
      if (text) out.push({ type: 'text', text });
    }
  }
  return out;
}

function toolLocations(raw: unknown): ToolLocation[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Loose[])
    .filter((l) => typeof l.path === 'string')
    .map((l) => ({ path: l.path as string, ...(typeof l.line === 'number' ? { line: l.line } : {}) }));
}

function upsertTool(s: SessionView, u: Loose): SessionView {
  const toolCallId = str(u.toolCallId);
  if (!toolCallId) return pushItem(s, { kind: 'generic', id: `i${s.seq}`, label: 'tool call (no id)' });
  const idx = s.items.findIndex((i) => i.kind === 'tool' && i.toolCallId === toolCallId);
  const prev = idx >= 0 ? s.items[idx] : undefined;
  if (prev && prev.kind === 'tool') {
    const next = {
      ...prev,
      title: str(u.title) ?? prev.title,
      toolKind: (str(u.kind) as ToolKindName | undefined) ?? prev.toolKind,
      status: (str(u.status) as ToolStatus | undefined) ?? prev.status,
      locations: Array.isArray(u.locations) ? toolLocations(u.locations) : prev.locations,
      content: Array.isArray(u.content) ? toolContent(u.content) : prev.content,
    };
    const items = s.items.slice();
    items[idx] = next;
    return { ...s, items };
  }
  return pushItem(s, {
    kind: 'tool', id: `i${s.seq}`, toolCallId,
    title: str(u.title) ?? str(u.name) ?? 'Tool call',
    toolKind: (str(u.kind) as ToolKindName | undefined) ?? 'other',
    status: (str(u.status) as ToolStatus | undefined) ?? 'pending',
    locations: toolLocations(u.locations),
    content: toolContent(u.content),
  });
}

function applyUpdate(s: SessionView, update: AcpSessionUpdate): SessionView {
  const u = update as unknown as Loose;
  switch (u.sessionUpdate) {
    case 'user_message_chunk': return appendChunk(s, 'user', blockText(u.content));
    case 'agent_message_chunk': return appendChunk(s, 'agent', blockText(u.content));
    case 'agent_thought_chunk': return appendChunk(s, 'thought', blockText(u.content));
    case 'tool_call':
    case 'tool_call_update': return upsertTool(s, u);
    case 'plan': {
      const entries = Array.isArray(u.entries) ? (u.entries as Loose[]) : [];
      return {
        ...s,
        plan: entries.map((e) => ({
          content: str(e.content) ?? '',
          status: (str(e.status) as PlanEntryView['status'] | undefined) ?? 'pending',
        })),
      };
    }
    case 'available_commands_update': {
      const cmds = Array.isArray(u.availableCommands) ? (u.availableCommands as Loose[]) : [];
      return {
        ...s,
        commands: cmds
          .filter((c) => typeof c.name === 'string')
          .map((c) => ({ name: c.name as string, description: str(c.description) ?? '' })),
      };
    }
    case 'current_mode_update': return { ...s, modeId: str(u.currentModeId) ?? s.modeId };
    case 'session_info_update': return { ...s, title: str(u.title) ?? s.title };
    case 'usage_update': {
      const cost = u.cost as Loose | null | undefined;
      return {
        ...s,
        usage: {
          used: typeof u.used === 'number' ? u.used : 0,
          size: typeof u.size === 'number' ? u.size : 0,
          ...(cost && typeof cost.amount === 'number'
            ? { cost: { amount: cost.amount, currency: str(cost.currency) ?? 'USD' } }
            : {}),
        },
      };
    }
    default: {
      // config_option_update, notice, compaction_*, subagent_*, plan_update... or variants newer than this UI
      const name = str(u.sessionUpdate) ?? 'unknown update';
      const detail = str(u.message) ?? str(u.title) ?? str(u.text) ?? str(u.summary);
      return pushItem(s, { kind: 'generic', id: `i${s.seq}`, label: detail ? `${name}: ${detail}` : name });
    }
  }
}

export function reduceSession(s: SessionView, e: AgentEvent): SessionView {
  switch (e.type) {
    case 'update': return applyUpdate(s, e.update);
    case 'user': return pushItem(s, { kind: 'user', id: `i${s.seq}`, text: e.text });
    case 'context':
      return pushItem(s, {
        kind: 'context', id: `i${s.seq}`,
        estimatedTokens: e.pack.estimatedTokens,
        nodeIds: [...e.pack.nodeIds],
        sections: [...e.pack.sections],
        text: e.pack.text,
      });
    case 'permission': {
      if (s.items.some((i) => i.kind === 'permission' && i.requestId === e.requestId)) return s;
      const tc = e.request.toolCall as unknown as Loose;
      return pushItem(s, {
        kind: 'permission', id: `i${s.seq}`, requestId: e.requestId,
        toolCallId: str(tc?.toolCallId) ?? null,
        title: str(tc?.title) ?? 'Permission requested',
        options: e.request.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      });
    }
    case 'permission-resolved': {
      const items = s.items.map((i) =>
        i.kind === 'permission' && i.requestId === e.requestId ? { ...i, resolution: e.optionId } : i);
      return { ...s, items };
    }
    case 'state':
      return {
        ...s,
        state: e.state,
        error: e.error ?? (e.state === 'error' ? s.error : null),
        stopReason: e.stopReason ?? (e.state === 'prompting' ? null : s.stopReason),
      };
    case 'stderr':
      return { ...s, stderr: [...s.stderr, e.line].slice(-STDERR_TAIL) };
    default: return s;
  }
}

export function reduce(state: AgentsState, e: AgentEvent): AgentsState {
  const sessionId = (e as { sessionId?: string }).sessionId;
  if (!sessionId) return state;
  return { ...state, [sessionId]: reduceSession(state[sessionId] ?? emptySession(), e) };
}

export function pendingPermissions(s: SessionView) {
  return s.items.filter((i): i is Extract<TimelineItem, { kind: 'permission' }> =>
    i.kind === 'permission' && i.resolution === undefined);
}

/** Total attached context across the session (for the header chip). */
export function contextTotals(s: SessionView): { tokens: number; items: number } {
  let tokens = 0;
  const ids = new Set<string>();
  for (const i of s.items) {
    if (i.kind !== 'context') continue;
    tokens += i.estimatedTokens;
    i.nodeIds.forEach((n) => ids.add(n));
  }
  return { tokens, items: ids.size };
}
