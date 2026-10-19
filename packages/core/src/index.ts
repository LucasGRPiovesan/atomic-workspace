// Public surface of @atomic/core. OWNED BY THE TECH LEAD — module boundaries are declared in contracts.ts.
export type * from './types.js';
export type * from './contracts.js';
export { extractFile, detectLang, isTestPath } from './extract/index.js';
export { detectStack, parsePrismaSchema, parseSqlSchema } from './detect/index.js';
export { importAiConfig, sourcesToNodes } from './importer/index.js';
export { openStore } from './store/index.js';
export { createIndexer, scanFiles, moduleOf } from './indexer/index.js';
export { buildGraph } from './graph/index.js';
export { buildOverview, buildContext, impactOf, findUnmapped, estimateTokens } from './context/index.js';
export { startMcpServer, createMcpServer } from './mcp/index.js';
