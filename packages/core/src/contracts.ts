/**
 * Module boundaries inside @atomic/core. OWNED BY THE TECH LEAD.
 * Each module implements exactly the exports declared here so that modules
 * can be built in parallel and wired without negotiation.
 *
 *   extract/   → extractFile, detectLang, isTestPath          (pure, no I/O)
 *   detect/    → detectStack                                  (reads manifests)
 *   importer/  → importAiConfig, sourcesToNodes               (reads AI config files)
 *   store/     → openStore → MemoryStore                      (node:sqlite)
 *   indexer/   → createIndexer → Indexer                      (scan, incremental, derived graph, watch)
 *   context/   → buildContext, buildOverview, impactOf        (deterministic context composer)
 *   graph/     → buildGraph                                   (UI graph projections)
 *   mcp/       → startMcpServer                               (agent-facing tools over stdio)
 */
import type {
  ChangeSet, ContextPack, EntityRecord, FileExtraction, FileRecord, GraphData, GraphView,
  ImportRecord, ImportedSource, IntegrationRecord, KnowledgeEdge, KnowledgeNode, KnowledgeNodeInput,
  Lang, MemoryStats, NodeFilter, RelKind, RouteRecord, SearchHit, StackInfo, SymbolRecord, TestRecord,
} from './types.js';

// ── extract/ ──────────────────────────────────────────────────────────────
export type ExtractFile = (
  path: string,
  content: string,
  /** project-relative paths of all indexed files, used to resolve relative imports */
  knownFiles: ReadonlySet<string>,
) => Promise<Omit<FileExtraction, 'file'> & { lang: Lang; isTest: boolean }>;
export type DetectLang = (path: string) => Lang;
export type IsTestPath = (path: string) => boolean;

// ── detect/ ───────────────────────────────────────────────────────────────
export type DetectStack = (root: string, files: readonly FileRecord[]) => Promise<StackInfo>;

// ── importer/ ─────────────────────────────────────────────────────────────
export type ImportAiConfig = (root: string) => Promise<ImportedSource[]>;
/** Maps sources to `instruction` / `convention` / `decision` nodes (origin=imported), anchored with line ranges and source hash. */
export type SourcesToNodes = (sources: readonly ImportedSource[]) => KnowledgeNodeInput[];

// ── store/ ────────────────────────────────────────────────────────────────
export interface MemoryStore {
  readonly root: string;
  /** absolute path of the sqlite file (<root>/.atomic/memory.db) */
  readonly dbPath: string;

  transaction<T>(fn: () => T): T;
  close(): void;

  // index
  upsertExtraction(ex: FileExtraction): void;
  removeFile(path: string): void;
  getFile(path: string): FileRecord | undefined;
  listFiles(): FileRecord[];
  fileHashes(): Map<string, string>;
  symbolsInFile(path: string): SymbolRecord[];
  findSymbols(name: string, limit?: number): SymbolRecord[];
  getSymbol(id: string): SymbolRecord | undefined;
  imports(filter?: { from?: string; resolved?: string }): ImportRecord[];
  routes(): RouteRecord[];
  entities(): EntityRecord[];
  /** replaces project-level entities (from prisma/sql schemas detected by detectStack) */
  setSchemaEntities(entities: EntityRecord[]): void;
  tests(path?: string): TestRecord[];
  integrations(): IntegrationRecord[];
  setIntegrations(items: IntegrationRecord[]): void;
  envVars(): { name: string; path: string }[];

  // knowledge
  upsertNode(input: KnowledgeNodeInput): KnowledgeNode;
  getNode(id: string): KnowledgeNode | undefined;
  listNodes(filter?: NodeFilter): KnowledgeNode[];
  deleteNode(id: string): void;
  /** delete all nodes (and their edges) with the given origin and optional kinds — used to rebuild deterministic layer */
  deleteNodesByOrigin(origin: KnowledgeNode['origin'], kinds?: KnowledgeNode['kind'][]): void;
  upsertEdge(edge: KnowledgeEdge): void;
  deleteEdges(filter: { from?: string; to?: string; rel?: RelKind; origin?: KnowledgeNode['origin'] }): void;
  edges(filter?: { from?: string; to?: string; rel?: RelKind }): KnowledgeEdge[];
  /** FTS5 search over node title/summary/body/tags and symbol names */
  search(query: string, opts?: { kinds?: string[]; limit?: number }): SearchHit[];
  /**
   * For every non-deterministic node anchored to `path` whose anchor hash !== newHash
   * (or newHash === null for deleted files) set status='stale'. Returns ids that changed to stale.
   */
  markStaleForFile(path: string, newHash: string | null): string[];
  /** re-hash anchors from current file records and set status fresh */
  markVerified(id: string): KnowledgeNode | undefined;

  // changes & sessions
  recordChange(cs: ChangeSet): void;
  listChanges(limit?: number): ChangeSet[];
  /** accounting for MemoryStats.contextServed */
  recordContextServed(tokens: number): void;

  // meta
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  stats(): MemoryStats;
}
export type OpenStore = (root: string) => MemoryStore;

// ── indexer/ ──────────────────────────────────────────────────────────────
export interface IndexProgress {
  phase: 'scan' | 'extract' | 'derive' | 'import' | 'done';
  done: number;
  total: number;
  message?: string;
}

export interface Indexer {
  /** Full pass: re-extracts only files whose hash changed; rebuilds the deterministic layer; imports AI config. */
  sync(onProgress?: (p: IndexProgress) => void): Promise<ChangeSet>;
  /** Incremental pass for specific paths (from watcher or an agent tool call). */
  apply(paths: string[], meta?: { source: ChangeSet['source']; sessionId?: string; agentId?: string }): Promise<ChangeSet>;
  /** Start a debounced fs watcher; calls onChange with each resulting ChangeSet. Returns stop(). */
  watch(onChange: (cs: ChangeSet) => void, meta?: () => { source: ChangeSet['source']; sessionId?: string; agentId?: string }): () => void;
  stack(): StackInfo | undefined;
}
export type CreateIndexer = (store: MemoryStore) => Indexer;

// ── context/ ──────────────────────────────────────────────────────────────
export type BuildContext = (
  store: MemoryStore,
  task: string,
  opts?: { budgetTokens?: number; excludeNodeIds?: readonly string[] },
) => ContextPack;
/** Compact project brief (stack, modules/capabilities, conventions, memory status). Target ≤ 800 tokens. */
export type BuildOverview = (store: MemoryStore, opts?: { budgetTokens?: number }) => ContextPack;
/** Nodes (capabilities, modules, flows, routes, entities, tests) impacted by changing these paths. */
export type ImpactOf = (store: MemoryStore, paths: readonly string[]) => { nodes: KnowledgeNode[]; tests: TestRecord[] };

// ── graph/ ────────────────────────────────────────────────────────────────
export type BuildGraph = (
  store: MemoryStore,
  view: GraphView,
  opts?: { focus?: string; changedNodeIds?: readonly string[] },
) => GraphData;

// ── mcp/ ──────────────────────────────────────────────────────────────────
export type StartMcpServer = (opts: { root: string; agentId?: string }) => Promise<void>;
