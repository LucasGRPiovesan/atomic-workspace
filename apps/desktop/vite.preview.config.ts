import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer-only preview in a normal browser, backed by src/renderer/src/mock (no Electron).
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  plugins: [react()],
  server: { port: 5199, strictPort: true },
});
