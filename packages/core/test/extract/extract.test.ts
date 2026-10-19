import { describe, expect, it } from 'vitest';
import { detectLang, extractFile, isTestPath } from '../../src/extract/index.js';

const extract = (source: string, path = 'src/example.ts', files: string[] = []) => extractFile(path, source, new Set(files));

describe('language and path detection', () => {
  it.each([['x.ts', 'typescript'], ['x.tsx', 'tsx'], ['x.jsx', 'javascript'], ['x.py', 'python'], ['x.rs', 'rust'], ['x.cs', 'csharp'], ['x.unknown', 'other']])('%s is %s', (path, lang) => expect(detectLang(path)).toBe(lang));
  it.each(['foo.test.ts', 'foo.spec.tsx', '__tests__/a.js', 'tests/x.py', 'test_a.py', 'a_test.go', 'OrderTest.java', 'src\\tests\\a.ts'])('recognizes %s', path => expect(isTestPath(path)).toBe(true));
  it('does not classify production paths as tests', () => expect(isTestPath('src/contest.ts')).toBe(false));
});

describe('source extraction', () => {
  it('extracts symbols, exports, methods and stable line ids', async () => {
    const result = await extract(`export interface Order { id: string }
export type Id = string;
export enum Status { New }
export class Orders {
  save(input: Order) { return input; }
}
export function createOrder() {}
const internal = () => 1;
const exposed = 1;
export { exposed };`);
    expect(result.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Order', kind: 'interface', exported: true }),
      expect.objectContaining({ name: 'Id', kind: 'type', exported: true }),
      expect.objectContaining({ name: 'Status', kind: 'enum' }),
      expect.objectContaining({ id: 'src/example.ts#save@5', name: 'save', parent: 'Orders', kind: 'method', startLine: 5, endLine: 5 }),
      expect.objectContaining({ name: 'createOrder', kind: 'function', exported: true }),
      expect.objectContaining({ name: 'internal', kind: 'function', exported: false }),
      expect.objectContaining({ name: 'exposed', exported: true }),
    ]));
  });
  it('keeps a bare package import external even when a sibling file shares its name', async () => {
    const r = await extract("import Stripe from 'stripe';\nimport { x } from './stripe';\n", 'src/payments/charge.ts', ['src/payments/stripe.ts', 'src/payments/charge.ts']);
    expect(r.imports).toEqual([
      expect.objectContaining({ specifier: 'stripe', external: true }),
      expect.objectContaining({ specifier: './stripe', external: false, resolved: 'src/payments/stripe.ts' }),
    ]);
    expect(r.imports[0]).not.toHaveProperty('resolved');
  });

  it('resolves relative, index and ESM imports and distinguishes external imports', async () => {
    const result = await extract(`import express from 'express';
import { save as persist } from './service';
import * as utils from './utils';
import './model.js';
const fs = require('node:fs');`, 'src/example.ts', ['src/service.ts', 'src/utils/index.ts', 'src/model.ts']);
    expect(result.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ specifier: 'express', external: true, names: ['express'] }),
      expect.objectContaining({ specifier: './service', external: false, resolved: 'src/service.ts', names: ['save'] }),
      expect.objectContaining({ specifier: './utils', resolved: 'src/utils/index.ts', names: ['*'] }),
      expect.objectContaining({ specifier: './model.js', resolved: 'src/model.ts', names: [] }),
      expect.objectContaining({ specifier: 'node:fs', external: true }),
    ]));
  });
  it('extracts Express route mounts, chain routes, parameters and handler links', async () => {
    const result = await extract(`import express from 'express';
const app = express(); const ordersRouter = express.Router();
function getOrder() {}
ordersRouter.get('/:id', getOrder);
ordersRouter.route('/new').post(getOrder);
app.use('/api/orders', ordersRouter);
app.get('/health', getOrder);`);
    expect(result.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', pattern: '/api/orders/:id', handler: 'getOrder', handlerSymbolId: 'src/example.ts#getOrder@3', framework: 'express' }),
      expect.objectContaining({ method: 'POST', pattern: '/api/orders/new' }),
      expect.objectContaining({ method: 'GET', pattern: '/health' }),
    ]));
    expect(result.routes).toHaveLength(3);
  });
  it('extracts NestJS controller prefixes', async () => {
    const result = await extract(`@Controller('orders')
export class OrdersController {
  @Get(':id')
  findOne() { return 1; }
  @Post('')
  create() {}
}`);
    expect(result.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', pattern: '/orders/:id', framework: 'nest', handler: 'findOne' }),
      expect.objectContaining({ method: 'POST', pattern: '/orders', framework: 'nest' }),
    ]));
  });
  it('extracts Next.js app router methods and parameters', async () => {
    const result = await extract('export async function GET() {}\nexport const POST = async () => {};', 'app/(shop)/orders/[id]/route.ts');
    expect(result.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', pattern: '/orders/:id', framework: 'nextjs-app' }),
      expect.objectContaining({ method: 'POST', pattern: '/orders/:id' }),
    ]));
  });
  it('extracts FastAPI routes, pytest names, imports and environment variables', async () => {
    const result = await extract(`from fastapi import FastAPI
from .models import Order
import os
app = FastAPI()
@app.get('/orders/{id}')
def get_order(id):
    return os.getenv('TOKEN')
def test_order():
    return os.environ['DATABASE_URL']`, 'api/test_orders.py', ['api/models.py']);
    expect(result.routes).toContainEqual(expect.objectContaining({ method: 'GET', pattern: '/orders/:id', framework: 'fastapi', handler: 'get_order' }));
    expect(result.tests).toContainEqual(expect.objectContaining({ name: 'test_order', framework: 'pytest' }));
    expect(result.envVars).toEqual(['DATABASE_URL', 'TOKEN']);
    expect(result.imports).toContainEqual(expect.objectContaining({ specifier: '.models', resolved: 'api/models.py', names: ['Order'] }));
  });
  it('extracts Flask methods and typed parameters', async () => {
    const result = await extract(`from flask import Flask
@app.route('/orders/<int:id>', methods=['GET', 'POST'])
def orders(): pass`, 'app.py');
    expect(result.routes.map(r => [r.method, r.pattern, r.framework])).toEqual([['GET', '/orders/:id', 'flask'], ['POST', '/orders/:id', 'flask']]);
  });
  it('extracts Go gin routes, http handlers, tests and env', async () => {
    const result = await extract(`package main
import "net/http"
func handler() {}
func TestOrders(t *testing.T) {}
func main() {
 r.GET("/orders/:id", handler)
 http.HandleFunc("POST /orders", handler)
 os.Getenv("TOKEN")
}`, 'server_test.go');
    expect(result.routes).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'GET', pattern: '/orders/:id', handler: 'handler' }), expect.objectContaining({ method: 'POST', pattern: '/orders' })]));
    expect(result.tests).toContainEqual(expect.objectContaining({ name: 'TestOrders', framework: 'go' }));
    expect(result.envVars).toEqual(['TOKEN']);
  });
  it('extracts nested vitest names and env without comment/string false positives', async () => {
    const result = await extract(`import { describe, test } from 'vitest';
describe('orders', () => { describe('save', () => { test('works', () => {}); }); });
process.env.TOKEN; process.env['DATABASE_URL']; import.meta.env.PUBLIC_API;
// process.env.IGNORED
const example = 'process.env.IGNORED_TOO';`, 'orders.test.ts');
    expect(result.tests).toEqual([expect.objectContaining({ name: 'orders > save > works', framework: 'vitest' })]);
    expect(result.envVars).toEqual(['DATABASE_URL', 'PUBLIC_API', 'TOKEN']);
  });
  it('extracts code entities and fields', async () => {
    const result = await extract(`@Entity()
export class Order {
 @PrimaryGeneratedColumn() id: number;
 @Column() title: string;
}
const userSchema = new Schema({ email: { type: String, required: true } });
const User = model('User', userSchema);
const products = pgTable('products', { id: integer('id').primaryKey() });`);
    expect(result.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Order', source: 'typeorm', fields: expect.arrayContaining([expect.objectContaining({ name: 'id', isId: true }), expect.objectContaining({ name: 'title' })]) }),
      expect.objectContaining({ name: 'User', source: 'mongoose', fields: [expect.objectContaining({ name: 'email', type: 'String' })] }),
      expect.objectContaining({ name: 'products', source: 'drizzle' }),
    ]));
  });
  it.each([
    ['example.java', 'import java.util.List; public class Example { @Test public void works() {} public int save() { return 1; } }', 'Example', 'save'],
    ['example.cs', 'using System; public class Example { public int Save() { return 1; } }', 'Example', 'Save'],
    ['example.php', '<?php use App\\Order; class Example { public function save() {} }', 'Example', 'save'],
    ['example.rb', 'require "json"\nclass Example\n def save\n end\nend', 'Example', 'save'],
    ['example.rs', 'use std::collections::HashMap; pub struct Example {} impl Example { pub fn save() {} }', 'Example', 'save'],
  ])('supports %s symbols and imports', async (path, source, name, method) => {
    const result = await extract(source, path);
    expect(result.symbols).toContainEqual(expect.objectContaining({ name, kind: 'class' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: method, kind: 'method', parent: name }));
    expect(result.imports.length).toBeGreaterThan(0);
  });
  it('returns partial extraction for malformed input and empty output for unsupported files', async () => {
    expect((await extract('export function intact() {}\nclass Broken {')).symbols).toContainEqual(expect.objectContaining({ name: 'intact' }));
    expect((await extract('anything', 'README.md')).symbols).toEqual([]);
  });
  it('keeps nested declarations private and recognizes TSX function components', async () => {
    const result = await extract('export function Card() { const local = 1; return <div>{local}</div>; }', 'Card.tsx');
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Card', kind: 'component', exported: true }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'local', exported: false }));
  });
  it('extracts Spring routes and JUnit tests', async () => {
    const result = await extract(`@RestController
@RequestMapping("/orders")
public class Orders {
 @GetMapping("/{id}")
 public Order find() { return null; }
 @PostMapping
 public void create() {}
 @Test
 public void testSave() {}
}`, 'Orders.java');
    expect(result.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', pattern: '/orders/:id', handler: 'find' }),
      expect.objectContaining({ method: 'POST', pattern: '/orders', handler: 'create' }),
    ]));
    expect(result.tests).toContainEqual(expect.objectContaining({ name: 'testSave', framework: 'junit' }));
  });
  it('extracts Next.js pages, SQLAlchemy and Django models', async () => {
    const pages = await extract(`export default function handler(req, res) { if (req.method === 'POST') {} }`, 'pages/api/orders/[id].ts');
    expect(pages.routes).toContainEqual(expect.objectContaining({ method: 'POST', pattern: '/api/orders/:id', framework: 'nextjs-pages' }));
    const models = await extract(`class User(Base):
 id = Column(Integer, primary_key=True)
class Order(models.Model):
 title = models.CharField(max_length=100)`, 'models.py');
    expect(models.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'User', source: 'sqlalchemy', fields: [expect.objectContaining({ name: 'id', isId: true })] }),
      expect.objectContaining({ name: 'Order', source: 'django', fields: [expect.objectContaining({ name: 'title' })] }),
    ]));
  });
  it('is deterministic across concurrent extraction', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => extract('export function hello() {}')));
    for (const result of results) expect(result).toEqual(results[0]);
  });
});
