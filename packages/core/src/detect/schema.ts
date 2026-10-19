import type { EntityField, EntityRecord } from '../types.js';

function args(first: string, second: string | undefined, extension: string): [string, string] {
  return second !== undefined && first.trim().endsWith(extension) && !first.includes('\n') ? [second, first] : [first, second ?? `schema${extension}`];
}

/** Accepts source followed by its project path; path-first callers are also supported. */
export function parsePrismaSchema(source: string, path?: string): EntityRecord[] {
  [source, path] = args(source, path, '.prisma');
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
  const blocks = [...clean.matchAll(/\bmodel\s+(\w+)\s*\{([^}]*)\}/g)];
  const models = new Set(blocks.map(m => m[1]));
  const entities: EntityRecord[] = [];
  const metadata = new Map<string, { name: string; type: string; list: boolean; attributes: string }[]>();
  for (const match of blocks) {
    const fields: EntityField[] = [];
    const info: { name: string; type: string; list: boolean; attributes: string }[] = [];
    for (const line of match[2].split(/\r?\n/)) {
      const field = line.match(/^\s*(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
      if (!field) continue;
      fields.push({ name: field[1], type: field[2] + (field[3] ?? ''), optional: field[3] === '?', isId: /@id\b/.test(field[4]) });
      info.push({ name: field[1], type: field[2], list: field[3] === '[]', attributes: field[4] });
    }
    const composite = match[2].match(/@@id\(\[([^\]]+)\]/)?.[1].split(',').map(s => s.trim()) ?? [];
    for (const field of fields) if (composite.includes(field.name)) field.isId = true;
    metadata.set(match[1], info);
    entities.push({ id: `entity:${match[1]}`, name: match[1], source: 'prisma', path, line: clean.slice(0, match.index).split('\n').length, fields, relations: [] });
  }
  for (const entity of entities) {
    for (const field of metadata.get(entity.name) ?? []) {
      if (!models.has(field.type)) continue;
      const relationName = field.attributes.match(/@relation\(\s*"([^"]+)"/)?.[1];
      const inverse = (metadata.get(field.type) ?? []).find(f => f.type === entity.name && (!relationName || f.attributes.includes(`"${relationName}"`)));
      const foreignFields = field.attributes.match(/fields\s*:\s*\[([^\]]+)\]/)?.[1].split(',').map(s => s.trim()) ?? [];
      const unique = foreignFields.length > 0 && foreignFields.every(name => (metadata.get(entity.name) ?? []).some(f => f.name === name && /@(?:unique|id)\b/.test(f.attributes)));
      entity.relations.push({ field: field.name, target: field.type, kind: field.list ? inverse?.list ? 'n-n' : '1-n' : inverse?.list ? 'n-1' : unique || inverse ? '1-1' : 'n-1' });
    }
  }
  return entities;
}

function splitColumns(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === quote && text[index + 1] === quote) index++; else if (char === quote) quote = ''; continue; }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

export function parseSqlSchema(source: string, path?: string): EntityRecord[] {
  [source, path] = args(source, path, '.sql');
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/--[^\n]*/g, '');
  const entities: EntityRecord[] = [];
  const identifier = '(?:["`\\[]?[\\w]+["`\\]]?\\.)?["`\\[]?([\\w]+)["`\\]]?';
  const tables = new RegExp('\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + identifier + '\\s*\\(', 'gi');
  for (const match of clean.matchAll(tables)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    let quote = '';
    for (; end < clean.length && depth; end++) {
      const char = clean[end];
      if (quote) { if (char === quote && clean[end + 1] === quote) end++; else if (char === quote) quote = ''; continue; }
      if (char === "'" || char === '"' || char === '`') quote = char;
      else if (char === '(') depth++;
      else if (char === ')') depth--;
    }
    const entity: EntityRecord = { id: `entity:${match[1]}`, name: match[1], source: 'sql', path, line: clean.slice(0, match.index).split('\n').length, fields: [], relations: [] };
    const columns = splitColumns(clean.slice(start, depth === 0 ? end - 1 : end));
    for (const column of columns) {
      const field = column.trim().match(/^["`\[]?(\w+)["`\]]?\s+([\w]+(?:\s*\([^)]*\))?(?:\[\])?)/);
      if (field && !/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|KEY)$/i.test(field[1])) entity.fields.push({ name: field[1], type: field[2], optional: !/NOT\s+NULL|PRIMARY\s+KEY/i.test(column), isId: /PRIMARY\s+KEY/i.test(column) });
      const foreign = column.match(/FOREIGN\s+KEY\s*\(([^)]+)\)/i);
      const reference = column.match(new RegExp('REFERENCES\\s+' + identifier, 'i'));
      if (reference) {
        const names = foreign ? foreign[1].replace(/["`\[\]]/g, '').split(',').map(s => s.trim()) : field ? [field[1]] : [];
        for (const name of names) if (!entity.relations.some(r => r.field === name && r.target === reference[1])) entity.relations.push({ field: name, target: reference[1], kind: /\bUNIQUE\b/i.test(column) ? '1-1' : 'n-1' });
      }
      if (/^\s*(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY/i.test(column)) {
        const keys = column.match(/\(([^)]+)\)/)?.[1].replace(/["`\[\]]/g, '').split(',').map(s => s.trim()) ?? [];
        for (const item of entity.fields) if (keys.includes(item.name)) { item.isId = true; item.optional = false; }
      }
    }
    entities.push(entity);
  }
  return entities;
}
