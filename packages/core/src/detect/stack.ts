import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import type { DetectStack } from '../contracts.js';
import type { IntegrationCategory, IntegrationRecord, Lang, StackInfo } from '../types.js';
import { parsePrismaSchema, parseSqlSchema } from './schema.js';

const frameworks = ['express', 'fastify', '@nestjs/core', 'next', 'react', 'vue', 'svelte', '@angular/core', 'vite', 'prisma', '@prisma/client', 'typeorm', 'mongoose', 'sequelize', 'drizzle-orm', 'fastapi', 'django', 'flask', 'gin', 'echo', 'chi', 'spring', 'rails', 'laravel', 'hono', 'koa', 'vitest', 'jest', 'pytest'];
const integrations: [RegExp, string, string, IntegrationCategory][] = [
  [/^stripe$/, 'stripe', 'Stripe', 'payment'], [/^@aws-sdk\//, 'aws', 'AWS', 'storage'],
  [/^(pg|psycopg\w*|postgres|postgresql)$/, 'postgres', 'PostgreSQL', 'database'], [/^(mysql2?|pymysql)$/, 'mysql', 'MySQL', 'database'],
  [/^(mongodb|mongoose|pymongo)$/, 'mongodb', 'MongoDB', 'database'], [/^(redis|ioredis)$/, 'redis', 'Redis', 'cache'],
  [/^openai$/, 'openai', 'OpenAI', 'ai'], [/^(@anthropic-ai\/sdk|anthropic)$/, 'anthropic', 'Anthropic', 'ai'],
  [/^nodemailer$/, 'smtp', 'SMTP', 'email'], [/^@sendgrid\//, 'sendgrid', 'SendGrid', 'email'], [/^twilio$/, 'twilio', 'Twilio', 'messaging'],
  [/^firebase(?:-admin)?$/, 'firebase', 'Firebase', 'auth'], [/^@supabase\//, 'supabase', 'Supabase', 'database'],
];
const manifestPattern = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements(?:[^/]*)\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|Gemfile|[^/]+\.csproj)$/;
const lockManagers: Record<string, string> = { 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun', 'poetry.lock': 'poetry', 'uv.lock': 'uv', 'Pipfile.lock': 'pipenv', 'Cargo.lock': 'cargo', 'go.sum': 'go', 'composer.lock': 'composer', 'Gemfile.lock': 'bundler' };

export const detectStack: DetectStack = async (root, files) => {
  const result: StackInfo = { languages: [], frameworks: [], packageManagers: [], manifests: [], scripts: [], integrations: [], entities: [] };
  const counts = new Map<Lang, { lang: Lang; files: number; loc: number }>();
  const foundFrameworks = new Set<string>();
  const managers = new Set<string>();
  const services = new Map<string, IntegrationRecord>();
  const addDependency = (dependency: string, version: string, path: string) => {
    const lower = dependency.toLowerCase();
    for (const framework of frameworks) {
      if (lower === framework || (['gin', 'echo', 'chi', 'spring', 'rails', 'laravel'].includes(framework) && lower.includes(framework))) foundFrameworks.add(framework === '@nestjs/core' ? 'nest' : framework === '@prisma/client' ? 'prisma' : framework === '@angular/core' ? 'angular' : framework);
    }
    for (const [pattern, key, name, category] of integrations) {
      if (!pattern.test(lower)) continue;
      const service = services.get(key) ?? { id: `integration:${key}`, key, name, category, evidence: [] };
      const detail = `dependency ${dependency}${version ? '@' + version : ''}`;
      if (!service.evidence.some(e => e.path === path && e.detail === detail)) service.evidence.push({ path, detail });
      services.set(key, service);
    }
  };
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const count = counts.get(file.lang) ?? { lang: file.lang, files: 0, loc: 0 };
    count.files++; count.loc += file.loc; counts.set(file.lang, count);
    const path = file.path.replaceAll('\\', '/');
    const name = basename(path);
    if (lockManagers[name]) managers.add(lockManagers[name]);
    const manifest = manifestPattern.test(path);
    if (manifest) result.manifests.push(path);
    if (!manifest && name !== 'Makefile' && !/\.(prisma|sql)$/.test(path)) continue;
    const absolute = resolve(root, path);
    const base = resolve(root);
    if (!absolute.startsWith(base + sep)) continue;
    let source: string;
    try { source = await readFile(absolute, 'utf8'); } catch { continue; }
    if (path.endsWith('.prisma')) { result.entities.push(...parsePrismaSchema(source, path)); continue; }
    if (path.endsWith('.sql')) { result.entities.push(...parseSqlSchema(source, path)); continue; }
    const cwd = dirname(path).replaceAll('\\', '/').replace(/^\.$/, '');
    const script = (name: string, command: string) => result.scripts.push({ name, command, source: path, cwd });
    if (name === 'package.json' || name === 'composer.json') {
      try {
        const json: unknown = JSON.parse(source);
        if (!json || typeof json !== 'object') continue;
        const data = json as Record<string, unknown>;
        for (const section of name === 'composer.json' ? ['require', 'require-dev'] : ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const dependencies = data[section];
          if (dependencies && typeof dependencies === 'object') for (const [dep, version] of Object.entries(dependencies)) addDependency(dep, String(version), path);
        }
        if (name === 'package.json') {
          if (typeof data.packageManager === 'string') managers.add(data.packageManager.split('@')[0]);
          if (data.scripts && typeof data.scripts === 'object') for (const [key, command] of Object.entries(data.scripts)) if (typeof command === 'string') script(key, command);
        }
      } catch { /* Keep other manifests when one is malformed. */ }
    } else if (name === 'Makefile') {
      for (const match of source.matchAll(/^([\w.-]+)\s*:(?!=)/gm)) if (!match[1].startsWith('.')) script(match[1], `make ${match[1]}`);
    } else {
      if (name === 'pyproject.toml') {
        let section = '';
        for (const line of source.split(/\r?\n/)) {
          const header = line.match(/^\s*\[([^\]]+)\]/);
          if (header) section = header[1];
          const entry = line.match(/^\s*([\w.-]+)\s*=\s*["']([^"']+)["']/);
          if (entry && /^(?:project\.scripts|tool\.poetry\.scripts)$/.test(section)) script(entry[1], entry[2]);
          else if (entry && /dependencies/.test(section)) addDependency(entry[1], entry[2], path);
        }
      }
      for (const match of source.matchAll(/["']([@\w][\w@./-]*)(?:\[[^\]]*\])?(?:[<>=!~^ ]+([^"']*))?["']/g)) addDependency(match[1], match[2] ?? '', path);
      for (const line of source.split(/\r?\n/)) {
        const dep = line.match(/^\s*([\w][\w./-]*)(?:\[[^\]]*\])?(?:\s*(?:==|>=|<=|~=|=|>|<|\s)\s*(.*))?$/);
        if (dep) addDependency(dep[1], dep[2] ?? '', path);
      }
      for (const match of source.matchAll(/<(?:artifactId|PackageReference\s+Include=)[>"']([^<"']+)/g)) addDependency(match[1], '', path);
    }
  }
  result.languages = [...counts.values()].sort((a, b) => a.lang.localeCompare(b.lang));
  result.frameworks = [...foundFrameworks].sort();
  result.packageManagers = [...managers].sort();
  result.integrations = [...services.values()].sort((a, b) => a.key.localeCompare(b.key));
  return result;
};
