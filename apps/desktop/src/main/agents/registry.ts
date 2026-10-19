import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentInfo } from '../../shared/ipc';

/** How to start an agent process (consumed by child_process.spawn). */
export interface LaunchSpec {
  command: string;
  args: string[];
  /** merged over the parent environment */
  env: Record<string, string>;
  /** set for the cmd.exe shim form: the command line is already quoted */
  windowsVerbatimArguments?: boolean;
}

export interface ResolvedAgent {
  info: AgentInfo;
  /** null when the agent is not available */
  launch: LaunchSpec | null;
}

export interface RegistryOptions {
  /** where `.atomic/agents.json` lives (default os.homedir()) */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  warn?: (msg: string) => void;
}

interface BuiltinDef {
  id: string;
  name: string;
  /** npm adapter bundled with the app, launched through the current Node/Electron binary */
  npm?: { pkg: string; bin: string };
  /** CLI looked up on PATH */
  cli?: { bin: string; args: string[] };
}

const BUILTINS: BuiltinDef[] = [
  { id: 'claude', name: 'Claude Code', npm: { pkg: '@agentclientprotocol/claude-agent-acp', bin: 'claude-agent-acp' } },
  { id: 'codex', name: 'Codex', npm: { pkg: '@agentclientprotocol/codex-acp', bin: 'codex-acp' } },
  { id: 'opencode', name: 'OpenCode', cli: { bin: 'opencode', args: ['acp'] } },
  { id: 'gemini', name: 'Gemini CLI', cli: { bin: 'gemini', args: ['--experimental-acp'] } },
];

interface CustomDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

function getEnv(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[key];
  const k = Object.keys(env).find((e) => e.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : env[k];
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves an executable like a shell would. On Windows only PATHEXT-qualified files match, so the
 * extension-less sh script npm drops next to `foo.cmd` is never picked. No network, no spawning.
 */
export async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const win = platform === 'win32';
  const pathext = (getEnv(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = win && pathext.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  const exts = !win || hasExt ? [''] : pathext;
  const dirs = name.includes('/') || name.includes('\\')
    ? ['']
    : (getEnv(env, 'PATH', platform) ?? '').split(win ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, name + ext) : name + ext;
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

// cmd.exe metacharacters (same set cross-spawn escapes)
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1');
}

function escapeCmdArg(arg: string): string {
  // CommandLineToArgvW rules first (the .cmd shim forwards %* to the real program), then cmd.exe carets
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  a = `"${a}"`;
  return a.replace(CMD_META, '^$1');
}

/** Builds the spawn recipe for a resolved executable; `.cmd`/`.bat` shims go through `cmd.exe /d /s /c`. */
export function buildLaunch(
  file: string,
  args: string[],
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  comspec = 'cmd.exe',
): LaunchSpec {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const line = [escapeCmdCommand(path.normalize(file)), ...args.map(escapeCmdArg)].join(' ');
    return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], env, windowsVerbatimArguments: true };
  }
  return { command: file, args, env };
}

function resolveNpmAdapter(pkg: string, bin: string): { entry: string; version: string } | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve(`${pkg}/package.json`);
    const manifest = require(pkgJsonPath) as { version?: string; bin?: string | Record<string, string> };
    const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin];
    if (!rel) return null;
    return { entry: path.join(path.dirname(pkgJsonPath), rel), version: manifest.version ?? '?' };
  } catch {
    return null;
  }
}

async function resolveBuiltin(def: BuiltinDef, opts: Required<Pick<RegistryOptions, 'platform'>> & { env: NodeJS.ProcessEnv }): Promise<ResolvedAgent> {
  const base = { id: def.id, name: def.name };
  if (def.npm) {
    const found = resolveNpmAdapter(def.npm.pkg, def.npm.bin);
    if (!found || !(await isFile(found.entry))) {
      return { info: { ...base, available: false, detail: `adapter ${def.npm.pkg} is not installed` }, launch: null };
    }
    return {
      info: { ...base, available: true, detail: `bundled adapter ${def.npm.pkg}@${found.version}` },
      launch: { command: process.execPath, args: [found.entry], env: { ELECTRON_RUN_AS_NODE: '1' } },
    };
  }
  const cli = def.cli!;
  const file = await findOnPath(cli.bin, opts.env, opts.platform);
  if (!file) {
    return { info: { ...base, available: false, detail: `${cli.bin} not on PATH` }, launch: null };
  }
  return {
    info: { ...base, available: true, detail: `${cli.bin} ${cli.args.join(' ')} (${file})` },
    launch: buildLaunch(file, cli.args, {}, opts.platform, getEnv(opts.env, 'ComSpec', opts.platform)),
  };
}

function asStringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  }
  return out;
}

async function loadCustom(homeDir: string, warn: (m: string) => void): Promise<CustomDef[]> {
  const file = path.join(homeDir, '.atomic', 'agents.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return []; // optional file
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warn(`ignoring ${file}: invalid JSON (${(e as Error).message})`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warn(`ignoring ${file}: expected an array`);
    return [];
  }
  const out: CustomDef[] = [];
  for (const item of parsed as Record<string, unknown>[]) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.command !== 'string' || !item.command) {
      warn(`ignoring an entry in ${file}: "id" and "command" are required`);
      continue;
    }
    out.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name ? item.name : item.id,
      command: item.command,
      args: Array.isArray(item.args) ? item.args.filter((a): a is string => typeof a === 'string') : [],
      env: asStringRecord(item.env),
    });
  }
  return out;
}

async function resolveCustom(def: CustomDef, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<ResolvedAgent> {
  const base = { id: def.id, name: def.name };
  const file = await findOnPath(def.command, env, platform);
  if (!file) {
    return { info: { ...base, available: false, detail: `custom agent: ${def.command} not found` }, launch: null };
  }
  return {
    info: { ...base, available: true, detail: `custom: ${[def.command, ...def.args].join(' ')}` },
    launch: buildLaunch(file, def.args, def.env, platform, getEnv(env, 'ComSpec', platform)),
  };
}

/** Built-ins first (claude, codex, opencode, gemini), then custom ones; a custom id replaces a built-in. */
export async function resolveAgents(options: RegistryOptions = {}): Promise<ResolvedAgent[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const warn = options.warn ?? (() => {});
  const custom = await loadCustom(options.homeDir ?? homedir(), warn);
  const overridden = new Set(custom.map((c) => c.id));
  const builtins = await Promise.all(
    BUILTINS.filter((b) => !overridden.has(b.id)).map((b) => resolveBuiltin(b, { env, platform })),
  );
  const customs = await Promise.all(custom.map((c) => resolveCustom(c, env, platform)));
  return [...builtins, ...customs];
}

export async function detectAgents(options: RegistryOptions = {}): Promise<AgentInfo[]> {
  return (await resolveAgents(options)).map((a) => a.info);
}
