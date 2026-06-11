import os from 'node:os';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { externalRenderers } from './vite-plugins/external-renderers';

export default defineConfig({
  plugins: [react(), externalRenderers()],
  resolve: {
    alias: {
      '@app': path.resolve(__dirname, 'src'),
    },
  },
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    fs: {
      allow: [path.resolve(os.homedir(), '.config', 'engin')],
    },
    proxy: {
      '/api': 'http://localhost:3619',
      '/ws': {
        target: 'ws://localhost:3619',
        ws: true,
      },
    },
  },
});
