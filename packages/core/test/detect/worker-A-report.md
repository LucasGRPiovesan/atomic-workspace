# Worker A verification

Implemented deterministic, database-free extraction and stack detection within the assigned ownership paths.

## Verification

- From `packages/core`: `npx vitest run test/extract test/detect` — 41 tests passed across 3 files.
- From the repository root: `npx tsc -p packages/core/tsconfig.json` — exit 0, no diagnostics.
- `git diff --check -- packages/core/src/extract packages/core/src/detect packages/core/test/extract packages/core/test/detect` — no whitespace diagnostics; these newly created directories are untracked, so this command alone does not validate their contents.
- Warm synthetic 300-line TypeScript module: final observed mean 11.47 ms across 20 extractions, with assertions that all 100 functions were extracted. This is a measured sample, not a latency guarantee; earlier runs before and during optimization measured 14.54–23.68 ms.

## Implemented behavior

- Lazy package-shipped WASM runtime, cached language/parser/query instances, and `ATOMIC_WASM_DIR` override.
- Per-language symbol/import queries for TypeScript, TSX, JavaScript/JSX, Python, Go, Java, C#, PHP, Ruby, and Rust.
- Stable symbol ids, class method parents, exports, TSX components, import resolution including index files and `.js` to `.ts`.
- Express-style routes, same-file router mounts and chained routes; Fastify/Koa/Hono identification; NestJS; Next.js app/pages; Flask/FastAPI; Go routers/http; Spring annotations.
- TypeORM, Mongoose, Sequelize, Drizzle, SQLAlchemy, and Django entities; Prisma and SQL schema parsing.
- Vitest/Jest/Mocha, pytest, Go and JUnit test names, plus supported environment variable access syntax.
- Manifest/lockfile language and framework detection, workspace scripts, Makefile/pyproject scripts, dependency evidence for integrations, and project-level schema entities.
- All required acceptance cases plus representative symbol/import checks in every supported grammar, malformed input, concurrency/determinism, TSX, Spring, JUnit, Next.js pages, SQLAlchemy, and Django.

## API details and limits

- `extractFile`, `detectLang`, `isTestPath`, and `detectStack` implement the existing contract signatures.
- Schema functions support `(source, projectPath?)` and `(projectPath, source)`; default paths are `schema.prisma` and `schema.sql`.
- Static extraction is best-effort: computed routes/import specifiers, dynamic ORM configuration, complex schema syntax, and cross-file route mounts cannot be fully resolved. Go and Spring routes use the contract's `unknown` framework because those frameworks are absent from its union.
- Prisma parsing expects conventional one-field-per-line formatting; SQL handles `CREATE TABLE` definitions and references, not later `ALTER TABLE` changes.
- Manifest parsing outside JSON is deliberately lightweight and does not evaluate build tools or configuration code. Tests cover the required Node manifest scenario; other ecosystem manifest formats have implementation coverage but are not all individually exercised.
- No contract edits, dependency installations, git mutations, or edits outside assigned ownership were performed.

## Created files

- `packages/core/src/extract/ast.ts`
- `packages/core/src/extract/entities.ts`
- `packages/core/src/extract/index.ts`
- `packages/core/src/extract/lang.ts`
- `packages/core/src/extract/parser.ts`
- `packages/core/src/extract/routes.ts`
- `packages/core/src/extract/langs/typescript.ts`
- `packages/core/src/extract/langs/python.ts`
- `packages/core/src/extract/langs/go.ts`
- `packages/core/src/extract/langs/java.ts`
- `packages/core/src/extract/langs/csharp.ts`
- `packages/core/src/extract/langs/php.ts`
- `packages/core/src/extract/langs/ruby.ts`
- `packages/core/src/extract/langs/rust.ts`
- `packages/core/src/detect/schema.ts`
- `packages/core/src/detect/stack.ts`
- `packages/core/src/detect/index.ts`
- `packages/core/test/extract/extract.test.ts`
- `packages/core/test/extract/performance.test.ts`
- `packages/core/test/detect/detect.test.ts`
- `packages/core/test/detect/worker-A-report.md`
