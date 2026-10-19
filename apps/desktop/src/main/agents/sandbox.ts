import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** realpath of the deepest existing ancestor, with the not-yet-existing tail re-appended */
async function realOfNearest(abs: string): Promise<string> {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(await realpath(cur), ...tail.reverse());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Absolute path of `requested` guaranteed to stay inside the session directory (symlinks included). */
export async function resolveInside(cwd: string, requested: string): Promise<string> {
  const outside = () => RequestError.invalidParams({ path: requested }, 'path is outside the session directory');
  const abs = path.resolve(cwd, requested);
  const cwdReal = await realpath(cwd);
  if (!isInside(cwd, abs) && !isInside(cwdReal, abs)) throw outside();
  if (!isInside(cwdReal, await realOfNearest(abs))) throw outside();
  return abs;
}

/** project-relative, forward-slash path or null when `abs` is not under `cwd` */
export function toProjectPath(cwd: string, abs: string): string | null {
  const resolved = path.resolve(cwd, abs);
  if (!isInside(cwd, resolved)) return null;
  const rel = path.relative(cwd, resolved);
  return rel === '' ? null : rel.split(path.sep).join('/');
}
