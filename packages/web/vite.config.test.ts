/**
 * Tests for the Vite dev server configuration file.
 *
 * Verifies that:
 * - The dev server binds to all interfaces (host: true) for LAN/mobile access
 * - The WebSocket proxy target is preserved
 * - Other existing config properties are unchanged
 *
 * We read the file as text rather than importing it because the Vite config
 * imports plugins that pull in esbuild, which is incompatible with jsdom.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readViteConfig(): string {
  const configPath = path.resolve(process.cwd(), 'vite.config.ts');
  return readFileSync(configPath, 'utf-8');
}

describe('Vite dev server config', () => {
  // ── server.host ────────────────────────────────────────────────────────────

  it('binds to all interfaces (host: true) for LAN/mobile access', () => {
    const source = readViteConfig();
    expect(source).toContain('host: true');
  });

  it('has host: true on a line indented inside the server block', () => {
    const source = readViteConfig();
    // Find the server block by searching around the server: { line
    const serverStart = source.indexOf('server: {');
    expect(serverStart).not.toBe(-1);

    // Take the substring from server: { to the end of the file (or a reasonable bound)
    const afterServer = source.slice(serverStart);

    // host: true should appear near the top of the server block,
    // before the proxy config starts
    const proxyIndex = afterServer.indexOf('proxy:');
    const hostIndex = afterServer.indexOf('host: true');

    expect(hostIndex).not.toBe(-1);
    // host: true must come before proxy: inside the server block
    expect(hostIndex).toBeLessThan(proxyIndex);
  });

  // ── proxy config (regression) ─────────────────────────────────────────────

  it('preserves the WebSocket proxy target', () => {
    const source = readViteConfig();
    expect(source).toContain("target: 'ws://localhost:3619'");
  });

  it('preserves the ws: true flag on the proxy', () => {
    const source = readViteConfig();
    expect(source).toContain('ws: true');
  });

  it('has the proxy config inside the server block', () => {
    const source = readViteConfig();
    const serverStart = source.indexOf('server: {');
    expect(serverStart).not.toBe(-1);

    // All content from server: { onward should contain proxy
    const afterServer = source.slice(serverStart);
    expect(afterServer).toContain("'/ws'");
    expect(afterServer).toContain('proxy:');
  });

  // ── other config properties (regression) ──────────────────────────────────

  it('has the react plugin', () => {
    const source = readViteConfig();
    expect(source).toContain('react()');
    expect(source).toContain('@vitejs/plugin-react');
  });

  it('has the expected resolve alias', () => {
    const source = readViteConfig();
    expect(source).toContain("@app'");
    expect(source).toContain("path.resolve(__dirname, 'src')");
  });

  it('has the expected build config', () => {
    const source = readViteConfig();
    expect(source).toContain("outDir: 'dist'");
    expect(source).toContain('emptyOutDir: true');
    expect(source).toContain('sourcemap: true');
  });

  it('exports using defineConfig from vite', () => {
    const source = readViteConfig();
    expect(source).toContain('defineConfig({');
    expect(source).toContain("from 'vite'");
  });

  it('has root set to the current directory', () => {
    const source = readViteConfig();
    expect(source).toContain("root: '.'");
  });
});
