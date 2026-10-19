// Mock slice for window.atomic.agents — owned by the feature worker that consumes it.
// Plays a scripted shop-app turn through the same 'agent:event' channel the real main process uses.
import type {
  AcpSessionUpdate, AgentEvent, AgentInfo, AgentSessionInfo, AtomicApi, PromptTemplate,
} from '../../../shared/ipc';
import type { Emit } from './index';

const AGENTS: AgentInfo[] = [
  { id: 'claude', name: 'Claude Code', available: true, detail: 'claude-agent-acp (bundled)' },
  { id: 'codex', name: 'Codex', available: true, detail: 'codex-acp (bundled)' },
  { id: 'opencode', name: 'OpenCode', available: true, detail: 'opencode acp' },
  { id: 'gemini', name: 'Gemini CLI', available: false, detail: 'gemini not on PATH' },
];

const TEMPLATES: Record<PromptTemplate, string> = {
  bootstrap: 'Explore this project and record capabilities, flows, routes and entities into the Atomic memory.',
  'refresh-stale': 'Re-verify the knowledge items marked stale and update or retire them.',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MARKDOWN_REPLY = `Done — \`createOrder\` now rejects empty carts before touching the database.

**What changed**
- \`src/orders/service.ts\`: guard clause that throws \`EmptyCartError\`
- the route handler already maps that error to a **422**, so no change was needed there

| Case | Before | After |
| --- | --- | --- |
| empty cart | 500 | 422 |
| valid cart | 201 | 201 |

Run \`npm test\` to confirm; I did not run the suite.`;

const OLD_TEXT = `import { db } from '../db';

export async function createOrder(userId: string, items: CartItem[]) {
  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return db.orders.insert({ userId, items, total });
}
`;
const NEW_TEXT = `import { db } from '../db';
import { EmptyCartError } from './errors';

export async function createOrder(userId: string, items: CartItem[]) {
  if (items.length === 0) throw new EmptyCartError();
  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return db.orders.insert({ userId, items, total });
}
`;

export function createAgentsMock(emit: Emit): AtomicApi['agents'] {
  let counter = 0;
  const cancelled = new Set<string>();
  const permissions = new Map<string, (optionId: string | null) => void>();
  const sessionOf = new Map<string, string>(); // requestId -> sessionId

  const send = (e: AgentEvent) => emit('agent:event', e);
  const update = (sessionId: string, u: unknown) =>
    send({ type: 'update', sessionId, update: u as AcpSessionUpdate });
  const text = (kind: string, t: string) => ({ sessionUpdate: kind, content: { type: 'text', text: t } });

  /** streams text as several chunks, like a real agent */
  async function stream(sessionId: string, kind: string, full: string, step = 24) {
    for (let i = 0; i < full.length; i += step) {
      if (cancelled.has(sessionId)) return;
      update(sessionId, text(kind, full.slice(i, i + step)));
      await sleep(40);
    }
  }

  async function play(sessionId: string, prompt: string, attachContext: boolean) {
    const nap = (ms: number) => sleep(ms);
    send({ type: 'state', sessionId, state: 'prompting' });
    send({ type: 'user', sessionId, text: prompt, at: new Date().toISOString() });
    if (attachContext) {
      await nap(150);
      send({
        type: 'context', sessionId,
        pack: {
          estimatedTokens: 812,
          nodeIds: ['cap:orders', 'flow:checkout', 'rule:no-empty-orders'],
          sections: ['Orders capability', 'Checkout flow', 'Rules'],
          text: '# Orders\nOrders are created by `createOrder` in src/orders/service.ts.\n\n# Rules\n- Never create an order with an empty cart.\n- Totals are computed server-side.',
        },
      });
    }
    await nap(300);
    await stream(sessionId, 'agent_thought_chunk', 'The request touches order creation. I should read the service first, then guard the empty-cart case.');
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read src/orders/service.ts', priority: 'high', status: 'in_progress' },
        { content: 'Reject empty carts in createOrder', priority: 'high', status: 'pending' },
        { content: 'Summarise the change', priority: 'low', status: 'pending' },
      ],
    });
    await nap(400);
    update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'tc-read', title: 'Read src/orders/service.ts', kind: 'read',
      status: 'in_progress', locations: [{ path: 'src/orders/service.ts', line: 1 }],
    });
    await nap(500);
    update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 'tc-read', status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: OLD_TEXT } }],
    });
    if (cancelled.has(sessionId)) return 'cancelled';

    const requestId = `perm-${++counter}`;
    sessionOf.set(requestId, sessionId);
    const answer = new Promise<string | null>((resolve) => permissions.set(requestId, resolve));
    send({
      type: 'permission', sessionId, requestId,
      request: {
        sessionId,
        toolCall: { toolCallId: 'tc-edit', title: 'Edit src/orders/service.ts', kind: 'edit' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-all', name: 'Always allow edits', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      } as never,
    });
    const chosen = await answer;
    send({ type: 'permission-resolved', sessionId, requestId, optionId: chosen });
    if (chosen === null || chosen.startsWith('reject') || cancelled.has(sessionId)) {
      await stream(sessionId, 'agent_message_chunk', 'Understood — I left the files untouched.');
      return cancelled.has(sessionId) ? 'cancelled' : 'end_turn';
    }

    update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'tc-edit', title: 'Edit src/orders/service.ts', kind: 'edit',
      status: 'in_progress', locations: [{ path: 'src/orders/service.ts', line: 4 }],
    });
    await nap(600);
    update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 'tc-edit', status: 'completed',
      content: [{ type: 'diff', path: 'src/orders/service.ts', oldText: OLD_TEXT, newText: NEW_TEXT }],
    });
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read src/orders/service.ts', priority: 'high', status: 'completed' },
        { content: 'Reject empty carts in createOrder', priority: 'high', status: 'completed' },
        { content: 'Summarise the change', priority: 'low', status: 'in_progress' },
      ],
    });
    await nap(300);
    await stream(sessionId, 'agent_message_chunk', MARKDOWN_REPLY, 32);
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read src/orders/service.ts', priority: 'high', status: 'completed' },
        { content: 'Reject empty carts in createOrder', priority: 'high', status: 'completed' },
        { content: 'Summarise the change', priority: 'low', status: 'completed' },
      ],
    });
    update(sessionId, { sessionUpdate: 'usage_update', used: 18400, size: 200000, cost: { amount: 0.07, currency: 'USD' } });
    return 'end_turn';
  }

  return {
    async list() { return AGENTS.map((a) => ({ ...a })); },

    async start(agentId): Promise<AgentSessionInfo> {
      const agent = AGENTS.find((a) => a.id === agentId);
      if (!agent || !agent.available) throw new Error(agent?.detail ?? `unknown agent ${agentId}`);
      const sessionId = `mock-${agentId}-${++counter}`;
      setTimeout(() => {
        send({ type: 'state', sessionId, state: 'ready' });
        update(sessionId, {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'review', description: 'Review the working tree changes' },
            { name: 'compact', description: 'Summarise the conversation to free context' },
            { name: 'test', description: 'Run the project tests' },
          ],
        });
      }, 50);
      return {
        sessionId, agentId, agentName: agent.name,
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Ask before edits', description: 'Request permission for edits' },
            { id: 'plan', name: 'Plan', description: 'Read-only planning' },
          ],
        },
        supportsImages: false,
        supportsLoadSession: false,
      };
    },

    async prompt(sessionId, prompt, opts) {
      cancelled.delete(sessionId);
      const stopReason = await play(sessionId, prompt, opts?.attachContext !== false);
      cancelled.delete(sessionId);
      send({ type: 'state', sessionId, state: 'ready', stopReason });
      return { stopReason };
    },

    async template(kind) { return TEMPLATES[kind]; },

    async cancel(sessionId) {
      cancelled.add(sessionId);
      for (const [requestId, sid] of sessionOf) {
        if (sid === sessionId) permissions.get(requestId)?.(null);
      }
    },

    async setMode() { /* the panel reflects the chosen mode locally */ },

    async respondPermission(requestId, optionId) {
      const resolve = permissions.get(requestId);
      permissions.delete(requestId);
      resolve?.(optionId);
    },

    async close(sessionId) {
      cancelled.add(sessionId);
      send({ type: 'state', sessionId, state: 'closed' });
    },
  };
}
