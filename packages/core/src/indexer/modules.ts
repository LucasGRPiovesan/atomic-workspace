import { detectLang, isTestPath } from '../extract/index.js';
import type { Lang } from '../types.js';

const SOURCE_ROOTS: ReadonlySet<string> = new Set(['src', 'app', 'lib', 'server']);
const CODE_LANGS: ReadonlySet<Lang> = new Set<Lang>([
  'typescript', 'tsx', 'javascript', 'python', 'go', 'java', 'rust', 'csharp', 'php', 'ruby',
]);

export const isCodeLang = (lang: Lang): boolean => CODE_LANGS.has(lang);

/** `src`, `app`, `lib`, `server`, `packages/<pkg>/src`, `apps/<app>/src` prefix of a file path, when it has one. */
function sourceRoot(segments: string[]): string | undefined {
  if ((segments[0] === 'packages' || segments[0] === 'apps') && segments[2] === 'src' && segments.length > 3) {
    return segments.slice(0, 3).join('/');
  }
  if (SOURCE_ROOTS.has(segments[0]) && segments.length > 1) return segments[0];
  return undefined;
}

/**
 * Directory that would hold the module of this path (module id without the `module:` prefix),
 * regardless of language or test-ness. Used to attach tests and docs to the module they live in.
 */
export function moduleDir(path: string): string | undefined {
  const segments = path.split('/');
  const root = sourceRoot(segments);
  if (root) {
    const depth = root.split('/').length;
    return segments.length > depth + 1 ? `${root}/${segments[depth]}` : root;
  }
  if (segments.length < 2) return undefined;
  if ((segments[0] === 'packages' || segments[0] === 'apps') && segments.length > 2) return `${segments[0]}/${segments[1]}`;
  return segments[0];
}

/** Module node id for a source file (tests and non-code files belong to no module). */
export function moduleOf(path: string): string | undefined {
  const posixPath = path.replaceAll('\\', '/');
  if (!isCodeLang(detectLang(posixPath)) || isTestPath(posixPath)) return undefined;
  const dir = moduleDir(posixPath);
  return dir === undefined ? undefined : `module:${dir}`;
}

export function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function moduleTitle(dir: string): string {
  const segments = dir.split('/');
  const name = humanize(segments[segments.length - 1]);
  return (segments[0] === 'packages' || segments[0] === 'apps') && segments.length > 1 && segments[1] !== name.toLowerCase()
    ? `${segments[1]} · ${name}`
    : name;
}
