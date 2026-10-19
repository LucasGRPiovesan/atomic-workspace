/**
 * Main ⇄ renderer contract. OWNED BY THE TECH LEAD.
 *
 * The preload exposes `window.atomic: AtomicApi` via contextBridge.
 * Request/response calls use ipcRenderer.invoke(channel, ...args) where
 * channel = `${namespace}:${method}` (e.g. "memory:getNode").
 * Push events use the channels in `EventChannels`.
 *
 * Agent updates are forwarded VERBATIM from ACP (`SessionUpdate`) — the UI renders
 * the agent's own structured output; no translation layer and no extra LLM calls.
 */
import type {
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type {
  ChangeSet, ContextPack, GraphData, GraphView, ImportedSource, KnowledgeEdge, KnowledgeNode,
  MemoryStats, NodeFilter, RunScript, SearchHit, StackInfo, SymbolRecord, TestRecord,
} from '@atomic/core/types';

export type AcpSessionUpdate = SessionNotification['update'];

// ───────────────────────────── Project ─────────────────────────────

export interface ProjectSummary {
  root: string;
  name: string;
  isGit: boolean;
  stack?: StackInfo;
  stats: MemoryStats;
  /** true when the deep (agent-recorded) knowledge layer is empty → UI offers "Build understanding" */
  needsBootstrap: boolean;
  /** AI configuration sources found in the project (CLAUDE.md, AGENTS.md, .cursor/rules, skills...) */
  aiSources: Pick<ImportedSource, 'path' | 'tool' | 'kind' | 'title'>[];
}

export interface RecentProject {
  root: string;
  name: string;
  openedAt: string;
}

export interface IndexProgressEvent {
  phase: 'scan' | 'extract' | 'derive' | 'import' | 'done';
  done: number;
  total: number;
  message?: string;
}

// ───────────────────────────── Memory ─────────────────────────────

export interface NodeDetail {
  node: KnowledgeNode;
  outgoing: (KnowledgeEdge & { target?: Pick<KnowledgeNode, 'id' | 'kind' | 'title' | 'status'> })[];
  incoming: (KnowledgeEdge & { source?: Pick<KnowledgeNode, 'id' | 'kind' | 'title' | 'status'> })[];
  /** symbols inside the node's anchors / module files (max 50) */
  symbols: SymbolRecord[];
  tests: TestRecord[];
  /** recent change sets that touched this node (max 10) */
  changes: ChangeSet[];
}

export interface FileContent {
  path: string;
  content: string;
  lang: string;
  /** false when the file is larger than the viewer limit (content truncated) */
  complete: boolean;
}

// ───────────────────────────── Agents ─────────────────────────────

export interface AgentInfo {
  /** "claude" | "codex" | "opencode" | "gemini" | custom id */
  id: string;
  name: string;
  available: boolean;
  /** why unavailable / how it is launched */
  detail: string;
}

export interface AgentSessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  /** ACP session modes if the agent exposes them */
  modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string | null }[] };
  /** ACP agent capabilities summary */
  supportsImages: boolean;
  supportsLoadSession: boolean;
}

export type AgentSessionState = 'starting' | 'ready' | 'prompting' | 'error' | 'closed';

export type PromptTemplate = 'bootstrap' | 'refresh-stale';

export interface PromptOptions {
  /** prepend a memory context pack (default true). Session-level dedupe: nodes already sent are excluded. */
  attachContext?: boolean;
  budgetTokens?: number;
}

export type AgentEvent =
  | { type: 'update'; sessionId: string; update: AcpSessionUpdate }
  | { type: 'permission'; sessionId: string; requestId: string; request: RequestPermissionRequest }
  | { type: 'permission-resolved'; sessionId: string; requestId: string; optionId: string | null }
  | { type: 'state'; sessionId: string; state: AgentSessionState; error?: string; stopReason?: string }
  /** what the Workspace attached to the user's prompt (shown to the developer for transparency) */
  | { type: 'context'; sessionId: string; pack: Pick<ContextPack, 'estimatedTokens' | 'nodeIds' | 'sections' | 'text'> }
  /** the user's own prompt, echoed so the timeline is complete */
  | { type: 'user'; sessionId: string; text: string; at: string }
  | { type: 'stderr'; sessionId: string; line: string };

// ───────────────────────────── Application (running app) ─────────────────────────────

export interface AppRunStatus {
  state: 'stopped' | 'starting' | 'running' | 'exited' | 'error';
  script?: RunScript;
  /** detected local URL (first http://localhost:PORT seen in output) */
  url?: string;
  pid?: number;
  exitCode?: number | null;
}

export interface AppLogLine {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  at: string;
}

export interface TraceMatch {
  routeNodeId: string;
  pattern: string;
  handler?: { path: string; line: number; symbol?: string };
  /** capability / module / flow / entity / integration nodes connected to the route */
  related: Pick<KnowledgeNode, 'id' | 'kind' | 'title'>[];
}

export interface TraceEvent {
  id: string;
  at: string;
  kind: 'request' | 'navigation' | 'click' | 'console';
  method?: string;
  url?: string;
  /** URL path only, e.g. /api/orders/42 */
  pathname?: string;
  status?: number;
  durationMs?: number;
  /** click: element text/selector; console: message */
  text?: string;
  /** groups requests caused by one user interaction (click/navigation id) */
  interactionId?: string;
  match?: TraceMatch;
}

// ───────────────────────────── API surface ─────────────────────────────

export interface AtomicApi {
  project: {
    pickFolder(): Promise<string | null>;
    open(root: string): Promise<ProjectSummary>;
    current(): Promise<ProjectSummary | null>;
    recent(): Promise<RecentProject[]>;
    reindex(): Promise<ProjectSummary>;
  };
  memory: {
    stats(): Promise<MemoryStats>;
    listNodes(filter?: NodeFilter): Promise<KnowledgeNode[]>;
    getNode(id: string): Promise<NodeDetail | null>;
    search(query: string): Promise<SearchHit[]>;
    graph(view: GraphView, focus?: string): Promise<GraphData>;
    changes(limit?: number): Promise<ChangeSet[]>;
    readFile(path: string): Promise<FileContent | null>;
    /** preview of what would be attached for a task (no side effects) */
    previewContext(task: string, budgetTokens?: number): Promise<ContextPack>;
    impact(paths: string[]): Promise<{ nodes: KnowledgeNode[]; tests: TestRecord[] }>;
    sources(): Promise<ImportedSource[]>;
    /** developer-authored note/rule pinned to the project memory */
    addNote(input: { kind: 'note' | 'rule' | 'decision' | 'convention'; title: string; summary: string; anchors?: { path: string; startLine?: number; endLine?: number }[] }): Promise<KnowledgeNode>;
    markVerified(id: string): Promise<KnowledgeNode | null>;
  };
  agents: {
    list(): Promise<AgentInfo[]>;
    start(agentId: string): Promise<AgentSessionInfo>;
    prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<{ stopReason: string }>;
    /** returns the text of a built-in prompt (bootstrap understanding, refresh stale knowledge) */
    template(kind: PromptTemplate): Promise<string>;
    cancel(sessionId: string): Promise<void>;
    setMode(sessionId: string, modeId: string): Promise<void>;
    respondPermission(requestId: string, optionId: string | null): Promise<void>;
    close(sessionId: string): Promise<void>;
  };
  app: {
    scripts(): Promise<RunScript[]>;
    start(scriptName: string): Promise<AppRunStatus>;
    stop(): Promise<AppRunStatus>;
    status(): Promise<AppRunStatus>;
    /** renderer reports interactions captured inside the app webview */
    reportInteraction(e: { kind: 'click' | 'navigation'; text?: string; url?: string }): Promise<TraceEvent>;
    /** absolute path of the webview preload script that captures clicks/navigation */
    webviewPreloadPath(): Promise<string>;
  };
  /** subscribe to push events; returns unsubscribe */
  on<K extends keyof EventPayloads>(channel: K, cb: (payload: EventPayloads[K]) => void): () => void;
}

export interface EventPayloads {
  'index:progress': IndexProgressEvent;
  'project:changed': ProjectSummary;
  'memory:changed': ChangeSet;
  'agent:event': AgentEvent;
  'app:status': AppRunStatus;
  'app:log': AppLogLine;
  'app:trace': TraceEvent;
}

export const EventChannels = [
  'index:progress', 'project:changed', 'memory:changed', 'agent:event', 'app:status', 'app:log', 'app:trace',
] as const satisfies readonly (keyof EventPayloads)[];

/** Partition used by the Application webview; main hooks its session.webRequest for tracing. */
export const APP_PARTITION = 'persist:atomic-app';

declare global {
  interface Window {
    atomic: AtomicApi;
  }
}
