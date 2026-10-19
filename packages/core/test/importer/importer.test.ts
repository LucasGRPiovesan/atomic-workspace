import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { importAiConfig, sourcesToNodes, splitMarkdownSections, splitNonMarkdownSections, mergeTinySections } from '../../src/importer/index.js';
import type { ImportedSource, SourceSection } from '../../src/types.js';

async function createTempProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atomic-importer-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('splitMarkdownSections', () => {
  it('splits by headings and keeps line numbers', () => {
    const content = `# Title
${'Intro text with enough content to exceed the tiny threshold of two hundred characters. '.repeat(3)}

## Section 1
${'Content 1 with enough content to exceed the tiny threshold of two hundred characters. '.repeat(3)}

### Subsection
${'Content 2 with enough content to exceed the tiny threshold of two hundred characters. '.repeat(3)}

## Section 2
${'Content 3 with enough content to exceed the tiny threshold of two hundred characters. '.repeat(3)}
`;
    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(4);
    expect(sections[0].heading).toBe('Title');
    expect(sections[0].startLine).toBe(1);
    expect(sections[0].endLine).toBe(2);
    expect(sections[1].heading).toBe('Section 1');
    expect(sections[1].startLine).toBe(4);
    expect(sections[1].endLine).toBe(5);
    expect(sections[2].heading).toBe('Subsection');
    expect(sections[2].startLine).toBe(7);
    expect(sections[2].endLine).toBe(8);
    expect(sections[3].heading).toBe('Section 2');
    expect(sections[3].startLine).toBe(10);
    expect(sections[3].endLine).toBe(11);
  });

  it('strips YAML front-matter and uses title/description for first heading', () => {
    const content = `---
title: "My Doc"
description: "A description"
---
# Real Heading
Content.
`;
    const sections = splitMarkdownSections(content);
    expect(sections[0].heading).toBe('My Doc');
    expect(sections[0].text).toContain('Real Heading');
    expect(sections[0].startLine).toBe(5); // After front matter
  });

  it('merges consecutive tiny sections (< 200 chars)', () => {
    const content = `# H1
Tiny.

## H2
Also tiny.

## H3
${'This is a much longer section with enough content to not be considered tiny and should stay separate. '.repeat(5)}
`;
    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('H1');
    expect(sections[0].text).toContain('Tiny');
    expect(sections[0].text).toContain('Also tiny');
    expect(sections[1].heading).toBe('H3');
  });

  it('drops empty sections', () => {
    const content = `# H1

## H2
Content.
`;
    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('H2');
  });
});

describe('splitNonMarkdownSections', () => {
  it('splits by blank-line-separated blocks', () => {
    const content = `Block one line 1
Block one line 2

Block two line 1

Block three
`;
    const sections = splitNonMarkdownSections(content);
    expect(sections).toHaveLength(3);
    expect(sections[0].text).toContain('Block one');
    expect(sections[1].text).toContain('Block two');
    expect(sections[2].text).toContain('Block three');
  });

  it('splits large blocks at ~1500 chars', () => {
    const small = 'x'.repeat(100);
    const content = `${small}\n\n${small}\n\n${'y'.repeat(2000)}`;
    const sections = splitNonMarkdownSections(content);
    // 2 small blocks (not merged) + 1 large block split into 2 = 4 sections
    expect(sections).toHaveLength(4);
    expect(sections[0].text.length).toBeLessThan(1500);
    expect(sections[1].text.length).toBeLessThan(1500);
    expect(sections[2].text.length).toBeLessThanOrEqual(1500);
    expect(sections[3].text.length).toBeLessThanOrEqual(1500);
  });
});

describe('mergeTinySections', () => {
  it('merges consecutive tiny sections', () => {
    const sections: SourceSection[] = [
      { heading: 'A', text: 'tiny', startLine: 1, endLine: 1 },
      { heading: 'B', text: 'also tiny', startLine: 2, endLine: 2 },
      { heading: 'C', text: 'this is a much longer section that exceeds the threshold '.repeat(5), startLine: 3, endLine: 3 },
    ];
    const merged = mergeTinySections(sections);
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toContain('tiny');
    expect(merged[0].text).toContain('also tiny');
    expect(merged[1].heading).toBe('C');
  });
});

describe('importAiConfig discovery', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('discovers CLAUDE.md and AGENTS.md at root', async () => {
    root = await createTempProject({
      'CLAUDE.md': '# Instructions\nDo this.',
      'AGENTS.md': '# Agents\nFollow that.',
    });
    const sources = await importAiConfig(root);
    expect(sources).toHaveLength(2);
    const paths = sources.map(s => s.path).sort();
    expect(paths).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(sources.find(s => s.path === 'CLAUDE.md')?.tool).toBe('claude');
    expect(sources.find(s => s.path === 'AGENTS.md')?.tool).toBe('claude');
    expect(sources.find(s => s.path === 'CLAUDE.md')?.kind).toBe('instructions');
  });

  it('discovers .claude/CLAUDE.md', async () => {
    root = await createTempProject({
      '.claude/CLAUDE.md': '# Claude Config\nSettings here.',
    });
    const sources = await importAiConfig(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe('.claude/CLAUDE.md');
    expect(sources[0].tool).toBe('claude');
  });

  it('discovers .cursor/rules/*.mdc with front-matter stripped', async () => {
    root = await createTempProject({
      '.cursor/rules/test.mdc': `---
description: "Test rule"
---
# Rule Title
Rule content here.
`,
    });
    const sources = await importAiConfig(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe('.cursor/rules/test.mdc');
    expect(sources[0].tool).toBe('cursor');
    expect(sources[0].kind).toBe('rules');
    expect(sources[0].sections[0].heading).toBe('Test rule');
    expect(sources[0].sections[0].text).toContain('Rule content');
  });

  it('discovers .claude/skills/s/SKILL.md', async () => {
    root = await createTempProject({
      '.claude/skills/my-skill/SKILL.md': '# Skill\nSkill description.',
    });
    const sources = await importAiConfig(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe('.claude/skills/my-skill/SKILL.md');
    expect(sources[0].tool).toBe('claude');
    expect(sources[0].kind).toBe('skill');
  });

  it('discovers .mcp.json and drops env values', async () => {
    root = await createTempProject({
      '.mcp.json': JSON.stringify({
        mcpServers: {
          myserver: {
            command: 'node',
            args: ['server.js'],
            env: { SECRET_KEY: 'should-not-appear' }
          }
        }
      }),
    });
    const sources = await importAiConfig(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe('mcp');
    expect(sources[0].sections[0].heading).toBe('myserver');
    expect(sources[0].sections[0].text).not.toContain('SECRET_KEY');
    expect(sources[0].sections[0].text).not.toContain('should-not-appear');
  });

  it('strips credentials from MCP headers, args and urls', async () => {
    root = await createTempProject({
      '.mcp.json': JSON.stringify({
        mcpServers: {
          remote: { type: 'http', url: 'https://mcp.example.com/v1?token=qs-secret', headers: { Authorization: 'Bearer hdr-secret' } },
          local: { command: 'npx', args: ['-y', 'some-server', '--api-key', 'flag-secret', 'TOKEN=kv-secret', 'postgres://u:pw-secret@db/x', 'sk-abcdef'] },
        },
      }),
    });
    const text = (await importAiConfig(root))[0].sections.map((s) => s.text).join('\n');
    for (const secret of ['qs-secret', 'hdr-secret', 'flag-secret', 'kv-secret', 'pw-secret', 'sk-abcdef', 'Authorization']) expect(text).not.toContain(secret);
    expect(text).toContain('https://mcp.example.com/v1');
    expect(text).toContain('some-server');
  });

  it('strips credentials hidden in the command, headers, urls inside args and short tokens', async () => {
    root = await createTempProject({
      '.mcp.json': JSON.stringify({
        mcpServers: {
          cmd: { command: 'mcp-server --api-key=cmd-secret --token tok-secret', args: [] },
          remote: { command: 'npx', args: ['mcp-remote', 'https://mcp.example.com/sse?api_key=q-secret#f-secret', '--header', 'Authorization: Bearer h-secret', '-H', 'X-Api-Key: h2-secret'] },
          json: { command: 'srv', args: ['--config', '{"api_key": "j-secret", "region": "eu"}', 'Bearer b-secret'] },
          short: { command: 'srv', args: ['aGV5SGlnaEVudHJvcHk9MTIz', 'AIzaSyShortKey1', 'password:pw2-secret'] },
        },
      }),
    });
    const text = (await importAiConfig(root))[0].sections.map((s) => s.text).join('\n');
    for (const secret of ['cmd-secret', 'tok-secret', 'q-secret', 'f-secret', 'h-secret', 'h2-secret', 'j-secret', 'b-secret', 'aGV5SGlnaEVudHJvcHk9MTIz', 'AIzaSyShortKey1', 'pw2-secret']) {
      expect(text).not.toContain(secret);
    }
    // the readable shape survives
    for (const kept of ['mcp-server', 'mcp-remote', 'https://mcp.example.com/sse', 'Authorization', 'X-Api-Key', 'region']) expect(text).toContain(kept);
  });

  it('imports a source discovered by two rules only once', async () => {
    root = await createTempProject({ 'docs/ARCHITECTURE.md': '# Architecture\n\nLayers and how requests flow through them, long enough to stand alone as a section.' });
    expect((await importAiConfig(root)).filter((s) => s.path === 'docs/ARCHITECTURE.md')).toHaveLength(1);
  });

  it('discovers docs/adr/0001-x.md', async () => {
    root = await createTempProject({
      'docs/adr/0001-decision.md': '# ADR 0001\nWe decided to use X.',
    });
    const sources = await importAiConfig(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe('docs/adr/0001-decision.md');
    expect(sources[0].kind).toBe('adr');
  });

  it('ignores node_modules/CLAUDE.md', async () => {
    root = await createTempProject({
      'CLAUDE.md': '# Root',
      'node_modules/CLAUDE.md': '# Should be ignored',
    });
    const sources = await importAiConfig(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe('CLAUDE.md');
  });

  it('ignores .git, dist, build, .atomic, vendor, .venv directories', async () => {
    root = await createTempProject({
      'CLAUDE.md': '# Root',
      '.git/CLAUDE.md': '# Ignored',
      'dist/CLAUDE.md': '# Ignored',
      'build/CLAUDE.md': '# Ignored',
      '.atomic/CLAUDE.md': '# Ignored',
      'vendor/CLAUDE.md': '# Ignored',
      '.venv/CLAUDE.md': '# Ignored',
    });
    const sources = await importAiConfig(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe('CLAUDE.md');
  });

  it('skips files larger than 256 KB', async () => {
    root = await createTempProject({
      'CLAUDE.md': '# Small',
      'large.md': 'x'.repeat(300 * 1024), // 300 KB
    });
    const sources = await importAiConfig(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe('CLAUDE.md');
  });

  it('discovers nested CLAUDE.md up to depth 3', async () => {
    root = await createTempProject({
      'CLAUDE.md': '# Root',
      'level1/CLAUDE.md': '# Level 1',
      'level1/level2/CLAUDE.md': '# Level 2',
      'level1/level2/level3/CLAUDE.md': '# Level 3',
      'level1/level2/level3/level4/CLAUDE.md': '# Level 4 - too deep',
    });
    const sources = await importAiConfig(root);
    const paths = sources.map(s => s.path).sort();
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('level1/CLAUDE.md');
    expect(paths).toContain('level1/level2/CLAUDE.md');
    expect(paths).toContain('level1/level2/level3/CLAUDE.md');
    expect(paths).not.toContain('level1/level2/level3/level4/CLAUDE.md');
  });
});

describe('sourcesToNodes', () => {
  it('creates instruction nodes for instructions kind', () => {
    const sources: ImportedSource[] = [{
      path: 'CLAUDE.md',
      tool: 'claude',
      kind: 'instructions',
      hash: 'abc123',
      title: 'CLAUDE',
      sections: [
        { heading: 'Overview', text: 'General guidance.', startLine: 1, endLine: 5 },
        { heading: 'Rules', text: '- Must do X\n- Never do Y\n- Always do Z\n- Should do A\n- Use B', startLine: 6, endLine: 12 },
      ]
    }];
    const nodes = sourcesToNodes(sources);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].kind).toBe('instruction');
    expect(nodes[0].id).toBe('instruction:CLAUDE.md#0');
    expect(nodes[0].title).toBe('Overview — CLAUDE.md');
    expect(nodes[0].anchors[0].path).toBe('CLAUDE.md');
    expect(nodes[0].anchors[0].startLine).toBe(1);
    expect(nodes[0].anchors[0].endLine).toBe(5);
    expect(nodes[0].anchors[0].hash).toBe('abc123');
    expect(nodes[0].tags).toContain('claude');
    expect(nodes[0].origin).toBe('imported');
    
    // Second section has rule-like content -> rule kind
    expect(nodes[1].kind).toBe('rule');
    expect(nodes[1].id).toBe('rule:CLAUDE.md#1');
    expect(nodes[1].tags).toContain('rule');
  });

  it('creates rule nodes for rules kind', () => {
    const sources: ImportedSource[] = [{
      path: '.cursor/rules/style.mdc',
      tool: 'cursor',
      kind: 'rules',
      hash: 'def456',
      title: 'style',
      sections: [
        { heading: 'Style Rule', text: 'Use tabs.', startLine: 1, endLine: 3 },
      ]
    }];
    const nodes = sourcesToNodes(sources);
    expect(nodes[0].kind).toBe('rule');
    expect(nodes[0].id).toBe('rule:.cursor-rules-style.mdc#0');
    expect(nodes[0].tags).toContain('cursor');
    expect(nodes[0].tags).toContain('rules');
  });

  it('creates instruction nodes with skill/agent/command tags', () => {
    const sources: ImportedSource[] = [
      { path: '.claude/skills/s/SKILL.md', tool: 'claude', kind: 'skill', hash: 'h1', title: 'skill', sections: [{ heading: 'Skill', text: 'Desc', startLine: 1, endLine: 2 }] },
      { path: '.claude/agents/a.md', tool: 'claude', kind: 'agent', hash: 'h2', title: 'agent', sections: [{ heading: 'Agent', text: 'Desc', startLine: 1, endLine: 2 }] },
      { path: '.claude/commands/c.md', tool: 'claude', kind: 'command', hash: 'h3', title: 'command', sections: [{ heading: 'Command', text: 'Desc', startLine: 1, endLine: 2 }] },
    ];
    const nodes = sourcesToNodes(sources);
    expect(nodes[0].kind).toBe('instruction');
    expect(nodes[0].tags).toContain('skill');
    expect(nodes[1].tags).toContain('agent');
    expect(nodes[2].tags).toContain('command');
  });

  it('creates note nodes for docs', () => {
    const sources: ImportedSource[] = [{
      path: 'README.md',
      tool: 'generic',
      kind: 'docs',
      hash: 'h1',
      title: 'README',
      sections: [{ heading: 'Intro', text: 'Project description.', startLine: 1, endLine: 3 }]
    }];
    const nodes = sourcesToNodes(sources);
    expect(nodes[0].kind).toBe('note');
    expect(nodes[0].id).toBe('note:README.md#0');
  });

  it('creates decision nodes for adr', () => {
    const sources: ImportedSource[] = [{
      path: 'docs/adr/0001.md',
      tool: 'generic',
      kind: 'adr',
      hash: 'h1',
      title: '0001',
      sections: [{ heading: 'Decision', text: 'We chose X.', startLine: 1, endLine: 3 }]
    }];
    const nodes = sourcesToNodes(sources);
    expect(nodes[0].kind).toBe('decision');
    expect(nodes[0].id).toBe('decision:docs-adr-0001.md#0');
  });

  it('creates integration nodes for mcp with special id format', () => {
    const sources: ImportedSource[] = [{
      path: '.mcp.json',
      tool: 'generic',
      kind: 'mcp',
      hash: 'h1',
      title: 'MCP',
      sections: [{ heading: 'myserver', text: 'config', startLine: 1, endLine: 1 }]
    }];
    const nodes = sourcesToNodes(sources);
    expect(nodes[0].kind).toBe('integration');
    expect(nodes[0].id).toBe('integration:mcp:myserver');
    expect(nodes[0].data).toEqual({ integrationType: 'mcp', serverName: 'myserver' });
  });

  it('caps body at 4000 chars and summary at ~240 chars', () => {
    const longText = 'x'.repeat(5000);
    const sources: ImportedSource[] = [{
      path: 'doc.md',
      tool: 'generic',
      kind: 'instructions',
      hash: 'h1',
      title: 'doc',
      sections: [{ heading: 'Long', text: longText, startLine: 1, endLine: 10 }]
    }];
    const nodes = sourcesToNodes(sources);
    expect(nodes[0].body?.length).toBeLessThanOrEqual(4001); // 4000 + '…'
    expect(nodes[0].summary.length).toBeLessThanOrEqual(241); // 240 + '…'
  });

  it('includes proper anchors with hash', () => {
    const sources: ImportedSource[] = [{
      path: 'CLAUDE.md',
      tool: 'claude',
      kind: 'instructions',
      hash: 'sourcehash123',
      title: 'CLAUDE',
      sections: [{ heading: 'Section', text: 'Content', startLine: 10, endLine: 20 }]
    }];
    const nodes = sourcesToNodes(sources);
    expect(nodes[0].anchors).toHaveLength(1);
    expect(nodes[0].anchors[0]).toEqual({
      path: 'CLAUDE.md',
      startLine: 10,
      endLine: 20,
      hash: 'sourcehash123'
    });
  });
});

describe('importAiConfig integration', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('end-to-end: discovers files, splits sections, creates nodes with correct ids/kinds/anchors', async () => {
    root = await createTempProject({
      'CLAUDE.md': `# Title
Intro.

## Rule Section
- Must do this
- Never do that
- Always do this
- Should do that
- Use this tool
`,
      '.cursor/rules/style.mdc': `---
description: Style Rules
---
# Formatting
Use 2 spaces.
`,
      '.claude/skills/test/SKILL.md': `# Test Skill
Skill content.
`,
      '.mcp.json': JSON.stringify({
        mcpServers: {
          postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], env: { POSTGRES_URL: 'secret' } }
        }
      }),
      'docs/adr/0001-choice.md': `# ADR 0001
We chose PostgreSQL.
`,
    });
    
    const sources = await importAiConfig(root);
    const nodes = sourcesToNodes(sources);
    
    // Should have multiple sources
    expect(sources.length).toBeGreaterThanOrEqual(5);
    
    // Check node kinds
    const kinds = nodes.map(n => n.kind).sort();
    expect(kinds).toContain('instruction');
    expect(kinds).toContain('rule');
    expect(kinds).toContain('decision');
    expect(kinds).toContain('integration');
    
    // Check mcp integration node
    const mcpNode = nodes.find(n => n.kind === 'integration');
    expect(mcpNode).toBeDefined();
    expect(mcpNode?.id).toBe('integration:mcp:postgres');
    expect(mcpNode?.data).toEqual({ integrationType: 'mcp', serverName: 'postgres' });
    
    // Check anchors present
    for (const node of nodes) {
      expect(node.anchors).toHaveLength(1);
      expect(node.anchors[0].hash).toBeDefined();
      expect(node.anchors[0].startLine).toBeDefined();
      expect(node.anchors[0].endLine).toBeDefined();
      if (node.anchors[0].startLine && node.anchors[0].endLine) {
        expect(node.anchors[0].startLine).toBeGreaterThan(0);
        expect(node.anchors[0].endLine).toBeGreaterThanOrEqual(node.anchors[0].startLine);
      }
    }
    
    // Check rule heuristic on CLAUDE.md second section
    const ruleNode = nodes.find(n => n.kind === 'rule' && n.title.includes('CLAUDE'));
    expect(ruleNode).toBeDefined();
  });
});