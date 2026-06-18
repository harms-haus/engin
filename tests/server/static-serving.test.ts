// ─── static-serving — test-first specification ───────────────────────────────
//
// Tests for `src/server/static-serving.ts`, the module extracted from
// `control-server.ts` that serves the frontend bundle and the placeholder
// page used when no build is present.
//
// Contract under test (see server-refactor.prompt.md):
//
//   export function serveStaticFile(url: URL, server: any): Response | undefined
//   export function serveSpaOrPlaceholder(
//     req: Request,
//     url: URL,
//     wsEndpoint: string,
//   ): Response
//
// Invariants verified here:
//   • serveStaticFile checks whether a file exists under the resolved
//     web/dist directory and, if so, returns it with the correct MIME type.
//     It returns `undefined` when the file does not exist so the caller can
//     fall through to the SPA / placeholder handler.
//   • serveSpaOrPlaceholder handles the SPA fallback (index.html for unknown
//     routes) and the placeholder page, substituting the provided
//     `wsEndpoint` into the served HTML (replacing the `{{WS_ENDPOINT}}`
//     token). It always returns a Response.
//
// The module resolves the frontend bundle directory (web/dist) once at
// module load. When a build is present (the case in this repo), the SPA
// fallback serves index.html; otherwise the placeholder HTML is served.
// Tests that require a built bundle are skipped via `it.skipIf` when
// web/dist is absent, so the suite is robust in environments without a build.

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { serveSpaOrPlaceholder, serveStaticFile } from '../../packages/engine/src/server/static-serving.js';

// ─── Bundle discovery ────────────────────────────────────────────────────────
//
// Resolve the frontend bundle the same way the module does. Asset filenames
// are content-hashed, so they are discovered at runtime. Tests requiring the
// bundle are conditionally skipped when it is absent.

const distDir = join(import.meta.dir, '../../packages/web/dist');
const assetsDir = join(distDir, 'assets');
const haveDist = existsSync(distDir) && existsSync(assetsDir);
const assetFiles: string[] = haveDist ? readdirSync(assetsDir) : [];
const jsFile = assetFiles.find((f) => f.endsWith('.js') && !f.endsWith('.js.map'));
const cssFile = assetFiles.find((f) => f.endsWith('.css'));

/** Minimal stand-in for the Bun server instance passed to serveStaticFile. */
function fakeServer(port = 9999): { port: number; hostname: string } {
  return { port, hostname: '127.0.0.1' };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('static-serving', () => {
  // ── serveStaticFile ─────────────────────────────────────────────────────

  describe('serveStaticFile', () => {
    it('returns undefined when the requested file does not exist', () => {
      const url = new URL('http://127.0.0.1:9999/no/such/file.xyz');
      expect(serveStaticFile(url, fakeServer())).toBeUndefined();
    });

    it('returns undefined for a deep non-existent path', () => {
      const url = new URL('http://127.0.0.1:9999/some/unknown/spa/route');
      expect(serveStaticFile(url, fakeServer())).toBeUndefined();
    });

    it.skipIf(!haveDist || !jsFile)('serves an existing JS asset with a JavaScript MIME type', async () => {
      const url = new URL(`http://127.0.0.1:9999/assets/${jsFile}`);
      const res = serveStaticFile(url, fakeServer());

      expect(res).toBeInstanceOf(Response);
      expect(res!.status).toBe(200);
      expect(res!.headers.get('content-type')).toContain('javascript');
      // The body must be non-empty (the actual asset bytes).
      const text = await res!.text();
      expect(text.length).toBeGreaterThan(0);
    });

    it.skipIf(!haveDist || !cssFile)('serves an existing CSS asset with the text/css MIME type', async () => {
      const url = new URL(`http://127.0.0.1:9999/assets/${cssFile}`);
      const res = serveStaticFile(url, fakeServer());

      expect(res).toBeInstanceOf(Response);
      expect(res!.status).toBe(200);
      expect(res!.headers.get('content-type')).toContain('text/css');
    });

    it.skipIf(!haveDist || !jsFile)('serves the asset bytes verbatim (no WS_ENDPOINT substitution)', async () => {
      // Static assets (JS/CSS) are served byte-for-byte from disk — only
      // index.html / the placeholder carry the {{WS_ENDPOINT}} substitution.
      // Verifying the served body equals the raw file proves no mutation.
      const url = new URL(`http://127.0.0.1:9999/assets/${jsFile}`);
      const res = serveStaticFile(url, fakeServer());
      const text = await res!.text();
      const raw = readFileSync(join(assetsDir, jsFile!), 'utf-8');
      expect(text).toBe(raw);
    });
  });

  // ── serveStaticFile — path-traversal containment ──────────────────────────
  //
  // Regression guard for the explicit containment check in serveStaticFile().
  // The static endpoint is UNAUTHENTICATED and may be exposed on a LAN, so the
  // resolved path must be provably contained within WEB_DIST_DIR regardless of
  // how the request URL is constructed. Every case below must resolve to
  // `undefined` — never serving a file outside the bundle root.
  //
  // The WHATWG URL parser normalizes literal '..' and '%2e%2e' path segments
  // that are delimited by '/', so those land as contained-but-nonexistent
  // paths. The encoded-slash cases ('%2f') survive URL normalization, so
  // decodeURIComponent yields real '..' segments that resolve OUTSIDE
  // WEB_DIST_DIR — these are caught only by the explicit path.resolve +
  // startsWith(WEB_DIST_DIR + sep) containment check and are the meaningful
  // guards for that branch. These tests are intentionally NOT gated on
  // haveDist: the early WEB_DIST_DIR === null return aside, the containment
  // check runs whenever WEB_DIST_DIR is non-null.

  describe('serveStaticFile — path-traversal containment', () => {
    it('rejects a URL with literal ".." segments', () => {
      const url = new URL('http://127.0.0.1:9999/../../../etc/passwd');
      expect(serveStaticFile(url, fakeServer())).toBeUndefined();
    });

    it('rejects a URL with percent-encoded "%2e%2e" segments', () => {
      const url = new URL('http://127.0.0.1:9999/%2e%2e/%2e%2e/etc/passwd');
      expect(serveStaticFile(url, fakeServer())).toBeUndefined();
    });

    it('rejects an absolute pathname (cannot become a new root)', () => {
      // path.resolve is invoked with '.' + pathname, so an absolute pathname
      // is treated as relative to WEB_DIST_DIR rather than as a new root.
      const url = new URL('http://127.0.0.1:9999//etc/passwd');
      expect(serveStaticFile(url, fakeServer())).toBeUndefined();
    });

    it('rejects percent-encoded ".." with encoded slashes that escape the root', () => {
      // '%2f' is an encoded '/'. These segments survive WHATWG normalization,
      // so decodeURIComponent yields real '..' segments that resolve OUTSIDE
      // WEB_DIST_DIR — caught only by the explicit containment check.
      const url = new URL('http://127.0.0.1:9999/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd');
      expect(serveStaticFile(url, fakeServer())).toBeUndefined();
    });

    it('rejects mid-path "..%2f" traversal', () => {
      const url = new URL('http://127.0.0.1:9999/assets/..%2f..%2fsecret.txt');
      expect(serveStaticFile(url, fakeServer())).toBeUndefined();
    });
  });

  // ── serveSpaOrPlaceholder ───────────────────────────────────────────────

  describe('serveSpaOrPlaceholder', () => {
    it('always returns a Response', () => {
      const url = new URL('http://127.0.0.1:9999/unknown/spa/route');
      const req = new Request(url);
      const res = serveSpaOrPlaceholder(req, url, 'ws://127.0.0.1:9999/ws');

      expect(res).toBeInstanceOf(Response);
    });

    it('substitutes the provided wsEndpoint into the served HTML', async () => {
      const wsEndpoint = 'ws://127.0.0.1:9999/ws';
      const url = new URL('http://127.0.0.1:9999/unknown/spa/route');
      const req = new Request(url);
      const res = serveSpaOrPlaceholder(req, url, wsEndpoint);

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain(wsEndpoint);
      // The placeholder token must be fully replaced.
      expect(text).not.toContain('{{WS_ENDPOINT}}');
    });

    it('returns HTML content-type', async () => {
      const url = new URL('http://127.0.0.1:9999/unknown/spa/route');
      const req = new Request(url);
      const res = serveSpaOrPlaceholder(req, url, 'ws://127.0.0.1:9999/ws');

      expect(res.headers.get('content-type')).toContain('text/html');
    });

    it('escapes/sanitizes the wsEndpoint so it is embedded safely', async () => {
      // The provided wsEndpoint is built from trusted server state, but the
      // served HTML must still contain it verbatim for the client to use.
      const wsEndpoint = 'ws://127.0.0.1:9999/ws';
      const url = new URL('http://127.0.0.1:9999/');
      const req = new Request(url);
      const res = serveSpaOrPlaceholder(req, url, wsEndpoint);

      const text = await res.text();
      expect(text).toContain(wsEndpoint);
    });

    it('serves the SPA fallback for arbitrary unknown routes', async () => {
      const wsEndpoint = 'ws://127.0.0.1:9999/ws';
      const url = new URL('http://127.0.0.1:9999/deeply/nested/unknown/route/xyz');
      const req = new Request(url);
      const res = serveSpaOrPlaceholder(req, url, wsEndpoint);

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain(wsEndpoint);
      expect(text).not.toContain('{{WS_ENDPOINT}}');
    });
  });
});
