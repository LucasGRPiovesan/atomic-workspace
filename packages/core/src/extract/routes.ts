import type { Node } from '@vscode/tree-sitter-wasm';
import type { HttpMethod, Lang, RouteFramework, RouteRecord, SymbolRecord } from '../types.js';
import { children, enclosing, field, unquote } from './ast.js';

export function normalizeRoute(pattern: string): string {
  return ('/' + pattern).replace(/\[\.\.\.([^\]]+)\]/g, ':$1*').replace(/\[([^\]]+)\]/g, ':$1').replace(/\{([^}:]+)(?::[^}]+)?\}/g, ':$1').replace(/<(?:[^:>]+:)?([^>]+)>/g, ':$1').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

export function extractRoutes(path: string, lang: Lang, nodes: Node[], symbols: SymbolRecord[], imports: string[]): RouteRecord[] {
  const result: RouteRecord[] = [];
  const prefixes = new Map<string, { prefix: string; parent: string }>();
  const calls = nodes.filter(n => /^(call_expression|call|method_invocation)$/.test(n.type));
  for (const node of calls) {
    const match = node.text.match(/^(\w+)\.use\(\s*['"]([^'"]*)['"]\s*,\s*(\w+)\s*\)/);
    if (match) prefixes.set(match[3], { parent: match[1], prefix: match[2] });
  }
  const prefixFor = (name: string, visited = new Set<string>()): string => {
    if (visited.has(name)) return '';
    visited.add(name);
    const mount = prefixes.get(name);
    return mount ? prefixFor(mount.parent, visited) + '/' + mount.prefix : '';
  };
  const add = (method: string, pattern: string, framework: RouteFramework, node: Node, handler?: string) => {
    const verb = method.toUpperCase() === 'ALL' ? 'ANY' : method.toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)$/.test(verb)) return;
    const normalized = normalizeRoute(pattern);
    const symbol = handler && symbols.find(s => s.name === handler);
    const record: RouteRecord = { id: `route:${verb} ${normalized}`, path, line: node.startPosition.row + 1, method: verb as HttpMethod, pattern: normalized, framework, ...(handler ? { handler } : {}), ...(symbol ? { handlerSymbolId: symbol.id } : {}) };
    if (!result.some(r => r.id === record.id && r.line === record.line)) result.push(record);
  };
  const jsFramework: RouteFramework = imports.includes('fastify') ? 'fastify' : imports.some(i => /koa/.test(i)) ? 'koa' : imports.includes('hono') ? 'hono' : 'express';
  for (const node of calls) {
    const fn = field(node, 'function');
    const args = field(node, 'arguments');
    if (fn && args) {
      const member = fn.text.match(/^(\w+)\.(get|post|put|patch|delete|all|head|options|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/);
      const first = args.namedChildren[0];
      if (member && lang !== 'python' && first && /^(string|string_literal|interpreted_string_literal|raw_string_literal)$/.test(first.type)) {
        const handlerNode = args.namedChildren.at(-1);
        const handler = handlerNode && /^(identifier|selector_expression|member_expression)$/.test(handlerNode.type) ? handlerNode.text : undefined;
        add(member[2], prefixFor(member[1]) + '/' + unquote(first.text), lang === 'go' ? 'unknown' : jsFramework, node, handler);
      }
      const chained = fn.text.match(/^(\w+)\.route\(\s*['"]([^'"]+)['"]\s*\)(?:\.[\s\S]*)?\.(get|post|put|patch|delete|all|head|options)$/);
      if (chained) {
        const handler = args.namedChildren[0];
        add(chained[3], prefixFor(chained[1]) + '/' + chained[2], jsFramework, node, handler?.type === 'identifier' ? handler.text : undefined);
      }
      if (lang === 'go' && /(?:^|\.)HandleFunc$/.test(fn.text) && first) {
        const raw = unquote(first.text);
        const match = raw.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.*)$/);
        add(match?.[1] ?? 'ANY', match?.[2] ?? raw, 'unknown', node, args.namedChildren[1]?.text);
      }
    }
  }
  if (lang === 'python') {
    for (const node of nodes.filter(n => n.type === 'decorated_definition')) {
      const definition = children(node).find(n => n.type === 'function_definition');
      if (!definition) continue;
      for (const decorator of children(node).filter(n => n.type === 'decorator')) {
        const match = decorator.text.match(/^@\w+\.(get|post|put|patch|delete|head|options|route)\(\s*['"]([^'"]*)['"]/);
        if (!match) continue;
        const flask = match[1] === 'route' || imports.some(i => i.startsWith('flask'));
        const methods = match[1] === 'route' ? [...(decorator.text.match(/methods\s*=\s*\[([^\]]*)\]/)?.[1] ?? "'GET'").matchAll(/['"]([A-Z]+)['"]/g)].map(m => m[1]) : [match[1]];
        for (const method of methods) add(method, match[2], flask ? 'flask' : 'fastapi', decorator, field(definition, 'name')?.text);
      }
    }
  }
  for (const node of nodes.filter(n => /^(method_definition|method_declaration)$/.test(n.type))) {
    const parent = enclosing(node, n => n.type === 'class_declaration');
    const controller = parent?.text.match(/@Controller\(\s*['"]([^'"]*)['"]\s*\)/) ?? parent?.parent?.text.slice(0, parent.startIndex - parent.parent.startIndex).match(/@Controller\(\s*['"]([^'"]*)['"]\s*\)/);
    const springPrefix = parent?.text.slice(0, parent.text.indexOf('{')).match(/@RequestMapping\(\s*(?:(?:value|path)\s*=\s*)?['"]([^'"]*)['"]/);
    const body = field(node, 'body');
    const decorators = node.text.slice(0, body ? body.startIndex - node.startIndex : node.text.length);
    const siblings = node.parent ? children(node.parent) : [];
    const index = siblings.findIndex(n => n.id === node.id);
    const adjacent: Node[] = [];
    for (let offset = index - 1; offset >= 0 && siblings[offset].type === 'decorator'; offset--) adjacent.unshift(siblings[offset]);
    const preceding = adjacent.map(n => n.text).join('\n');
    for (const match of (preceding + '\n' + decorators).matchAll(/@(Get|Post|Put|Patch|Delete|Head|Options|All)(Mapping)?\(\s*(?:(?:value|path)\s*=\s*)?['"]([^'"]*)['"]/g)) {
      add(match[1], (controller?.[1] ?? springPrefix?.[1] ?? '') + '/' + match[3], match[2] ? 'unknown' : 'nest', node, field(node, 'name')?.text);
    }
    for (const match of (preceding + '\n' + decorators).matchAll(/@(Get|Post|Put|Patch|Delete|Head|Options|All)(Mapping)?(?:\(\s*\))?(?![\w(])/g)) {
      add(match[1], controller?.[1] ?? springPrefix?.[1] ?? '', match[2] ? 'unknown' : 'nest', node, field(node, 'name')?.text);
    }
    for (const match of decorators.matchAll(/@RequestMapping\(\s*(?:(?:value|path)\s*=\s*)?['"]([^'"]*)['"]([^)]*)\)/g)) {
      const methods = [...match[2].matchAll(/RequestMethod\.(\w+)/g)].map(m => m[1]);
      for (const method of methods.length ? methods : ['ANY']) add(method, (springPrefix?.[1] ?? '') + '/' + match[1], 'unknown', node, field(node, 'name')?.text);
    }
  }
  const appRoute = path.match(/(?:^|\/)app\/(.*?)\/?route\.[mc]?[jt]sx?$/);
  if (appRoute) {
    const pattern = appRoute[1].split('/').filter(s => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/');
    for (const symbol of symbols.filter(s => s.exported && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(s.name))) {
      const node = nodes.find(n => n.startPosition.row + 1 === symbol.startLine) ?? nodes[0];
      if (node) add(symbol.name, pattern, 'nextjs-app', node, symbol.name);
    }
  }
  const pagesRoute = path.match(/(?:^|\/)pages\/(api\/.*?)\.[jt]sx?$/);
  if (pagesRoute && nodes[0]) {
    const methods = [...nodes.filter(n => /^(binary_expression|switch_case)$/.test(n.type)).flatMap(n => [...n.text.matchAll(/['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/g)].map(m => m[1]))];
    for (const method of new Set(methods.length ? methods : ['ANY'])) add(method, pagesRoute[1].replace(/\/index$/, ''), 'nextjs-pages', nodes[0], symbols.find(s => s.exported)?.name);
  }
  return result;
}
