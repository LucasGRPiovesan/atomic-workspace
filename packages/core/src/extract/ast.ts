import { posix } from 'node:path';
import type { Node } from '@vscode/tree-sitter-wasm';
import type { ImportRecord, Lang, SymbolRecord } from '../types.js';
import type { LanguageSpec } from './parser.js';

export function* walk(node: Node): Generator<Node> {
  const pending: Node[] = [node];
  while (pending.length) {
    const current = pending.pop()!;
    yield current;
    const nested = children(current);
    for (let index = nested.length - 1; index >= 0; index--) pending.push(nested[index]);
  }
}
export function children(node: Node): Node[] { return node.namedChildren.filter((child): child is Node => child !== null); }
export function field(node: Node, name: string): Node | null { return node.childForFieldName(name); }
export function unquote(text: string): string { return text.replace(/^["'`]|["'`]$/g, ''); }
export function enclosing(node: Node, predicate: (node: Node) => boolean): Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (predicate(parent)) return parent;
}

export function symbolFrom(node: Node, path: string, lang: Lang, spec: LanguageSpec): SymbolRecord | undefined {
  let kind = spec.symbols[node.type];
  const nameNode = field(node, 'name');
  if (!kind || !nameNode) return;
  const name = nameNode.text;
  if (node.type === 'variable_declarator') {
    if (!/^(identifier|shorthand_property_identifier_pattern)$/.test(nameNode.type)) return;
    const value = field(node, 'value');
    if (value && /arrow_function|function_expression|generator_function/.test(value.type)) {
      kind = /^[A-Z]/.test(name) && [...walk(value)].some(n => n.type.startsWith('jsx_') || (n.type === 'call_expression' && /createElement$/.test(field(n, 'function')?.text ?? ''))) ? 'component' : 'function';
    }
  }
  const parent = enclosing(node, n => /^(class_declaration|abstract_class_declaration|class_definition|class|impl_item|interface_declaration|struct_declaration|record_declaration)$/.test(n.type));
  let parentName = parent && (field(parent, 'name') ?? field(parent, 'type'))?.text;
  const receiver = field(node, 'receiver');
  if (receiver) parentName = receiver.text.replace(/\*|\(|\)/g, '').trim().split(/\s+/).at(-1);
  if (parentName && (kind === 'function' || kind === 'method')) kind = 'method';
  const declaration = enclosing(node, n => /^(export_statement|decorated_definition)$/.test(n.type));
  const scope = enclosing(node, n => /^(function_declaration|function_definition|arrow_function|function_expression|method_definition|method_declaration)$/.test(n.type));
  let exported = (declaration?.type === 'export_statement' && !scope) || /\b(public|pub)\b/.test(node.text.split('{')[0]);
  if (lang === 'python' || lang === 'ruby') exported = !name.startsWith('_');
  if (lang === 'go') exported = /^[A-Z]/.test(name);
  if (kind === 'function' && /^[A-Z]/.test(name) && [...walk(node)].some(n => n.type.startsWith('jsx_') || (n.type === 'call_expression' && /createElement$/.test(field(n, 'function')?.text ?? '')))) kind = 'component';
  const startLine = node.startPosition.row + 1;
  const signature = node.text.slice(0, field(node, 'body') ? field(node, 'body')!.startIndex - node.startIndex : node.text.length).replace(/\s+/g, ' ').trim().slice(0, 200);
  return { id: `${path}#${name}@${startLine}`, path, name, kind, startLine, endLine: node.endPosition.row + 1, exported, signature, ...(parentName && kind === 'method' ? { parent: parentName } : {}) };
}

function resolveImport(path: string, specifier: string, files: ReadonlySet<string>, lang: Lang): string | undefined {
  // a bare JS/TS specifier is a package ('stripe'), never a sibling file that happens to share its name
  if (['typescript', 'tsx', 'javascript'].includes(lang) && !/^\.{1,2}(\/|$)/.test(specifier)) return undefined;
  let base = posix.normalize(posix.join(posix.dirname(path), specifier));
  if (lang === 'python') {
    const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
    base = dots ? posix.join(posix.dirname(path), ...Array<string>(Math.max(0, dots - 1)).fill('..'), specifier.slice(dots).replaceAll('.', '/')) : specifier.replaceAll('.', '/');
  }
  const bases = [base];
  if (/\.[mc]?jsx?$/.test(base)) bases.push(base.replace(/\.[mc]?jsx?$/, ''), base.replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts'));
  for (const candidate of bases) {
    for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.rb', '.php', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs', '/index.cjs', '/__init__.py']) {
      if (files.has(candidate + suffix)) return candidate + suffix;
    }
  }
}

export function importsFrom(node: Node, path: string, lang: Lang, files: ReadonlySet<string>): ImportRecord[] {
  const text = node.text;
  const found: { specifier: string; names: string[] }[] = [];
  const strings = () => [...walk(node)].filter(n => /^(string|string_literal|interpreted_string_literal|raw_string_literal)$/.test(n.type));
  const add = (specifier: string, names: string[]) => found.push({ specifier, names });
  if (['typescript', 'tsx', 'javascript'].includes(lang)) {
    if (node.type === 'call_expression') {
      if (/^(require|import)$/.test(field(node, 'function')?.text ?? '')) {
        const literal = strings()[0];
        if (literal) add(unquote(literal.text), []);
      }
    } else {
      const source = field(node, 'source');
      if (source) {
        const clause = children(node).find(n => /import_clause|export_clause|namespace_export/.test(n.type));
        const names = clause ? [...walk(clause)].filter(n => n.type === 'identifier' && n.parent?.type !== 'namespace_import' && !(n.parent?.type === 'import_specifier' && field(n.parent, 'alias')?.id === n.id)).map(n => n.text) : [];
        add(unquote(source.text), clause && /\*/.test(clause.text) ? ['*'] : [...new Set(names)]);
      }
    }
  } else if (lang === 'python') {
    const from = text.match(/^from\s+(\S+)\s+import\s+([\s\S]+)/);
    if (from) add(from[1], from[2].replace(/[()]/g, '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    else for (const part of text.replace(/^import\s+/, '').split(',')) { const name = part.trim().split(/\s+as\s+/)[0]; if (name) add(name, [name]); }
  } else if (lang === 'go' && strings()[0]) add(unquote(strings()[0].text), [field(node, 'name')?.text ?? unquote(strings()[0].text).split('/').at(-1)!]);
  else if (lang === 'ruby') { if (/^require(?:_relative)?\s*(?:\(\s*)?["']/.test(text) && strings()[0]) add((text.startsWith('require_relative') ? './' : '') + unquote(strings()[0].text), []); }
  else if (lang === 'php') {
    if (strings()[0]) add(unquote(strings()[0].text), []);
    else { const specifier = text.replace(/^use\s+/, '').replace(/;$/, '').trim(); add(specifier, [specifier.split('\\').at(-1)!]); }
  } else if (lang === 'rust') {
    const specifier = text.replace(/^(?:pub\s+)?(?:use|extern\s+crate)\s+/, '').replace(/;$/, '');
    add(specifier, specifier.includes('{') ? specifier.split('{')[1].split('}')[0].split(',').map(s => s.trim()) : [specifier.split('::').at(-1)!]);
  } else if (lang === 'java' || lang === 'csharp') {
    const specifier = text.replace(/^(?:import|using)\s+(?:static\s+)?/, '').replace(/;$/, '').trim(); add(specifier, [specifier.split('.').at(-1)!]);
  }
  return found.map(({ specifier, names }) => {
    const resolved = resolveImport(path, specifier, files, lang);
    const internal = specifier.startsWith('.') || !!resolved || /^(crate|self|super)::/.test(specifier);
    return { from: path, specifier, names, external: !internal, line: node.startPosition.row + 1, ...(resolved ? { resolved } : {}) };
  });
}
