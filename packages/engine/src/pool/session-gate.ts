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

/** Concurrency limits for the {@link SessionGate}. Controls how many LLM
 *  sessions may be in-flight simultaneously — a hard total cap, an optional
 *  provider-level shared pool, and per-model/agent caps. */
export interface SessionGateOptions {
  /** Hard cap on concurrent in-flight callbacks across ALL models. */
  total: number;
  /** Concurrency caps keyed by specificity (most-specific that matches wins
   *  for the model level; provider level is layered additively — see below):
   *
   *    `${provider}`                  — provider-level cap: shared pool across
   *                                     ALL of the provider's models. Applied
   *                                     IN ADDITION to any model/agent cap.
   *    `${provider}:${model}`         — per-model cap.
   *    `${provider}:${model}:${agent}` — per-agent override (most specific).
   *
   *  Provider caps (no colon) and model caps are independent constraints:
   *  an acquire must satisfy BOTH the provider pool (if set) and the
   *  model/agent bucket (if set), in addition to the total. Use a provider
   *  cap to model a shared rate-limit pool across a provider's models
   *  (e.g. `zai: 7` when all zai models draw from one account limit). */
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

function abortError(): Error {
  const err = new Error('AbortError');
  err.name = 'AbortError';
  return err;
}

interface Waiter {
  resolve: () => void;
  reject: (reason?: unknown) => void;
  /** Set when the abort handler fires for this waiter. */
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
  /** Provider-level buckets keyed by `${provider}`. Only present for providers
   *  that have a `${provider}` entry in `perModel`. Unlike model buckets these
   *  never own a FIFO queue — waiters always live in their (most-specific)
   *  model bucket's queue; the provider bucket is purely an additional
   *  capacity counter checked during acquire/dispatch. */
  private readonly providers = new Map<string, ModelBucket>();

  private readonly signal?: AbortSignal;

  /** Optional callback fired after a slot is released (a session ended and a
   *  concurrency slot freed). Used by the RunnerPool to wake its drain loop
   *  so newly-freed capacity can claim waiting ready tasks WITHOUT waiting
   *  for an in-flight task to fully settle. */
  onRelease?: () => void;

  /** True during the synchronous portion of the callback — used to detect
   *  guaranteed-deadlock re-entrant run() calls. */
  private inSyncCallback = false;

  constructor(options: SessionGateOptions, signal?: AbortSignal) {
    this.totalAvailable = options.total;
    this.totalCap = options.total;
    this.perModel = options.perModel;
    this.signal = signal;
    // Eagerly materialize provider-level buckets (keys with no ':'). These
    // represent a shared pool across all of a provider's models and are
    // decremented additively alongside any model/agent cap.
    for (const [key, cap] of Object.entries(this.perModel)) {
      if (!key.includes(':')) {
        this.providers.set(key, { available: cap, queue: [] });
      }
    }
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
    providers: { key: string; available: number; cap: number }[];
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
    const providers: { key: string; available: number; cap: number }[] = [];
    for (const [key, bucket] of this.providers) {
      providers.push({ key, available: bucket.available, cap: this.perModel[key] });
    }
    return { totalAvailable: this.totalAvailable, totalCap: this.totalCap, models, providers };
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
    // Provider-level pool (shared across the provider's models), if configured.
    const pb = this.providers.get(profile.provider);
    if (pb !== undefined && pb.available <= 0) return false;
    const key = this.modelKey(profile);
    const cap = this.perModel[key];
    if (cap === undefined) return true; // uncapped model — only total (+ provider) gates it
    const b = this.models.get(key);
    return b === undefined ? cap > 0 : b.available > 0;
  }
  /** Build the per-model key for a profile. Uses the 3-part key when an agent
   *  is set AND a cap exists for that key; otherwise falls back to 2-part. */
  private modelKey(profile: { provider: string; model: string; agent?: string }): string {
    const two = `${profile.provider}:${profile.model}`;
    if (profile.agent) {
      const three = `${two}:${profile.agent}`;
      if (this.perModel[three] !== undefined) return three;
    }
    return two;
  }

  /** Get-or-create the model bucket. Uncapped models are effectively infinite. */
  private bucket(modelKey: string): ModelBucket {
    let b = this.models.get(modelKey);
    if (!b) {
      const cap = this.perModel[modelKey];
      b = { available: cap === undefined ? Number.POSITIVE_INFINITY : cap, queue: [] };
      this.models.set(modelKey, b);
    }
    return b;
  }

  /** Try to claim a total slot, a provider-pool slot (if the provider has a
   *  cap), and a per-model slot (atomic in single-threaded JS). */
  private tryAcquire(modelKey: string, providerKey: string): boolean {
    if (this.totalAvailable <= 0) return false;
    const pb = this.providers.get(providerKey);
    if (pb !== undefined && pb.available <= 0) return false;
    const b = this.bucket(modelKey);
    if (b.available <= 0) return false;
    this.totalAvailable -= 1;
    if (pb !== undefined) pb.available -= 1;
    b.available -= 1;
    return true;
  }

  /** Admit FIFO waiters while capacity allows. Total capacity is shared across
   *  models, so admitting one model's head may block another's. A waiter is
   *  admitted only when the total, its provider pool (if any), AND its model
   *  bucket all have capacity. */
  private dispatch(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [key, b] of this.models) {
        if (b.queue.length === 0) continue;
        if (b.available <= 0) continue;
        if (this.totalAvailable <= 0) break;
        // Provider-level pool (shared across the provider's models).
        const provider = key.split(':')[0] ?? key;
        const pb = this.providers.get(provider);
        if (pb !== undefined && pb.available <= 0) continue;
        // Admit queue head.
        const waiter = b.queue.shift();
        if (!waiter) continue;
        this.totalAvailable -= 1;
        if (pb !== undefined) pb.available -= 1;
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
    if (this.signal?.aborted) {
      throw abortError();
    }

    const modelKey = this.modelKey(profile);
    const providerKey = profile.provider;
    const bucket = this.bucket(modelKey);

    // Fast path: all slots free synchronously.
    if (!this.tryAcquire(modelKey, providerKey)) {
      // DeadlockError guard: re-entrant run() while holding the last total
      // slot would never acquire — detect and reject.
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

      const onAbort = () => {
        if (waiter.aborted) return;
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

      // Abort-vs-dispatch race: the waiter may have been dispatched AND then
      // aborted in a later tick. If aborted after waking, release the slot
      // we just consumed and reject.
      if (waiter.aborted) {
        this.releaseSlot(modelKey, providerKey);
        throw abortError();
      }
    }

    // ── Slot held: run the callback ──────────────────────────────────────

    const handleSignal = this.signal ?? new AbortController().signal;

    let called = false;
    const release = () => {
      if (called) return;
      called = true;
      this.releaseSlot(modelKey, providerKey);
    };

    try {
      // Abort-vs-dispatch race: gate aborted after we acquired but before fn.
      if (this.signal?.aborted) {
        throw abortError();
      }

      // The synchronous portion of an async fn runs before the first await.
      // Flag inSyncCallback so re-entrant run() within that window can be
      // detected as a deadlock. The try/finally ensures the flag is reset
      // even on synchronous throw.
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

  /** Try to claim a concurrency slot for the given profile. This is the
   *  manual-pairing alternative to RAII `run()` for scheduler-owned sessions
   *  (e.g. RunnerPool draining loop). Pure try-acquire: decrements total FIRST
   *  then per-model (per lock-ordering invariant in file header). Returns
   *  `false` (never throws) when either total or per-model capacity is
   *  exhausted; does NOT enqueue a FIFO waiter.
   *
   *  Pairing contract: each `true` return MUST be matched by exactly one later
   *  `release(profile)` for the SAME model key. A `false` return MUST NOT be
   *  released. See `release()` for lock-ordering details.
   *
   *  @returns `true` if both slots were available and decremented. */
  acquire(profile: { provider: string; model: string; agent?: string }): boolean {
    return this.tryAcquire(this.modelKey(profile), profile.provider);
  }

  /** Release a previously-acquired slot and admit any FIFO waiters that may
   *  now be admissible, then fire `onRelease()` so the pool can claim freed
   *  capacity. Lock ordering: per-model FIRST then total — reverse of
   *  `acquire()` — to prevent circular-wait (see file header).
   *
   *  Pairing contract: see `acquire()`. The RAII `run()` path releases
   *  internally via the same mechanism. */
  release(profile: { provider: string; model: string; agent?: string }): void {
    this.releaseSlot(this.modelKey(profile), profile.provider);
  }

  /** Release per-model FIRST, then provider pool (if any), then total
   *  (reverse of tryAcquire), then dispatch waiters and fire onRelease.
   *  Always increments the applicable counters; idempotency is owned by the
   *  caller. */
  private releaseSlot(modelKey: string, providerKey: string): void {
    const b = this.bucket(modelKey);
    b.available += 1;
    const pb = this.providers.get(providerKey);
    if (pb !== undefined) pb.available += 1;
    this.totalAvailable += 1;
    this.dispatch();
    // Notify the pool that capacity freed so it can claim waiting ready tasks.
    // dispatch() may have immediately re-consumed the slot (admitting a queued
    // waiter); that's fine — the pool's re-iteration is a cheap no-op then.
    this.onRelease?.();
  }
}
