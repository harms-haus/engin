// ─── Tests for pool/session-gate.ts — two-level concurrency authority ───────
//
// SessionGate provides two-level (total + per-model) FIFO concurrency gating
// for LLM sessions. Two access modes:
//
//   1. RAII mode:  `gate.run(profile, fn)` — holds a slot for the duration of
//      `fn`, releases automatically on completion or throw.
//   2. Manual mode: `gate.acquire(profile)` / `gate.release(profile)` — for
//      scheduler-owned session lifecycles where start and end live in different
//      stack frames (e.g. RunnerPool draining loop). Each `acquire()` must be
//      paired with exactly one `release()`.
//
// The two modes interoperate: manual acquire/release can block/unblock RAII
// run() waiters via the shared FIFO dispatch mechanism.
//
// Constructor signature: `new SessionGate(options, signal?)` where
//   options: { total: number; perModel: Record<string, number> }
//   signal?: AbortSignal (optional, for cooperative cancellation)
//
// This follows the common AbortSignal convention (separate from config) used
// by fetch, EventTarget.addEventListener, etc.

import { describe, expect, it } from 'bun:test';
import { DeadlockError, SessionGate } from './session-gate.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Deferred promise — resolve/reject externally for deterministic gating. */
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Sleep for `ms` — lets the event loop settle for timing-sensitive assertions. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Construct a fresh SessionGate. perModel defaults to {} (no per-model caps). */
function makeGate(options: { total: number; perModel?: Record<string, number> }, signal?: AbortSignal) {
  return new SessionGate({ total: options.total, perModel: options.perModel ?? {} }, signal);
}

/** Build a profile for gate.run(). */
function makeProfile(provider: string, model: string, agent?: string) {
  return { provider, model, agent };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SessionGate', () => {
  // ── 1. Total cap enforced ──────────────────────────────────────────────
  //
  // total=2, start 3 run() calls; exactly 2 invoke fn concurrently,
  // 3rd waits; when one resolves, 3rd proceeds.

  it('1. total cap enforced: total=2 allows 2 concurrent, 3rd waits', async () => {
    const gate = makeGate({ total: 2 });
    const profile = makeProfile('p', 'm');

    let running = 0;
    let peak = 0;

    const hold1 = deferred();
    const hold2 = deferred();
    const hold3 = deferred();

    const p1 = gate.run(profile, async () => {
      running++;
      peak = Math.max(peak, running);
      await hold1.promise;
      running--;
      return 'a';
    });

    const p2 = gate.run(profile, async () => {
      running++;
      peak = Math.max(peak, running);
      await hold2.promise;
      running--;
      return 'b';
    });

    // Third call — should wait for a slot.
    const p3 = gate.run(profile, async () => {
      running++;
      peak = Math.max(peak, running);
      await hold3.promise;
      running--;
      return 'c';
    });

    await sleep(10);

    // Exactly 2 running (p1, p2), 3rd waiting.
    expect(running).toBe(2);
    expect(peak).toBe(2);

    // Resolve first — 3rd should now proceed.
    hold1.resolve();
    await sleep(10);

    expect(running).toBe(2); // p2 + p3

    hold2.resolve();
    hold3.resolve();

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  // ── 2. Per-model cap independent ──────────────────────────────────────
  //
  // total=5, perModel={'a:m':2,'b:m':2}; 3 calls for a:m → 2 run, 1 waits;
  // a b:m call runs concurrently with the 2 a:m.

  it('2. per-model cap independent: b:m runs alongside a:m', async () => {
    const gate = makeGate({ total: 5, perModel: { 'a:m': 2, 'b:m': 2 } });

    let running = 0;
    let peak = 0;

    const hold = deferred();

    // 3 calls for a:m — only 2 should run (per-model cap = 2).
    const pa1 = gate.run(makeProfile('a', 'm'), async () => {
      running++;
      peak = Math.max(peak, running);
      await hold.promise;
      running--;
      return 'a1';
    });
    const pa2 = gate.run(makeProfile('a', 'm'), async () => {
      running++;
      peak = Math.max(peak, running);
      await hold.promise;
      running--;
      return 'a2';
    });
    const pa3 = gate.run(makeProfile('a', 'm'), async () => {
      running++;
      peak = Math.max(peak, running);
      running--;
      return 'a3';
    });

    await sleep(10);
    expect(running).toBe(2); // 2 a:m running, 1 waiting

    // b:m call — different model key, total not exhausted → runs concurrently.
    const pb1 = gate.run(makeProfile('b', 'm'), async () => {
      running++;
      peak = Math.max(peak, running);
      await hold.promise;
      running--;
      return 'b1';
    });

    await sleep(10);

    // 2 a:m + 1 b:m = 3 concurrent.
    expect(running).toBe(3);
    expect(peak).toBe(3);

    hold.resolve();

    const results = await Promise.all([pa1, pa2, pa3, pb1]);
    expect(results).toEqual(['a1', 'a2', 'a3', 'b1']);
  });

  // ── 3. FIFO ordering per model ────────────────────────────────────────
  //
  // perModel cap 1, total 3; 3 calls for same model → execute strictly
  // in call order.

  it('3. FIFO ordering per model: strictly call-order execution', async () => {
    const gate = makeGate({ total: 3, perModel: { 'p:m': 1 } });
    const profile = makeProfile('p', 'm');

    const order: number[] = [];
    const hold = deferred();

    const p1 = gate.run(profile, async () => {
      await hold.promise;
      order.push(1);
      return 'r1';
    });
    const p2 = gate.run(profile, async () => {
      order.push(2);
      return 'r2';
    });
    const p3 = gate.run(profile, async () => {
      order.push(3);
      return 'r3';
    });

    await sleep(10);
    expect(order).toEqual([]); // none completed yet (p1 holding slot)

    hold.resolve();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]); // strict FIFO
  });

  // ── 4. Release-on-throw ──────────────────────────────────────────────
  //
  // fn throws → slot freed (a subsequent call proceeds);
  // run() rejects with the same error instance.

  it('4. release-on-throw: fn throws → slot freed, error propagated', async () => {
    const gate = makeGate({ total: 1 });
    const profile = makeProfile('p', 'm');
    const sentinel = new Error('boom');

    // Call that throws — occupies and then releases the slot.
    const p1 = gate.run(profile, async () => {
      throw sentinel;
    });

    // Error is the same instance (not a copy).
    await expect(p1).rejects.toBe(sentinel);

    // Slot freed — next call proceeds immediately.
    const p2 = gate.run(profile, async () => 'ok');
    expect(await p2).toBe('ok');
  });

  // ── 5. Abort drains waiters ──────────────────────────────────────────
  //
  // gate built with a controller; abort after a call is queued → queued
  // run() rejects with AbortError; in-flight run NOT rejected by the gate.

  it('5. abort drains waiters: queued rejects, in-flight completes', async () => {
    const ac = new AbortController();
    const gate = makeGate({ total: 1 }, ac.signal);
    const profile = makeProfile('p', 'm');

    const hold = deferred();

    // In-flight — holds the only slot.
    const p1 = gate.run(profile, async () => {
      await hold.promise;
      return 'in-flight';
    });

    // Queued — waiting for slot.
    const p2 = gate.run(profile, async () => 'queued');

    await sleep(10);

    // Abort — should drain p2 from FIFO.
    ac.abort();

    // p2 rejects with AbortError.
    await expect(p2).rejects.toThrow('AbortError');

    // p1 completes normally (in-flight not rejected by the gate).
    hold.resolve();
    expect(await p1).toBe('in-flight');
  });

  // ── 6. Already-aborted gate ──────────────────────────────────────────
  //
  // All run() calls reject immediately when the signal is already aborted.

  it('6. already-aborted gate: all run() calls reject immediately', async () => {
    const ac = new AbortController();
    ac.abort(); // abort before creating the gate

    const gate = makeGate({ total: 5 }, ac.signal);
    const profile = makeProfile('p', 'm');

    await expect(gate.run(profile, async () => 'a')).rejects.toThrow('AbortError');
    await expect(gate.run(profile, async () => 'b')).rejects.toThrow('AbortError');
    await expect(gate.run(profile, async () => 'c')).rejects.toThrow('AbortError');
  });

  // ── 7. Abort-vs-dispatch race ────────────────────────────────────────
  //
  // Signal aborts just as a slot frees — the waking call must not consume
  // the slot; release immediately and let the next waiter proceed (if any).

  it('7. abort-vs-dispatch race: freed slot not consumed by waking waiter', async () => {
    const ac = new AbortController();
    const gate = makeGate({ total: 1 }, ac.signal);
    const profile = makeProfile('p', 'm');

    const hold = deferred();

    // In-flight — holds the only slot.
    const p1 = gate.run(profile, async () => {
      await hold.promise;
      return 'r1';
    });

    // Queued waiter.
    const p2 = gate.run(profile, async () => 'r2');

    await sleep(10);

    // Abort + release simultaneously (same microtask).
    ac.abort();
    hold.resolve();

    // p1 completes normally.
    expect(await p1).toBe('r1');

    // p2 rejected with AbortError (did NOT consume the freed slot).
    await expect(p2).rejects.toThrow('AbortError');

    // Gate counters clean: subsequent call also rejects (no leaked slot).
    await expect(gate.run(profile, async () => 'r3')).rejects.toThrow('AbortError');
  });

  // ── 8. Idempotent release ────────────────────────────────────────────
  //
  // The handle exposes NO release/acquire — RAII only.

  it('8. idempotent release: handle exposes NO release/acquire', async () => {
    const gate = makeGate({ total: 2 });
    const profile = makeProfile('p', 'm');

    const handleKeys: string[] = [];
    let signalInstance = false;

    await gate.run(profile, async (handle) => {
      handleKeys.push(...Object.keys(handle));
      signalInstance = handle.signal instanceof AbortSignal;
      return 'ok';
    });

    // Handle must NOT expose release or acquire.
    expect(handleKeys).not.toContain('release');
    expect(handleKeys).not.toContain('acquire');
    // Handle MUST expose signal as an AbortSignal.
    expect(handleKeys).toContain('signal');
    expect(signalInstance).toBe(true);
  });

  // ── 9. Deadlock-freedom: parallelRunner-style ────────────────────────
  //
  // 3 independent gate.run calls awaited together under total cap 1 →
  // all complete (they serialize), no hang.

  it('9. deadlock-freedom: 3 parallel gate.run() under total=1 serialize', async () => {
    const gate = makeGate({ total: 1 });
    const profile = makeProfile('p', 'm');

    const results = await Promise.all([
      gate.run(profile, async () => 'a'),
      gate.run(profile, async () => 'b'),
      gate.run(profile, async () => 'c'),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
  }, 5000);

  // ── 10. Deadlock-freedom: coordinator-then-children ──────────────────
  //
  // A fn that completes, then 2 children awaited together → all complete,
  // no hang.

  it('10. deadlock-freedom: coordinator-then-children under total=1', async () => {
    const gate = makeGate({ total: 1 });
    const profile = makeProfile('p', 'm');

    // Coordinator phase — runs and completes, releasing the slot.
    const coordinatorResult = await gate.run(profile, async () => 'plan');
    expect(coordinatorResult).toBe('plan');

    // Children phase — submitted concurrently, serialized by total=1.
    const childResults = await Promise.all([
      gate.run(profile, async () => 'child-1'),
      gate.run(profile, async () => 'child-2'),
    ]);

    expect(childResults).toEqual(['child-1', 'child-2']);
  }, 5000);

  // ── 11. Per-agent key resolution ─────────────────────────────────────
  //
  // perModel={'p:m:agent-a':1,'p:m:agent-b':1}; calls for agent-a and
  // agent-b capped independently (different 3-part keys).

  it('11. per-agent key resolution: agent-a and agent-b independent caps', async () => {
    const gate = makeGate({
      total: 5,
      perModel: { 'p:m:agent-a': 1, 'p:m:agent-b': 1 },
    });

    let running = 0;
    let peak = 0;
    const hold = deferred();

    // agent-a call — holds its slot.
    const pa1 = gate.run(makeProfile('p', 'm', 'agent-a'), async () => {
      running++;
      peak = Math.max(peak, running);
      await hold.promise;
      running--;
      return 'a1';
    });

    // agent-b call — different key, should run concurrently.
    const pb1 = gate.run(makeProfile('p', 'm', 'agent-b'), async () => {
      running++;
      peak = Math.max(peak, running);
      await hold.promise;
      running--;
      return 'b1';
    });

    await sleep(10);

    // Both running (different agent keys).
    expect(running).toBe(2);
    expect(peak).toBe(2);

    // Second agent-a call — should wait (cap=1 for agent-a).
    const pa2 = gate.run(makeProfile('p', 'm', 'agent-a'), async () => {
      running++;
      peak = Math.max(peak, running);
      running--;
      return 'a2';
    });

    await sleep(10);

    // Still 2 running (pa1 + pb1), pa2 waiting.
    expect(running).toBe(2);

    hold.resolve();

    const results = await Promise.all([pa1, pb1, pa2]);
    expect(results).toEqual(['a1', 'b1', 'a2']);
  });

  // ── 12. Optional DeadlockError guard ─────────────────────────────────
  //
  // A fn that synchronously calls gate.run on the same gate while holding
  // the last total slot throws/rejects with DeadlockError (if implemented).
  // Guard: test must not hang regardless — races against a safety timeout.

  it('12. optional DeadlockError guard: re-entrant run() on last slot', async () => {
    const gate = makeGate({ total: 1 });
    const profile = makeProfile('p', 'm');

    const outcome = await Promise.race([
      gate
        .run(profile, async () => {
          // Synchronous re-entrant call — guaranteed deadlock if not detected.
          return gate.run(profile, async () => 'inner');
        })
        .then(
          () => 'completed' as const,
          (e) => {
            if (e instanceof DeadlockError) return 'deadlock-error' as const;
            throw e;
          },
        ),
      // Safety timeout: catches hangs (no deadlock guard implemented).
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);

    // Must not hang. Either the guard fired (DeadlockError) or the call completed.
    expect(outcome === 'deadlock-error' || outcome === 'completed').toBe(true);
  }, 5000);

  // ── 13. sync-throw in fn does not poison the gate (inSyncCallback reset) ──
  //
  // A NON-async fn that throws synchronously must not leave inSyncCallback
  // stuck true. If it does, every subsequent slow-path run() spuriously
  // throws DeadlockError.
  //
  // Regression: inSyncCallback is set true before fn(...) and false after,
  // but a synchronous throw skips the reset.

  it('13. sync-throw in fn does not poison the gate (inSyncCallback reset)', async () => {
    const gate = makeGate({ total: 1 });
    const profile = makeProfile('p', 'm');
    const profile2 = makeProfile('q', 'n');

    // Step 1: NON-async fn that throws synchronously — must reject with the same error.
    const syncError = new Error('sync boom');
    await expect(
      gate.run(profile, () => {
        throw syncError;
      }),
    ).rejects.toBe(syncError);

    // Step 2: Hold the only slot with a deferred so the next call queues.
    const hold = deferred();
    const holder = gate.run(profile, async () => {
      await hold.promise;
      return 'holding';
    });

    await sleep(10); // let the slot be acquired

    // Step 3: This call must queue (total=1, slot held) and eventually
    // complete — it must NOT reject with DeadlockError.
    const queued = gate.run(profile2, async () => 'ok');

    await sleep(10); // let it settle in the queue

    // Step 4: Release the held slot — queued call should now proceed.
    hold.resolve();

    const [heldResult, queuedResult] = await Promise.all([holder, queued]);
    expect(heldResult).toBe('holding');
    expect(queuedResult).toBe('ok');
  }, 5000);

  // ── 14. canStart (canonical) ≡ canAcquireFor (compat alias) ────────────
  //
  // canStart and canAcquireFor must return the same truthy/falsy result for
  // identical inputs across a variety of total/per-model states (the latter
  // delegates to the former).

  it('14. canStart is an alias of canAcquireFor (equivalence)', async () => {
    const gate = makeGate({ total: 3, perModel: { 'p:m': 2, 'p:n': 1 } });
    const profileA = makeProfile('p', 'm');
    const profileB = makeProfile('p', 'n');
    const profileC = makeProfile('p', 'o'); // uncapped

    // Both return true when there is capacity.
    expect(gate.canStart(profileA)).toBe(true);
    expect(gate.canAcquireFor(profileA)).toBe(true);
    expect(gate.canStart(profileA)).toBe(gate.canAcquireFor(profileA));

    // Both return false when total is exhausted.
    // Acquire 3 slots (total=3).
    gate.acquire(profileA); // 1
    gate.acquire(profileB); // 2
    gate.acquire(profileC); // 3

    expect(gate.canStart(profileA)).toBe(false);
    expect(gate.canAcquireFor(profileA)).toBe(false);
    expect(gate.canStart(profileA)).toBe(gate.canAcquireFor(profileA));

    // Release one — both return true again.
    gate.release(profileA);
    expect(gate.canStart(profileA)).toBe(true);
    expect(gate.canAcquireFor(profileA)).toBe(true);

    // Per-model cap: p:n has cap=1, already held.
    expect(gate.canStart(profileB)).toBe(false);
    expect(gate.canAcquireFor(profileB)).toBe(false);
  });

  // ── 15. acquire returns true on success, false on saturation ───────────
  //
  // Synchronous slot acquisition; returns true when both total and per-model
  // slots are available, false otherwise. Does NOT queue or wait.

  it('15. acquire returns true on success, false on saturation', async () => {
    const gate = makeGate({ total: 1, perModel: { 'p:m': 1 } });
    const profile = makeProfile('p', 'm');

    // First acquire succeeds (both caps positive).
    expect(gate.acquire(profile)).toBe(true);

    // Second acquire for same model fails (per-model cap=1 exhausted).
    expect(gate.acquire(profile)).toBe(false);

    // Different model also fails (total cap=1 exhausted).
    const profileB = makeProfile('p', 'n');
    expect(gate.acquire(profileB)).toBe(false);

    // Release one, then acquire should succeed again.
    gate.release(profile);
    expect(gate.acquire(profile)).toBe(true);
  });

  // ── 16. release restores capacity and fires onRelease ─────────────────
  //
  // After release, a previously-saturated total or per-model bucket admits
  // new acquire calls. onRelease callback fires when a slot is freed.

  it('16. release restores capacity and fires onRelease', () => {
    const gate = makeGate({ total: 1 });
    const profile = makeProfile('p', 'm');

    let onReleaseFired = 0;
    gate.onRelease = () => {
      onReleaseFired++;
    };

    // Acquire the only slot.
    expect(gate.acquire(profile)).toBe(true);
    expect(gate.availableTotal()).toBe(0);

    // Release it.
    gate.release(profile);

    // Capacity restored.
    expect(gate.availableTotal()).toBe(1);
    expect(onReleaseFired).toBe(1);

    // Acquire again succeeds.
    expect(gate.acquire(profile)).toBe(true);
  });

  // ── 17. acquire/release per-model independence ─────────────────────────
  //
  // Acquire for two different model keys with independent caps should
  // each succeed up to their respective per-model caps.

  it('17. acquire/release with per-model caps: independent model keys', () => {
    const gate = makeGate({ total: 5, perModel: { 'a:x': 1, 'b:y': 2 } });
    const profileA = makeProfile('a', 'x');
    const profileB = makeProfile('b', 'y');
    const profileC = makeProfile('a', 'x'); // same as A

    // Acquire a:x (cap=1) → succeeds.
    expect(gate.acquire(profileA)).toBe(true);

    // Acquire a:x again (cap=1) → fails.
    expect(gate.acquire(profileC)).toBe(false);

    // Acquire b:y (cap=2) → succeeds.
    expect(gate.acquire(profileB)).toBe(true);

    // Acquire b:y again (cap=2, still 1 left) → succeeds.
    expect(gate.acquire(profileB)).toBe(true);

    // Acquire b:y third time (cap=2 exhausted) → fails.
    expect(gate.acquire(profileB)).toBe(false);

    // Release a:x → frees that per-model slot.
    gate.release(profileA);

    // Now a:x can be acquired again.
    expect(gate.acquire(profileA)).toBe(true);

    // Total cap (5) not exhausted; check availableTotal.
    expect(gate.availableTotal()).toBe(2); // total=5, 3 acquired across all models
  });

  // ── 18. Cross-mode interop: acquire blocks run, release unblocks ──────
  //
  // gate.acquire holds the last total slot; a subsequent gate.run queues and
  // does NOT invoke fn until gate.release frees the slot via dispatch().
  // onRelease fires exactly once (for the release that unblocks the waiter).

  it('18. cross-mode interop: acquire blocks run, release unblocks', async () => {
    const gate = makeGate({ total: 1 });
    const profile = makeProfile('p', 'm');

    let onReleaseFired = 0;
    gate.onRelease = () => {
      onReleaseFired++;
    };

    // Acquire the only slot — holds it manually.
    expect(gate.acquire(profile)).toBe(true);
    expect(gate.availableTotal()).toBe(0);

    // run() call — should queue and NOT execute fn yet.
    let fnRan = false;
    const runPromise = gate.run(profile, async () => {
      fnRan = true;
      return 'ok';
    });

    // Allow microtasks to settle — fn should still NOT have run
    // because the slot is held via acquire().
    await sleep(10);
    expect(fnRan).toBe(false);

    // Release the manually-held slot — dispatch() should admit the run() waiter.
    gate.release(profile);

    // onRelease fired exactly once (for the release that freed the slot).
    // We check synchronously before the run() microtask resolves.
    expect(onReleaseFired).toBe(1);

    // Now the run() should complete.
    const result = await runPromise;
    expect(result).toBe('ok');
    expect(fnRan).toBe(true);
  });
});
