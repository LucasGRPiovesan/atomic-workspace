import { createHash } from 'node:crypto';
import type { ImportedSource, SourceSection, KnowledgeNodeInput, AiSourceKind, AiTool } from '../types.js';

const MAX_BODY_CHARS = 4000;
const MAX_SUMMARY_CHARS = 240;
const RULE_HEURISTIC_THRESHOLD = 0.5;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .trim();
}

function isMostlyImperativeRules(text: string): boolean {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return false;
  
  let ruleLikeLines = 0;
  const ruleKeywords = ['must', 'never', 'always', 'should', 'don\'t', 'do not', 'use', 'avoid', 'ensure', 'require'];
  
  for (const line of lines) {
    const trimmed = line.trim();
    const startsWithBullet = /^[-*•]/.test(trimmed) || /^\d+\./.test(trimmed);
    if (!startsWithBullet) continue;
    
    const lower = trimmed.toLowerCase();
    const hasKeyword = ruleKeywords.some(kw => lower.includes(kw));
    if (hasKeyword) ruleLikeLines++;
  }
  
  return ruleLikeLines / lines.length >= RULE_HEURISTIC_THRESHOLD;
}

function getNodeKind(sourceKind: AiSourceKind, sectionText: string): 'instruction' | 'rule' | 'note' | 'decision' | 'integration' {
  switch (sourceKind) {
    case 'instructions':
    case 'skill':
    case 'agent':
    case 'command':
      return isMostlyImperativeRules(sectionText) ? 'rule' : 'instruction';
    case 'rules':
      return 'rule';
    case 'docs':
      return 'note';
    case 'adr':
      return 'decision';
    case 'mcp':
      return 'integration';
    default:
      return 'instruction';
  }
}

function getKindPrefix(kind: 'instruction' | 'rule' | 'note' | 'decision' | 'integration'): string {
  return kind;
}

function generateNodeId(
  kind: 'instruction' | 'rule' | 'note' | 'decision' | 'integration',
  path: string,
  index: number,
  sourceKind: AiSourceKind,
  sectionHeading: string
): string {
  const prefix = getKindPrefix(kind);
  
  // Special handling for MCP integration nodes
  if (kind === 'integration' && sourceKind === 'mcp') {
    const serverName = slugify(sectionHeading);
    return `integration:mcp:${serverName}`;
  }
  
  // For other nodes, keep the full path with extension, replace separators with dashes
  const cleanPath = path.replace(/[/\\]/g, '-');
  return `${prefix}:${cleanPath}#${index}`;
}

function generateSummary(text: string): string {
  const plain = stripMarkdown(text);
  const truncated = plain.slice(0, MAX_SUMMARY_CHARS);
  return truncated.length === MAX_SUMMARY_CHARS ? truncated + '…' : truncated;
}

function generateBody(text: string): string | undefined {
  if (text.length <= MAX_BODY_CHARS) return text;
  return text.slice(0, MAX_BODY_CHARS) + '…';
}

function getTags(tool: AiTool, sourceKind: AiSourceKind, nodeKind: string): string[] {
  const tags: string[] = [tool];
  if (sourceKind !== 'instructions' && sourceKind !== 'docs' && sourceKind !== 'adr') {
    tags.push(sourceKind);
  }
  if (nodeKind === 'rule' && sourceKind === 'instructions') {
    tags.push('rule');
  }
  return tags;
}

function createAnchor(path: string, section: SourceSection, contentHash: string) {
  return {
    path,
    startLine: section.startLine,
    endLine: section.endLine,
    hash: contentHash
  };
}

export function sourcesToNodes(sources: readonly ImportedSource[]): KnowledgeNodeInput[] {
  const nodes: KnowledgeNodeInput[] = [];
  
  for (const source of sources) {
    for (let i = 0; i < source.sections.length; i++) {
      const section = source.sections[i];
      const nodeKind = getNodeKind(source.kind, section.text);
      const id = generateNodeId(nodeKind, source.path, i, source.kind, section.heading);
      const title = `${section.heading} — ${source.path}`;
      const summary = generateSummary(section.text);
      const body = generateBody(section.text);
      const tags = getTags(source.tool, source.kind, nodeKind);
      const anchor = createAnchor(source.path, section, source.hash);
      
      const node: KnowledgeNodeInput = {
        id,
        kind: nodeKind,
        title,
        summary,
        body,
        origin: 'imported',
        anchors: [anchor],
        tags,
        confidence: 0.9,
        data: source.kind === 'mcp' ? { integrationType: 'mcp', serverName: section.heading } : undefined
      };
      
      nodes.push(node);
    }
  }
  
  return nodes;
}

export { splitMarkdownSections, splitNonMarkdownSections, mergeTinySections } from './sections.js';
export { getNodeKind, isMostlyImperativeRules, generateNodeId };