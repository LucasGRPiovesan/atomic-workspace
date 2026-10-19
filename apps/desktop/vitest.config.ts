import { defineConfig } from 'vitest/config';

// Unit tests for electron-free logic (main/agents, main/app, renderer reducers). No DOM, no Electron.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 20000,
  },
});
