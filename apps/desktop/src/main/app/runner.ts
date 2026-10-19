import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, join, basename } from 'node:path';
import type { RunScript } from '@atomic/core/types';
import type { AppLogLine, AppRunStatus, EventPayloads } from '../../shared/ipc';

export type AppRunnerEmit = <K extends 'app:status' | 'app:log'>(channel: K, payload: EventPayloads[K]) => void;

export interface AppRunnerOptions {
  emit: AppRunnerEmit;
  /** project root; RunScript.cwd is relative to it */
  root: string;
}

const MAX_LOG_LINES = 2000;
const KILL_GRACE_MS = 3000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const URL_RE = /(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i;
const LISTEN_RE = /listening\s+(?:on|at)\s+(?:port\s+)?:?(\d{2,5})\b/i;
// script names go into a shell command line on Windows, so only accept plain tokens
const SAFE_NAME = /^[\w:.@/-]+$/;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/** First local URL (or "listening on PORT") in a line, normalized to http(s)://localhost:PORT. */
export function detectUrl(line: string): string | undefined {
  const text = stripAnsi(line);
  const m = URL_RE.exec(text);
  if (m) return `${m[1].toLowerCase()}://localhost:${m[2]}`;
  const l = LISTEN_RE.exec(text);
  return l ? `http://localhost:${l[1]}` : undefined;
}

/** Shell command line that runs `script` through the project's package manager (or make). */
export function commandLine(script: RunScript, packageManager: string): string {
  if (!SAFE_NAME.test(script.name)) throw new Error(`Unsupported script name: ${script.name}`);
  const src = basename(script.source).toLowerCase();
  if (src === 'makefile') return `make ${script.name}`;
  if (src !== 'package.json') return script.command;
  switch (packageManager) {
    case 'pnpm': return `pnpm ${script.name}`;
    case 'yarn': return `yarn ${script.name}`;
    case 'bun': return `bun run ${script.name}`;
    default: return `npm run ${script.name}`;
  }
}

export class AppRunner {
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private stopping = false;
  private status: AppRunStatus = { state: 'stopped' };
  private lines: AppLogLine[] = [];
  private partial = { stdout: '', stderr: '' };

  constructor(private readonly opts: AppRunnerOptions) {}

  getStatus(): AppRunStatus { return this.status; }

  logs(): AppLogLine[] { return this.lines; }

  async start(script: RunScript, packageManager: string): Promise<AppRunStatus> {
    if (this.child) await this.stop();
    const cmd = commandLine(script, packageManager);
    const cwd = isAbsolute(script.cwd) ? script.cwd : join(this.opts.root, script.cwd);
    this.lines = [];
    this.partial = { stdout: '', stderr: '' };
    this.stopping = false;
    this.setStatus({ state: 'starting', script });
    this.log('system', `$ ${cmd}  (cwd: ${script.cwd || '.'})`);

    const env = { ...process.env, FORCE_COLOR: '0', BROWSER: 'none' };
    const win = process.platform === 'win32';
    let child: ChildProcess;
    try {
      child = win
        ? spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
        : spawn('sh', ['-c', cmd], { cwd, env, detached: true });
    } catch (err) {
      this.log('system', `Failed to start: ${(err as Error).message}`);
      return this.setStatus({ state: 'error', script });
    }
    this.child = child;
    this.setStatus({ ...this.status, pid: child.pid });

    child.stdout?.on('data', (b: Buffer) => this.onData('stdout', b));
    child.stderr?.on('data', (b: Buffer) => this.onData('stderr', b));
    this.exited = new Promise<void>((resolve) => {
      let done = false;
      const finish = (code: number | null, err?: Error) => {
        if (done) return;
        done = true;
        this.flush();
        if (this.child === child) this.child = undefined;
        if (err) {
          this.log('system', `Process error: ${err.message}`);
          this.setStatus({ state: 'error', script });
        } else {
          this.log('system', `Process exited with code ${code}`);
          this.setStatus({ state: this.stopping ? 'stopped' : 'exited', script, exitCode: code });
        }
        resolve();
      };
      child.once('error', (err) => finish(null, err));
      child.once('close', (code) => finish(code));
    });
    return this.status;
  }

  /** Manual override when the URL could not be detected from output. */
  setUrl(url: string): AppRunStatus {
    if (this.status.state !== 'starting' && this.status.state !== 'running') return this.status;
    return this.setStatus({ ...this.status, state: 'running', url });
  }

  async stop(): Promise<AppRunStatus> {
    const child = this.child;
    if (!child?.pid) return this.status;
    this.stopping = true;
    this.killTree(child.pid, false);
    const timer = setTimeout(() => child.pid && this.killTree(child.pid, true), KILL_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
    return this.status;
  }

  private killTree(pid: number, force: boolean): void {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
      return;
    }
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
  }

  private onData(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const parts = (this.partial[stream] + chunk.toString('utf8')).split(/\r?\n/);
    this.partial[stream] = parts.pop() ?? '';
    for (const line of parts) this.onLine(stream, line);
  }

  private flush(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.partial[stream]) this.onLine(stream, this.partial[stream]);
      this.partial[stream] = '';
    }
  }

  private onLine(stream: 'stdout' | 'stderr', raw: string): void {
    const text = stripAnsi(raw);
    if (!text.trim()) return;
    this.log(stream, text);
    if (this.status.state === 'starting') {
      const url = detectUrl(text);
      if (url) this.setStatus({ ...this.status, state: 'running', url });
    }
  }

  private log(stream: AppLogLine['stream'], text: string): void {
    const line: AppLogLine = { stream, text, at: new Date().toISOString() };
    this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
    this.opts.emit('app:log', line);
  }

  private setStatus(next: AppRunStatus): AppRunStatus {
    this.status = next;
    this.opts.emit('app:status', next);
    return next;
  }
}
