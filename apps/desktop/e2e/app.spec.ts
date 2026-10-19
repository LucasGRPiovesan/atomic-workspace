import { test, expect } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const here = import.meta.dirname;
const fixture = resolve(here, '../../../fixtures/shop-app');
const mainPath = resolve(here, '../out/main/index.js');
const mcpPath = resolve(here, '../out/main/mcp.js');

let projectDir: string;
let app: Awaited<ReturnType<typeof electron.launch>>;
let page: Awaited<ReturnType<typeof app.firstWindow>>;

test.beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'atomic-e2e-'));
  await cp(fixture, projectDir, { recursive: true, filter: (s) => !s.includes('.atomic') });

  // a dev-server URL or node mode inherited from the parent shell would break the packaged launch
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (e): e is [string, string] => e[1] !== undefined && e[0] !== 'ELECTRON_RENDERER_URL' && e[0] !== 'ELECTRON_RUN_AS_NODE',
  ));

  app = await electron.launch({
    executablePath: require('electron'),
    args: [mainPath, '--project', projectDir],
    env,
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1480, height: 920 });
});

test.afterAll(async () => {
  try { await app.close(); } catch {}
  try { await rm(projectDir, { recursive: true, force: true }); } catch {}
});

test('opens the project and shows the system', async () => {
  // Overview is the default section
  await expect(page.getByRole('group', { name: 'Mode' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Development' })).toHaveClass(/is-active/);
  await expect(page.getByRole('navigation', { name: 'System views' })).toBeVisible();
  await expect(page.getByText('Overview')).toBeVisible();

  // Status bar shows routes and entities
  const statusbar = page.locator('footer.statusbar');
  await expect(statusbar).toContainText('10 routes');
  await expect(statusbar).toContainText('7 entities');

  // Click System map tab
  await page.getByRole('navigation', { name: 'System views' }).getByText('System map').click();

  // At least 10 .react-flow__node elements
  const nodes = page.locator('.react-flow__node');
  await expect(async () => {
    const count = await nodes.count();
    expect(count).toBeGreaterThan(9);
  }).toPass({ timeout: 5000 });

  // Click first node and expect "Node detail" drawer
  await nodes.first().click();
  await expect(page.getByText('Node detail')).toBeVisible({ timeout: 5000 });
});

test('agent knowledge recorded over MCP shows up in the app', async () => {
  // Connect MCP client
  const transport = new StdioClientTransport({
    command: require('electron'),
    args: [mcpPath, '--project', projectDir, '--agent', 'e2e'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const client = new Client({ name: 'e2e-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    // atomic_overview returns non-empty text containing "shop" or a module name
    const overviewResult = await client.callTool({ name: 'atomic_overview', arguments: {} });
    const overviewText = (overviewResult.content as { type: 'text'; text: string }[])[0]!.text;
    expect(overviewText).toBeTruthy();
    expect(overviewText.toLowerCase()).toMatch(/shop|module/);

    // Record a rule with unique title anchored to src/orders/pricing.ts
    const uniqueTitle = `E2E rule ${Date.now()}`;
    await client.callTool({
      name: 'atomic_record',
      arguments: {
        items: [
          {
            kind: 'rule',
            title: uniqueTitle,
            summary: 'E2E test rule for pricing validation',
            anchors: [{ path: 'src/orders/pricing.ts' }],
          },
        ],
      },
    });

    // In the app, open Memory and expect the title visible within 10s
    await page.getByRole('navigation', { name: 'System views' }).getByText('Memory').click();
    await expect(page.getByText(uniqueTitle)).toBeVisible({ timeout: 10000 });
  } finally {
    await client.close();
  }
});

test('application mode traces a click to a route', async () => {
  // Switch to Application mode
  await page.getByRole('group', { name: 'Mode' }).getByText('Application').click();
  await expect(page.getByRole('button', { name: 'Application' })).toHaveClass(/is-active/);

  // Select script "start"
  const scriptSelect = page.getByLabel('Script');
  await expect(scriptSelect).toBeVisible();
  await scriptSelect.selectOption('start');

  // Click Run button
  await page.getByText('▶ Run').click();

  // Expect "Running" status within 30s
  await expect(page.locator('.badge.badge-ok', { hasText: 'Running' })).toBeVisible({ timeout: 30_000 });

  try {
    // the webview attaches and loads asynchronously: retry until it accepts scripts and shows products
    await expect(async () => {
      const clicked = await page.evaluate(() => {
        const wv = document.querySelector('webview') as (HTMLElement & { executeJavaScript(code: string): Promise<string> }) | null;
        if (!wv) throw new Error('no webview');
        return wv.executeJavaScript(`(() => {
          const card = document.querySelector('.product-card button:not([disabled])');
          if (!card) return 'no product card';
          card.click();
          return 'clicked: ' + card.innerText.trim();
        })()`);
      });
      expect(clicked).toMatch(/^clicked: /);
    }).toPass({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Behavior' }).click();
    await expect(page.getByRole('button', { name: 'GET /api/products/:id' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'src/catalog/routes.ts:12' })).toBeVisible({ timeout: 15_000 });
  } finally {
    // never leave the shop server running, even when an assertion above failed
    await page.getByText('■ Stop').click();
  }
  await expect(page.locator('.badge', { hasText: 'Stopped' })).toBeVisible({ timeout: 5_000 });
});
