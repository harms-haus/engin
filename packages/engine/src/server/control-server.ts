import type { ClientMessage, ServerMessage } from '@engin/shared/protocol-types';
import type { ServerWebSocket } from 'bun';

import { createMessageRouter } from './message-router.js';
import type { RunManager } from './run-manager.js';
import { serveSpaOrPlaceholder, serveStaticFile } from './static-serving.js';
import { validateWebSocketOrigin } from './ws-origin-guard.js';

// ─── ControlServer interface ───────────────────────────────────────────────

export interface ControlServer {
  server: ReturnType<typeof Bun.serve>;
  broadcast: (msg: ServerMessage) => void;
  url: string;
  stop: () => Promise<void>;
}

// ─── startControlServer ────────────────────────────────────────────────────

export async function startControlServer(options: {
  host: string;
  port: number;
  displayHost?: string;
  /** Owns the run registry and per-run bridges; routes WS messages to it. */
  runManager: RunManager;
  /**
   * Optional async hook invoked by {@link ControlServer.stop} BEFORE the
   * underlying Bun server is stopped. Typically `() => runManager.shutdownAll()`
   * so active runs are cooperatively cancelled and their stores flushed before
   * the process exits. When omitted, `stop()` behaves exactly as before
   * (backward compatible).
   */
  onShutdown?: () => Promise<void>;
}): Promise<ControlServer> {
  const clients = new Set<ServerWebSocket>();
  const runManager = options.runManager;
  const onShutdown = options.onShutdown;
  // Bind a message router to this server's RunManager. Every inbound
  // ClientMessage passes through the authorize chokepoint inside the router
  // before being dispatched.
  const router = createMessageRouter(runManager);

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
        router.routeMessage(ws, msg);
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

      // Static asset serving — returns the file verbatim with the correct
      // MIME type, or `undefined` to fall through to the SPA / placeholder
      // handler. index.html is NOT served here (it requires WS_ENDPOINT
      // substitution, handled below).
      const staticResponse = serveStaticFile(url, server);
      if (staticResponse) return staticResponse;

      // SPA fallback (index.html for unknown routes) or the placeholder page
      // when no frontend build exists. The wsEndpoint is derived ONLY from
      // the request URL's own protocol/host — X-Forwarded-Proto is ignored
      // to prevent spoofing (an attacker could otherwise force wss → ws
      // downgrade or vice versa).
      const wsEndpoint = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/ws`;
      return serveSpaOrPlaceholder(req, url, wsEndpoint);
    },
  });

  function broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of Array.from(clients)) {
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
