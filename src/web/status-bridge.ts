import type { EventStore } from '../tracking/event-store.js';
import type { EventRecord, WorkflowProjection } from '../tracking/event-types.js';
import type { ServerMessage } from './protocol-types.js';

// ─── StatusBridge ───────────────────────────────────────────────────────────

/**
 * Thin view over the {@link EventStore} that broadcasts
 * snapshot/delta {@link ServerMessage}s whenever the store changes.
 *
 * - Late-joining clients receive a `{ type: 'snapshot' }` via `getSnapshot()`.
 * - Between snapshots the bridge coalesces store changes into a single
 *   `{ type: 'events' }` message per microtask tick, forwarding raw
 *   {@link EventRecord}s. The web client replays them via its own evolve.
 * - Terminal lifecycle transitions (→ complete / → failed) are broadcast
 *   IMMEDIATELY via `{ type: 'workflow_complete' }` /
 *   `{ type: 'workflow_failed' }`, not coalesced, so clients can surface a
 *   status banner without waiting for the event batch flush.  The coalesced
 *   events batch also carries the terminal event records (idempotent).
 */
export class StatusBridge {
  private unsubscribe: () => void;

  /** Last projection seq we sent to clients. */
  private lastSentSeq: number;

  /** Whether a microtask flush is already scheduled. */
  private flushPending = false;

  /** Reference to the store. */
  private readonly store: EventStore;

  /** Last projection status we observed (for terminal lifecycle detection). */
  private prevStatus: WorkflowProjection['status'];

  constructor(
    private broadcast: (msg: ServerMessage) => void,
    store: EventStore,
  ) {
    this.store = store;

    // Initialise lastSentSeq to the store's current seq so that pre-subscribe
    // history is NOT re-broadcast — late joiners get it via getSnapshot().
    const snap = store.getSnapshot();
    this.lastSentSeq = snap.seq;
    this.prevStatus = snap.state.status;

    // Subscribe to future projection changes.
    this.unsubscribe = store.subscribe((projection) => this.onProjectionChange(projection));
  }

  /**
   * Return a full snapshot derived from the store's current projection.
   * This is what a late-connecting web client receives.
   */
  getSnapshot(): ServerMessage & { type: 'snapshot' } {
    const { state, seq } = this.store.getSnapshot();
    return { type: 'snapshot', seq, state };
  }

  /**
   * Handle a resync request from a client. Returns the appropriate message
   * to send back to the requesting WebSocket (via the broadcast callback
   * from the observer server).
   */
  handleResync(lastSeq?: number): ServerMessage {
    if (lastSeq !== undefined && lastSeq >= 0) {
      const events = this.store.getEventsSince(lastSeq);
      // Only use events catch-up if they are contiguous: the first event's
      // seq must equal lastSeq + 1.  If there's a gap (ring buffer evicted
      // the intervening events) or the buffer is empty, fall through to a
      // full snapshot so the client gets a clean baseline.
      if (events.length > 0 && events[0].seq === lastSeq + 1) {
        return {
          type: 'events',
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
   */
  dispose(): void {
    this.unsubscribe();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Handle a projection change from the store.  Terminal lifecycle
   * transitions (→ complete / → failed) are broadcast IMMEDIATELY — not
   * coalesced — so clients can surface a status banner without waiting for
   * the event batch flush.  All projection changes (including terminal ones)
   * also schedule a coalesced events flush.
   */
  private onProjectionChange(projection: WorkflowProjection): void {
    const prev = this.prevStatus;
    this.prevStatus = projection.status;

    if (prev !== projection.status) {
      if (projection.status === 'complete') {
        this.broadcast({ type: 'workflow_complete' });
      } else if (projection.status === 'failed') {
        this.broadcast({
          type: 'workflow_failed',
          error: projection.error ?? '',
          phase: projection.failedPhase ?? '',
        });
      }
    }

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
   */
  private flush(): void {
    this.flushPending = false;

    const latestSeq = this.store.getSnapshot().seq;
    if (latestSeq <= this.lastSentSeq) return; // nothing new

    const events: EventRecord[] = this.store.getEventsSince(this.lastSentSeq);
    if (events.length === 0) return; // should not happen, but guard

    this.lastSentSeq = latestSeq;
    this.broadcast({
      type: 'events',
      seq: latestSeq,
      events,
    });
  }
}
