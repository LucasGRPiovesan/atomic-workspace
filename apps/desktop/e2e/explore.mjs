// Ad-hoc visual pass: node e2e/explore.mjs <outDir>. Launches the built app on a temp copy of the fixture.
import { _electron as electron } from 'playwright-core';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = import.meta.dirname;
const out = resolve(process.argv[2] ?? join(here, '../.e2e-shots'));
const fixture = resolve(here, '../../../fixtures/shop-app');
const tmpRoot = await mkdtemp(join(tmpdir(), 'atomic-explore-'));
// a readable project name in the UI (and in screenshots)
const project = join(tmpRoot, 'shop-app');
await cp(fixture, project, { recursive: true, filter: (s) => !s.includes('.atomic') });

const env = { ...process.env };
delete env.ELECTRON_RENDERER_URL;
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'), args: [join(here, '../out/main/index.js'), '--project', project], env });
const page = await app.firstWindow();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.setViewportSize({ width: 1480, height: 920 }).catch(() => undefined);
await page.waitForTimeout(4000);
await page.screenshot({ path: join(out, '01-overview.png') });
for (const [i, name] of ['System map', 'Data model', 'Flows', 'Changes', 'Memory'].entries()) {
  const tab = page.getByRole('navigation', { name: 'System views' }).getByText(name, { exact: false }).first();
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(1200); await page.screenshot({ path: join(out, `0${i + 2}-${name.replace(/\s/g, '-')}.png`) }); }
  else errors.push(`no tab ${name}`);
}
// node drawer from the map
try {
  await page.getByRole('navigation', { name: 'System views' }).getByText('System map').click({ timeout: 5000 });
  await page.waitForTimeout(800);
  const firstNode = page.locator('.react-flow__node').first();
  if (await firstNode.count()) { await firstNode.click(); await page.waitForTimeout(800); await page.screenshot({ path: join(out, '08-drawer.png') }); }
} catch (e) {
  errors.push(`drawer step: ${e.message.split('\n')[0]}`);
  await page.screenshot({ path: join(out, '08-drawer-failed.png') });
}

// application mode: run the fixture server, click inside the app, read the behavior panel
await page.getByRole('group', { name: 'Mode' }).getByText('Application').click();
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, '09-app-idle.png') });
const script = page.getByLabel('Script');
if (await script.locator('option[value="start"]').count()) await script.selectOption('start');
await page.getByText('▶ Run').click();
await page.locator('.badge', { hasText: /running|exited|failed|crashed/i }).first().waitFor({ timeout: 20000 }).catch(() => undefined);
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, '10-app-running.png') });
await page.getByRole('button', { name: 'Logs' }).click();
console.log('LOGS:', (await page.locator('.appmode-panel').innerText()).slice(0, 1500));
await page.getByRole('button', { name: 'Behavior' }).click();
const clicked = await page.evaluate(async () => {
  const wv = document.querySelector('webview');
  if (!wv) return 'no webview';
  // open the first product, then add it to the cart: two user actions that hit /api/products/:id and /api/cart/items
  return wv.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 20 && !document.querySelector('.product-card button'); i++) await wait(150);
    const card = document.querySelector('.product-card button:not([disabled])');
    if (!card) return 'no product card';
    card.click(); await wait(800);
    const add = document.querySelector('.detail-actions button:not(.secondary):not([disabled])');
    if (add) { add.click(); await wait(500); }
    return card.innerText.trim() + (add ? ' → ' + add.innerText.trim() : '');
  })()`);
}).catch((e) => `err ${e.message}`);
console.log('clicked:', clicked);
await page.waitForTimeout(2500);
await page.screenshot({ path: join(out, '11-app-trace.png') });
await page.getByText('■ Stop').click().catch(() => undefined);

console.log('project', project);
console.log(errors.join('\n') || 'no console errors');
console.log((await page.locator('body').innerText()).slice(0, 1500));
await app.close();
if (!process.argv.includes('--keep')) await rm(tmpRoot, { recursive: true, force: true });
