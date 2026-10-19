import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// @atomic/core is TypeScript source inside the monorepo: it must be bundled, not externalized.
const core = { exclude: ['@atomic/core'] };

export default defineConfig({
  main: {
    build: {
      externalizeDeps: core,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // stdio MCP server spawned by coding agents (ELECTRON_RUN_AS_NODE=1)
          mcp: resolve(__dirname, 'src/main/mcp-entry.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // injected into the Application webview to capture clicks/navigation
          webview: resolve(__dirname, 'src/preload/webview.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
      isolatedEntries: true,
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
    plugins: [react()],
  },
});
