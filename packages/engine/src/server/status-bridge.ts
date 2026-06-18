import type { EventRecord, WorkflowProjection } from '@engin/shared/event-types';
import type { ServerMessage } from '@engin/shared/protocol-types';
import type { EventStore } from '../tracking/event-store.js';

// ─── StatusBridge ───────────────────────────────────────────────────────────

/**
 * The subset of {@link ServerMessage}s that StatusBridge emits to its
 * broadcast callback.  Every variant is tagged with the run's `runId` so a
 * single WebSocket connection can fan out to many concurrent runs.
 */
export type BridgeMessage = Extract<ServerMessage, { type: 'snapshot' | 'events' | 'run_complete' | 'run_failed' }>;

/**
 * Thin view over the {@link EventStore} that broadcasts run-scoped
 * {@link BridgeMessage}s (tagged with `runId`) whenever the store changes.
 *
 * - Late-joining clients receive a `{ type: 'snapshot' }` via `getSnapshot()`.
 * - Between snapshots the bridge coalesces store changes into a single
 *   `{ type: 'events' }` message per microtask tick, forwarding raw
 *   {@link EventRecord}s. The web client replays them via its own evolve.
 * - Terminal lifecycle messages (`run_complete` / `run_failed`) are the SOLE
 *   responsibility of the {@link RunManager}: it calls `broadcastTerminal()`
 *   explicitly when a workflow reaches a terminal state.  The bridge does NOT
 *   auto-detect terminal transitions from projection changes — that would
 *   duplicate the RunManager's explicit signal.  The coalesced events batch
 *   still carries the raw terminal event records (idempotent replay).
 */
export class StatusBridge {
  private unsubscribe: () => void;

  /** Last projection seq we sent to clients. */
  private lastSentSeq: number;

  /** Whether a microtask flush is already scheduled. */
  private flushPending = false;

  /** Whether the bridge has been disposed. Guards against uncancellable microtask flushes. */
  private disposed = false;

  /** Reference to the store. */
  private readonly store: EventStore;

  /** The run this bridge is scoped to; tags every broadcast message. */
  private readonly runId: string;

  constructor(
    private broadcast: (msg: ServerMessage) => void,
    store: EventStore,
    runId: string,
  ) {
    this.store = store;
    this.runId = runId;

    // Initialise lastSentSeq to the store's current seq so that pre-subscribe
    // history is NOT re-broadcast — late joiners get it via getSnapshot().
    this.lastSentSeq = store.getSnapshot().seq;

    // Subscribe to future projection changes.
    this.unsubscribe = store.subscribe((projection) => this.onProjectionChange(projection));
  }

  /**
   * Return a full snapshot derived from the store's current projection,
   * tagged with this run's `runId`.  This is what a late-connecting web
   * client receives.
   */
  getSnapshot(): Extract<ServerMessage, { type: 'snapshot' }> {
    const { state, seq } = this.store.getSnapshot();
    return { type: 'snapshot', runId: this.runId, seq, state };
  }

  /**
   * Handle a resync request from a client. Returns the appropriate
   * `runId`-tagged message to send back to the requesting WebSocket (via the
   * broadcast callback from the control server).
   */
  handleResync(lastSeq?: number): Extract<ServerMessage, { type: 'snapshot' | 'events' }> {
    if (lastSeq !== undefined && lastSeq >= 0) {
      const events = this.store.getEventsSince(lastSeq);
      // Only use events catch-up if they are contiguous: the first event's
      // seq must equal lastSeq + 1.  If there's a gap (ring buffer evicted
      // the intervening events) or the buffer is empty, fall through to a
      // full snapshot so the client gets a clean baseline.
      if (events.length > 0 && events[0].seq === lastSeq + 1) {
        return {
          type: 'events',
          runId: this.runId,
          seq: this.store.getSnapshot().seq,
          events,
        };
      }
    }
    // Full resync — snapshot
    return this.getSnapshot();
  }

  /**
   * Unsubscribe from the store. Call during teardown to avoid leaks.
   *
   * Idempotent: subsequent calls are safely ignored.  The store unsubscribe
   * is invoked exactly once.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  /**
   * Broadcast a run-scoped terminal lifecycle message (`run_complete` /
   * `run_failed`) directly.  This is the canonical hook the RunManager calls
   * when a workflow reaches a terminal lifecycle state; it broadcasts the
   * message IMMEDIATELY (synchronously, not coalesced) to subscribers.
   *
   * No-op after {@link dispose} has been called.
   */
  broadcastTerminal(msg: Extract<BridgeMessage, { type: 'run_complete' | 'run_failed' }>): void {
    if (this.disposed) return;
    this.broadcast(msg);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Handle a projection change from the store.  Every change (terminal or
   * otherwise) schedules a coalesced events flush — the bridge does NOT
   * auto-detect terminal transitions here, since terminal broadcasts are the
   * sole responsibility of the {@link RunManager} via `broadcastTerminal()`.
   *
   * No-op after {@link dispose} has been called.
   */
  private onProjectionChange(_projection: WorkflowProjection): void {
    if (this.disposed) return;
    this.scheduleFlush();
  }

  /**
   * Schedule a microtask flush if one isn't already pending.
   * Multiple store.append() calls within the same synchronous frame will be
   * coalesced into a single events broadcast.
   */
  private scheduleFlush(): void {
    if (!this.flushPending) {
      this.flushPending = true;
      queueMicrotask(() => this.flush());
    }
  }

  /**
   * Collect all events since lastSentSeq and broadcast them in one message.
   *
   * No-op after {@link dispose} has been called (guards against uncancellable
   * microtask flushes that were scheduled before disposal).
   */
  private flush(): void {
    if (this.disposed) return;

    this.flushPending = false;

    const latestSeq = this.store.getSnapshot().seq;
    if (latestSeq <= this.lastSentSeq) return; // nothing new

    const events: EventRecord[] = this.store.getEventsSince(this.lastSentSeq);
    if (events.length === 0) return; // should not happen, but guard

    this.lastSentSeq = latestSeq;
    this.broadcast({
      type: 'events',
      runId: this.runId,
      seq: latestSeq,
      events,
    });
  }
}
