import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@app': path.resolve(__dirname, 'src'), '@engin/shared': path.resolve(__dirname, '..', 'shared', 'src') },
  },
  server: {
    host: true,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3619',
        ws: true,
      },
    },
  },
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
