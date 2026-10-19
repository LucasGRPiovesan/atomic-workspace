import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveInside } from './sandbox';
import { buildLaunch, detectAgents, findOnPath, resolveAgents } from './registry';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'atomic-registry-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const win = process.platform === 'win32';

describe('registry', () => {
  it('bundled npm adapters resolve to node + ELECTRON_RUN_AS_NODE', async () => {
    const agents = await resolveAgents({ homeDir: tmp, env: { PATH: '' } });
    for (const id of ['claude', 'codex']) {
      const a = agents.find((x) => x.info.id === id)!;
      expect(a.info.available).toBe(true);
      expect(a.launch?.command).toBe(process.execPath);
      expect(a.launch?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
      expect(a.launch?.args[0]).toMatch(/dist[\\/]index\.js$/);
    }
  });

  it('PATH CLIs are reported unavailable with a reason (no network, no spawn)', async () => {
    const list = await detectAgents({ homeDir: tmp, env: { PATH: tmp } });
    expect(list.find((a) => a.id === 'opencode')).toMatchObject({ available: false, detail: 'opencode not on PATH' });
    expect(list.find((a) => a.id === 'gemini')).toMatchObject({ available: false, detail: 'gemini not on PATH' });
  });

  it('finds CLIs on PATH and applies the right args', async () => {
    const bin = win ? 'opencode.exe' : 'opencode';
    await writeFile(path.join(tmp, bin), '');
    if (!win) await chmod(path.join(tmp, bin), 0o755);
    const agents = await resolveAgents({ homeDir: tmp, env: { PATH: tmp, PATHEXT: '.EXE;.CMD' } });
    const oc = agents.find((a) => a.info.id === 'opencode')!;
    expect(oc.info.available).toBe(true);
    expect(oc.launch?.command.toLowerCase()).toBe(path.join(tmp, bin).toLowerCase());
    expect(oc.launch?.args).toEqual(['acp']);
  });

  it('loads custom agents from ~/.atomic/agents.json; a custom id replaces a built-in; bad entries warn', async () => {
    await mkdir(path.join(tmp, '.atomic'));
    await writeFile(
      path.join(tmp, '.atomic', 'agents.json'),
      JSON.stringify([
        { id: 'mine', name: 'Mine', command: process.execPath, args: ['--version'], env: { A: '1' } },
        { id: 'gemini', command: process.execPath },
        { name: 'no id', command: 'x' },
      ]),
    );
    const warnings: string[] = [];
    const agents = await resolveAgents({ homeDir: tmp, env: { PATH: '' }, warn: (m) => warnings.push(m) });
    expect(agents.map((a) => a.info.id)).toEqual(['claude', 'codex', 'opencode', 'mine', 'gemini']);
    expect(agents.find((a) => a.info.id === 'mine')).toMatchObject({
      info: { name: 'Mine', available: true },
      launch: { command: process.execPath, args: ['--version'], env: { A: '1' } },
    });
    expect(agents.find((a) => a.info.id === 'gemini')?.info.name).toBe('gemini');
    expect(warnings).toHaveLength(1);
  });

  it('ignores a malformed agents.json', async () => {
    await mkdir(path.join(tmp, '.atomic'));
    await writeFile(path.join(tmp, '.atomic', 'agents.json'), '{nope');
    const warnings: string[] = [];
    const list = await detectAgents({ homeDir: tmp, env: { PATH: '' }, warn: (m) => warnings.push(m) });
    expect(list).toHaveLength(4);
    expect(warnings[0]).toMatch(/invalid JSON/);
  });

  it.skipIf(!win)('Windows: only PATHEXT matches count (never the extension-less sh script)', async () => {
    await writeFile(path.join(tmp, 'tool'), '#!/bin/sh');
    expect(await findOnPath('tool', { PATH: tmp, PATHEXT: '.EXE;.CMD' }, 'win32')).toBeNull();
    await writeFile(path.join(tmp, 'tool.cmd'), '@echo off');
    expect(await findOnPath('tool', { Path: tmp, PATHEXT: '.EXE;.CMD' }, 'win32')).toMatch(/tool.cmd$/i);
  });

  it.skipIf(!win)('Windows: .cmd shims go through cmd.exe and keep awkward arguments intact', async () => {
    const dir = path.join(tmp, 'with space (x86)');
    await mkdir(dir);
    const out = path.join(tmp, 'argv.json');
    await writeFile(path.join(dir, 'dump.js'), `require('fs').writeFileSync(process.env.OUT, JSON.stringify(process.argv.slice(2)));`);
    const shim = path.join(dir, 'tool.cmd');
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "%~dp0dump.js" %*\r\n`);
    const args = ['acp', 'a b', 'c&d', 'say "hi"', 'x|y', '(p)'];
    const launch = buildLaunch(shim, args, {}, 'win32', process.env.ComSpec);
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const child = spawn(launch.command, launch.args, {
      env: { ...process.env, OUT: out },
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
    const code = await new Promise((r) => child.once('exit', r));
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(args);
  });

  it('non-shim executables are launched directly', () => {
    expect(buildLaunch('/usr/bin/gemini', ['--experimental-acp'], { A: '1' }, 'linux')).toEqual({
      command: '/usr/bin/gemini',
      args: ['--experimental-acp'],
      env: { A: '1' },
    });
  });
});

describe('sandbox', () => {
  it('keeps paths inside the session directory, including via symlinks', async () => {
    const root = path.join(tmp, 'root');
    await mkdir(root);
    expect(await resolveInside(root, 'a/b.txt')).toBe(path.join(root, 'a', 'b.txt'));
    expect(await resolveInside(root, path.join(root, 'x.txt'))).toBe(path.join(root, 'x.txt'));
    await expect(resolveInside(root, '../outside.txt')).rejects.toThrow(/outside/);
    await expect(resolveInside(root, path.join(tmp, 'other.txt'))).rejects.toThrow(/outside/);
    await expect(resolveInside(root, path.parse(tmp).root)).rejects.toThrow(/outside/);
    const { symlink } = await import('node:fs/promises');
    await mkdir(path.join(tmp, 'secret'));
    try {
      await symlink(path.join(tmp, 'secret'), path.join(root, 'link'), 'junction');
    } catch {
      return; // symlinks unavailable here
    }
    await expect(resolveInside(root, 'link/x.txt')).rejects.toThrow(/outside/);
  });
});
