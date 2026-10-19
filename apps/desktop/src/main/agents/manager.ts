import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type McpServer,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import type { ContextPack } from '@atomic/core/types';
import type {
  AgentEvent,
  AgentInfo,
  AgentSessionInfo,
  AgentSessionState,
  PromptOptions,
  PromptTemplate,
} from '../../shared/ipc';
import { resolveAgents, type RegistryOptions, type ResolvedAgent } from './registry';
import { resolveInside, toProjectPath } from './sandbox';
import { template } from './templates';

export interface AgentManagerDeps {
  emit(ev: AgentEvent): void;
  /** stdio MCP servers injected into session/new (the Atomic memory server) */
  mcpServers(agentId: string): McpServer[];
  composeContext(sessionId: string, text: string, opts: PromptOptions): Promise<ContextPack | null>;
  /** project-relative, forward-slash paths written by the agent through fs/write_text_file */
  onFilesWritten(paths: string[], sessionId: string, agentId: string): void;
  /** project-relative paths named by tool_call / tool_call_update locations and diffs */
  onToolLocations(paths: string[], sessionId: string): void;
  /** lifecycle diagnostics only; never receives prompt contents */
  log?(msg: string): void;
}

export interface AgentManagerOptions {
  registry?: RegistryOptions;
  clientVersion?: string;
}

const STDERR_TAIL = 200;
const STDERR_MAX_PER_SECOND = 30;
const EARLY_EVENTS_MAX = 500;
const READ_MAX_BYTES = 20 * 1024 * 1024;
const KILL_WAIT_MS = 3000;

interface PendingPermission {
  request: RequestPermissionRequest;
  settle(optionId: string | null): void;
}

interface Session {
  id: string;
  agent: ResolvedAgent;
  cwd: string;
  child: ChildProcess;
  conn: ClientSideConnection;
  state: AgentSessionState;
  /** false until session/new returned: events are held so they carry a known session id */
  announced: boolean;
  early: AgentEvent[];
  pending: Map<string, PendingPermission>;
  stderrTail: string[];
  stderrWindowStart: number;
  stderrWindowCount: number;
  stderrSuppressed: number;
  stderrTimer?: NodeJS.Timeout;
  exited: boolean;
  exitPromise: Promise<void>;
  /** rejects when the process dies; used to fail in-flight requests fast */
  failure: Promise<never>;
  exitError?: Error;
  closing: boolean;
  terminal: boolean;
  info?: AgentSessionInfo;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `code ${code}`;
}

function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => resolve());
    });
  }
  try {
    process.kill(-pid, 'SIGKILL'); // spawned detached → own process group
  } catch {
    child.kill('SIGKILL');
  }
  return Promise.resolve();
}

function lastLines(lines: string[], n = 5): string {
  const tail = lines.slice(-n).join('\n');
  return tail ? `\n${tail}` : '';
}

export class AgentManager {
  private readonly sessions = new Map<string, Session>();
  private readonly permissions = new Map<string, Session>();

  constructor(
    private readonly deps: AgentManagerDeps,
    private readonly options: AgentManagerOptions = {},
  ) {}

  async list(): Promise<AgentInfo[]> {
    return (await resolveAgents(this.options.registry)).map((a) => a.info);
  }

  template(kind: PromptTemplate): string {
    return template(kind);
  }

  async start(agentId: string, cwd: string): Promise<AgentSessionInfo> {
    const agent = (await resolveAgents(this.options.registry)).find((a) => a.info.id === agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    if (!agent.launch) throw new Error(`${agent.info.name} is not available: ${agent.info.detail}`);
    const root = path.resolve(cwd);
    if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`Not a directory: ${root}`);

    const s = this.spawnSession(agent, root);
    this.deps.log?.(`[agents] starting ${agentId} in ${root}`);
    try {
      const init = await this.guard(
        s,
        s.conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          clientInfo: { name: 'atomic-workspace', title: 'Atomic Workspace', version: this.options.clientVersion ?? '0.1.0' },
        }),
      );
      const created = await this.guard(s, s.conn.newSession({ cwd: root, mcpServers: this.deps.mcpServers(agentId) }));
      s.id = created.sessionId;
      const caps = init.agentCapabilities;
      s.info = {
        sessionId: created.sessionId,
        agentId,
        agentName: agent.info.name,
        modes: created.modes
          ? {
              currentModeId: created.modes.currentModeId,
              availableModes: created.modes.availableModes.map((m) => ({ id: m.id, name: m.name, description: m.description })),
            }
          : undefined,
        supportsImages: caps?.promptCapabilities?.image === true,
        supportsLoadSession: caps?.loadSession === true,
      };
      this.sessions.set(s.id, s);
      s.announced = true;
      this.setState(s, 'starting');
      this.setState(s, 'ready');
      for (const ev of s.early.splice(0)) this.deps.emit(ev);
      this.deps.log?.(`[agents] ${agentId} ready (session ${s.id})`);
      return s.info;
    } catch (e) {
      const message = (e as Error).message;
      s.closing = true;
      await this.terminate(s);
      throw new Error(`${agent.info.name} failed to start: ${message}${lastLines(s.stderrTail)}`);
    }
  }

  async prompt(sessionId: string, text: string, opts: PromptOptions = {}): Promise<{ stopReason: string }> {
    const s = this.live(sessionId);
    if (s.state === 'prompting') throw new Error('A prompt is already running in this session');
    this.emit(s, { type: 'user', sessionId, text, at: new Date().toISOString() });

    const blocks: ContentBlock[] = [{ type: 'text', text }];
    if (opts.attachContext !== false) {
      let pack: ContextPack | null = null;
      try {
        pack = await this.deps.composeContext(sessionId, text, opts);
      } catch (e) {
        this.deps.log?.(`[agents] composeContext failed: ${(e as Error).message}`);
      }
      if (pack) {
        blocks.unshift({ type: 'text', text: `<workspace-context>\n${pack.text}\n</workspace-context>` });
        const { estimatedTokens, nodeIds, sections, text: packText } = pack;
        this.emit(s, { type: 'context', sessionId, pack: { estimatedTokens, nodeIds, sections, text: packText } });
      }
    }
    if (s.terminal) throw new Error('The session was closed while preparing the prompt');

    this.setState(s, 'prompting');
    try {
      const res = await this.guard(s, s.conn.prompt({ sessionId, prompt: blocks }));
      if (!s.terminal) this.setState(s, 'ready', { stopReason: res.stopReason });
      return { stopReason: res.stopReason };
    } catch (e) {
      const message = (e as Error).message;
      if (!s.terminal) this.setState(s, 'error', { error: message });
      throw e;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const s = this.live(sessionId);
    // spec: pending permission requests of a cancelled turn must answer "cancelled"
    for (const id of [...s.pending.keys()]) s.pending.get(id)?.settle(null);
    if (s.state === 'prompting') await s.conn.cancel({ sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const s = this.live(sessionId);
    await this.guard(s, s.conn.setSessionMode({ sessionId, modeId }));
    if (s.info?.modes) s.info.modes.currentModeId = modeId;
  }

  respondPermission(requestId: string, optionId: string | null): void {
    const s = this.permissions.get(requestId);
    const pending = s?.pending.get(requestId);
    if (!s || !pending) {
      this.deps.log?.(`[agents] permission ${requestId} is not pending (already answered or cancelled)`);
      return;
    }
    if (optionId !== null && !pending.request.options.some((o) => o.optionId === optionId)) {
      throw new Error(`Unknown permission option: ${optionId}`);
    }
    pending.settle(optionId);
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.closing = true;
    await this.terminate(s);
    this.sessions.delete(sessionId);
  }

  /** closes every session; call on app quit */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  /** last stderr lines of a session (up to 200) */
  stderrTail(sessionId: string): string[] {
    return [...(this.sessions.get(sessionId)?.stderrTail ?? [])];
  }

  // ───────────────────────────── internals ─────────────────────────────

  private live(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session: ${sessionId}`);
    if (s.terminal) throw new Error(`Session ${sessionId} is ${s.state}`);
    return s;
  }

  /** races a request against the process dying; a dead process explains itself better than "connection closed" */
  private async guard<T>(s: Session, p: Promise<T>): Promise<T> {
    try {
      return await Promise.race([p, s.failure]);
    } catch (e) {
      if (e instanceof RequestError) throw e; // the agent answered with an error: keep it
      if (!s.exited) await Promise.race([s.exitPromise, new Promise((r) => setTimeout(r, 1000).unref())]);
      throw s.exitError ?? e;
    }
  }

  private emit(s: Session, ev: AgentEvent): void {
    if (s.announced) this.deps.emit(ev);
    else if (s.early.length < EARLY_EVENTS_MAX) s.early.push(ev);
  }

  private setState(s: Session, state: AgentSessionState, extra: { error?: string; stopReason?: string } = {}): void {
    s.state = state;
    if (state === 'closed' || state === 'error') s.terminal = state === 'closed' || s.exited;
    this.emit(s, { type: 'state', sessionId: s.id, state, ...extra });
  }

  private spawnSession(agent: ResolvedAgent, cwd: string): Session {
    const launch = agent.launch!;
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: { ...process.env, ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
    });

    let onExit!: () => void;
    let fail!: (e: Error) => void;
    const exitPromise = new Promise<void>((r) => (onExit = r));
    const failure = new Promise<never>((_, reject) => (fail = reject));
    failure.catch(() => {}); // consumers race against it; avoid unhandled rejection when nobody does

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const s: Session = {
      id: '',
      agent,
      cwd,
      child,
      conn: undefined as unknown as ClientSideConnection,
      state: 'starting',
      announced: false,
      early: [],
      pending: new Map(),
      stderrTail: [],
      stderrWindowStart: 0,
      stderrWindowCount: 0,
      stderrSuppressed: 0,
      exited: false,
      exitPromise,
      failure,
      closing: false,
      terminal: false,
    };
    s.conn = new ClientSideConnection(() => this.clientFor(s), stream);

    createInterface({ input: child.stderr! }).on('line', (line) => this.onStderr(s, line));
    child.stdin!.on('error', () => {}); // EPIPE after the agent died is reported through the exit path
    child.once('error', (e) => fail(new Error(`could not launch ${launch.command}: ${e.message}`)));
    child.once('exit', (code, signal) => {
      s.exited = true;
      if (s.stderrTimer) clearTimeout(s.stderrTimer);
      for (const p of [...s.pending.values()]) p.settle(null);
      const how = describeExit(code, signal);
      this.deps.log?.(`[agents] ${agent.info.id} exited (${how})`);
      if (!s.closing) {
        if (code === 0) this.setState(s, 'closed');
        else {
          s.terminal = true;
          this.setState(s, 'error', { error: `${agent.info.name} exited unexpectedly (${how})${lastLines(s.stderrTail)}` });
        }
      }
      s.exitError = new Error(`${agent.info.name} exited (${how})`);
      fail(s.exitError);
      onExit();
    });
    return s;
  }

  private async terminate(s: Session): Promise<void> {
    for (const p of [...s.pending.values()]) p.settle(null);
    if (!s.exited) {
      await killTree(s.child);
      await Promise.race([s.exitPromise, new Promise((r) => setTimeout(r, KILL_WAIT_MS).unref())]);
    }
    s.child.stdin?.destroy();
    if (s.stderrTimer) clearTimeout(s.stderrTimer);
    if (s.announced && s.state !== 'closed') {
      s.terminal = true;
      this.setState(s, 'closed');
    }
    s.terminal = true;
  }

  private onStderr(s: Session, line: string): void {
    s.stderrTail.push(line);
    if (s.stderrTail.length > STDERR_TAIL) s.stderrTail.shift();
    const now = Date.now();
    if (now - s.stderrWindowStart >= 1000) {
      s.stderrWindowStart = now;
      s.stderrWindowCount = 0;
    }
    if (s.stderrWindowCount >= STDERR_MAX_PER_SECOND) {
      s.stderrSuppressed++;
      s.stderrTimer ??= setTimeout(() => {
        s.stderrTimer = undefined;
        const n = s.stderrSuppressed;
        s.stderrSuppressed = 0;
        if (n > 0) this.emit(s, { type: 'stderr', sessionId: s.id, line: `… ${n} more stderr lines suppressed` });
      }, 1000);
      s.stderrTimer.unref();
      return;
    }
    s.stderrWindowCount++;
    this.emit(s, { type: 'stderr', sessionId: s.id, line });
  }

  private clientFor(s: Session): Client {
    return {
      sessionUpdate: (p) => this.onSessionUpdate(s, p),
      requestPermission: (p) => this.onRequestPermission(s, p),
      readTextFile: (p) => this.onReadTextFile(s, p),
      writeTextFile: (p) => this.onWriteTextFile(s, p),
    };
  }

  private onSessionUpdate(s: Session, p: SessionNotification): void {
    this.emit(s, { type: 'update', sessionId: p.sessionId, update: p.update });
    const u = p.update;
    if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return;
    const raw = [
      ...(u.locations ?? []).map((l) => l.path),
      ...(u.content ?? []).flatMap((c) => (c.type === 'diff' ? [c.path] : [])),
    ];
    const paths = [...new Set(raw.map((r) => toProjectPath(s.cwd, r)).filter((r): r is string => r !== null))];
    if (paths.length === 0) return;
    try {
      this.deps.onToolLocations(paths, p.sessionId);
    } catch (e) {
      this.deps.log?.(`[agents] onToolLocations failed: ${(e as Error).message}`);
    }
  }

  private onRequestPermission(s: Session, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      s.pending.set(requestId, {
        request,
        settle: (optionId) => {
          if (!s.pending.delete(requestId)) return;
          this.permissions.delete(requestId);
          resolve({ outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } });
          this.emit(s, { type: 'permission-resolved', sessionId: request.sessionId, requestId, optionId });
        },
      });
      this.permissions.set(requestId, s);
      this.emit(s, { type: 'permission', sessionId: request.sessionId, requestId, request });
    });
  }

  private async onReadTextFile(s: Session, p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const abs = await resolveInside(s.cwd, p.path);
    let info;
    try {
      info = await stat(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new RequestError(-32002, 'File not found', { path: p.path });
      throw e;
    }
    if (!info.isFile()) throw RequestError.invalidParams({ path: p.path }, 'not a file');
    if (info.size > READ_MAX_BYTES) throw RequestError.invalidParams({ path: p.path }, 'file too large');
    const content = await readFile(abs, 'utf8');
    if (p.line == null && p.limit == null) return { content };
    // keep line terminators so the slice is byte-faithful
    const lines = content.split(/(?<=\n)/);
    const start = Math.max(0, (p.line ?? 1) - 1);
    const end = p.limit == null ? undefined : start + Math.max(0, p.limit);
    return { content: lines.slice(start, end).join('') };
  }

  private async onWriteTextFile(s: Session, p: WriteTextFileRequest): Promise<Record<string, never>> {
    const abs = await resolveInside(s.cwd, p.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, p.content, 'utf8');
    const rel = toProjectPath(s.cwd, abs);
    if (rel) {
      try {
        this.deps.onFilesWritten([rel], p.sessionId, s.agent.info.id);
      } catch (e) {
        this.deps.log?.(`[agents] onFilesWritten failed: ${(e as Error).message}`);
      }
    }
    return {};
  }
}
