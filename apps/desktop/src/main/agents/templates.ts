import type { PromptTemplate } from '../../shared/ipc';

const BOOTSTRAP = `Build the project understanding for the Atomic Workspace memory.

Use the atomic_* MCP tools; do not modify any code.

1. Call atomic_overview, then atomic_unmapped. They list the modules, routes and entities that no capability covers yet, so start there.
2. Before recording anything, call atomic_search / atomic_context for the area you are about to describe, and reuse or update existing knowledge instead of duplicating it.
3. Read only the code you need to be sure of what it does. Skip generated files, vendored code and lockfiles.
4. Record what you learned with atomic_record, each item anchored to real files/symbols (with line ranges when you can):
   - capabilities: business-level features, named the way a product owner would ("Checkout", "Authentication"), not folder names;
   - flows: ordered steps across files/symbols, with file and line for every step;
   - rules: business rules and invariants, and where they are enforced;
   - entities: what each data entity means in the business, beyond its fields;
   - decisions: key technical decisions and conventions that are not obvious from the code.
5. Connect the nodes you record: capabilities contain the modules, routes and components that implement them.
6. Finish with a short summary: what you recorded, what remains unmapped, and anything you were unsure about.`;

const REFRESH_STALE = `Refresh the stale knowledge in the Atomic Workspace memory.

Use the atomic_* MCP tools; do not modify any code.

1. Call atomic_stale to list the nodes whose anchored files changed since they were recorded.
2. For each stale node, re-read only its anchored files/symbols (atomic_node gives the anchors) and compare them with what the node says.
3. If the node is still correct, call atomic_verify with its id.
4. If it is outdated or incomplete, call atomic_record to update it (same id/title, corrected summary, flow steps and anchors).
5. If the code it described no longer exists, say so in your summary instead of guessing.
6. Do not touch nodes that are not stale. Finish with a short summary: verified, updated and removed-in-code counts.`;

export const TEMPLATES: Record<PromptTemplate, string> = {
  bootstrap: BOOTSTRAP,
  'refresh-stale': REFRESH_STALE,
};

export function template(kind: PromptTemplate): string {
  const text = TEMPLATES[kind];
  if (text === undefined) throw new Error(`unknown prompt template: ${String(kind)}`);
  return text;
}
