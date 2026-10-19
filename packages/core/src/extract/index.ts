import type { Tree } from '@vscode/tree-sitter-wasm';
import type { ExtractFile } from '../contracts.js';
import { detectLang, isTestPath } from './lang.js';
import { parseSource } from './parser.js';
import { enclosing, field, importsFrom, symbolFrom, unquote, walk } from './ast.js';
import { extractRoutes } from './routes.js';
import { extractEntities } from './entities.js';
export { detectLang, isTestPath } from './lang.js';

export const extractFile: ExtractFile = async (inputPath, content, knownFiles) => {
  const path = inputPath.replaceAll('\\', '/');
  const lang = detectLang(path);
  const result: Awaited<ReturnType<ExtractFile>> = { lang, isTest: isTestPath(path), symbols: [], imports: [], routes: [], entities: [], tests: [], envVars: [] };
  let tree: Tree | undefined;
  try {
    const parsed = await parseSource(lang, content);
    if (!parsed) return result;
    tree = parsed.tree;
    // Most source files contain no framework records. Avoid materializing every
    // syntax node unless a relevant token is present; symbol/import queries still run.
    const hasRoutes = /\b(?:get|post|put|patch|delete|all|head|options|route|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|HandleFunc|Controller|Get|Post|Put|Patch|Delete|Head|Options|All|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|HeadMapping|OptionsMapping|RequestMapping)\b/.test(content) || /(?:^|\/)(?:app\/.*route\.|pages\/api\/)/.test(path);
    const hasEntities = /\b(?:Entity|Schema|model|define|pgTable|mysqlTable|sqliteTable|Base|Model|DeclarativeBase)\b/.test(content);
    const hasTests = /\b(?:test|it|describe|Test|test_\w+|Test\w+)\b/.test(content);
    const hasEnv = /\b(?:env|environ|getenv|Getenv)\b/.test(content);
    const hasNamedExports = /\bexport\s*\{/.test(content);
    const nodes = hasRoutes || hasEntities || hasTests || hasEnv || hasNamedExports ? [...walk(tree.rootNode)] : [];
    const captures = parsed.query.captures(tree.rootNode);
    const seen = new Set<number>();
    for (const { node } of captures) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const symbol = symbolFrom(node, path, lang, parsed.spec);
      if (symbol) result.symbols.push(symbol);
      if (parsed.spec.imports.includes(node.type)) result.imports.push(...importsFrom(node, path, lang, knownFiles));
    }
    // Named exports can occur after a declaration.
    const exportedNames = new Set(hasNamedExports ? nodes.filter(n => n.type === 'export_specifier').map(n => field(n, 'name')?.text) : []);
    for (const symbol of result.symbols) if (exportedNames.has(symbol.name)) symbol.exported = true;
    if (hasRoutes) result.routes = extractRoutes(path, lang, nodes, result.symbols, result.imports.map(i => i.specifier));
    if (hasEntities) result.entities = extractEntities(path, nodes);
    const envVars = new Set<string>();
    for (const node of nodes) {
      if (hasEnv && /^(member_expression|subscript_expression|call_expression|call|subscript|attribute|method_invocation)$/.test(node.type)) {
        const match = node.text.match(/^(?:process\.env|import\.meta\.env)(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])$|^os\.environ\[\s*['"]([^'"]+)['"]\s*\]$|^(?:os\.(?:getenv|Getenv)|System\.getenv)\(\s*['"]([^'"]+)['"]/);
        if (match) envVars.add(match[1] ?? match[2] ?? match[3] ?? match[4]);
      }
      if (hasTests && node.type === 'call_expression') {
        const fn = field(node, 'function')?.text ?? '';
        if (/^(?:it|test)(?:\.(?:only|skip|todo|concurrent))?$/.test(fn)) {
          const title = field(node, 'arguments')?.namedChildren[0];
          if (title && /^(string|template_string)$/.test(title.type)) {
            const suites: string[] = [];
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (parent.type === 'call_expression' && /^describe(?:\.(?:only|skip))?$/.test(field(parent, 'function')?.text ?? '')) {
                const suite = field(parent, 'arguments')?.namedChildren[0];
                if (suite && /^(string|template_string)$/.test(suite.type)) suites.unshift(unquote(suite.text));
              }
            }
            result.tests.push({ path, line: node.startPosition.row + 1, name: [...suites, unquote(title.text)].join(' > '), framework: result.imports.some(i => i.specifier === 'vitest') ? 'vitest' : result.imports.some(i => /mocha/.test(i.specifier)) ? 'mocha' : 'jest' });
          }
        }
      }
      if (!/^(function_definition|function_declaration|method_declaration)$/.test(node.type) || !['python', 'go', 'java'].includes(lang)) continue;
      const name = field(node, 'name')?.text;
      if (lang === 'python' && node.type === 'function_definition' && name?.startsWith('test_')) {
        const parent = enclosing(node, n => n.type === 'class_definition');
        result.tests.push({ path, line: node.startPosition.row + 1, name: parent ? `${field(parent, 'name')?.text} > ${name}` : name, framework: 'pytest' });
      }
      if (lang === 'go' && node.type === 'function_declaration' && name && /^Test[A-Z_]/.test(name)) result.tests.push({ path, line: node.startPosition.row + 1, name, framework: 'go' });
      if (lang === 'java' && node.type === 'method_declaration' && name && /@Test\b/.test(node.text)) result.tests.push({ path, line: node.startPosition.row + 1, name, framework: 'junit' });
    }
    result.envVars = [...envVars].sort();
  } catch {
    // A broken file or unavailable grammar must not interrupt indexing the project.
  } finally { tree?.delete(); }
  return result;
};
