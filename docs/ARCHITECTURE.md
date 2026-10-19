# Atomic Workspace — Architecture

> Developer → **Workspace** ← AI agent. The Workspace is the operational bridge between the
> developer, a real coding agent, and the software. It is not an AI and does not replace the agent.

## 1. Decisions (and why)

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D1 | **Electron 44 + electron-vite 6 + React 19 + TS** | All integration surfaces (ACP adapters, MCP SDK, tree-sitter WASM, `node:sqlite`) are Node-native. No Rust toolchain on target machines. Zero native compiled deps. | Tauri (needs Rust + sidecar Node anyway for ACP adapters/MCP) |
| D2 | **Agent Client Protocol (ACP) for every agent** | Open standard (Apache-2.0) for editor⇄agent. Agents stay *real agents* on the real directory, with their own tools, auth and config. Structured stream (messages, tool calls, diffs, plans, permissions, modes, usage) → rich UI with **zero extra tokens**. OpenCode native (`opencode acp`), Claude (`@agentclientprotocol/claude-agent-acp`), Codex (`@agentclientprotocol/codex-acp`), Gemini (`gemini --experimental-acp`), any custom ACP command. | Scraping terminals (lossy), calling model APIs directly (turns agent into chatbot, violates invariants 1/12) |
| D3 | **Project memory = SQLite (+FTS5) at `<project>/.atomic/memory.db`**, auto-excluded via `.git/info/exclude` | Local-first, single file, transactional, fast incremental updates, full-text search. `.git/info/exclude` keeps it out of versioning without touching `.gitignore`. | JSON files (no query/search), external DB (not local-first) |
| D4 | **Memory exposed to agents through a stdio MCP server injected per ACP session** (`session/new.mcpServers`) | Agent-agnostic. Agent pulls *only* what it needs (`atomic_context`, `atomic_search`, `atomic_node`...) instead of re-reading the repo. Same server works outside the Workspace. | Dumping big context files into prompts |
| D5 | **Three knowledge layers**: deterministic (tree-sitter extraction) → imported (existing AI config/docs) → semantic (recorded *by the user's agent* via `atomic_record`) | Never use inference for what can be computed. Semantic layer is paid once by the agent the user already pays for, then reused by any agent. | Own LLM in the Workspace (violates invariant 12) |
| D6 | **Anchors with content hashes** on every non-deterministic node | Knowledge is verifiable: a change to an anchored file flips only those nodes to `stale`. Refresh touches only stale nodes. | Periodic full re-analysis |
| D7 | **tree-sitter via `@vscode/tree-sitter-wasm`** (ships runtime + ABI-matched grammars: ts, tsx, js, python, go, java, rust, c#, php, ruby, ...) | Multi-language, no native build, MIT. | TS compiler API (single language) |
| D8 | **Application mode = `<webview partition="persist:atomic-app">`** + `session.webRequest` tracing + webview preload capturing clicks | Real app runs in the Workspace; each request is matched deterministically to an indexed route → handler → module/capability/flow/entities. | Proxy server (intrusive), instrumentation of user code |

## 2. Runtime topology

```
┌────────────── Electron main ───────────────┐        ┌──── coding agent process ────┐
│ ProjectService  (open, .atomic/, exclude)  │  ACP   │ opencode acp / claude-agent- │
│ Indexer (core)  scan → extract → derive    │◀──────▶│ acp / codex-acp / gemini     │
│ MemoryStore (core, node:sqlite WAL)        │ stdio  │   works on the REAL project  │
│ AgentManager  (ACP client, permissions)    │        │   dir with its own tools     │
│ AppRunner (dev script) + Tracer (webReq)   │        │        │ spawns              │
└───────▲────────────────────────────────────┘        │        ▼                     │
        │ IPC (shared/ipc.ts)                         │  atomic MCP server (stdio)  │
┌───────┴──────── renderer (React) ───────────┐       │  out/main/mcp.js → same     │
│ Development: System map · Node detail ·     │       │  .atomic/memory.db (WAL)    │
│   Data model · Changes · Memory             │       └─────────────────────────────┘
│ Application: webview · run · trace panel    │
│ Agent panel: timeline from raw ACP updates  │
└─────────────────────────────────────────────┘
```

## 3. Repository layout & ownership

```
packages/core/src/
  types.ts, contracts.ts   ← contracts (Tech Lead only)
  extract/   tree-sitter extraction per file (pure)
  detect/    stack/manifests/scripts/schema entities/integrations
  importer/  existing AI config & docs → ImportedSource → nodes
  store/     MemoryStore on node:sqlite
  indexer/   sync / apply / watch, deterministic layer (modules, routes, entities, integrations, tests, edges)
  context/   buildContext / buildOverview / impactOf
  graph/     buildGraph projections for UI
  mcp/       MCP server tools
  index.ts   public barrel
apps/desktop/src/
  shared/ipc.ts            ← contract (Tech Lead only)
  main/      project, agents/, app/ (runner+tracer), ipc wiring, mcp-entry.ts
  preload/   index.ts (window.atomic), webview.ts (interaction capture)
  renderer/src/            app shell, features/{system,agent,app,memory}, mock/
fixtures/shop-app/         realistic sample project used by tests and e2e
```

## 4. Knowledge model (see `packages/core/src/types.ts`)

- **Index tables** (deterministic, per file, replaced on re-extract): files, symbols, imports, routes, entities, tests, env vars.
- **Nodes** `KnowledgeNode {id, kind, title, summary, body?, data?, origin, status, confidence, anchors[], tags[]}` and **edges** `{from, to, rel, origin}`.
- **Deterministic layer is rebuilt** (origin=`deterministic` deleted & recomputed) after each sync/apply; it never goes stale.
- **Imported/agent/user nodes persist**; they turn `stale` when an anchored file hash changes, back to `fresh` on verify.
- **Module grouping** (deterministic): files grouped by directory under the source root (`src/`, `app/`, `lib/`, `packages/*/src`, `apps/*/src`...); module id `module:<dir>`. Capabilities (semantic) contain modules/routes/components via `contains`/`implements` edges.

## 5. Token-efficiency mechanics

1. Nothing is re-extracted unless its sha1 changed. Watcher → incremental `apply(paths)`.
2. UI renders ACP structured updates and memory data directly — **no LLM call for presentation**.
3. First prompt of a session gets a compact **overview pack** (≤ ~800 tokens); later prompts get a **task pack** (FTS + graph expansion) excluding nodes already sent in that session.
4. Agents pull more via MCP tools instead of exploring the repo.
5. Semantic bootstrap runs once per project (`bootstrap` template); afterwards only `refresh-stale` over stale nodes.
6. `MemoryStats.estimatedRepoTokens` vs `contextServed` is shown honestly in the UI.

## 6. MCP tools (agent-facing)

| Tool | Purpose |
|------|---------|
| `atomic_overview` | Project brief: stack, modules/capabilities, conventions, memory status |
| `atomic_context {task, budget_tokens?}` | Relevant nodes + files/line ranges for a task |
| `atomic_search {query, kinds?, limit?}` | FTS over knowledge + symbols |
| `atomic_node {id}` | Node detail, anchors, edges, status |
| `atomic_symbol {name}` | Symbol locations |
| `atomic_impact {paths}` | Capabilities/flows/routes/entities/tests affected |
| `atomic_record {items[]}` | Agent records capabilities/flows/rules/entities/decisions anchored to code |
| `atomic_stale` / `atomic_verify {ids}` | Re-verification loop for stale knowledge |
| `atomic_unmapped` | Modules/routes/entities not yet covered by a capability (bootstrap guide) |

## 7. Agent integration (ACP client)

- Registry: built-in `claude`, `codex`, `opencode`, `gemini` + custom entries from `~/.atomic/agents.json` (`{id,name,command,args,env}`).
- Adapters bundled as npm deps are launched with `process.execPath` + `ELECTRON_RUN_AS_NODE=1`.
- `session/new { cwd: root, mcpServers: [atomic] }`. Permission requests → UI → `RequestPermissionResponse`.
- Client capabilities: `fs.readTextFile/writeTextFile` implemented against the real directory (writes recorded as agent ChangeSets).
- Tool calls with `locations` and file edits trigger `indexer.apply()` → ChangeSet(source=agent) → UI highlights affected nodes.

## 8. Quality gates

- core: vitest unit tests per module against `fixtures/shop-app`.
- desktop: typecheck + build; Playwright `_electron` e2e (open fixture → index → system map → node detail → app run & trace).
- Real agent loop validated with OpenCode ACP (free model) end-to-end.
