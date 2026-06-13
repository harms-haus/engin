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

// ─── startObserverServer ────────────────────────────────────────────────────

export async function startObserverServer(options: {
  host: string;
  port: number;
  onTerminate?: () => void;
  getSnapshot?: () => ServerMessage;
}): Promise<ObserverServer> {
  const clients = new Set<ServerWebSocket>();

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
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

  const url = `http://${server.hostname}:${server.port}`;

  return {
    server,
    broadcast,
    url,
    stop: () => server.stop(),
  };
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
      html = html.replace('{{WS_ENDPOINT}}', `ws://${url.host}/ws`);
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
    html = html.replace('{{WS_ENDPOINT}}', `ws://${url.host}/ws`);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // No frontend built — serve placeholder
  const placeholder = PLACEHOLDER_HTML.replace('{{WS_ENDPOINT}}', `ws://${url.host}/ws`);
  return new Response(placeholder, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
