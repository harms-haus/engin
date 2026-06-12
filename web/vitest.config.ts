import react from '@vitejs/plugin-react';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { externalRenderers } from './vite-plugins/external-renderers';

export default defineConfig({
  plugins: [react(), externalRenderers()],
  resolve: {
    alias: {
      '@app': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    fs: {
      allow: [path.resolve(os.homedir(), '.config', 'engin')],
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
    },
    projects: [
      // Main project — in-tree tests under src/
      {
        extends: true,
        test: {
          name: 'main',
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },

      // External project — workflow renderer tests living outside the repo
      {
        extends: true,
        plugins: [react()],
        resolve: {
          alias: {
            '@app': path.resolve(__dirname, 'src'),
          },
        },
        server: {
          fs: {
            allow: [path.resolve(os.homedir(), '.config', 'engin')],
          },
        },
        test: {
          name: 'external',
          globals: true,
          environment: 'jsdom',
          include: [path.resolve(os.homedir(), '.config', 'engin', 'workflows', '*', 'web', '**', '*.test.{ts,tsx}')],
        },
      },
    ],
  },
});
