// ─── SubscriptionManager ────────────────────────────────────────────────────
//
// Per-run WebSocket subscriber fan-out, extracted from RunManager
// (decomposition step). It is the logic that was previously inlined in the
// per-run `broadcast` closure and the RunManager.subscribe / unsubscribe /
// unsubscribeAll methods.
//
// The manager operates on a RunHandle's `subscribers` set passed in by the
// facade (the registry owns the handles; this manager owns the fan-out
// semantics). The RunManager facade resolves a runId to its handle via the
// registry, then delegates to these methods.

import type { ServerMessage } from '@engin/shared/protocol-types';
import type { ServerWebSocket } from 'bun';

import type { RunHandle } from './run-manager.js';

/**
 * Manages per-run WebSocket subscriber sets and broadcast fan-out.
 *
 * `broadcast` serializes the payload ONCE (before iterating) and delivers the
 * identical string to every subscriber whose `readyState === 1` (OPEN),
 * swallowing `send()` errors so a single stale socket cannot break delivery
 * to the rest.
 */
export class SubscriptionManager {
  /**
   * Add a WebSocket to a run's subscriber set. Idempotent (Set semantics):
   * subscribing the same socket twice adds it once.
   *
   * @param ws     The WebSocket to subscribe.
   * @param runId  The run being subscribed to (carried for the facade's API
   *               symmetry; the subscriber set lives on `handle`).
   * @param handle The run handle whose `subscribers` set is mutated.
   */
  subscribe(ws: ServerWebSocket, _runId: string, handle: RunHandle): void {
    handle.subscribers.add(ws);
  }

  /**
   * Remove a WebSocket from a run's subscriber set. No-op (does not throw)
   * when the socket was never subscribed.
   */
  unsubscribe(ws: ServerWebSocket, _runId: string, handle: RunHandle): void {
    handle.subscribers.delete(ws);
  }

  /**
   * Remove a WebSocket from the given handle's subscriber set. The RunManager
   * facade iterates every registered handle and calls this for each, so a
   * disconnecting client is purged from all runs. No-op when the socket was
   * never subscribed.
   */
  unsubscribeAll(ws: ServerWebSocket, handle: RunHandle): void {
    handle.subscribers.delete(ws);
  }

  /**
   * Deliver a message to every OPEN subscriber of the run.
   *
   * The payload is `JSON.stringify`-ed ONCE (before iterating) and the
   * identical string is sent to each socket. Subscribers whose
   * `readyState !== 1` are skipped, and any error thrown by a stale socket's
   * `send()` is swallowed so one dead socket cannot break delivery to the rest.
   *
   * @param runId  The run being broadcast to (tags the message upstream; the
   *               subscriber set lives on `handle`).
   * @param msg    The server message to broadcast.
   * @param handle The run handle whose `subscribers` set is iterated.
   */
  broadcast(_runId: string, msg: ServerMessage, handle: RunHandle): void {
    const payload = JSON.stringify(msg);
    for (const ws of handle.subscribers) {
      if (ws.readyState === 1) {
        try {
          ws.send(payload);
        } catch {
          // Ignore send errors on stale sockets.
        }
      }
    }
  }
}
