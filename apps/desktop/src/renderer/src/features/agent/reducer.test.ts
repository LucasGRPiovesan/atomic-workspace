import { describe, expect, it } from 'vitest';
import type { AcpSessionUpdate, AgentEvent } from '../../../../shared/ipc';
import { contextTotals, pendingPermissions, reduce, type AgentsState } from './reducer';
import { diffStats, lineDiff } from './diff';

const S = 's1';
const upd = (update: unknown): AgentEvent => ({ type: 'update', sessionId: S, update: update as AcpSessionUpdate });
const fold = (events: AgentEvent[]): AgentsState => events.reduce(reduce, {} as AgentsState);
const chunk = (kind: string, text: string) => upd({ sessionUpdate: kind, content: { type: 'text', text } });

describe('agent reducer', () => {
  it('merges consecutive message and thought chunks', () => {
    const v = fold([
      chunk('agent_thought_chunk', 'hmm '), chunk('agent_thought_chunk', 'ok'),
      chunk('agent_message_chunk', 'Hel'), chunk('agent_message_chunk', 'lo'),
    ])[S]!;
    expect(v.items.map((i) => [i.kind, 'text' in i ? i.text : ''])).toEqual([['thought', 'hmm ok'], ['agent', 'Hello']]);
  });

  it('keeps separate user prompts apart but merges replayed user chunks', () => {
    const v = fold([
      { type: 'user', sessionId: S, text: 'a', at: '' }, { type: 'user', sessionId: S, text: 'b', at: '' },
      chunk('user_message_chunk', '1'), chunk('user_message_chunk', '2'),
    ])[S]!;
    expect(v.items.map((i) => 'text' in i && i.text)).toEqual(['a', 'b12']);
  });

  it('updates a tool call in place and keeps unchanged fields', () => {
    const v = fold([
      upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read service', kind: 'read', status: 'pending',
        locations: [{ path: 'src/a.ts', line: 3 }] }),
      chunk('agent_message_chunk', 'between'),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }] }),
    ])[S]!;
    const tools = v.items.filter((i) => i.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      title: 'Read service', toolKind: 'read', status: 'completed',
      locations: [{ path: 'src/a.ts', line: 3 }], content: [{ type: 'text', text: 'done' }],
    });
    expect(v.items).toHaveLength(2);
  });

  it('captures diff and terminal content', () => {
    const v = fold([
      upd({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Edit', kind: 'edit' }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'in_progress', content: [
        { type: 'diff', path: 'src/a.ts', oldText: 'x\n', newText: 'y\n' },
        { type: 'terminal', terminalId: 'term1' },
      ] }),
    ])[S]!;
    expect(v.items[0]).toMatchObject({ content: [
      { type: 'diff', path: 'src/a.ts', oldText: 'x\n', newText: 'y\n' },
      { type: 'terminal', terminalId: 'term1' },
    ] });
  });

  it('creates a tool item from an update for an unknown id', () => {
    const v = fold([upd({ sessionUpdate: 'tool_call_update', toolCallId: 'zz', status: 'failed' })])[S]!;
    expect(v.items[0]).toMatchObject({ kind: 'tool', toolCallId: 'zz', status: 'failed' });
  });

  it('tracks the permission lifecycle', () => {
    const request = {
      sessionId: S, toolCall: { toolCallId: 't1', title: 'Run tests' },
      options: [{ optionId: 'o1', name: 'Allow', kind: 'allow_once' }, { optionId: 'o2', name: 'No', kind: 'reject_once' }],
    } as unknown as Extract<AgentEvent, { type: 'permission' }>['request'];
    const ask: AgentEvent = { type: 'permission', sessionId: S, requestId: 'r1', request };
    let st = fold([ask, ask]);
    expect(pendingPermissions(st[S]!)).toHaveLength(1);
    expect(pendingPermissions(st[S]!)[0]).toMatchObject({ title: 'Run tests', toolCallId: 't1' });
    st = reduce(st, { type: 'permission-resolved', sessionId: S, requestId: 'r1', optionId: 'o1' });
    expect(pendingPermissions(st[S]!)).toHaveLength(0);
    expect(st[S]!.items[0]).toMatchObject({ resolution: 'o1' });
  });

  it('records plan, commands, mode, usage, state and stderr', () => {
    const v = fold([
      upd({ sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'high', status: 'pending' }] }),
      upd({ sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'high', status: 'completed' }] }),
      upd({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review' }] }),
      upd({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }),
      upd({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.5, currency: 'USD' } }),
      { type: 'state', sessionId: S, state: 'prompting' },
      { type: 'state', sessionId: S, state: 'ready', stopReason: 'end_turn' },
      { type: 'stderr', sessionId: S, line: 'warn' },
    ])[S]!;
    expect(v.plan).toEqual([{ content: 'a', status: 'completed' }]);
    expect(v.commands).toEqual([{ name: 'review', description: 'Review' }]);
    expect(v.modeId).toBe('plan');
    expect(v.usage).toEqual({ used: 10, size: 100, cost: { amount: 0.5, currency: 'USD' } });
    expect(v.state).toBe('ready');
    expect(v.stopReason).toBe('end_turn');
    expect(v.stderr).toEqual(['warn']);
  });

  it('tracks attached context', () => {
    const v = fold([
      { type: 'context', sessionId: S, pack: { estimatedTokens: 100, nodeIds: ['a', 'b'], sections: ['Orders'], text: 'ctx' } },
      { type: 'context', sessionId: S, pack: { estimatedTokens: 50, nodeIds: ['b', 'c'], sections: [], text: 'ctx2' } },
    ])[S]!;
    expect(contextTotals(v)).toEqual({ tokens: 150, items: 3 });
  });

  it('tolerates unknown update variants and malformed payloads', () => {
    const v = fold([
      upd({ sessionUpdate: 'quantum_update', message: 'hi' }),
      upd({ sessionUpdate: 'tool_call' }),
      upd({ sessionUpdate: 'plan' }),
      upd({}),
    ])[S]!;
    expect(v.items[0]).toMatchObject({ kind: 'generic', label: 'quantum_update: hi' });
    expect(v.items).toHaveLength(3);
  });
});

describe('lineDiff', () => {
  it('marks added and removed lines with context', () => {
    const d = lineDiff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nD\ne\nf\ng', 1);
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
    expect(d.filter((l) => l.op !== ' ' && l.op !== '…').map((l) => l.op + l.text)).toEqual(['-d', '+D']);
  });

  it('treats a missing old text as a new file', () => {
    expect(diffStats(lineDiff(null, 'x\ny'))).toEqual({ added: 2, removed: 0 });
  });
});
