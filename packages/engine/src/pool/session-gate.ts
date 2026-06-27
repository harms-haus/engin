// ─── SessionGate — RAII concurrency authority ────────────────────────────────
//
// Two-level (total + per-model) FIFO gate for LLM session concurrency.
// Callers acquire via `gate.run(profile, fn)` — the gate holds the slot for
// the duration of `fn`, then releases automatically (RAII). There is NO
// manual acquire/release API.
//
// Design (informed by async-mutex `runExclusive` and p-queue):
//
//   - `totalAvailable` counter: hard cap across ALL models.
//   - `Map<modelKey, { available, queue }>`: per-model cap + FIFO queue.
//   - LOCK ORDERING: acquire total slot FIRST, then per-model; release
//     per-model FIRST, then total (reverse order) — prevents circular-wait.
//   - `tryAcquire(modelKey)` is synchronous: JS is single-threaded so the
//     two-counter decrement is atomic. On success both counters decrement.
//   - `dispatch()` scans each model queue head and admits any FIFO waiter
//     whose model has capacity AND total has capacity.
//   - `release()` is idempotent via a `called` flag.
//   - AbortSignal: pre-queue abort removes the waiter from its FIFO and
//     rejects with AbortError; already-aborted gate rejects immediately;
//     a waiter that wakes only to discover it's been aborted releases the
//     slot it just claimed and rejects (abort-vs-dispatch race guard).
//   - DeadlockError guard: a synchronous re-entrant run() on the same gate
//     while holding the last total slot is detected and rejected.

export interface SessionGateOptions {
  /** Hard cap on concurrent in-flight callbacks across ALL models. */
  total: number;
  /** Per-model cap keyed by `${provider}:${model}` (or `${provider}:${model}:${agent}` when agent is set). */
  perModel: Record<string, number>;
}

/** Thrown when a callback synchronously re-enters gate.run on the same gate
 *  while holding the last total slot (guaranteed deadlock). Optional — the
 *  gate MAY detect this or may not. Tests guard accordingly. */
export class DeadlockError extends Error {
  constructor(
    message = 'SessionGate deadlock detected: synchronous re-entrant run() while holding the last total slot',
  ) {
    super(message);
    this.name = 'DeadlockError';
  }
}

/** Internal AbortError-like DOMException substitute (no global required). */
function abortError(): Error {
  const err = new Error('AbortError');
  err.name = 'AbortError';
  return err;
}

interface Waiter {
  resolve: () => void;
  reject: (reason?: unknown) => void;
  /** Mutated by abort handler when this waiter is drained. */
  aborted: boolean;
}

interface ModelBucket {
  available: number;
  queue: Waiter[];
}

export class SessionGate {
  private totalAvailable: number;
  private readonly perModel: Record<string, number>;
  private readonly models = new Map<string, ModelBucket>();

  private readonly signal?: AbortSignal;

  /** True during the synchronous portion of a callback invocation — used to
   *  detect guaranteed-deadlock re-entrant run() calls. */
  private inSyncCallback = false;

  constructor(options: SessionGateOptions, signal?: AbortSignal) {
    this.totalAvailable = options.total;
    this.perModel = options.perModel;
    this.signal = signal;
  }

  /** Compute the per-model key for a profile. Prefers the 3-part
   *  `${provider}:${model}:${agent}` key when an agent is set AND a cap
   *  exists for it; otherwise falls back to the 2-part key. */
  private modelKey(profile: { provider: string; model: string; agent?: string }): string {
    const two = `${profile.provider}:${profile.model}`;
    if (profile.agent) {
      const three = `${two}:${profile.agent}`;
      if (this.perModel[three] !== undefined) return three;
    }
    return two;
  }

  /** Get-or-create the model bucket. Buckets with no explicit cap are
   *  treated as effectively unlimited (Infinity). */
  private bucket(modelKey: string): ModelBucket {
    let b = this.models.get(modelKey);
    if (!b) {
      const cap = this.perModel[modelKey];
      b = { available: cap === undefined ? Number.POSITIVE_INFINITY : cap, queue: [] };
      this.models.set(modelKey, b);
    }
    return b;
  }

  /** Synchronously attempt to claim both a total slot and a per-model slot.
   *  Returns true iff both decrements succeeded (atomic in single-threaded JS). */
  private tryAcquire(modelKey: string): boolean {
    if (this.totalAvailable <= 0) return false;
    const b = this.bucket(modelKey);
    if (b.available <= 0) return false;
    this.totalAvailable -= 1;
    b.available -= 1;
    return true;
  }

  /** Synchronously admit as many FIFO waiters as capacity allows. Scans each
   *  model's queue head; because total capacity is shared, admission of one
   *  model's head may block another's until a total slot frees. */
  private dispatch(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const b of this.models.values()) {
        if (b.queue.length === 0) continue;
        if (b.available <= 0) continue;
        if (this.totalAvailable <= 0) break;
        // Admit queue head.
        const waiter = b.queue.shift();
        if (!waiter) continue;
        this.totalAvailable -= 1;
        b.available -= 1;
        progressed = true;
        // Resolve on next microtask so the caller's await unblocks.
        queueMicrotask(() => waiter.resolve());
      }
    }
  }

  async run<R>(
    profile: { provider: string; model: string; agent?: string },
    fn: (handle: { signal: AbortSignal }) => Promise<R>,
  ): Promise<R> {
    // Already-aborted gate rejects immediately.
    if (this.signal?.aborted) {
      throw abortError();
    }

    const modelKey = this.modelKey(profile);
    const bucket = this.bucket(modelKey);

    // Fast path: both slots free synchronously.
    if (!this.tryAcquire(modelKey)) {
      // DeadlockError guard: a synchronous re-entrant run() while holding
      // the last total slot would never acquire — detect and reject.
      if (this.inSyncCallback && this.totalAvailable <= 0) {
        throw new DeadlockError();
      }

      // Slow path: enqueue a FIFO waiter.
      let resolveWait!: () => void;
      let rejectWait!: (reason?: unknown) => void;
      const waitPromise = new Promise<void>((res, rej) => {
        resolveWait = res;
        rejectWait = rej;
      });
      const waiter: Waiter = {
        resolve: resolveWait,
        reject: rejectWait,
        aborted: false,
      };
      bucket.queue.push(waiter);

      // Wire up abort handling (if a signal is present).
      const onAbort = () => {
        if (waiter.aborted) return;
        // Remove from FIFO if still queued.
        const idx = bucket.queue.indexOf(waiter);
        if (idx !== -1) {
          bucket.queue.splice(idx, 1);
          waiter.aborted = true;
          waiter.reject(abortError());
        }
      };
      this.signal?.addEventListener('abort', onAbort, { once: true });

      await waitPromise;
      this.signal?.removeEventListener('abort', onAbort);

      // Abort-vs-dispatch race: the waiter may have been dispatched (resolved)
      // AND then aborted in a later tick. If aborted after waking, release the
      // slot we just consumed and reject.
      if (waiter.aborted) {
        this.releaseSlot(modelKey);
        throw abortError();
      }
    }

    // ── Slot held: run the callback under RAII. ──────────────────────────

    // Build the cooperative handle signal. If the gate signal aborts during
    // the callback we propagate it; we do NOT force-kill in-flight callbacks.
    const handleSignal = this.signal ?? new AbortController().signal;

    let called = false;
    const release = () => {
      if (called) return;
      called = true;
      this.releaseSlot(modelKey);
    };

    try {
      // Abort-vs-dispatch race (already-aborted after acquiring): release
      // immediately and reject without invoking fn.
      if (this.signal?.aborted) {
        throw abortError();
      }

      // Invoke fn. The synchronous portion of an async fn executes before
      // the first internal await — set inSyncCallback so any re-entrant
      // run() within that window can be detected as a guaranteed deadlock.
      // A try/finally wraps ONLY the synchronous fn() call so that a
      // synchronous throw also resets the flag (fix-1: defensive reset).
      this.inSyncCallback = true;
      let resultPromise: Promise<R>;
      try {
        resultPromise = fn({ signal: handleSignal });
      } finally {
        this.inSyncCallback = false;
      }
      return await resultPromise;
    } finally {
      release();
    }
  }

  /** Release a per-model + total slot (per-model first, then total), then
   *  dispatch any waiters that may now be admissible. Idempotency is handled
   *  by the caller's `called` flag; this method always increments. */
  private releaseSlot(modelKey: string): void {
    const b = this.bucket(modelKey);
    b.available += 1;
    this.totalAvailable += 1;
    this.dispatch();
  }
}
