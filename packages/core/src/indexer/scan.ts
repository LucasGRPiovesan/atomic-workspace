import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import ignore, { type Ignore } from 'ignore';

export const MAX_FILE_BYTES = 1024 * 1024;

/** Directory names skipped at any depth. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.atomic', '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', '.venv',
]);

const LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'go.sum',
]);

const BINARY_EXT: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tif', '.tiff', '.svg', '.avif', '.psd',
  '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class', '.jar', '.pyc', '.o', '.a',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.ogg',
  '.sqlite', '.sqlite3', '.db', '.map',
]);

export interface ScanEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  files: ScanEntry[];
  /** lockfiles present on disk: not indexed, but package manager detection needs their names */
  lockfiles: string[];
}

export const isLockfile = (path: string): boolean => LOCKFILES.has(posix.basename(path));

/** Static (gitignore-independent) exclusion rules for a root-relative POSIX path. */
export function isIgnoredPath(path: string): boolean {
  const segments = path.split('/');
  for (let i = 0; i < segments.length - 1; i++) if (SKIP_DIRS.has(segments[i])) return true;
  const name = segments[segments.length - 1];
  if (LOCKFILES.has(name) || name === '.DS_Store' || name.endsWith('.min.js') || name.endsWith('.min.css')) return true;
  return BINARY_EXT.has(posix.extname(name).toLowerCase());
}

export async function loadIgnore(root: string): Promise<Ignore> {
  const ig = ignore();
  try {
    ig.add(await readFile(join(root, '.gitignore'), 'utf8'));
  } catch {
    // no .gitignore
  }
  return ig;
}

function gitList(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : stdout.split('\0').filter(Boolean));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(root: string, dir: string, ig: Ignore, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || ig.ignores(`${rel}/`)) continue;
      await walk(root, rel, ig, out);
    } else if (entry.isFile() && !ig.ignores(rel)) {
      out.push(rel);
    }
  }
}

/** Stat candidates with bounded concurrency; drops missing, non-regular and oversized files. */
export async function statEntries(root: string, paths: readonly string[]): Promise<ScanEntry[]> {
  const out: (ScanEntry | undefined)[] = new Array(paths.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < paths.length; i = next++) {
      try {
        const s = await stat(join(root, paths[i]));
        if (s.isFile() && s.size <= MAX_FILE_BYTES) out[i] = { path: paths[i], size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        // deleted between listing and stat
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return out.filter((e): e is ScanEntry => e !== undefined);
}

export async function scan(root: string): Promise<ScanResult> {
  let listed: string[] | undefined;
  if (await exists(join(root, '.git'))) listed = await gitList(root);
  if (!listed) {
    listed = [];
    await walk(root, '', await loadIgnore(root), listed);
  }
  const unique = [...new Set(listed.map((p) => p.replaceAll('\\', '/')))];
  const lockfiles = unique.filter((p) => isLockfile(p) && !p.split('/').slice(0, -1).some((s) => SKIP_DIRS.has(s))).sort();
  const candidates = unique.filter((p) => !isIgnoredPath(p)).sort();
  return { files: await statEntries(root, candidates), lockfiles };
}

/** Root-relative POSIX paths of every file the indexer would consider. */
export async function scanFiles(root: string): Promise<string[]> {
  return (await scan(root)).files.map((e) => e.path);
}
