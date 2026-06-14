import type { ServerWebSocket } from 'bun';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerMessage } from './protocol-types.js';

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
<title>engin observer</title>
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
<h1>engin observer</h1>
<p>WebSocket server running. Frontend build not found.</p>
</div>
</body>
</html>`;

// ─── ObserverServer interface ───────────────────────────────────────────────

export interface ObserverServer {
  server: ReturnType<typeof Bun.serve>;
  broadcast: (msg: ServerMessage) => void;
  url: string;
  stop: () => Promise<void>;
}

// ─── Origin validation for WebSocket upgrades ─────────────────────────────

/**
 * Validate the Origin header for a WebSocket upgrade request.
 *
 * Non-browser clients such as curl or custom scripts that connect via WebSocket
 * do not send an Origin header, so they bypass this check. The terminate_server
 * command remains accessible to any client that can reach the WebSocket endpoint
 * without an Origin header. A future enhancement should require authentication
 * tokens for destructive commands like terminate_server. The primary protection
 * is the default localhost binding.
 *
 * @returns true if the request should be allowed, false to reject with 403.
 */
function validateWebSocketOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host') || '';

  // Determine if the connection is from localhost
  const isLocalhost =
    host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('::1') || host.startsWith('[::1]');

  // If an Origin header is present AND the connection is NOT from localhost,
  // parse the Origin URL and validate it.
  if (origin && !isLocalhost) {
    try {
      const originUrl = new URL(origin);

      // Bug 1 — Non-HTTP scheme Origins (e.g. capacitor://, file://, ionic://)
      // Mobile browsers and Capacitor apps send origins with app-specific
      // schemes. These are safe same-app connections that should be allowed.
      if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
        return true;
      }

      // Determine the comparison target hostname.
      // If X-Forwarded-Host is present, use it instead of the Host header.
      const xForwardedHost = req.headers.get('x-forwarded-host') || '';
      const targetHost = xForwardedHost || host;

      // Extract hostname and port from the target host string.
      const targetParts = targetHost.split(':');
      const targetHostname = targetParts[0]?.toLowerCase() || '';
      const targetPort = targetParts.length > 1 ? targetParts.slice(1).join(':') : '';

      // Bug 3 — Compare hostnames case-insensitively (RFC 3986).
      // originUrl.hostname is already lowercased by the URL constructor.
      if (originUrl.hostname.toLowerCase() !== targetHostname) {
        return false;
      }

      // Bug 2 — Port omission: only compare ports when both are present
      // and non-empty. If one side omits the port (default scheme port),
      // treat it as a match.
      const originPort = originUrl.port;
      if (originPort && targetPort && originPort !== targetPort) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  return true;
}

// ─── startObserverServer ────────────────────────────────────────────────────

export async function startObserverServer(options: {
  host: string;
  port: number;
  displayHost?: string;
  onTerminate?: () => void;
  getSnapshot?: () => ServerMessage;
  handleResync?: (ws: ServerWebSocket, lastSeq?: number) => void;
}): Promise<ObserverServer> {
  const clients = new Set<ServerWebSocket>();

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    // Disable the server-level HTTP idle timeout (Bun default: 10s).
    // Without this, slow mobile WebSocket upgrades can be silently killed
    // before the connection is fully established. Post-upgrade, WebSocket
    // connections are governed by the websocket.idleTimeout (default 120s),
    // which Bun manages with automatic ping/pong keepalive.
    idleTimeout: 0,
    websocket: {
      open(ws) {
        clients.add(ws);
        // Send snapshot on connect
        const snapshot = options.getSnapshot?.();
        if (snapshot) {
          ws.send(JSON.stringify(snapshot));
        }
      },
      message(ws, raw) {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'terminate_server') {
            options.onTerminate?.();
          } else if (msg.type === 'resync') {
            options.handleResync?.(ws, msg.lastSeq as number | undefined);
          }
        } catch {
          // Ignore invalid messages
        }
      },
      close(ws) {
        clients.delete(ws);
      },
    },
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === '/ws') {
        // Validate Origin header to prevent cross-origin WebSocket attacks
        if (!validateWebSocketOrigin(req)) {
          return new Response('Forbidden', { status: 403 });
        }

        const upgraded = server.upgrade(req);
        if (!upgraded) {
          return new Response('Upgrade failed', { status: 400 });
        }
        return;
      }

      // Static file serving
      return serveStatic(req, url);
    },
  });

  function broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      try {
        ws.send(payload);
      } catch {
        clients.delete(ws);
      }
    }
  }

  const displayHost = options.displayHost ?? server.hostname;
  const url = `http://${displayHost}:${server.port}`;

  return {
    server,
    broadcast,
    url,
    stop: () => server.stop(),
  };
}

// ─── WebSocket scheme helper ───────────────────────────────────────────────

/**
 * Determine the appropriate WebSocket scheme (ws or wss) based on the
 * incoming request and the URL being served.
 *
 * Priority:
 * 1. If the X-Forwarded-Proto header is 'https', return 'wss'.
 * 2. If the URL protocol is 'https:', return 'wss'.
 * 3. Otherwise return 'ws'.
 */
function getWsScheme(req: Request, url: URL): string {
  const xForwardedProto = req.headers.get('x-forwarded-proto');
  if (xForwardedProto === 'https') {
    return 'wss';
  }
  if (url.protocol === 'https:') {
    return 'wss';
  }
  return 'ws';
}

// ─── Static file serving ────────────────────────────────────────────────────

function serveStatic(req: Request, url: URL): Response {
  // Determine the static root: web/dist relative to this file
  const distDir = join(import.meta.dir, '..', '..', 'web', 'dist');
  let pathname = url.pathname;

  // Default to index.html for directory requests
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  const filePath = join(distDir, pathname);

  // Check if the file exists
  if (existsSync(filePath)) {
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    const contentType = MIME_MAP[ext] || 'application/octet-stream';
    const content = readFileSync(filePath);

    // For index.html, replace WS_ENDPOINT placeholder
    if (pathname === '/index.html') {
      let html = content.toString('utf-8');
      html = html.replace('{{WS_ENDPOINT}}', `${getWsScheme(req, url)}://${url.host}/ws`);
      return new Response(html, {
        headers: { 'Content-Type': contentType },
      });
    }

    return new Response(content, {
      headers: { 'Content-Type': contentType },
    });
  }

  // SPA fallback: serve index.html with WS_ENDPOINT replacement
  const indexPath = join(distDir, 'index.html');
  if (existsSync(indexPath)) {
    let html = readFileSync(indexPath, 'utf-8');
    html = html.replace('{{WS_ENDPOINT}}', `${getWsScheme(req, url)}://${url.host}/ws`);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // No frontend built — serve placeholder
  const placeholder = PLACEHOLDER_HTML.replace('{{WS_ENDPOINT}}', `${getWsScheme(req, url)}://${url.host}/ws`);
  return new Response(placeholder, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
