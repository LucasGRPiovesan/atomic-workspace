import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunScript } from '@atomic/core/types';
import type { AppLogLine, AppRunStatus } from '../../shared/ipc';
import { AppRunner, commandLine, detectUrl, stripAnsi } from './runner';

describe('detectUrl', () => {
  it.each([
    ['  ➜  Local:   http://localhost:5173/', 'http://localhost:5173'],
    ['\u001b[32m- Local:\u001b[0m        http://localhost:3000', 'http://localhost:3000'],
    ['ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000', 'http://localhost:3000'],
    ['Server listening on http://127.0.0.1:4311', 'http://localhost:4311'],
    ['Express app listening on port 8080', 'http://localhost:8080'],
    ['listening on :9000', 'http://localhost:9000'],
    ['  Network: http://[::]:4000/', 'http://localhost:4000'],
    ['https://localhost:8443/', 'https://localhost:8443'],
  ])('%s', (line, url) => expect(detectUrl(line)).toBe(url));

  it('returns nothing for unrelated lines', () => {
    expect(detectUrl('compiled in 120ms')).toBeUndefined();
    expect(detectUrl('see https://vite.dev/guide for docs')).toBeUndefined();
  });
});

describe('commandLine', () => {
  const s = (source: string, name = 'dev'): RunScript => ({ name, command: 'vite', source, cwd: '' });
  it('uses the package manager', () => {
    expect(commandLine(s('package.json'), 'npm')).toBe('npm run dev');
    expect(commandLine(s('apps/web/package.json'), 'pnpm')).toBe('pnpm dev');
    expect(commandLine(s('package.json'), 'yarn')).toBe('yarn dev');
    expect(commandLine(s('package.json'), 'bun')).toBe('bun run dev');
    expect(commandLine(s('Makefile'), 'npm')).toBe('make dev');
  });
  it('rejects names that could inject shell syntax', () => {
    expect(() => commandLine(s('package.json', 'dev & calc'), 'npm')).toThrow();
  });
  it('strips ANSI', () => expect(stripAnsi('\u001b[1mhi\u001b[0m')).toBe('hi'));
});

describe('AppRunner (real process)', () => {
  const dirs: string[] = [];
  let runner: AppRunner | undefined;
  afterEach(async () => {
    await runner?.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'atomic-runner-'));
    dirs.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    writeFileSync(join(root, 'server.js'), [
      "console.log('pid=' + process.pid);",
      "console.error('warning: something on stderr');",
      "console.log('Local: http://0.0.0.0:4555/');",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const statuses: AppRunStatus[] = [];
    const logs: AppLogLine[] = [];
    runner = new AppRunner({
      root,
      emit: ((channel: string, payload: unknown) => {
        if (channel === 'app:status') statuses.push(payload as AppRunStatus);
        else logs.push(payload as AppLogLine);
      }) as never,
    });
    const script: RunScript = { name: 'dev', command: 'node server.js', source: 'package.json', cwd: '' };
    return { runner, statuses, logs, script };
  }

  const waitFor = async (cond: () => boolean, ms = 15000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('detects the URL, streams logs by stream, and kills the whole tree on stop', async () => {
    const { runner, statuses, logs, script } = setup();
    await runner.start(script, 'npm');
    await waitFor(() => runner.getStatus().state === 'running');
    expect(runner.getStatus().url).toBe('http://localhost:4555');
    expect(statuses[0].state).toBe('starting');

    const pidLine = logs.find((l) => l.text.startsWith('pid='));
    expect(pidLine?.stream).toBe('stdout');
    expect(logs.find((l) => l.text.includes('something on stderr'))?.stream).toBe('stderr');
    const nodePid = Number(pidLine!.text.slice(4));
    expect(alive(nodePid)).toBe(true);

    const final = await runner.stop();
    expect(final.state).toBe('stopped');
    await waitFor(() => !alive(nodePid), 5000);
    expect(alive(nodePid)).toBe(false);
  });

  it('reports exited with the exit code when the process ends on its own', async () => {
    const { runner, statuses } = setup();
    const script: RunScript = { name: 'fail', command: 'x', source: 'package.json', cwd: '' };
    writeFileSync(join(dirs[0], 'package.json'), JSON.stringify({ scripts: { fail: 'node -e "process.exit(3)"' } }));
    await runner.start(script, 'npm');
    await waitFor(() => runner.getStatus().state === 'exited');
    expect(runner.getStatus().exitCode).not.toBe(0);
    expect(statuses.at(-1)?.state).toBe('exited');
  });

  it('setUrl overrides while starting', async () => {
    const { runner, script } = setup();
    writeFileSync(join(dirs[0], 'server.js'), 'setInterval(() => {}, 1000);');
    await runner.start(script, 'npm');
    expect(runner.getStatus().state).toBe('starting');
    runner.setUrl('http://localhost:1234');
    expect(runner.getStatus()).toMatchObject({ state: 'running', url: 'http://localhost:1234' });
  });
});
