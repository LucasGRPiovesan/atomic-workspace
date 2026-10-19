// Manual check with a real agent: node e2e/agent-run.mjs <outDir> [agentId=opencode] [--keep]
// Starts an agent session in the built app on a temp copy of the fixture, asks it to use the atomic MCP tools,
// then checks that what it recorded reached the project memory. OpenCode runs on a free model unless
// OPENCODE_CONFIG_CONTENT is already set.
import { _electron as electron } from 'playwright-core';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = import.meta.dirname;
const out = resolve(process.argv[2] ?? join(here, '../.e2e-shots'));
const agentId = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'opencode';
const fixture = resolve(here, '../../../fixtures/shop-app');
const tmpRoot = await mkdtemp(join(tmpdir(), 'atomic-agent-'));
const project = join(tmpRoot, 'shop-app');
await cp(fixture, project, { recursive: true, filter: (s) => !s.includes('.atomic') });

const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'opencode/nemotron-3-ultra-free' }), ...process.env };
delete env.ELECTRON_RENDERER_URL;
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'), args: [join(here, '../out/main/index.js'), '--project', project], env });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1480, height: 920 }).catch(() => undefined);
await page.getByRole('navigation', { name: 'System views' }).waitFor({ timeout: 30000 });

const title = `Agent e2e rule ${Date.now()}`;
let verdict = 'FAIL';
try {
  await page.locator('select[aria-label="Agent"]').selectOption(agentId);
  await page.getByRole('button', { name: 'Start session' }).click();
  const input = page.locator('.ag-input');
  await page.waitForFunction(() => { const el = document.querySelector('.ag-input'); return el && !el.disabled; }, null, { timeout: 90000 });
  await input.fill([
    'Use the atomic MCP tools only (do not read files or run commands).',
    '1) Call atomic_overview and tell me in one sentence what this project is.',
    `2) Call atomic_record with one item: kind "rule", title "${title}", summary "Order totals add 19% tax on the subtotal", anchors [{"path":"src/orders/pricing.ts"}].`,
    'Reply DONE when both calls succeeded.',
  ].join('\n'));
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForFunction(() => { const el = document.querySelector('.ag-input'); return el && !el.disabled; }, null, { timeout: 240000 });
  await page.screenshot({ path: join(out, '20-agent-chat.png') });
  console.log('TOOLS:', (await page.locator('.ag-tool-title').allInnerTexts()).join(' | '));
  console.log('AGENT:', (await page.locator('.ag-agent').allInnerTexts()).join('\n---\n').slice(0, 1200));
  await page.getByRole('navigation', { name: 'System views' }).getByText('Memory').click();
  await page.getByText(title).first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(out, '21-agent-memory.png') });
  verdict = 'PASS';
} catch (e) {
  console.log('error:', e.message.split('\n')[0]);
  await page.screenshot({ path: join(out, '20-agent-failed.png') }).catch(() => undefined);
  console.log((await page.locator('.ag').innerText().catch(() => '')).slice(0, 1500));
}
console.log(`${verdict}: recorded "${title}" ${verdict === 'PASS' ? 'is' : 'is NOT'} visible in Memory`);
await app.close();
if (!process.argv.includes('--keep')) await rm(tmpRoot, { recursive: true, force: true });
