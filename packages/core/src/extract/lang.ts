import { posix } from 'node:path';
import type { DetectLang, IsTestPath } from '../contracts.js';
import type { Lang } from '../types.js';

const extensions: Record<string, Lang> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', go: 'go', java: 'java', rs: 'rust', cs: 'csharp',
  php: 'php', rb: 'ruby', prisma: 'prisma', sql: 'sql', md: 'markdown', mdx: 'markdown',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml',
};
export const detectLang: DetectLang = path => extensions[posix.extname(path.replaceAll('\\', '/')).slice(1).toLowerCase()] ?? 'other';
export const isTestPath: IsTestPath = path => /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|(?:^|\/)test_[^/]+\.py$|(?:\.test|\.spec)\.[^/]+$|_test\.go$|Test\.java$/i.test(path.replaceAll('\\', '/'));
