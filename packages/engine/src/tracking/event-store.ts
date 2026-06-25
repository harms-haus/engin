import type { EventRecord, EventType, WorkflowProjection } from '@engin/shared/event-types';
import { createInitialProjection } from '@engin/shared/event-types';
import { evolve } from '@engin/shared/evolve';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Capture the real console.error at module load time (before any RunManager or
// TUI console override is installed). Internal write-error logging uses this
// reference so it does NOT feed back through an overridden console.error —
// which would otherwise cause an infinite append→write→fail→log loop when a
// RunManager run has console.error overridden to append log events to THIS
// store.
const persistError = console.error;

const SNAPSHOT_VERSION = 2;

interface SnapshotData {
  state: WorkflowProjection;
  seq: number;
  timestamp: string;
  version?: number;
}

export class EventStore {
  private seq = 0;
  private projection: WorkflowProjection;
  private ringBuffer: EventRecord[] = [];
  private subscribers = new Set<(projection: WorkflowProjection) => void>();
  private readonly logPath: string;
  private readonly snapshotPath: string;
  private dirEnsured = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  // Backpressure guard: after enough consecutive write failures the store
  // stops attempting disk writes so the promise chain cannot grow without
  // bound under sustained pressure (e.g. disk full). The in-memory ring
  // buffer and projection keep updating — only persistence is short-circuited.
  private consecutiveWriteFailures = 0;
  private static readonly MAX_CONSECUTIVE_WRITE_FAILURES = 10;

  // ── Write coalescing (F2) ────────────────────────────────────────────────
  // Records appended within the same microtask tick are accumulated in
  // `pendingRecords` and flushed to disk in a SINGLE `appendFile` call by
  // `drainPending()`.  This avoids one fs syscall per event (every tool call /
  // turn) while preserving seq ordering and line-delimited JSON.  `flush()`
  // drains synchronously when called so it guarantees durability even when
  // invoked immediately after `append()` (before the scheduled microtask fires).
  private pendingRecords: EventRecord[] = [];
  private writeScheduled = false;

  constructor(
    private readonly workDir: string,
    private readonly opts?: { maxRingBuffer?: number },
  ) {
    this.logPath = join(workDir, 'events.jsonl');
    this.snapshotPath = join(workDir, 'event-snapshot.json');
    this.projection = createInitialProjection();
  }

  append(
    type: EventType,
    data: Record<string, unknown>,
    metadata?: { agentId?: string; taskId?: string; phaseId?: string },
  ): EventRecord {
    // After dispose the store is frozen: append is a no-op for every side
    // effect (no ring-buffer push, no evolve, no disk write, no subscriber
    // notification) but still returns a synthetic EventRecord carrying the
    // next seq and the passed type/data so callers that rely on a monotonically
    // increasing seq keep counting.
    if (this.disposed) {
      return {
        seq: ++this.seq,
        type,
        data,
        metadata: {
          timestamp: new Date().toISOString(),
          ...metadata,
        },
      };
    }

    const record: EventRecord = {
      seq: ++this.seq,
      type,
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        ...metadata,
      },
    };

    // Update ring buffer — trim in batches (10% hysteresis) to avoid
    // an O(n) slice on every single append.
    this.ringBuffer.push(record);
    const maxBuffer = this.opts?.maxRingBuffer ?? 1000;
    if (this.ringBuffer.length > maxBuffer * 1.1) {
      this.ringBuffer = this.ringBuffer.slice(this.ringBuffer.length - maxBuffer);
    }

    // Evolve projection
    this.projection = evolve(this.projection, record);

    // Coalesced fire-and-forget disk append (drained per microtask tick).
    this.enqueueWrite(record);

    // Notify subscribers
    for (const cb of this.subscribers) {
      try {
        cb(this.projection);
      } catch {
        // subscriber errors should not crash the store
      }
    }

    return record;
  }

  getProjection(): WorkflowProjection {
    return this.projection;
  }

  getSnapshot(): { state: WorkflowProjection; seq: number } {
    return { state: this.projection, seq: this.seq };
  }

  getEventsSince(seq: number): EventRecord[] {
    const buf = this.ringBuffer;
    if (buf.length === 0) return [];
    // If seq is older than the buffer's oldest, return everything available.
    const oldest = buf[0].seq;
    if (seq < oldest) {
      return [...buf];
    }
    // The ring buffer is a contiguous, seq-ordered slice, so a binary search
    // for the first record with seq > arg replaces the previous O(n) filter.
    let lo = 0;
    let hi = buf.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (buf[mid].seq <= seq) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return buf.slice(lo);
  }

  subscribe(cb: (projection: WorkflowProjection) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  async flush(): Promise<void> {
    // If a drain is pending (the scheduled microtask has not fired yet),
    // drain synchronously now so flush() guarantees durability even when
    // called immediately after append().
    if (this.writeScheduled) {
      this.drainPending();
    }
    await this.writeQueue;
  }

  async saveSnapshot(): Promise<void> {
    if (this.disposed) return;
    await this.ensureDir();

    const data: SnapshotData = {
      state: this.projection,
      seq: this.seq,
      timestamp: new Date().toISOString(),
      version: SNAPSHOT_VERSION,
    };

    const tmpPath = this.snapshotPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmpPath, this.snapshotPath);
  }

  /**
   * Tear down the store: clear subscribers and cancel any pending coalesced
   * write so it never lands on disk. After dispose, {@link append} is a no-op
   * for all side effects (it still returns a synthetic {@link EventRecord}
   * carrying the next seq so callers that assign seq keep counting),
   * {@link flush} resolves cleanly, and {@link saveSnapshot} writes nothing.
   *
   * Idempotent: subsequent calls are a no-op. Disposing one instance does not
   * affect any other instance — all cleared state is per-instance.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Drop subscribers so callbacks do not leak past teardown.
    this.subscribers.clear();

    // Cancel any scheduled microtask drain: clearing the flag + pending batch
    // makes the already-queued queueMicrotask(drainPending) a no-op (it
    // returns early on an empty batch), so no further disk writes fire. The
    // in-flight writeQueue (if any) is left to settle on its own — it already
    // swallows its own errors, so a later flush() resolves safely.
    if (this.writeScheduled) {
      this.writeScheduled = false;
      this.pendingRecords = [];
    }
  }

  static async load(workDir: string, opts?: { maxRingBuffer?: number }): Promise<EventStore> {
    const store = new EventStore(workDir, opts);
    const logPath = join(workDir, 'events.jsonl');
    const snapshotPath = join(workDir, 'event-snapshot.json');

    let snapshotSeq = 0;

    // 1. Try loading snapshot
    try {
      const raw = await readFile(snapshotPath, 'utf-8');
      const snap: SnapshotData = JSON.parse(raw);
      if (snap.version !== SNAPSHOT_VERSION) {
        console.debug('[EventStore] Discarding snapshot with version', snap.version, 'expected', SNAPSHOT_VERSION);
      } else {
        store.projection = snap.state;
        store.seq = snap.seq;
        snapshotSeq = snap.seq;
      }
    } catch {
      // No snapshot — start fresh
    }

    // 2. Replay events.jsonl with seq > snapshotSeq
    try {
      const content = await readFile(logPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const record: EventRecord = JSON.parse(line);
          if (record.seq > snapshotSeq) {
            store.projection = evolve(store.projection, record);
            store.seq = Math.max(store.seq, record.seq);
            store.ringBuffer.push(record);
          }
        } catch {
          console.warn(`[EventStore] Skipping malformed JSONL line: ${line.slice(0, 100)}`);
        }
      }
      // Trim ring buffer to capacity
      const maxBuffer = opts?.maxRingBuffer ?? 1000;
      if (store.ringBuffer.length > maxBuffer) {
        store.ringBuffer = store.ringBuffer.slice(store.ringBuffer.length - maxBuffer);
      }
    } catch {
      // No events.jsonl — fine
    }

    return store;
  }

  private enqueueWrite(record: EventRecord): void {
    this.pendingRecords.push(record);
    // Defer the actual fs write to the next microtask so that multiple
    // synchronous appends within the same tick coalesce into a single
    // appendFile call.  Ordering is preserved because records are pushed in
    // seq order and drained in order.
    if (!this.writeScheduled) {
      this.writeScheduled = true;
      queueMicrotask(() => this.drainPending());
    }
  }

  private drainPending(): void {
    // Snapshot the pending buffer and clear the scheduling flag so that
    // appends arriving during the async write schedule a fresh drain chained
    // after this one.
    const batch = this.pendingRecords;
    this.pendingRecords = [];
    this.writeScheduled = false;
    if (batch.length === 0) return;
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (this.consecutiveWriteFailures >= EventStore.MAX_CONSECUTIVE_WRITE_FAILURES) {
          return; // Persistent failure detected — stop attempting disk writes.
        }
        await this.ensureDir();
        const payload = batch.map((r) => JSON.stringify(r)).join('\n') + '\n';
        await appendFile(this.logPath, payload, 'utf-8');
        this.consecutiveWriteFailures = 0; // Reset on success.
      })
      .catch((err) => {
        this.consecutiveWriteFailures++;
        // Log write errors so silent permanent data loss is visible on restart.
        // Uses the module-load-time reference (NOT the possibly-overridden
        // global console.error) to avoid a feedback loop with RunManager's
        // console capture override.
        persistError('[EventStore] Failed to persist events:', err);
        if (this.consecutiveWriteFailures === EventStore.MAX_CONSECUTIVE_WRITE_FAILURES) {
          persistError(
            `[EventStore] ${EventStore.MAX_CONSECUTIVE_WRITE_FAILURES} consecutive write failures — stopping disk writes to prevent unbounded queue growth.`,
          );
        }
      });
  }

  private async ensureDir(): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(this.workDir, { recursive: true });
      this.dirEnsured = true;
    }
  }
}
