// ─── message-router — route parsed ClientMessages to RunManager methods ─────
//
// Extracted from control-server.ts so the server module contains only the
// Bun.serve wiring. This module encapsulates the authorize chokepoint and
// the switch/case routing logic that dispatches each inbound ClientMessage to
// the appropriate RunManager method.

import type { ClientMessage, ServerMessage } from '@engin/shared/protocol-types';
import type { ServerWebSocket } from 'bun';

import { authorize } from './auth.js';
import type { RunManager, StartRunMessage } from './run-manager.js';

/**
 * A bound message router. The {@link routeMessage} method is the single entry
 * point through which every parsed {@link ClientMessage} reaches the
 * {@link RunManager}.
 */
export interface MessageRouter {
  routeMessage(ws: ServerWebSocket, msg: ClientMessage): void;
}

/**
 * Create a {@link MessageRouter} bound to a specific {@link RunManager}.
 *
 * Every inbound {@link ClientMessage} passes through the {@link authorize}
 * chokepoint first. If authorization fails, the router replies with
 * `{ type: 'auth_required' }` and closes the WebSocket. Otherwise the message
 * is routed by `type` to the appropriate RunManager method.
 *
 * Unknown types and stubs are tolerated without crashing or replying.
 */
export function createMessageRouter(runManager: RunManager): MessageRouter {
  /**
   * Route a parsed {@link ClientMessage} to the appropriate RunManager method.
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

  return { routeMessage };
}
