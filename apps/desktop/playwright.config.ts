import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 120_000,
  retries: 0,
  reporter: 'list',
  use: {
    headless: true,
  },
});