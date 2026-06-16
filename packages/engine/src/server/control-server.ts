import type { ClientMessage, ServerMessage } from '@engin/shared/protocol-types';
import type { ServerWebSocket } from 'bun';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { authorize } from './auth.js';
import type { RunManager, StartRunMessage } from './run-manager.js';

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
 * tokens for destructive commands like terminate_server. The default binding is
 * localhost (127.0.0.1); bind to 0.0.0.0 only when the user explicitly opts in
 * via --host or --lan.
 *
 * @returns true if the request should be allowed, false to reject with 403.
 */
function validateWebSocketOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host') || '';

  // ── Sec-C1: Reject all browser-originated connections while auth is
  // disabled. Browsers send an Origin header on WebSocket upgrades; CLI /
  // engin-binary clients do not. Until an authentication layer is enabled,
  // only non-browser clients are permitted to connect. When auth lands,
  // replace this with an allowlist validated against the Origin header.
  if (origin) return false;

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

      // Use only the actual Host header — do not trust client-controlled
      // X-Forwarded-Host, which an attacker can spoof to bypass Origin checks.
      const targetHost = host;

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
  /** Owns the run registry and per-run bridges; routes WS messages to it. */
  runManager: RunManager;
  /**
   * Optional async hook invoked by {@link ObserverServer.stop} BEFORE the
   * underlying Bun server is stopped. Typically `() => runManager.shutdownAll()`
   * so active runs are cooperatively cancelled and their stores flushed before
   * the process exits. When omitted, `stop()` behaves exactly as before
   * (backward compatible).
   */
  onShutdown?: () => Promise<void>;
}): Promise<ObserverServer> {
  const clients = new Set<ServerWebSocket>();
  const runManager = options.runManager;
  const onShutdown = options.onShutdown;

  /**
   * Route a parsed {@link ClientMessage} to the appropriate RunManager method.
   * Unknown types and stubs are tolerated without crashing or replying.
   *
   * Every message passes through the {@link authorize} chokepoint first. If
   * authorization fails, the server replies with `{ type: 'auth_required' }`
   * and closes the WebSocket.
   */
  function routeMessage(ws: ServerWebSocket, msg: ClientMessage): void {
    // T35: authorize chokepoint — every inbound ClientMessage must pass
    // through this gate before being routed to RunManager.
    if (!authorize(msg, ws).authorized) {
      ws.send(JSON.stringify({ type: 'auth_required' } satisfies ServerMessage));
      ws.close();
      return;
    }

    switch (msg.type) {
      case 'list_runs':
        ws.send(JSON.stringify({ type: 'runs', runs: runManager.listRuns() }));
        break;

      case 'start_run': {
        // Strip the `type` discriminator before forwarding to RunManager.
        const { type: _type, ...startMsg } = msg;
        void _type;
        const payload: StartRunMessage = startMsg;
        runManager
          .startRun(payload)
          .then((result) => {
            ws.send(JSON.stringify({ type: 'run_started', runId: result.runId, summary: result.summary }));
            // Auto-subscribe the requesting socket to the new run.
            runManager.subscribe(ws, result.runId);
          })
          .catch((err) => {
            console.error('startRun failed:', err instanceof Error ? err.message : String(err));
          });
        break;
      }

      case 'subscribe':
        runManager.subscribe(ws, msg.runId);
        // Send a snapshot when the run exists.
        if (runManager.getRun(msg.runId)) {
          runManager.handleResync(ws, msg.runId);
        }
        break;

      case 'unsubscribe':
        runManager.unsubscribe(ws, msg.runId);
        break;

      case 'resync':
        runManager.handleResync(ws, msg.runId, msg.lastSeq);
        break;

      case 'cancel_run':
        runManager.cancelRun(msg.runId);
        break;

      case 'worktree_action':
        void Promise.resolve(runManager.handleWorktreeAction(msg.runId, msg.action)).catch((err) =>
          console.error(
            `handleWorktreeAction failed for ${msg.runId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        break;

      case 'auth':
        // No-op for now.
        break;

      default:
        // Unknown message types are ignored.
        break;
    }
  }

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
      // Sec-H3: Cap inbound WebSocket frame size to 1 MiB to mitigate
      // memory-exhaustion DoS from oversized payloads.
      maxPayloadLength: 1024 * 1024,
      open(ws) {
        clients.add(ws);
        // Send the active-run list immediately on connect.
        ws.send(JSON.stringify({ type: 'runs', runs: runManager.listRuns() }));
      },
      message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          // Ignore invalid JSON.
          return;
        }
        routeMessage(ws, msg);
      },
      close(ws) {
        clients.delete(ws);
        runManager.unsubscribeAll(ws);
      },
    },
    fetch(req, server) {
      const url = new URL(req.url);

      // Health / readiness probe. Returns the exact shape { pid, port,
      // activeRuns } and must NOT fall through to static / SPA / placeholder
      // so the daemon lifecycle and monitoring tools receive JSON, not HTML.
      // The second `server` parameter is the bound Bun server instance, so
      // `server.port` is the actual listening port (correct even when the
      // caller passed `port: 0` for an ephemeral bind).
      if (url.pathname === '/health') {
        return Response.json(
          { pid: process.pid, port: server.port, activeRuns: runManager.listRuns().length },
          { status: 200 },
        );
      }

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
    stop: async () => {
      // Run the optional shutdown hook BEFORE stopping the server so active
      // runs are cancelled and stores flushed while the WS layer can still
      // broadcast terminal state.
      if (onShutdown) {
        await onShutdown();
      }
      server.stop();
    },
  };
}

// ─── WebSocket scheme helper ───────────────────────────────────────────────

/**
 * Determine the appropriate WebSocket scheme (ws or wss) based on the
 * incoming request URL.
 *
 * Uses only the URL protocol — does not trust client-controlled
 * X-Forwarded-Proto headers, which an attacker can spoof.
 */
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

function getWsScheme(_req: Request, url: URL): string {
  if (url.protocol === 'https:') {
    return 'wss';
  }
  return 'ws';
}

// ─── Static file serving ────────────────────────────────────────────────────

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
 * no frontend bundle is present — in which case {@link serveStatic} falls back
 * to {@link PLACEHOLDER_HTML}.
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

function serveStatic(req: Request, url: URL): Response {
  // No frontend bundle present — serve the placeholder page directly.
  if (WEB_DIST_DIR === null) {
    const safeHost = escapeHtml(url.host);
    const placeholder = PLACEHOLDER_HTML.replace('{{WS_ENDPOINT}}', `${getWsScheme(req, url)}://${safeHost}/ws`);
    return new Response(placeholder, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  let pathname = url.pathname;

  // Default to index.html for directory requests
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  const filePath = join(WEB_DIST_DIR, pathname);

  // Check if the file exists
  if (existsSync(filePath)) {
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    const contentType = MIME_MAP[ext] || 'application/octet-stream';
    const content = readFileSync(filePath);

    // For index.html, replace WS_ENDPOINT placeholder
    if (pathname === '/index.html') {
      let html = content.toString('utf-8');
      html = html.replace('{{WS_ENDPOINT}}', `${getWsScheme(req, url)}://${escapeHtml(url.host)}/ws`);
      return new Response(html, {
        headers: { 'Content-Type': contentType },
      });
    }

    return new Response(content, {
      headers: { 'Content-Type': contentType },
    });
  }

  // SPA fallback: serve index.html with WS_ENDPOINT replacement
  const indexPath = join(WEB_DIST_DIR, 'index.html');
  if (existsSync(indexPath)) {
    let html = readFileSync(indexPath, 'utf-8');
    html = html.replace('{{WS_ENDPOINT}}', `${getWsScheme(req, url)}://${escapeHtml(url.host)}/ws`);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // No frontend built — serve placeholder
  const safeHost = escapeHtml(url.host);
  const placeholder = PLACEHOLDER_HTML.replace('{{WS_ENDPOINT}}', `${getWsScheme(req, url)}://${safeHost}/ws`);
  return new Response(placeholder, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
