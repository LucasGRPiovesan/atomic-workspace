import type { Node } from '@vscode/tree-sitter-wasm';
import type { EntityField, EntityRecord } from '../types.js';
import { children, field, walk } from './ast.js';

export function extractEntities(path: string, nodes: Node[]): EntityRecord[] {
  const entities: EntityRecord[] = [];
  const schemas = new Map<string, EntityField[]>();
  const fieldsFrom = (node: Node): EntityField[] => {
    const object = node.type === 'object' || node.type === 'dictionary' ? node : [...walk(node)].find(n => n.type === 'object' || n.type === 'dictionary');
    if (!object) return [];
    return children(object).filter(n => /^(pair|shorthand_property_identifier)$/.test(n.type)).map(n => {
      const key = field(n, 'key')?.text.replace(/['"]/g, '') ?? n.text;
      const value = field(n, 'value')?.text ?? 'unknown';
      return { name: key, type: value.match(/type\s*:\s*([\w.]+)/)?.[1] ?? value.split(/[({]/)[0].trim(), optional: !/required\s*:\s*true|notNull\(/.test(value), isId: key === '_id' || /primaryKey\(/.test(value) };
    });
  };
  const add = (name: string, source: EntityRecord['source'], node: Node, fields: EntityField[]) => {
    if (!entities.some(e => e.name === name && e.source === source)) entities.push({ id: `entity:${name}`, name, source, path, line: node.startPosition.row + 1, fields, relations: [] });
  };
  for (const node of nodes.filter(n => n.type === 'variable_declarator')) {
    const value = field(node, 'value');
    if (value && /^new\s+(?:mongoose\.)?Schema\s*\(/.test(value.text)) schemas.set(field(node, 'name')?.text ?? '', fieldsFrom(value));
  }
  for (const node of nodes) {
    if (node.type === 'class_declaration' || node.type === 'class_definition') {
      const head = node.text.slice(0, node.text.indexOf('{') < 0 ? node.text.indexOf(':') : node.text.indexOf('{'));
      const before = node.parent ? node.parent.text.slice(0, node.startIndex - node.parent.startIndex) : '';
      const source = /@Entity\b/.test(head + before) ? 'typeorm' : /\bmodels\.Model\b/.test(head) ? 'django' : /\b(?:Base|db\.Model|DeclarativeBase)\b/.test(head) ? 'sqlalchemy' : undefined;
      const name = field(node, 'name')?.text;
      if (name && source) {
        const fields: EntityField[] = [];
        for (const child of walk(node)) {
          if (/^(public_field_definition|property_declaration|field_declaration)$/.test(child.type)) {
            const fieldName = field(child, 'name')?.text;
            if (fieldName) fields.push({ name: fieldName, type: field(child, 'type')?.text.replace(/^:\s*/, '') ?? 'unknown', optional: /\?/.test(child.text), isId: /@Primary/.test(child.text) });
          } else if (child.type === 'assignment') {
            const left = field(child, 'left');
            const right = field(child, 'right');
            if (left?.type === 'identifier' && right && /(?:Column|mapped_column|\w+Field)\(/.test(right.text)) fields.push({ name: left.text, type: right.text.match(/(?:Column|mapped_column)\(\s*(\w+)/)?.[1] ?? right.text.split('(')[0], optional: /(?:nullable|null)\s*=\s*True/.test(right.text), isId: /primary_key\s*=\s*True/.test(right.text) });
          }
        }
        add(name, source, node, fields);
      }
    }
    if (node.type === 'call_expression') {
      const match = node.text.match(/^(?:(?:\w+)\.)?(model|define|pgTable|mysqlTable|sqliteTable)\(\s*['"]([^'"]+)['"]\s*,/);
      if (match) {
        const args = field(node, 'arguments');
        const schema = args?.namedChildren[1];
        add(match[2], match[1] === 'model' ? 'mongoose' : match[1] === 'define' ? 'sequelize' : 'drizzle', node, schema ? schemas.get(schema.text) ?? fieldsFrom(schema) : []);
      }
    }
  }
  for (const [name, fields] of schemas) {
    if (!entities.some(e => e.source === 'mongoose' && e.fields === fields)) {
      const node = nodes.find(n => n.type === 'variable_declarator' && field(n, 'name')?.text === name);
      if (node) add(name.replace(/Schema$/, ''), 'mongoose', node, fields);
    }
  }
  return entities;
}
