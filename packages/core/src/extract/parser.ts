import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Language, Parser, Query, Tree } from '@vscode/tree-sitter-wasm';
import type { Lang, SymbolKind } from '../types.js';
import * as typescript from './langs/typescript.js';
import * as python from './langs/python.js';
import * as go from './langs/go.js';
import * as java from './langs/java.js';
import * as csharp from './langs/csharp.js';
import * as php from './langs/php.js';
import * as ruby from './langs/ruby.js';
import * as rust from './langs/rust.js';

export interface LanguageSpec { symbols: Record<string, SymbolKind>; imports: readonly string[]; query: string }
const specs: Partial<Record<Lang, LanguageSpec>> = { typescript, tsx: typescript, javascript: typescript, python, go, java, csharp, php, ruby, rust };
// not named `require`: bundlers inject a module-level `require` shim into ESM output
const resolveFrom = createRequire(import.meta.url);
const wasmDir = process.env.ATOMIC_WASM_DIR || join(dirname(resolveFrom.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
type Runtime = typeof import('@vscode/tree-sitter-wasm');
let runtime: Promise<Runtime> | undefined;
const languages = new Map<string, Promise<{ language: Language; parser: Parser; query: Query }>>();

function loadRuntime(): Promise<Runtime> {
  return runtime ??= import(pathToFileURL(join(wasmDir, 'tree-sitter.js')).href).then(async module => {
    const api: Runtime = module.Parser ? module : module.default;
    await api.Parser.init({ locateFile: file => join(wasmDir, file) });
    return api;
  });
}

export async function parseSource(lang: Lang, content: string): Promise<{ tree: Tree; query: Query; spec: LanguageSpec } | undefined> {
  const spec = specs[lang];
  if (!spec) return;
  const grammar = lang === 'csharp' ? 'c-sharp' : lang;
  let loaded = languages.get(grammar);
  if (!loaded) {
    loaded = loadRuntime().then(async api => {
      const language = await api.Language.load(join(wasmDir, `tree-sitter-${grammar}.wasm`));
      const parser = new api.Parser().setLanguage(language);
      // JS shares TS extraction rules; only compile node types present in this grammar.
      const queryText = spec.query.split('\n').filter(pattern => language.types.includes(pattern.slice(1, pattern.indexOf(')')))).join('\n');
      return { language, parser, query: new api.Query(language, queryText) };
    });
    languages.set(grammar, loaded);
  }
  const { parser, query } = await loaded;
  const tree = parser.parse(content);
  return tree ? { tree, query, spec } : undefined;
}
