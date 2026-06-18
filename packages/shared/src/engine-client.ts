// ─── EngineClient ──────────────────────────────────────────────────────────
//
// A framework-agnostic, pure-TypeScript WebSocket client extracted from the
// React `useWebSocket` hook (web/src/hooks/useWebSocket.ts). It owns connection
// lifecycle, exponential-backoff reconnection, resync, and multi-run
// subscription (run multiplexing) — with NO dependency on React, zustand, Node
// builtins, or pi packages.
//
// The shared package's ONLY runtime API is the global `WebSocket` constructor.

import type { ClientMessage, RunSummary, ServerMessage } from './protocol-types.js';
import { isServerMessage } from './protocol-types.js';

// ─── Backoff defaults ──────────────────────────────────────────────────────

const BACKOFF_INITIAL = 1000;
const BACKOFF_MULTIPLIER = 1.5;
const BACKOFF_MAX = 30_000;

// ─── Public types ──────────────────────────────────────────────────────────

/** Exponential-backoff tuning knobs. Every field is optional; absent values
 *  fall back to the defaults (initial 1000ms, multiplier 1.5, max 30_000ms). */
export interface EngineClientBackoffOptions {
  /** First reconnect delay, in milliseconds. Default `1000`. */
  initial?: number;
  /** Factor the delay grows by after each unsuccessful attempt. Default `1.5`. */
  multiplier?: number;
  /** Upper bound on the delay, in milliseconds. Default `30_000`. */
  max?: number;
}

/** Construction-time configuration for {@link EngineClient}. */
export interface EngineClientOptions {
  /** WebSocket endpoint to connect to (e.g. `ws://host/ws`). */
  url: string;
  /** Optional bearer token sent as `{ type:'auth', token }` on each (re)open. */
  authToken?: string;
  /** Optional exponential-backoff overrides. */
  backoff?: EngineClientBackoffOptions;
}

/** Callbacks handed to {@link EngineClient.connect}. Only `onMessage` is
 *  required; the rest are optional lifecycle notifications. */
export interface EngineClientCallbacks {
  /** Receives every validated {@link ServerMessage}. Required. */
  onMessage: (msg: ServerMessage) => void;
  /** Fired once when the socket transitions to OPEN. */
  onConnected?: () => void;
  /** Fired once when the socket transitions to CLOSED (manual or otherwise). */
  onDisconnected?: () => void;
  /** Convenience: fired with the runs array whenever a `runs` message arrives,
   *  in addition to (not instead of) {@link onMessage}. */
  onRunsChanged?: (runs: RunSummary[]) => void;
}

// ─── EngineClient ──────────────────────────────────────────────────────────

/**
 * Framework-agnostic WebSocket client with exponential-backoff reconnection,
 * resync, and multi-run subscription.
 *
 * The constructor only stores configuration — no socket is opened until
 * {@link connect} is called. Once connected the client manages its own
 * reconnection; call {@link disconnect} for a clean, manual teardown that will
 * NOT trigger a reconnect.
 */
export class EngineClient {
  // ── Immutable configuration ──────────────────────────────────────────────
  private readonly url: string;
  private readonly authToken: string | undefined;
  private readonly backoffInitial: number;
  private readonly backoffMultiplier: number;
  private readonly backoffMax: number;

  // ── Live connection state ────────────────────────────────────────────────
  private callbacks: EngineClientCallbacks | null = null;
  private ws: WebSocket | null = null;
  private connected = false;
  private manualClose = false;
  private backoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Run multiplexing & resync tracking ───────────────────────────────────
  /** Every runId the caller has subscribed to. Replayed as `subscribe` +
   *  `resync` on each (re)connect so the server re-establishes the stream. */
  private readonly subscribedRunIds = new Set<string>();
  /** Latest observed `seq` per runId, harvested from `snapshot`/`events`
   *  messages and explicit {@link resync} calls. Replayed on reconnect. */
  private readonly lastSeqByRunId = new Map<string, number>();
  /** Pending one-shot resolvers for in-flight {@link requestRuns} calls. A
   *  single incoming `runs` message drains and clears this set, so several
   *  concurrent callers share one server response without interfering. */
  private readonly requestRunsResolvers: ((runs: RunSummary[]) => void)[] = [];

  constructor(options: EngineClientOptions) {
    this.url = options.url;
    this.authToken = options.authToken;
    this.backoffInitial = options.backoff?.initial ?? BACKOFF_INITIAL;
    this.backoffMultiplier = options.backoff?.multiplier ?? BACKOFF_MULTIPLIER;
    this.backoffMax = options.backoff?.max ?? BACKOFF_MAX;
    this.backoff = this.backoffInitial;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Opens a WebSocket using the configured URL and wires all event handlers.
   * Safe to call again after {@link disconnect} (resets the manual-close flag
   * so reconnection is re-enabled).
   */
  connect(callbacks: EngineClientCallbacks): void {
    this.callbacks = callbacks;
    this.openSocket();
  }

  /**
   * Clean, manual teardown: clears any pending reconnect timer, closes the
   * socket, and does NOT schedule a reconnect. Idempotent — calling it more
   * than once (or before ever connecting) is a no-op.
   */
  disconnect(): void {
    // Block the close handler from scheduling a reconnect.
    this.manualClose = true;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws !== null) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
  }

  /** True while the underlying socket is in the OPEN state. */
  isConnected(): boolean {
    return this.connected;
  }

  // ── Outbound messaging ───────────────────────────────────────────────────

  /**
   * Serializes and sends a {@link ClientMessage} over the active socket.
   * No-op when the socket is absent or not yet open.
   */
  send(msg: ClientMessage): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── One-shot request helpers ──────────────────────────────────────────────

  /**
   * Sends `{ type: 'list_runs' }` and returns a one-shot Promise that resolves
   * with the server's active-run list (`{ type: 'runs', runs }` response).
   *
   * Resolves with `[]` when the client is not connected, the socket is not
   * open, or no response arrives within `timeoutMs` (default 3 000 ms).
   *
   * Implementation detail: rather than mutating the caller's `onMessage`
   * callback (which under concurrent calls would overwrite the previous
   * caller's interceptor and desync), each call registers a one-shot resolver
   * in {@link requestRunsResolvers}. When a `runs` message arrives the
   * connection's `onmessage` handler drains that set, resolving every pending
   * caller with the same runs array, then clears it. The user's `onMessage` /
   * `onRunsChanged` callbacks are untouched and still receive every message —
   * including the resolving `runs` message.
   */
  requestRuns(timeoutMs = 3000): Promise<RunSummary[]> {
    return new Promise((resolve) => {
      if (!this.connected || this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
        resolve([]);
        return;
      }

      let resolved = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const resolver = (runs: RunSummary[]): void => {
        if (resolved) return;
        resolved = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        resolve(runs);
      };

      timer = setTimeout(() => {
        this.removeRequestRunsResolver(resolver);
        resolver([]);
      }, timeoutMs);

      this.requestRunsResolvers.push(resolver);
      this.send({ type: 'list_runs' });
    });
  }

  /** Drains every pending {@link requestRuns} resolver, resolving each with
   *  the supplied runs list, then clears the set so a later `runs` message
   *  does not re-resolve already-settled promises. */
  private resolvePendingRequestRuns(runs: RunSummary[]): void {
    if (this.requestRunsResolvers.length === 0) return;
    const resolvers = this.requestRunsResolvers.splice(0);
    for (const resolver of resolvers) {
      resolver(runs);
    }
  }

  /** Removes a single resolver from the pending set (used by the per-call
   *  timeout so a timed-out caller is no longer resolved by a later message). */
  private removeRequestRunsResolver(resolver: (runs: RunSummary[]) => void): void {
    const idx = this.requestRunsResolvers.indexOf(resolver);
    if (idx !== -1) {
      this.requestRunsResolvers.splice(idx, 1);
    }
  }

  // ── Run multiplexing ─────────────────────────────────────────────────────

  /**
   * Subscribes to a run: tracks the runId (so it is replayed on reconnect) and
   * sends `{ type:'subscribe', runId }` immediately when connected.
   * Safe to call before {@link connect} — the subscribe is deferred to the
   * on-open handshake.
   */
  subscribe(runId: string): void {
    this.subscribedRunIds.add(runId);
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', runId } satisfies ClientMessage));
    }
  }

  /**
   * Unsubscribes from a run: removes the runId from the tracked set (so it is
   * NOT replayed on reconnect) and sends `{ type:'unsubscribe', runId }`
   * immediately when connected.
   */
  unsubscribe(runId: string): void {
    this.subscribedRunIds.delete(runId);
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', runId } satisfies ClientMessage));
    }
  }

  /**
   * Requests a resync for a run. When `lastSeq` is provided it both overrides
   * and updates the tracked value; when omitted, the tracked value (if any) is
   * replayed; when neither exists, `lastSeq` is omitted from the wire payload.
   */
  resync(runId: string, lastSeq?: number): void {
    if (lastSeq !== undefined) {
      this.lastSeqByRunId.set(runId, lastSeq);
    }
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      const seq = lastSeq !== undefined ? lastSeq : this.lastSeqByRunId.get(runId);
      const msg: ClientMessage =
        seq !== undefined ? { type: 'resync', runId, lastSeq: seq } : { type: 'resync', runId };
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── Internal: connection lifecycle ───────────────────────────────────────

  /** Opens a fresh socket and wires the open/message/close/error handlers.
   *  Resets the manual-close flag so reconnection works after a disconnect. */
  private openSocket(): void {
    this.manualClose = false;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      // Reset backoff on a successful open.
      this.backoff = this.backoffInitial;

      // ── Handshake ───────────────────────────────────────────────────────
      // 1. auth (if a token was provided)
      if (this.authToken !== undefined) {
        this.send({ type: 'auth', token: this.authToken });
      }
      // 2. request the active-run list
      this.send({ type: 'list_runs' });
      // 3. re-subscribe + resync every tracked run (reconnect scenario)
      for (const runId of this.subscribedRunIds) {
        this.send({ type: 'subscribe', runId });
        const seq = this.lastSeqByRunId.get(runId);
        if (seq !== undefined) {
          this.send({ type: 'resync', runId, lastSeq: seq });
        } else {
          this.send({ type: 'resync', runId });
        }
      }

      this.callbacks?.onConnected?.();
    };

    ws.onmessage = (event: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        // Silently ignore unparseable payloads.
        return;
      }
      if (!isServerMessage(data)) {
        // Silently ignore non-server payloads.
        return;
      }
      const msg = data as ServerMessage;

      // Track the latest seq per runId from snapshot/events for reconnect resync.
      if (msg.type === 'snapshot' || msg.type === 'events') {
        this.lastSeqByRunId.set(msg.runId, msg.seq);
      }

      this.callbacks?.onMessage(msg);

      // Convenience fan-out for the active-run list.
      if (msg.type === 'runs') {
        this.callbacks?.onRunsChanged?.(msg.runs);
        // Resolve every in-flight requestRuns() caller with this list.
        this.resolvePendingRequestRuns(msg.runs);
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this.ws = null;

      this.callbacks?.onDisconnected?.();

      // Do not reconnect on a manual disconnect.
      if (this.manualClose) return;

      // Exponential backoff: delay grows by `multiplier`, capped at `max`,
      // reset to `initial` on the next successful open.
      const delay = this.backoff;
      this.backoff = Math.min(delay * this.backoffMultiplier, this.backoffMax);
      this.reconnectTimer = setTimeout(() => {
        this.openSocket();
      }, delay);
    };

    ws.onerror = () => {
      // Closing routes through onclose (which handles reconnect / disconnect).
      ws.close();
    };
  }
}
