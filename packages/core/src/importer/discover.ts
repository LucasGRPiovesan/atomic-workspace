import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, posix, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { ImportedSource, AiTool, AiSourceKind, SourceSection } from '../types.js';
import { splitMarkdownSections, splitNonMarkdownSections, mergeTinySections } from './sections.js';

const MAX_FILE_SIZE = 256 * 1024; // 256 KB
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.atomic', 'vendor', '.venv']);
const MAX_DOCS_FILES = 20;
const MAX_NESTED_DEPTH = 3;

interface FileEntry {
  path: string;
  tool: AiTool;
  kind: AiSourceKind;
  title: string;
}

function sha1(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function toPosixPath(path: string): string {
  return path.split(sep).join(posix.sep);
}

function getToolFromPath(relPath: string): AiTool {
  const parts = relPath.split(posix.sep);
  const first = parts[0].toLowerCase();
  
  if (first === '.claude' || first === 'claude.md' || first === 'agents.md') return 'claude';
  if (first === '.cursor' || first === 'cursorrules') return 'cursor';
  if (first === '.windsurf' || first === '.windsurfrules') return 'windsurf';
  if (first === '.github') return 'copilot';
  if (first === '.opencode' || first === 'opencode.json') return 'opencode';
  if (first === '.codex') return 'codex';
  if (first === 'gemini.md' || first === '.gemini') return 'gemini';
  if (first === '.clinerules') return 'cline';
  return 'generic';
}

function getKindFromPath(relPath: string): AiSourceKind {
  const lower = relPath.toLowerCase();
  
  if (lower.includes('/rules/') || lower.endsWith('.mdc') || lower.endsWith('.cursorrules') || 
      lower.endsWith('.windsurfrules') || lower.endsWith('.clinerules') ||
      lower.includes('.cursor/rules/') || lower.includes('.windsurf/rules/') ||
      lower.includes('.claude/rules/') || lower.includes('.github/instructions/')) {
    return 'rules';
  }
  if (lower.includes('/skills/') && lower.endsWith('skill.md')) return 'skill';
  if (lower.includes('/agents/') && lower.endsWith('.md')) return 'agent';
  if (lower.includes('/commands/') && lower.endsWith('.md')) return 'command';
  if (lower.includes('.mcp.json') || lower.includes('/mcp.json')) return 'mcp';
  if (lower.includes('/adr/') || lower.includes('/decisions/') || lower.startsWith('adr/')) return 'adr';
  if (lower.startsWith('docs/') || lower === 'readme.md' || lower === 'architecture.md' ||
      lower === 'contributing.md' || lower === 'codebase_map.md') return 'docs';
  if (lower === 'claude.md' || lower === 'agents.md' || lower === 'gemini.md' ||
      lower === 'copilot-instructions.md' || lower === 'opencode.json' ||
      lower.endsWith('.cursorrules') || lower.endsWith('.windsurfrules') || lower.endsWith('.clinerules')) {
    return 'instructions';
  }
  return 'instructions';
}

function getTitleFromPath(relPath: string): string {
  const parts = relPath.split(posix.sep);
  const fileName = parts[parts.length - 1];
  return fileName.replace(/\.md$/, '').replace(/\.mdc$/, '').replace(/\.json$/, '');
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_SIZE) return null;
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

const ALLOWED_DOT_DIRS = new Set(['.claude', '.cursor', '.windsurf', '.github', '.opencode', '.codex', '.gemini']);

function shouldSkipDir(dirName: string): boolean {
  if (EXCLUDED_DIRS.has(dirName)) return true;
  if (dirName.startsWith('.') && !ALLOWED_DOT_DIRS.has(dirName)) return true;
  return false;
}

async function findFilesRecursive(
  root: string,
  currentDir: string,
  depth: number,
  maxDepth: number,
  results: FileEntry[],
  pattern: RegExp,
  tool: AiTool,
  kind: AiSourceKind,
  seenPaths?: Set<string>
): Promise<void> {
  if (depth > maxDepth) return;
  
  try {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = toPosixPath(relative(root, fullPath));
      
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
          await findFilesRecursive(root, fullPath, depth + 1, maxDepth, results, pattern, tool, kind, seenPaths);
        }
      } else if (entry.isFile() && pattern.test(entry.name)) {
        if (!seenPaths || !seenPaths.has(relPath)) {
          results.push({ path: relPath, tool, kind, title: getTitleFromPath(relPath) });
          seenPaths?.add(relPath);
        }
      }
    }
  } catch {
    // Ignore permission errors
  }
}

async function discoverInstructions(root: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const seenPaths = new Set<string>();
  
  // Root-level instruction files
  const rootFiles = [
    'CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', 'GEMINI.md',
    '.github/copilot-instructions.md', '.windsurfrules', '.cursorrules',
    '.clinerules', 'opencode.json'
  ];
  
  for (const file of rootFiles) {
    const fullPath = join(root, file);
    const content = await readFileSafe(fullPath);
    if (content !== null) {
      const relPath = toPosixPath(file);
      if (!seenPaths.has(relPath)) {
        seenPaths.add(relPath);
        results.push({
          path: relPath,
          tool: getToolFromPath(relPath),
          kind: 'instructions',
          title: getTitleFromPath(relPath)
        });
      }
    }
  }
  
  // Nested CLAUDE.md and AGENTS.md up to depth 3 (including root level for deduplication)
  await findFilesRecursive(root, root, 0, MAX_NESTED_DEPTH, results, 
    /^(CLAUDE\.md|AGENTS\.md)$/i, 'claude', 'instructions', seenPaths);
  
  return results;
}

async function discoverRules(root: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const patterns = [
    { dir: '.cursor/rules', pattern: /\.(mdc|md)$/i, tool: 'cursor' as AiTool },
    { dir: '.windsurf/rules', pattern: /\.(md|mdc)$/i, tool: 'windsurf' as AiTool },
    { dir: '.claude/rules', pattern: /\.md$/i, tool: 'claude' as AiTool },
    { dir: '.github/instructions', pattern: /\.md$/i, tool: 'copilot' as AiTool },
  ];
  
  for (const { dir, pattern, tool } of patterns) {
    const fullDir = join(root, dir);
    await findFilesRecursive(root, fullDir, 0, 10, results, pattern, tool, 'rules');
  }
  
  return results;
}

async function discoverSkillsAgentsCommands(root: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  
  // .claude/skills/*/SKILL.md
  const skillsDir = join(root, '.claude/skills');
  await findFilesRecursive(root, skillsDir, 0, 5, results, /^SKILL\.md$/i, 'claude', 'skill');
  
  // .claude/agents/*.md
  const agentsDir = join(root, '.claude/agents');
  await findFilesRecursive(root, agentsDir, 0, 2, results, /\.md$/i, 'claude', 'agent');
  
  // .claude/commands/**/*.md
  const commandsDir = join(root, '.claude/commands');
  await findFilesRecursive(root, commandsDir, 0, 5, results, /\.md$/i, 'claude', 'command');
  
  // .opencode/agent/*.md
  const opencodeAgentDir = join(root, '.opencode/agent');
  await findFilesRecursive(root, opencodeAgentDir, 0, 2, results, /\.md$/i, 'opencode', 'agent');
  
  // .opencode/command/*.md
  const opencodeCommandDir = join(root, '.opencode/command');
  await findFilesRecursive(root, opencodeCommandDir, 0, 2, results, /\.md$/i, 'opencode', 'command');
  
  // .codex/**/*.md
  const codexDir = join(root, '.codex');
  await findFilesRecursive(root, codexDir, 0, 5, results, /\.md$/i, 'codex', 'command');
  
  return results;
}

async function discoverMcp(root: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const mcpFiles = ['.mcp.json', '.cursor/mcp.json'];
  
  for (const file of mcpFiles) {
    const fullPath = join(root, file);
    const content = await readFileSafe(fullPath);
    if (content !== null) {
      const relPath = toPosixPath(file);
      results.push({
        path: relPath,
        tool: getToolFromPath(relPath),
        kind: 'mcp',
        title: getTitleFromPath(relPath)
      });
    }
  }
  
  return results;
}

async function discoverDocs(root: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  
  // Root-level docs
  const rootDocs = ['README.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'CODEBASE_MAP.md'];
  for (const file of rootDocs) {
    const fullPath = join(root, file);
    const content = await readFileSafe(fullPath);
    if (content !== null) {
      const relPath = toPosixPath(file);
      results.push({
        path: relPath,
        tool: getToolFromPath(relPath),
        kind: 'docs',
        title: getTitleFromPath(relPath)
      });
    }
  }
  
  // docs/ARCHITECTURE.md
  const docsArch = join(root, 'docs/ARCHITECTURE.md');
  const content = await readFileSafe(docsArch);
  if (content !== null) {
    results.push({
      path: 'docs/ARCHITECTURE.md',
      tool: 'generic',
      kind: 'docs',
      title: 'ARCHITECTURE'
    });
  }
  
  // docs/*.md (depth 1, max 20 files)
  const docsDir = join(root, 'docs');
  try {
    const entries = await readdir(docsDir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (count >= MAX_DOCS_FILES) break;
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const fullPath = join(docsDir, entry.name);
        const fileContent = await readFileSafe(fullPath);
        if (fileContent !== null) {
          const relPath = toPosixPath(relative(root, fullPath));
          results.push({
            path: relPath,
            tool: 'generic',
            kind: 'docs',
            title: getTitleFromPath(relPath)
          });
          count++;
        }
      }
    }
  } catch {
    // docs dir may not exist
  }
  
  return results;
}

async function discoverAdr(root: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const adrDirs = ['docs/adr', 'docs/decisions', 'adr'];
  
  for (const dir of adrDirs) {
    const fullDir = join(root, dir);
    await findFilesRecursive(root, fullDir, 0, 5, results, /\.md$/i, 'generic', 'adr');
  }
  
  return results;
}

const SECRET_FLAG = /^--?(?:api[-_]?key|token|access[-_]?token|key|secret|password|pass|auth|bearer)$/i;
const HEADER_FLAG = /^(?:-H|--header)$/;
const SECRET_NAME = /key|token|secret|passw(?:or)?d|pwd|auth|credential|cookie|session/i;
const REDACTED = '<redacted>';

/** Masks anything credential-like inside one command-line string, keeping its shape readable. */
function redactSecrets(s: string): string {
  return s
    // URLs: user:pass@ and the query/fragment (tokens often ride in ?api_key=...)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, `$1${REDACTED}@`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"']*)[?#][^\s"']*/gi, '$1')
    // auth schemes and NAME=value / NAME: value pairs whose name looks secret
    .replace(/\b(Bearer|Basic|Token)\s+\S+/gi, `$1 ${REDACTED}`)
    .replace(/(^|[\s'{,;])("?-{0,2}[\w.-]+"?)(\s*[=:]\s*)("?)([^\s"',;}]+)\4/g, (m, pre, name, sep, q, value) =>
      SECRET_NAME.test(name) && !value.startsWith('//') ? `${pre}${name}${sep}${q}${REDACTED}${q}` : m)
    // "--token value" inside a single command string
    .replace(/(^|\s)(--?[\w-]+)(\s+)(?!-)(\S+)/g, (m, pre, flag, sp) => (SECRET_NAME.test(flag) ? `${pre}${flag}${sp}${REDACTED}` : m))
    // well-known token prefixes and long random-looking words (letters and digits mixed)
    .replace(/\b(?:sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|github_pat_|xox[abpr]-|glpat-|AKIA|AIza|eyJ)[\w.-]+/g, REDACTED)
    .replace(/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}\b/g, REDACTED);
}

/** What an MCP server entry may expose to memory: how it runs, never its credentials. */
function sanitizeMcpServer(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof config.type === 'string') out.type = config.type;
  if (typeof config.command === 'string') out.command = redactSecrets(config.command);
  if (Array.isArray(config.args)) {
    const args = config.args.map(String);
    out.args = args.map((a, i) => {
      const prev = i > 0 ? args[i - 1]! : '';
      if (SECRET_FLAG.test(prev)) return REDACTED;
      // header values are credentials more often than not: keep only the header name
      if (HEADER_FLAG.test(prev)) return a.includes(':') ? `${a.slice(0, a.indexOf(':'))}: ${REDACTED}` : REDACTED;
      return redactSecrets(a);
    });
  }
  if (typeof config.url === 'string') {
    try { const u = new URL(config.url); out.url = `${u.origin}${u.pathname}`; } catch { /* not a url: leave it out */ }
  }
  // env, headers and anything else may carry credentials
  return out;
}

function parseMcpConfig(content: string, path: string): ImportedSource {
  try {
    const parsed = JSON.parse(content);
    const servers = parsed.mcpServers || parsed.servers || {};
    const sections: SourceSection[] = [];

    for (const [name, config] of Object.entries(servers)) {
      const sanitized = sanitizeMcpServer((config ?? {}) as Record<string, unknown>);
      sections.push({
        heading: name,
        text: JSON.stringify(sanitized, null, 2),
        startLine: 1,
        endLine: 1
      });
    }
    
    return {
      path,
      tool: getToolFromPath(path),
      kind: 'mcp',
      hash: sha1(content),
      title: 'MCP Servers',
      sections
    };
  } catch {
    // Malformed JSON, return empty sections
    return {
      path,
      tool: getToolFromPath(path),
      kind: 'mcp',
      hash: sha1(content),
      title: 'MCP Servers',
      sections: []
    };
  }
}

function parseOpencodeJson(content: string, path: string): ImportedSource {
  try {
    const parsed = JSON.parse(content);
    const instructions = parsed.instructions || [];
    const sections: SourceSection[] = instructions.map((inst: unknown, i: number) => ({
      heading: `Instruction ${i + 1}`,
      text: typeof inst === 'string' ? inst : JSON.stringify(inst),
      startLine: 1,
      endLine: 1
    }));
    
    return {
      path,
      tool: 'opencode',
      kind: 'instructions',
      hash: sha1(content),
      title: 'OpenCode Instructions',
      sections
    };
  } catch {
    return {
      path,
      tool: 'opencode',
      kind: 'instructions',
      hash: sha1(content),
      title: 'OpenCode Instructions',
      sections: []
    };
  }
}

async function buildImportedSource(root: string, entry: FileEntry): Promise<ImportedSource | null> {
  const fullPath = join(root, entry.path);
  const content = await readFileSafe(fullPath);
  if (content === null) return null;
  
  const hash = sha1(content);
  let sections: SourceSection[] = [];
  
  if (entry.path.endsWith('.json')) {
    if (entry.kind === 'mcp') {
      return parseMcpConfig(content, entry.path);
    } else if (entry.path === 'opencode.json') {
      return parseOpencodeJson(content, entry.path);
    }
  } else if (entry.path.endsWith('.md') || entry.path.endsWith('.mdc')) {
    sections = splitMarkdownSections(content);
  } else {
    // Non-markdown files like .cursorrules, .windsurfrules, .clinerules
    sections = splitNonMarkdownSections(content);
  }
  
  return {
    path: entry.path,
    tool: entry.tool,
    kind: entry.kind,
    hash,
    title: entry.title,
    sections
  };
}

export async function importAiConfig(root: string): Promise<ImportedSource[]> {
  const allEntries: FileEntry[] = [];
  
  // Discover all file types
  allEntries.push(...await discoverInstructions(root));
  allEntries.push(...await discoverRules(root));
  allEntries.push(...await discoverSkillsAgentsCommands(root));
  allEntries.push(...await discoverMcp(root));
  allEntries.push(...await discoverDocs(root));
  allEntries.push(...await discoverAdr(root));
  
  // Build ImportedSource for each entry; the first discovery of a path wins (docs/ARCHITECTURE.md is also a docs/*.md)
  const sources: ImportedSource[] = [];
  const seen = new Set<string>();
  for (const entry of allEntries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const source = await buildImportedSource(root, entry);
    if (source && source.sections.length > 0) {
      sources.push(source);
    }
  }
  
  return sources;
}

export { splitMarkdownSections, splitNonMarkdownSections, mergeTinySections } from './sections.js';