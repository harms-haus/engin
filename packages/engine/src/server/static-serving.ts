// ─── static-serving — frontend bundle, SPA fallback, and placeholder HTML ──
//
// Extracted from control-server.ts so the server module contains only the
// Bun.serve wiring. This module owns:
//   • The MIME map for static asset serving.
//   • The placeholder HTML served when no frontend build exists.
//   • web/dist directory resolution (computed once at module load).
//   • Two pure helpers used by the control server's fetch handler:
//       - serveStaticFile(url, server) → Response | undefined
//       - serveSpaOrPlaceholder(req, url, wsEndpoint) → Response

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

// ─── MIME map for static file serving ──────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// ─── Placeholder HTML (used when web/dist/index.html does not exist) ────────

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>engin server</title>
<script>window.__WS_ENDPOINT__ = '{{WS_ENDPOINT}}';</script>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:grid;place-items:center;min-height:100vh}
h1{font-size:1.5rem}
p{color:#8b949e}
.status{text-align:center}
</style>
</head>
<body>
<div class="status">
<h1>engin server</h1>
<p>WebSocket server running. Frontend build not found.</p>
</div>
</body>
</html>`;

// ─── HTML escaping ─────────────────────────────────────────────────────────

/**
 * Escape the five characters that must be encoded inside an HTML attribute
 * or text node (& < > " '). Used to sanitise user-influenced values before
 * embedding them in served HTML (e.g. the Host header in WS_ENDPOINT).
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── web/dist resolution ───────────────────────────────────────────────────

/**
 * Resolve the frontend bundle directory (web/dist) once at module load.
 *
 * This module lives at packages/engine/src/server/, so the repo root is four
 * directories up. Tries candidate locations in priority order:
 *   1. Monorepo workspace layout — packages/web/dist (dev working copy)
 *   2. Legacy flat layout — web/dist at the repo root
 *   3. Global install — sibling of the Bun binary at <bun>/../web/dist
 *
 * Returns the first candidate for which `existsSync` is true, or `null` when
 * no frontend bundle is present — in which case {@link serveSpaOrPlaceholder}
 * falls back to {@link PLACEHOLDER_HTML}.
 */
function resolveWebDistDir(): string | null {
  const candidates = [
    join(import.meta.dir, '..', '..', '..', '..', 'packages', 'web', 'dist'),
    join(import.meta.dir, '..', '..', '..', '..', 'web', 'dist'),
    join(dirname(process.execPath), '..', 'web', 'dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolved frontend bundle directory, computed once at module load. `null`
 * when no web/dist directory exists at any candidate location.
 */
export const WEB_DIST_DIR: string | null = resolveWebDistDir();

// ─── Static file serving ───────────────────────────────────────────────────

/**
 * Check whether a static asset exists under the resolved web/dist directory
 * and, if so, return it with the correct MIME type. Returns `undefined` when
 * the file does not exist (or no bundle is present) so the caller can fall
 * through to {@link serveSpaOrPlaceholder}.
 *
 * Assets are served byte-for-byte from disk — no `{{WS_ENDPOINT}}`
 * substitution. `index.html` (and the root path) is intentionally NOT served
 * here: it requires substitution and is owned by {@link serveSpaOrPlaceholder}.
 *
 * Path-traversal hardening: the target path is canonicalized with
 * `path.resolve` against WEB_DIST_DIR (prefixing the pathname with '.' so an
 * absolute pathname cannot become a new root) and rejected unless it is
 * contained within WEB_DIST_DIR. Containment is therefore explicit and does
 * not depend on WHATWG URL-normalization behaviour — important because this
 * endpoint is unauthenticated and may be exposed on a LAN.
 *
 * The `server` parameter is the bound Bun server instance (reserved for future
 * use, e.g. Cache-Control headers); currently unused.
 */
export function serveStaticFile(url: URL, _server: unknown): Response | undefined {
  if (WEB_DIST_DIR === null) return undefined;

  const pathname = url.pathname;
  // The root, empty path, and index.html are handled by the SPA/placeholder
  // handler (they require {{WS_ENDPOINT}} substitution).
  if (pathname === '/' || pathname === '' || pathname === '/index.html') {
    return undefined;
  }

  const filePath = resolve(WEB_DIST_DIR, '.' + decodeURIComponent(pathname));
  if (filePath !== WEB_DIST_DIR && !filePath.startsWith(WEB_DIST_DIR + sep)) {
    return undefined; // refuse anything that escapes the bundle root
  }
  if (!existsSync(filePath)) return undefined;

  const ext = filePath.substring(filePath.lastIndexOf('.'));
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);

  return new Response(content, {
    headers: { 'Content-Type': contentType },
  });
}

// ─── SPA fallback / placeholder ────────────────────────────────────────────

/**
 * Serve the SPA shell (index.html) for unknown routes, or the placeholder
 * page when no frontend build is present. The provided `wsEndpoint` is
 * HTML-escaped and substituted into the `{{WS_ENDPOINT}}` token before being
 * embedded in the served HTML.
 *
 * Always returns a Response.
 */
export function serveSpaOrPlaceholder(_req: Request, _url: URL, wsEndpoint: string): Response {
  const safeEndpoint = escapeHtml(wsEndpoint);

  // SPA fallback: serve index.html from the bundle (with WS_ENDPOINT substituted).
  if (WEB_DIST_DIR !== null) {
    const indexPath = join(WEB_DIST_DIR, 'index.html');
    if (existsSync(indexPath)) {
      const html = readFileSync(indexPath, 'utf-8').replace('{{WS_ENDPOINT}}', safeEndpoint);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
  }

  // No frontend bundle — serve the placeholder page.
  const placeholder = PLACEHOLDER_HTML.replace('{{WS_ENDPOINT}}', safeEndpoint);
  return new Response(placeholder, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
