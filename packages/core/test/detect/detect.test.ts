import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectStack, parsePrismaSchema, parseSqlSchema } from '../../src/detect/index.js';
import { detectLang } from '../../src/extract/index.js';
import type { FileRecord } from '../../src/types.js';

describe('schema detection', () => {
  it('parses Prisma fields, ids, optional values and both sides of relations', () => {
    const source = `model User {
 id Int @id @default(autoincrement())
 email String?
 orders Order[]
}
model Order {
 id Int @id
 userId Int
 user User @relation(fields: [userId], references: [id])
}`;
    const entities = parsePrismaSchema(source, 'prisma/schema.prisma');
    expect(entities[0]).toMatchObject({ name: 'User', path: 'prisma/schema.prisma', line: 1, relations: [{ field: 'orders', target: 'Order', kind: '1-n' }] });
    expect(entities[0].fields).toContainEqual(expect.objectContaining({ name: 'id', isId: true }));
    expect(entities[0].fields).toContainEqual(expect.objectContaining({ name: 'email', optional: true }));
    expect(entities[1].relations).toEqual([{ field: 'user', target: 'User', kind: 'n-1' }]);
    expect(parsePrismaSchema('prisma/schema.prisma', source)).toEqual(entities);
  });
  it('parses SQL tables, nested field types, primary keys and references', () => {
    const entities = parseSqlSchema(`CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL);
CREATE TABLE orders (
 id INTEGER,
 user_id INTEGER NOT NULL REFERENCES users(id),
 total DECIMAL(10, 2),
 PRIMARY KEY (id),
 FOREIGN KEY (user_id) REFERENCES users(id)
);`, 'migrations/init.sql');
    expect(entities).toHaveLength(2);
    expect(entities[1]).toMatchObject({ name: 'orders', source: 'sql', path: 'migrations/init.sql' });
    expect(entities[1].fields).toContainEqual(expect.objectContaining({ name: 'total', type: 'DECIMAL(10, 2)' }));
    expect(entities[1].fields).toContainEqual(expect.objectContaining({ name: 'id', isId: true, optional: false }));
    expect(entities[1].relations).toContainEqual({ field: 'user_id', target: 'users', kind: 'n-1' });
  });
  it('tolerates malformed schemas', () => {
    expect(parsePrismaSchema('model Broken {')).toEqual([]);
    expect(parseSqlSchema('CREATE TABLE broken ( id INT')).toHaveLength(1);
  });
});

describe('stack detection', () => {
  it('reads workspace manifests, scripts, locks, integrations and schema entities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-detect-'));
    const sources: Record<string, string> = {
      'package.json': JSON.stringify({ dependencies: { express: '^5', prisma: '^6', stripe: '^14' }, scripts: { dev: 'tsx src/server.ts', test: 'vitest' } }),
      'package-lock.json': '{}',
      'apps/web/package.json': JSON.stringify({ dependencies: { react: '^19', '@aws-sdk/client-s3': '^3' }, scripts: { dev: 'vite' } }),
      'schema.prisma': 'model User {\n id Int @id\n}',
      'Makefile': 'build:\n\techo build\n',
      'src/server.ts': 'export const app = 1;',
      'broken/package.json': '{',
    };
    try {
      const files: FileRecord[] = [];
      for (const [path, source] of Object.entries(sources)) {
        await mkdir(join(root, path, '..'), { recursive: true });
        await writeFile(join(root, path), source);
        files.push({ path, hash: '', lang: detectLang(path), loc: source.split('\n').length, size: source.length, isTest: false });
      }
      const stack = await detectStack(root, files);
      expect(stack.frameworks).toEqual(['express', 'prisma', 'react']);
      expect(stack.packageManagers).toEqual(['npm']);
      expect(stack.manifests).toContain('apps/web/package.json');
      expect(stack.scripts).toEqual(expect.arrayContaining([
        { name: 'dev', command: 'tsx src/server.ts', source: 'package.json', cwd: '' },
        { name: 'test', command: 'vitest', source: 'package.json', cwd: '' },
        { name: 'dev', command: 'vite', source: 'apps/web/package.json', cwd: 'apps/web' },
        { name: 'build', command: 'make build', source: 'Makefile', cwd: '' },
      ]));
      expect(stack.integrations).toContainEqual(expect.objectContaining({ key: 'stripe', category: 'payment', evidence: [{ path: 'package.json', detail: 'dependency stripe@^14' }] }));
      expect(stack.integrations).toContainEqual(expect.objectContaining({ key: 'aws' }));
      expect(stack.entities).toContainEqual(expect.objectContaining({ name: 'User', source: 'prisma' }));
      expect(stack.languages).toContainEqual({ lang: 'typescript', files: 1, loc: 1 });
      expect(await detectStack(root, files.reverse())).toEqual(stack);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
