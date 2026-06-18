// ─── SubscriptionManager — test-first specification ───────────────────────
//
// Test-first specification for
// `packages/engine/src/server/subscription-manager.ts`, the per-run WebSocket
// subscriber logic extracted from RunManager (decomposition step).
//
// It is the logic currently inlined in the per-run `broadcast` closure and
// the RunManager.subscribe / unsubscribe / unsubscribeAll methods. The manager
// operates on a RunHandle's `subscribers` set passed in by the facade (the
// registry owns the handles; the manager owns the fan-out semantics).
//
// CONTRACT UNDER TEST (the new module must export a class `SubscriptionManager`):
//
//   class SubscriptionManager {
//     subscribe(ws: ServerWebSocket, runId: string, handle: RunHandle): void;
//     unsubscribe(ws: ServerWebSocket, runId: string, handle: RunHandle): void;
//     unsubscribeAll(ws: ServerWebSocket, handle: RunHandle): void;
//     broadcast(runId: string, msg: ServerMessage, handle: RunHandle): void;
//   }
//
// `broadcast` must:
//   • JSON.stringify the message ONCE (before iterating) and send the same
//     payload to every subscriber.
//   • deliver only to subscribers whose `readyState === 1` (OPEN).
//   • swallow errors thrown by a stale socket's `send()` so one dead socket
//     cannot break delivery to the rest.
//
// `unsubscribeAll(ws, handle)` removes the socket from the given handle's
// subscriber set; the RunManager facade iterates every registered handle and
// delegates to it so a disconnecting client is purged from all runs.
//
// Tests are RED (expected) because the source module is created in the
// NEXT (implement) phase.

import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import type { ServerMessage } from '@engin/shared/protocol-types';
import type { RunHandle, RunStatus } from '../../packages/engine/src/server/run-manager.js';
import { StatusBridge } from '../../packages/engine/src/server/status-bridge.js';
import { SubscriptionManager } from '../../packages/engine/src/server/subscription-manager.js';
import { EventStore } from '../../packages/engine/src/tracking/event-store.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Mock WebSocket ─────────────────────────────────────────────────────────

interface MockWs {
  ws: any;
  sent: any[];
  rawSent: string[];
}

/**
 * Minimal mock of a Bun ServerWebSocket that records every sent payload.
 * `readyState` and a throwing `send` are configurable to exercise the
 * broadcast fan-out guards.
 */
function makeMockWs(opts: { readyState?: number; sendThrows?: boolean } = {}): MockWs {
  const sent: any[] = [];
  const rawSent: string[] = [];
  const ws = {
    readyState: opts.readyState ?? 1, // 1 === OPEN
    send: (data: string | ArrayBuffer | Uint8Array) => {
      if (opts.sendThrows) throw new Error('send failed on stale socket');
      const str = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
      rawSent.push(str);
      try {
        sent.push(JSON.parse(str));
      } catch {
        sent.push(str);
      }
    },
    close: () => {
      /* no-op */
    },
  };
  return { ws, sent, rawSent };
}

// ─── Handle factory ────────────────────────────────────────────────────────

describe('SubscriptionManager', () => {
  const { getDir } = useTempDir();
  const bridges: StatusBridge[] = [];

  function makeHandle(runId: string, opts: { status?: RunStatus } = {}): RunHandle {
    const workDir = join(getDir(), runId);
    const store = new EventStore(workDir);
    const bridge = new StatusBridge(() => {}, store, runId);
    bridges.push(bridge);
    return {
      runId,
      cwd: '/tmp/project',
      workflowName: 'develop',
      taskPrompt: 't',
      workDir,
      store,
      controller: new AbortController(),
      bridge,
      status: opts.status ?? 'running',
      summary: {
        runId,
        cwd: '/tmp/project',
        workflowName: 'develop',
        taskPrompt: 't',
        status: opts.status ?? 'running',
        startedAt: new Date().toISOString(),
      },
      startedAt: new Date().toISOString(),
      subscribers: new Set(),
    };
  }

  afterEach(() => {
    for (const b of bridges) b.dispose();
    bridges.length = 0;
  });

  // ─── subscribe ───────────────────────────────────────────────────────────

  describe('subscribe', () => {
    it('adds the websocket to the handle.subscribers set', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('sub-1');
      const { ws } = makeMockWs();

      expect(handle.subscribers.has(ws)).toBe(false);
      mgr.subscribe(ws, 'sub-1', handle);
      expect(handle.subscribers.has(ws)).toBe(true);
    });

    it('is idempotent (subscribing the same ws twice adds it once)', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('sub-2');
      const { ws } = makeMockWs();

      mgr.subscribe(ws, 'sub-2', handle);
      mgr.subscribe(ws, 'sub-2', handle);

      expect(handle.subscribers.size).toBe(1);
    });

    it('wires the socket to receive a subsequent broadcast', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('sub-3');
      const { ws, sent } = makeMockWs();
      const msg: ServerMessage = { type: 'run_complete', runId: 'sub-3' };

      mgr.subscribe(ws, 'sub-3', handle);
      mgr.broadcast('sub-3', msg, handle);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual(msg);
    });
  });

  // ─── broadcast ───────────────────────────────────────────────────────────

  describe('broadcast', () => {
    it('delivers the message to every subscriber in the set', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('bcast-many');
      const a = makeMockWs();
      const b = makeMockWs();
      const c = makeMockWs();
      mgr.subscribe(a.ws, 'bcast-many', handle);
      mgr.subscribe(b.ws, 'bcast-many', handle);
      mgr.subscribe(c.ws, 'bcast-many', handle);

      const msg: ServerMessage = { type: 'run_failed', runId: 'bcast-many', error: 'boom', phase: 'plan' };
      mgr.broadcast('bcast-many', msg, handle);

      for (const m of [a, b, c]) {
        expect(m.sent).toHaveLength(1);
        expect(m.sent[0]).toEqual(msg);
      }
    });

    it('serializes the payload once and sends the identical string to each socket', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('bcast-once');
      const a = makeMockWs();
      const b = makeMockWs();
      mgr.subscribe(a.ws, 'bcast-once', handle);
      mgr.subscribe(b.ws, 'bcast-once', handle);

      const msg: ServerMessage = { type: 'run_complete', runId: 'bcast-once' };
      mgr.broadcast('bcast-once', msg, handle);

      expect(a.rawSent).toHaveLength(1);
      expect(b.rawSent).toHaveLength(1);
      // The exact same serialized payload reached both sockets.
      expect(a.rawSent[0]).toBe(b.rawSent[0]);
      expect(a.rawSent[0]).toBe(JSON.stringify(msg));
    });

    it('skips subscribers whose readyState is not OPEN (1)', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('bcast-state');
      const open = makeMockWs({ readyState: 1 }); // OPEN
      const closing = makeMockWs({ readyState: 2 }); // CLOSING
      const closed = makeMockWs({ readyState: 3 }); // CLOSED
      mgr.subscribe(open.ws, 'bcast-state', handle);
      mgr.subscribe(closing.ws, 'bcast-state', handle);
      mgr.subscribe(closed.ws, 'bcast-state', handle);

      const msg: ServerMessage = { type: 'run_complete', runId: 'bcast-state' };
      mgr.broadcast('bcast-state', msg, handle);

      expect(open.sent).toHaveLength(1);
      expect(closing.sent).toHaveLength(0);
      expect(closed.sent).toHaveLength(0);
    });

    it('swallows send() errors so a stale socket cannot break delivery to the rest', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('bcast-throw');
      const healthy = makeMockWs();
      const stale = makeMockWs({ sendThrows: true });
      const alsoHealthy = makeMockWs();
      mgr.subscribe(healthy.ws, 'bcast-throw', handle);
      mgr.subscribe(stale.ws, 'bcast-throw', handle);
      mgr.subscribe(alsoHealthy.ws, 'bcast-throw', handle);

      const msg: ServerMessage = { type: 'run_complete', runId: 'bcast-throw' };
      expect(() => mgr.broadcast('bcast-throw', msg, handle)).not.toThrow();

      // The stale socket threw mid-loop, but the sockets before and after it
      // still received the payload.
      expect(healthy.sent).toHaveLength(1);
      expect(alsoHealthy.sent).toHaveLength(1);
    });

    it('does nothing when there are no subscribers', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('bcast-empty');
      // No subscribers at all.
      expect(() => mgr.broadcast('bcast-empty', { type: 'run_complete', runId: 'bcast-empty' }, handle)).not.toThrow();
    });
  });

  // ─── unsubscribe ─────────────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('removes the websocket from the handle.subscribers set', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('unsub-1');
      const { ws } = makeMockWs();

      mgr.subscribe(ws, 'unsub-1', handle);
      expect(handle.subscribers.has(ws)).toBe(true);

      mgr.unsubscribe(ws, 'unsub-1', handle);
      expect(handle.subscribers.has(ws)).toBe(false);
    });

    it('stops a previously-subscribed socket from receiving broadcasts', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('unsub-2');
      const { ws, sent } = makeMockWs();
      const msg: ServerMessage = { type: 'run_complete', runId: 'unsub-2' };

      mgr.subscribe(ws, 'unsub-2', handle);
      mgr.unsubscribe(ws, 'unsub-2', handle);
      mgr.broadcast('unsub-2', msg, handle);

      expect(sent).toHaveLength(0);
    });

    it('is a no-op when the socket was never subscribed (does not throw)', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('unsub-3');
      const { ws } = makeMockWs();
      expect(() => mgr.unsubscribe(ws, 'unsub-3', handle)).not.toThrow();
      expect(handle.subscribers.size).toBe(0);
    });
  });

  // ─── unsubscribeAll ──────────────────────────────────────────────────────
  //
  // `unsubscribeAll(ws, handle)` removes the socket from the given handle's
  // subscriber set. The RunManager facade iterates every registered handle
  // and calls this for each, so a disconnecting client is purged from all
  // runs. We verify both the single-handle contract AND the facade-style
  // "iterate all handles" usage.

  describe('unsubscribeAll', () => {
    it('removes the websocket from the given handle', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('unsuball-1');
      const { ws } = makeMockWs();
      mgr.subscribe(ws, 'unsuball-1', handle);

      mgr.unsubscribeAll(ws, handle);
      expect(handle.subscribers.has(ws)).toBe(false);
    });

    it('does not touch other sockets subscribed to the same handle', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('unsuball-2');
      const leaving = makeMockWs();
      const staying = makeMockWs();
      mgr.subscribe(leaving.ws, 'unsuball-2', handle);
      mgr.subscribe(staying.ws, 'unsuball-2', handle);

      mgr.unsubscribeAll(leaving.ws, handle);

      expect(handle.subscribers.has(leaving.ws)).toBe(false);
      expect(handle.subscribers.has(staying.ws)).toBe(true);
    });

    it('purges a disconnecting socket across many handles when the facade iterates', () => {
      const mgr = new SubscriptionManager();
      const h1 = makeHandle('unsuball-a');
      const h2 = makeHandle('unsuball-b');
      const h3 = makeHandle('unsuball-c');
      const handles = [h1, h2, h3];
      const { ws } = makeMockWs();

      // The socket is subscribed to several runs.
      mgr.subscribe(ws, h1.runId, h1);
      mgr.subscribe(ws, h2.runId, h2);
      mgr.subscribe(ws, h3.runId, h3);
      expect(handles.every((h) => h.subscribers.has(ws))).toBe(true);

      // On disconnect the facade calls unsubscribeAll for every handle.
      for (const h of handles) mgr.unsubscribeAll(ws, h);

      expect(handles.every((h) => h.subscribers.has(ws))).toBe(false);
    });

    it('is a no-op when the socket was never subscribed (does not throw)', () => {
      const mgr = new SubscriptionManager();
      const handle = makeHandle('unsuball-3');
      const { ws } = makeMockWs();
      expect(() => mgr.unsubscribeAll(ws, handle)).not.toThrow();
    });
  });
});
