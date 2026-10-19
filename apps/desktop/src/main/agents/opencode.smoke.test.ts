import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../shared/ipc';
import { AgentManager } from './manager';
import { detectAgents } from './registry';

// Real agent, no prompt (zero model cost): initialize + session/new only.
const opencode = (await detectAgents()).find((a) => a.id === 'opencode');

describe.skipIf(!opencode?.available)('opencode smoke (real agent, no prompt)', () => {
  const events: AgentEvent[] = [];
  const manager = new AgentManager({
    emit: (e) => events.push(e),
    mcpServers: () => [],
    composeContext: async () => null,
    onFilesWritten: () => {},
    onToolLocations: () => {},
  });
  let dir: string;

  afterAll(async () => {
    await manager.dispose();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('initialize + session/new succeed and the session can be closed', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'atomic-opencode-'));
    const info = await manager.start('opencode', dir);
    expect(info.agentId).toBe('opencode');
    expect(info.agentName).toBe('OpenCode');
    expect(info.sessionId).toBeTruthy();
    expect(typeof info.supportsImages).toBe('boolean');
    expect(typeof info.supportsLoadSession).toBe('boolean');
    console.log('opencode session info:', JSON.stringify(info));
    await manager.close(info.sessionId);
    expect(events.some((e) => e.type === 'state' && e.state === 'closed')).toBe(true);
  }, 60000);
});
