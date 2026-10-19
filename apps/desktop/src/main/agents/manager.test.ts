import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ContextPack } from '@atomic/core/types';
import type { AgentEvent } from '../../shared/ipc';
import { AgentManager, type AgentManagerDeps } from './manager';
import { template } from './templates';

const FAKE = fileURLToPath(new URL('./__fixtures__/fake-agent.mjs', import.meta.url));

const PACK: ContextPack = {
  task: 'add checkout',
  budgetTokens: 800,
  estimatedTokens: 12,
  nodeIds: ['capability:checkout'],
  files: [],
  sections: ['Overview'],
  text: '# Checkout\nuse PaymentService',
};

async function waitFor<T>(fn: () => T | undefined | false, ms = 10000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('AgentManager with a fake ACP agent', () => {
  let tmp: string;
  let home: string;
  let project: string;
  let events: AgentEvent[];
  let written: { paths: string[]; sessionId: string; agentId: string }[];
  let located: { paths: string[]; sessionId: string }[];
  let deps: AgentManagerDeps;
  let manager: AgentManager;
  let composeContext: Mock<AgentManagerDeps['composeContext']>;

  const type = (t: AgentEvent['type']) => events.filter((e) => e.type === t);
  const received = (): unknown[] =>
    type('update').flatMap((e) => {
      const u = (e as Extract<AgentEvent, { type: 'update' }>).update;
      return u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? [u.content.text] : [];
    });

  async function setup(extraAgents: object[] = []) {
    await mkdir(path.join(home, '.atomic'), { recursive: true });
    const agents = [
      { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE], env: { FAKE_AGENT_PIDFILE: path.join(tmp, 'fake.pid'), FAKE_AGENT_LOG: path.join(tmp, 'fake.log') } },
      { id: 'fake2', name: 'Fake Two', command: process.execPath, args: [FAKE], env: { FAKE_AGENT_PIDFILE: path.join(tmp, 'fake2.pid') } },
      ...extraAgents,
    ];
    await writeFile(path.join(home, '.atomic', 'agents.json'), JSON.stringify(agents));
  }

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'atomic-agents-'));
    home = path.join(tmp, 'home');
    project = path.join(tmp, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, 'lines.txt'), 'a\nb\nc\nd\n');
    events = [];
    written = [];
    located = [];
    composeContext = vi.fn<AgentManagerDeps['composeContext']>(async () => PACK);
    deps = {
      emit: (ev) => events.push(ev),
      mcpServers: () => [{ name: 'atomic', command: 'node', args: ['mcp.js'], env: [] }],
      composeContext,
      onFilesWritten: (paths, sessionId, agentId) => written.push({ paths, sessionId, agentId }),
      onToolLocations: (paths, sessionId) => located.push({ paths, sessionId }),
    };
    await setup();
    manager = new AgentManager(deps, { registry: { homeDir: home } });
  });

  afterEach(async () => {
    await manager.dispose();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('lists built-ins and custom agents with an explanation', async () => {
    const list = await manager.list();
    expect(list.map((a) => a.id)).toEqual(['claude', 'codex', 'opencode', 'gemini', 'fake', 'fake2']);
    expect(list.find((a) => a.id === 'claude')).toMatchObject({ available: true });
    expect(list.find((a) => a.id === 'fake')).toMatchObject({ available: true, name: 'Fake' });
    for (const a of list) expect(a.detail).not.toBe('');
  });

  it('start: initialize + session/new with cwd and MCP servers, returns AgentSessionInfo', async () => {
    const info = await manager.start('fake', project);
    expect(info).toMatchObject({
      agentId: 'fake',
      agentName: 'Fake',
      supportsImages: true,
      supportsLoadSession: true,
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan', description: 'Read only' }] },
    });
    expect(info.sessionId).toMatch(/^fake-/);
    const log = JSON.parse((await readFile(path.join(tmp, 'fake.log'), 'utf8')).trim());
    expect(log.newSession.cwd).toBe(project);
    expect(log.newSession.mcpServers).toEqual([{ name: 'atomic', command: 'node', args: ['mcp.js'], env: [] }]);
    const states = events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
    expect(states).toEqual(['starting', 'ready']);
    // stderr emitted during boot is held until the session id is known, then delivered
    expect(type('stderr').map((e) => (e as { line: string }).line)).toContain('fake-agent booted');
  });

  it('prompt: events in order, permission round trip, file write, context block', async () => {
    const { sessionId } = await manager.start('fake', project);
    events.length = 0;

    const done = manager.prompt(sessionId, 'please write the file');
    const perm = (await waitFor(() => type('permission')[0])) as Extract<AgentEvent, { type: 'permission' }>;
    expect(perm.sessionId).toBe(sessionId);
    expect(perm.request.options.map((o) => o.optionId)).toEqual(['allow', 'reject']);
    expect(perm.requestId).toBeTruthy();
    manager.respondPermission(perm.requestId, 'allow');
    await expect(done).resolves.toEqual({ stopReason: 'end_turn' });

    const seq = events.map((e) => {
      if (e.type === 'update') return `update:${e.update.sessionUpdate}`;
      if (e.type === 'state') return `state:${e.state}`;
      return e.type;
    });
    expect(seq).toEqual([
      'user',
      'context',
      'state:prompting',
      'update:agent_message_chunk', // echo of what the agent received
      'update:tool_call',
      'permission',
      'permission-resolved',
      'update:tool_call_update',
      'update:agent_message_chunk', // "done"
      'state:ready',
    ]);
    expect(events.find((e) => e.type === 'user')).toMatchObject({ text: 'please write the file', sessionId });
    expect(events.find((e) => e.type === 'permission-resolved')).toMatchObject({ requestId: perm.requestId, optionId: 'allow' });
    expect(events.at(-1)).toMatchObject({ type: 'state', state: 'ready', stopReason: 'end_turn' });

    // context pack: separate leading block, delimited, plus a transparency event
    const blocks = JSON.parse((received()[0] as string).slice('received:'.length));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: `<workspace-context>\n${PACK.text}\n</workspace-context>` });
    expect(blocks[1]).toEqual({ type: 'text', text: 'please write the file' });
    expect(composeContext).toHaveBeenCalledWith(sessionId, 'please write the file', {});
    expect(events.find((e) => e.type === 'context')).toMatchObject({
      pack: { estimatedTokens: 12, nodeIds: ['capability:checkout'], sections: ['Overview'], text: PACK.text },
    });

    // fs/write_text_file landed on disk and was reported; tool locations were reported (project-relative)
    expect(await readFile(path.join(project, 'out', 'hello.txt'), 'utf8')).toBe('hello from fake agent\n');
    expect(written).toEqual([{ paths: ['out/hello.txt'], sessionId, agentId: 'fake' }]);
    expect(located.length).toBeGreaterThanOrEqual(2); // tool_call + tool_call_update(diff)
    expect(located.every((l) => l.sessionId === sessionId && l.paths.join() === 'out/hello.txt')).toBe(true);
  });

  it('prompt with attachContext=false sends only the user text and no context event', async () => {
    const { sessionId } = await manager.start('fake', project);
    const done = manager.prompt(sessionId, 'plain', { attachContext: false });
    const perm = (await waitFor(() => type('permission')[0])) as Extract<AgentEvent, { type: 'permission' }>;
    manager.respondPermission(perm.requestId, 'reject');
    await done;
    expect(composeContext).not.toHaveBeenCalled();
    expect(type('context')).toHaveLength(0);
    expect(JSON.parse((received()[0] as string).slice('received:'.length))).toEqual([{ type: 'text', text: 'plain' }]);
  });

  it('a failing composeContext does not block the prompt', async () => {
    composeContext.mockRejectedValueOnce(new Error('db locked'));
    const { sessionId } = await manager.start('fake', project);
    const done = manager.prompt(sessionId, 'plain');
    const perm = (await waitFor(() => type('permission')[0])) as Extract<AgentEvent, { type: 'permission' }>;
    manager.respondPermission(perm.requestId, 'reject');
    await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
    expect(type('context')).toHaveLength(0);
  });

  it('respondPermission(null) answers "cancelled" and no file is written', async () => {
    const { sessionId } = await manager.start('fake', project);
    const done = manager.prompt(sessionId, 'x', { attachContext: false });
    const perm = (await waitFor(() => type('permission')[0])) as Extract<AgentEvent, { type: 'permission' }>;
    manager.respondPermission(perm.requestId, null);
    await done;
    expect(received()).toContain('permission:cancelled');
    expect(events.find((e) => e.type === 'permission-resolved')).toMatchObject({ optionId: null });
    await expect(stat(path.join(project, 'out', 'hello.txt'))).rejects.toThrow();
    expect(written).toHaveLength(0);
    // unknown request ids and unknown option ids
    manager.respondPermission(perm.requestId, null);
  });

  it('rejects an option that was not offered and keeps the request pending', async () => {
    const { sessionId } = await manager.start('fake', project);
    const done = manager.prompt(sessionId, 'x', { attachContext: false });
    const perm = (await waitFor(() => type('permission')[0])) as Extract<AgentEvent, { type: 'permission' }>;
    expect(() => manager.respondPermission(perm.requestId, 'bogus')).toThrow(/Unknown permission option/);
    manager.respondPermission(perm.requestId, 'reject');
    await done;
  });

  it('cancel: ends a running turn with stopReason=cancelled', async () => {
    const { sessionId } = await manager.start('fake', project);
    const done = manager.prompt(sessionId, 'hang', { attachContext: false });
    await waitFor(() => received().length > 0);
    await manager.cancel(sessionId);
    await expect(done).resolves.toEqual({ stopReason: 'cancelled' });
    expect(events.at(-1)).toMatchObject({ type: 'state', state: 'ready', stopReason: 'cancelled' });
  });

  it('cancel while a permission is pending resolves it as cancelled', async () => {
    const { sessionId } = await manager.start('fake', project);
    const done = manager.prompt(sessionId, 'x', { attachContext: false });
    await waitFor(() => type('permission')[0]);
    await manager.cancel(sessionId);
    await done;
    expect(events.find((e) => e.type === 'permission-resolved')).toMatchObject({ optionId: null });
    expect(received()).toContain('permission:cancelled');
  });

  it('setMode forwards session/set_mode and the agent echoes a mode update', async () => {
    const { sessionId } = await manager.start('fake', project);
    events.length = 0;
    await manager.setMode(sessionId, 'plan');
    await waitFor(() => type('update').some((e) => (e as { update: { sessionUpdate: string } }).update.sessionUpdate === 'current_mode_update'));
  });

  it('fs/write_text_file outside the session cwd is rejected', async () => {
    const { sessionId } = await manager.start('fake', project);
    await manager.prompt(sessionId, 'outside', { attachContext: false });
    expect(received().some((t) => String(t).startsWith('outside:rejected'))).toBe(true);
    await expect(stat(path.join(tmp, 'escape.txt'))).rejects.toThrow();
    expect(written).toHaveLength(0);
  });

  it('fs/read_text_file honours line and limit', async () => {
    const { sessionId } = await manager.start('fake', project);
    await manager.prompt(sessionId, 'read', { attachContext: false });
    expect(received()).toContain(`read:${JSON.stringify('b\nc\n')}`);
  });

  it('close kills the child process and emits closed', async () => {
    const { sessionId } = await manager.start('fake', project);
    const pid = Number(await readFile(path.join(tmp, 'fake.pid'), 'utf8'));
    expect(alive(pid)).toBe(true);
    await manager.close(sessionId);
    await waitFor(() => !alive(pid), 5000);
    expect(events.at(-1)).toMatchObject({ type: 'state', state: 'closed', sessionId });
    await expect(manager.prompt(sessionId, 'again')).rejects.toThrow(/Unknown session/);
    await manager.close(sessionId); // idempotent
  });

  it('a crash mid-turn rejects the prompt and reports an error state with the exit code', async () => {
    const { sessionId } = await manager.start('fake', project);
    await expect(manager.prompt(sessionId, 'crash', { attachContext: false })).rejects.toThrow(/exited/);
    const err = events.filter((e) => e.type === 'state' && e.state === 'error');
    expect(err).toHaveLength(1);
    expect((err[0] as { error: string }).error).toMatch(/code 3/);
    await expect(manager.prompt(sessionId, 'again')).rejects.toThrow(/error/);
    await manager.close(sessionId);
  });

  it('runs several agents/sessions concurrently', async () => {
    const other = path.join(tmp, 'project2');
    await mkdir(other);
    const [a, b] = await Promise.all([manager.start('fake', project), manager.start('fake2', other)]);
    expect(a.sessionId).not.toBe(b.sessionId);
    const pa = manager.prompt(a.sessionId, 'one', { attachContext: false });
    const pb = manager.prompt(b.sessionId, 'two', { attachContext: false });
    const perms = await waitFor(() => (type('permission').length === 2 ? (type('permission') as Extract<AgentEvent, { type: 'permission' }>[]) : undefined));
    for (const p of perms) manager.respondPermission(p.requestId, 'allow');
    await Promise.all([pa, pb]);
    expect(await readFile(path.join(project, 'out', 'hello.txt'), 'utf8')).toContain('hello');
    expect(await readFile(path.join(other, 'out', 'hello.txt'), 'utf8')).toContain('hello');
    expect(written.map((w) => w.agentId).sort()).toEqual(['fake', 'fake2']);
    await manager.close(a.sessionId);
    const pidB = Number(await readFile(path.join(tmp, 'fake2.pid'), 'utf8'));
    expect(alive(pidB)).toBe(true); // closing one session leaves the other running
  });

  it('rate-limits stderr events but keeps the tail', async () => {
    const { sessionId } = await manager.start('fake', project);
    events.length = 0;
    await manager.prompt(sessionId, 'noisy', { attachContext: false });
    await waitFor(() => manager.stderrTail(sessionId).length >= 100);
    expect(type('stderr').length).toBeLessThanOrEqual(31);
    expect(manager.stderrTail(sessionId).length).toBeLessThanOrEqual(200);
    await waitFor(() => type('stderr').some((e) => (e as { line: string }).line.includes('suppressed')), 3000);
  });

  it('start errors: unknown agent, unavailable agent, agent that dies during initialize', async () => {
    await setup([
      { id: 'ghost', command: 'definitely-not-a-real-binary-xyz' },
      { id: 'dies', command: process.execPath, args: ['-e', "console.error('boom on boot');process.exit(2)"] },
    ]);
    await expect(manager.start('nope', project)).rejects.toThrow(/Unknown agent/);
    await expect(manager.start('ghost', project)).rejects.toThrow(/not available/);
    await expect(manager.start('fake', path.join(project, 'missing'))).rejects.toThrow(/Not a directory/);
    await expect(manager.start('dies', project)).rejects.toThrow(/exited[\s\S]*boom on boot/);
    expect(events).toHaveLength(0);
  });

  it('exposes the prompt templates', () => {
    expect(manager.template('bootstrap')).toBe(template('bootstrap'));
    expect(manager.template('bootstrap')).toMatch(/atomic_overview[\s\S]*atomic_unmapped[\s\S]*atomic_record/);
    expect(manager.template('refresh-stale')).toMatch(/atomic_stale[\s\S]*atomic_verify[\s\S]*atomic_record/);
  });
});
