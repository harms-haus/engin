// ─── SessionGate — RAII concurrency authority ────────────────────────────────
//
// Two-level (total + per-model) FIFO gate for LLM session concurrency.
// Callers acquire via `gate.run(profile, fn)` (RAII) OR via manual
// `gate.acquire(profile)` / `gate.release(profile)` for scheduler-owned
// lifecycle.
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
  private readonly totalCap: number;
  private readonly perModel: Record<string, number>;
  private readonly models = new Map<string, ModelBucket>();

  private readonly signal?: AbortSignal;

  /** Optional callback fired after a slot is released (a session ended and a
   *  concurrency slot freed). Used by the RunnerPool to wake its drain loop
   *  so newly-freed capacity can claim waiting ready tasks WITHOUT waiting
   *  for an in-flight task to fully settle. */
  onRelease?: () => void;

  /** True during the synchronous portion of a callback invocation — used to
   *  detect guaranteed-deadlock re-entrant run() calls. */
  private inSyncCallback = false;

  constructor(options: SessionGateOptions, signal?: AbortSignal) {
    this.totalAvailable = options.total;
    this.totalCap = options.total;
    this.perModel = options.perModel;
    this.signal = signal;
  }

  /** Current number of available total (cross-model) concurrency slots.
   *  Lets callers (e.g. RunnerPool) limit how many tasks they start so tasks
   *  aren't marked active before a session slot is actually available. */
  availableTotal(): number {
    return this.totalAvailable;
  }

  /** Snapshot the gate's current capacity state for diagnostics/audit. Returns
   *  the configured total cap, the currently-available total slots, and every
   *  known model bucket with its cap (null = uncapped) and available slots.
   *  Read-only — does not mutate any counter. Used by the scheduler to record
   *  WHY sessions were started / skipped / parked in each drain pass. */
  snapshot(): {
    totalAvailable: number;
    totalCap: number;
    models: { key: string; available: number; cap: number | null }[];
  } {
    const models: { key: string; available: number; cap: number | null }[] = [];
    for (const [key, bucket] of this.models) {
      const configured = this.perModel[key];
      models.push({
        key,
        available: bucket.available,
        cap: configured === undefined ? null : configured,
      });
    }
    return { totalAvailable: this.totalAvailable, totalCap: this.totalCap, models };
  }

  /** Non-mutating peek: could a session for this profile's model be admitted
   *  right now? True iff a total slot is free AND the per-model bucket has
   *  capacity (uncapped models are only gated by the total). Used by the
   *  scheduler to check whether a session can start for this profile before
   *  attempting acquire (canonical/spec-required name). Also used by the
   *  RunnerPool to decide whether a ready task's FIRST session can run, so the
   *  task stays 'ready' until its first session actually has capacity. */
  canStart(profile: { provider: string; model: string; agent?: string }): boolean {
    if (this.totalAvailable <= 0) return false;
    const key = this.modelKey(profile);
    const cap = this.perModel[key];
    if (cap === undefined) return true; // uncapped model — only total gates it
    const b = this.models.get(key);
    return b === undefined ? cap > 0 : b.available > 0;
  }

  /** Backward-compatible alias of {@link canStart}. Delegates to canStart.
   *  Used by legacy `run()`-based callers (e.g. RunnerPool). */
  canAcquireFor(profile: { provider: string; model: string; agent?: string }): boolean {
    return this.canStart(profile);
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

  /** Synchronously attempt to claim a concurrency slot for the given
   *  profile, for use by the scheduler when it owns the session lifecycle
   *  (acquire before execute, release on settle). This is the manual-pairing
   *  alternative to the RAII `run()` — callers that need to bracket a session
   *  whose start and end are in different stack frames (e.g. the RunnerPool
   *  draining loop) use acquire()/release(); callers that can express the
   *  session as a single async function prefer `run()`.
   *
   *  This is a pure try-acquire: it decrements the total counter FIRST and the
   *  per-model counter SECOND (preserving the gate's lock-ordering invariant —
   *  see the file header), and returns `false` (never throws) when EITHER the
   *  total OR the per-model capacity is exhausted. It does NOT enqueue a FIFO
   *  waiter; the caller decides whether to retry, queue externally, or skip.
   *
   *  Pairing contract: each `true` return MUST be matched by exactly one later
   *  `release(profile)` for the SAME profile (same model key). A `false`
   *  return MUST NOT be released. Unbalanced calls inflate the available
   *  counters and break the cap.
   *
   *  @returns `true` if both total and per-model slots were available and
   *           decremented; `false` if either is saturated. */
  acquire(profile: { provider: string; model: string; agent?: string }): boolean {
    return this.tryAcquire(this.modelKey(profile));
  }

  /** Release a previously-acquired slot for the given profile, restoring one
   *  unit of per-model capacity AND one unit of total capacity, then admit any
   *  FIFO `run()` waiters that may now be admissible and fire `onRelease()` so
   *  the pool can claim newly-freed capacity. This is the manual-pairing
   *  counterpart to `acquire()` for scheduler-owned session lifecycles; the
   *  RAII `run()` path releases internally via the same mechanism.
   *
   *  Lock ordering: per-model counter is incremented FIRST and the total
   *  counter SECOND — the exact reverse of `acquire()` / `tryAcquire()` — to
   *  preserve the gate's lock-ordering invariant (see file header) and prevent
   *  circular-wait.
   *
   *  Pairing contract: call this exactly once for each prior successful
   *  `acquire()` with the SAME profile. Releasing without a matching acquire,
   *  or releasing more than once per acquire, will inflate the available
   *  counters beyond their configured caps — there is no internal bookkeeping
   *  to detect unbalanced releases, so callers own this invariant. */
  release(profile: { provider: string; model: string; agent?: string }): void {
    this.releaseSlot(this.modelKey(profile));
  }

  /** Release a per-model + total slot (per-model FIRST, then total — reverse
   *  of tryAcquire's lock ordering), then dispatch any waiters that may now be
   *  admissible, then fire `onRelease()`. Always increments both counters;
   *  idempotency / pairing is owned by the caller (RAII `called` flag for the
   *  `run()` path, or the scheduler's acquire/release bookkeeping for the
   *  manual path). */
  private releaseSlot(modelKey: string): void {
    const b = this.bucket(modelKey);
    b.available += 1;
    this.totalAvailable += 1;
    this.dispatch();
    // Notify the pool that capacity freed so it can claim waiting ready tasks.
    // dispatch() may have immediately re-consumed the slot (admitting a queued
    // waiter); that's fine — the pool's re-iteration is a cheap no-op then.
    this.onRelease?.();
  }
}
