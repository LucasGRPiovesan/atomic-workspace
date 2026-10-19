/**
 * @atomic/core domain contract.
 *
 * OWNED BY THE TECH LEAD. Workers must not change existing shapes; if a field
 * is missing, ask the coordinator. All paths are POSIX-style and relative to
 * the project root (e.g. "src/orders/service.ts").
 */

// ───────────────────────────── Deterministic index ─────────────────────────────

export type Lang =
  | 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'java' | 'rust'
  | 'csharp' | 'php' | 'ruby' | 'prisma' | 'sql' | 'markdown' | 'json' | 'yaml' | 'other';

export interface FileRecord {
  path: string;
  /** sha1 hex of file content */
  hash: string;
  lang: Lang;
  loc: number;
  size: number;
  isTest: boolean;
}

export type SymbolKind =
  | 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable' | 'component';

export interface SymbolRecord {
  /** `${path}#${name}@${startLine}` */
  id: string;
  path: string;
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive */
  startLine: number;
  endLine: number;
  exported: boolean;
  /** single-line signature, max 200 chars, e.g. "createOrder(input: OrderInput): Promise<Order>" */
  signature?: string;
  /** enclosing class name for methods */
  parent?: string;
}

export interface ImportRecord {
  /** importing file */
  from: string;
  /** raw specifier as written: "./service", "express", "app.models" */
  specifier: string;
  /** resolved project file path when the import is internal and resolvable */
  resolved?: string;
  /** imported names; ["*"] for namespace / side-effect imports use [] */
  names: string[];
  external: boolean;
  line: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ANY';

export type RouteFramework =
  | 'express' | 'fastify' | 'koa' | 'hono' | 'nest' | 'nextjs-app' | 'nextjs-pages'
  | 'fastapi' | 'flask' | 'django' | 'unknown';

export interface RouteRecord {
  /** `route:${method} ${pattern}` */
  id: string;
  path: string;
  line: number;
  method: HttpMethod;
  /** normalized pattern with ":param" segments, always starting with "/": "/orders/:id" */
  pattern: string;
  framework: RouteFramework;
  /** name of the handler symbol when statically identifiable */
  handler?: string;
  /** SymbolRecord.id of the handler when resolvable inside the same file */
  handlerSymbolId?: string;
}

export type EntitySource =
  | 'prisma' | 'sql' | 'typeorm' | 'sequelize' | 'mongoose' | 'drizzle' | 'sqlalchemy' | 'django' | 'other';

export interface EntityField {
  name: string;
  type: string;
  optional?: boolean;
  isId?: boolean;
}

export interface EntityRelation {
  field: string;
  /** target entity name */
  target: string;
  kind: '1-1' | '1-n' | 'n-1' | 'n-n' | 'unknown';
}

export interface EntityRecord {
  /** `entity:${name}` */
  id: string;
  name: string;
  source: EntitySource;
  path: string;
  line: number;
  fields: EntityField[];
  relations: EntityRelation[];
}

export interface TestRecord {
  path: string;
  line: number;
  /** full test title incl. suite: "OrderService > creates an order" */
  name: string;
  framework?: string;
}

export type IntegrationCategory =
  | 'payment' | 'database' | 'cache' | 'queue' | 'email' | 'auth' | 'storage'
  | 'http' | 'ai' | 'observability' | 'messaging' | 'search' | 'other';

export interface IntegrationEvidence {
  path: string;
  line?: number;
  /** e.g. "dependency stripe@^14" or "env STRIPE_SECRET_KEY" or "import 'stripe'" */
  detail: string;
}

export interface IntegrationRecord {
  /** `integration:${key}` */
  id: string;
  /** stable lowercase key, e.g. "stripe", "postgres", "redis", "openai" */
  key: string;
  name: string;
  category: IntegrationCategory;
  evidence: IntegrationEvidence[];
}

/** Everything extracted from a single source file. Pure function output. */
export interface FileExtraction {
  file: FileRecord;
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  routes: RouteRecord[];
  entities: EntityRecord[];
  tests: TestRecord[];
  /** env var names referenced (process.env.X, os.environ["X"], os.getenv("X")) */
  envVars: string[];
}

export interface RunScript {
  /** "dev", "start", ... */
  name: string;
  command: string;
  /** manifest it came from, e.g. "package.json" or "apps/web/package.json" */
  source: string;
  /** working directory relative to root ("" for root) */
  cwd: string;
}

export interface StackInfo {
  languages: { lang: Lang; files: number; loc: number }[];
  /** detected frameworks/libraries of note: "express", "react", "prisma", "next", "fastapi", "vitest" */
  frameworks: string[];
  packageManagers: string[];
  manifests: string[];
  scripts: RunScript[];
  /** integrations detectable from manifests / env templates alone */
  integrations: IntegrationRecord[];
  /** entities from schema files that are not per-file source (prisma, sql migrations) */
  entities: EntityRecord[];
}

// ───────────────────────────── Knowledge model ─────────────────────────────

export type NodeKind =
  | 'capability'   // business/system capability: "Checkout", "Authentication"
  | 'module'       // code module (deterministic grouping of files)
  | 'flow'         // functional flow: ordered steps across symbols
  | 'rule'         // business rule / invariant
  | 'entity'       // data model entity
  | 'integration'  // external service
  | 'route'        // HTTP/API entry point
  | 'component'    // notable component/service/class
  | 'test_suite'   // tests covering something
  | 'convention'   // coding convention / project practice
  | 'decision'     // architectural decision (ADR-like)
  | 'instruction'  // imported AI instruction (CLAUDE.md, AGENTS.md, cursor rules, skills)
  | 'note';

/** deterministic = computed from code; imported = from existing docs/AI config; agent = recorded by a coding agent; user = typed by the developer */
export type NodeOrigin = 'deterministic' | 'imported' | 'agent' | 'user';

/** fresh = anchors match current code; stale = an anchored file changed since recorded; unverified = recorded without anchors */
export type NodeStatus = 'fresh' | 'stale' | 'unverified';

export interface Anchor {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  /** FileRecord.hash at the time the anchor was recorded/verified */
  hash: string;
}

export interface FlowStep {
  order: number;
  title: string;
  path?: string;
  line?: number;
  symbol?: string;
  /** knowledge node this step passes through (route/component/entity...) */
  nodeId?: string;
}

export interface KnowledgeNode {
  /**
   * Stable id `${kind}:${slug}`. Deterministic ids:
   *   module:<dir path>          e.g. module:src/orders
   *   route:<METHOD> <pattern>   e.g. route:GET /orders/:id
   *   entity:<Name>              e.g. entity:Order
   *   integration:<key>          e.g. integration:stripe
   *   test_suite:<path>          e.g. test_suite:src/orders/service.test.ts
   *   instruction:<path>#<n>     e.g. instruction:CLAUDE.md#2
   */
  id: string;
  kind: NodeKind;
  title: string;
  /** 1–3 sentences; what the agent/developer needs first */
  summary: string;
  /** optional markdown detail */
  body?: string;
  /** kind-specific structured data. flow: { trigger?: string, steps: FlowStep[] } ; rule: { enforcedAt?: string } ; module: { files: number, loc: number } */
  data?: Record<string, unknown>;
  origin: NodeOrigin;
  status: NodeStatus;
  /** 0..1 */
  confidence: number;
  anchors: Anchor[];
  tags: string[];
  /** agent id that recorded it ("claude", "opencode", ...) when origin=agent */
  author?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating/updating nodes. status/timestamps are computed by the store. */
export type KnowledgeNodeInput =
  Omit<KnowledgeNode, 'status' | 'createdAt' | 'updatedAt' | 'confidence' | 'tags'> &
  Partial<Pick<KnowledgeNode, 'status' | 'confidence' | 'tags'>>;

export type RelKind =
  | 'contains'    // capability/module contains module/component/route
  | 'depends_on'  // module → module (imports)
  | 'implements'  // module/component/route implements capability/rule/flow
  | 'calls'
  | 'reads' | 'writes'  // → entity
  | 'tests'       // test_suite → module/component/capability
  | 'uses'        // → integration
  | 'exposes'     // module → route
  | 'step_of'     // node → flow
  | 'governs'     // rule/convention/instruction → anything
  | 'relates';

export interface KnowledgeEdge {
  from: string;
  to: string;
  rel: RelKind;
  origin: NodeOrigin;
}

export interface NodeFilter {
  kinds?: NodeKind[];
  status?: NodeStatus[];
  origin?: NodeOrigin[];
  /** only nodes having an anchor in one of these paths */
  paths?: string[];
  limit?: number;
}

export interface SearchHit {
  type: 'node' | 'symbol';
  id: string;
  kind: NodeKind | SymbolKind;
  title: string;
  /** node summary or symbol signature */
  snippet: string;
  path?: string;
  line?: number;
  score: number;
}

// ───────────────────────────── Changes ─────────────────────────────

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

export interface ChangeSet {
  id: string;
  at: string;
  /** agent = observed during an agent session; external = file watcher outside a session */
  source: 'agent' | 'external' | 'index';
  sessionId?: string;
  agentId?: string;
  files: FileChange[];
  /** nodes whose anchors/derived membership include a changed file */
  affectedNodes: string[];
  /** nodes that transitioned to stale because of this change */
  staleNodes: string[];
  summary?: string;
}

// ───────────────────────────── Imported AI configuration ─────────────────────────────

export type AiTool =
  | 'claude' | 'codex' | 'cursor' | 'gemini' | 'copilot' | 'windsurf' | 'opencode' | 'cline' | 'generic';

export type AiSourceKind =
  | 'instructions' | 'rules' | 'skill' | 'agent' | 'command' | 'mcp' | 'docs' | 'adr';

export interface SourceSection {
  heading: string;
  text: string;
  startLine: number;
  endLine: number;
}

export interface ImportedSource {
  path: string;
  tool: AiTool;
  kind: AiSourceKind;
  hash: string;
  title: string;
  sections: SourceSection[];
}

// ───────────────────────────── Context delivery ─────────────────────────────

export interface ContextPack {
  task: string;
  budgetTokens: number;
  /** ceil(chars / 4) of `text` */
  estimatedTokens: number;
  nodeIds: string[];
  files: { path: string; startLine?: number; endLine?: number; reason: string }[];
  /** section titles included, in order */
  sections: string[];
  /** rendered compact markdown handed to the agent */
  text: string;
}

export interface MemoryStats {
  files: number;
  symbols: number;
  routes: number;
  entities: number;
  tests: number;
  nodesByKind: Partial<Record<NodeKind, number>>;
  nodesByOrigin: Partial<Record<NodeOrigin, number>>;
  stale: number;
  lastIndexedAt?: string;
  lastIndexMs?: number;
  /** sum(file.size)/4 over indexed files: what a blind re-read would cost */
  estimatedRepoTokens: number;
  contextServed: { count: number; tokens: number };
  /** deterministic structure no capability/flow describes yet (findUnmapped); filled by the host, not the store */
  unmapped?: { modules: number; routes: number; entities: number };
}

// ───────────────────────────── Graph views (for UI) ─────────────────────────────

export type GraphView = 'system' | 'data' | 'flow' | 'neighborhood';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  sublabel?: string;
  status: NodeStatus;
  origin: NodeOrigin;
  /** small counters shown on the node: { routes: 3, entities: 2, tests: 5 } */
  badges?: Record<string, number>;
  /** touched by the most recent change sets */
  changed?: boolean;
  parent?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: RelKind;
  /** e.g. number of imports collapsed into this module edge */
  weight?: number;
}

export interface GraphData {
  view: GraphView;
  focus?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
