// ─── Tests for run-registry.ts — the in-memory run handle map + reaper timer ─
//
// These tests pin the behavior of `RunRegistry`:
//
//  (1) The core map operations — register / get / listRuns / values / remove —
//      including the documented "register overwrites a previous handle for the
//      same runId" semantics (used by resume) and the live-reference guarantee
//      for `listRuns`.
//  (2) `scheduleReap` — the reaper timer that fires `onReap` after `delayMs`
//      ONLY when the run is still registered, no longer `'running'`, AND has
//      no active subscribers. It defers (reschedules) while subscribers are
//      present so the post-run worktree final-merge flow can complete.
//  (3) Timer leak fix — `scheduleReap` must track its timer so it can be
//      cancelled:
//        - `cancelReap(runId)` clears the pending reap timer for a run.
//        - `cancelAllReap()` clears EVERY pending reap timer.
//        - `remove(runId)` cancels the pending reap timer as a side effect.
//        - calling `scheduleReap` twice for the same runId cancels the first.
//
// Approach: a deterministic timer mock replaces `globalThis.setTimeout` /
// `globalThis.clearTimeout` for each test, capturing every armed timer and
// exposing `flushPending()` / `pendingCount()` so the reaper cadence can be
// driven by hand. This avoids real wall-clock waits and makes timer
// cancellation assertions exact (the cleared callback must NOT fire even when
// the queue is flushed).
//
// The `RunHandle` is a minimal stub: `scheduleReap` only reads `handle.status`
// and `handle.subscribers.size`, so only those fields are exercised. This keeps
// the registry unit test free of `EventStore` / `StatusBridge` machinery.

import type { RunSummary } from '@engin/shared/protocol-types';
import type { ServerWebSocket } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { RunHandle } from './run-manager.js';
import { RunRegistry } from './run-registry.js';

// ── Constants ───────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';
const REAP_DELAY = 60_000;

// ── Timer mock ──────────────────────────────────────────────────────────────
//
// Replaces `globalThis.setTimeout` / `globalThis.clearTimeout` with a
// deterministic queue. Each armed timer is stored keyed by a numeric id; a
// test flushes the queue to fire due callbacks in insertion order. `clearTimeout`
// removes a timer so its callback will NOT fire on subsequent flushes — this is
// exactly what the leak fix relies on.

interface MockTimer {
  id: number;
  callback: () => void;
  cleared: boolean;
}

let nextTimerId = 1;
let pendingTimers: MockTimer[] = [];
let realSetTimeout: typeof globalThis.setTimeout;
let realClearTimeout: typeof globalThis.clearTimeout;

beforeEach(() => {
  nextTimerId = 1;
  pendingTimers = [];
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    const id = nextTimerId++;
    const timer: MockTimer = { id, callback, cleared: false };
    pendingTimers.push(timer);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((ref: ReturnType<typeof setTimeout>) => {
    const id = typeof ref === 'number' ? ref : (ref as unknown as { id?: number }).id;
    const timer = pendingTimers.find((t) => t.id === id);
    if (timer) timer.cleared = true;
  }) as typeof globalThis.clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

/** Number of timers currently armed (not yet flushed / not cleared). */
function pendingCount(): number {
  return pendingTimers.filter((t) => !t.cleared).length;
}

/**
 * Flush every currently-armed, non-cleared timer exactly once, firing callbacks
 * in insertion order. Callbacks that arm NEW timers do NOT fire in the same
 * flush (they are picked up on the next `flushPending()`), mirroring real
 * `setTimeout` semantics and letting a test drive the reaper cadence one tick
 * at a time.
 */
function flushPending(): void {
  const due = pendingTimers.filter((t) => !t.cleared);
  // Mark them fired by removing from the queue so a reentrant arm isn't
  // re-flushed in this pass.
  pendingTimers = pendingTimers.filter((t) => t.cleared);
  for (const timer of due) {
    timer.callback();
  }
}

// ── Handle factory ──────────────────────────────────────────────────────────

function makeHandle(
  runId: string = RUN_ID,
  opts: { status?: 'running' | 'complete' | 'failed'; subscribers?: ServerWebSocket[] } = {},
): RunHandle {
  const summary: RunSummary = {
    runId,
    cwd: '/tmp/cwd',
    workflowName: 'wf',
    taskPrompt: 'do thing',
    status: opts.status ?? 'running',
    startedAt: new Date().toISOString(),
  };
  return {
    runId,
    cwd: '/tmp/cwd',
    workflowName: 'wf',
    taskPrompt: 'do thing',
    workDir: `/tmp/${runId}`,
    store: { flush: () => undefined } as unknown as RunHandle['store'],
    controller: new AbortController(),
    bridge: { dispose: () => undefined } as unknown as RunHandle['bridge'],
    status: opts.status ?? 'running',
    summary,
    startedAt: new Date().toISOString(),
    subscribers: new Set(opts.subscribers ?? []),
  };
}

// A throwaway stand-in for a ServerWebSocket (only used as a Set member).
function makeWs(): ServerWebSocket {
  return {} as ServerWebSocket;
}

// ── (1) Core map operations ─────────────────────────────────────────────────

describe('RunRegistry — core map operations', () => {
  it('register + get round-trips a handle', () => {
    const registry = new RunRegistry();
    const handle = makeHandle();
    registry.register(handle);
    expect(registry.get(RUN_ID)).toBe(handle);
  });

  it('get returns undefined for an unknown runId', () => {
    const registry = new RunRegistry();
    expect(registry.get('nope')).toBeUndefined();
  });

  it('register overwrites a previous handle for the same runId (resume semantics)', () => {
    // The registry intentionally allows a resumed run to replace its completed
    // predecessor — collision detection happens in the RunManager facade
    // BEFORE register is called. The registry must faithfully store the new one.
    const registry = new RunRegistry();
    const first = makeHandle(RUN_ID, { status: 'complete' });
    const second = makeHandle(RUN_ID, { status: 'running' });
    registry.register(first);
    registry.register(second);
    expect(registry.get(RUN_ID)).toBe(second);
    expect(registry.get(RUN_ID)?.status).toBe('running');
  });

  it('listRuns returns a summary per registered run reflecting CURRENT status', () => {
    // Live-reference guarantee: mutating a handle's status is observable
    // through listRuns without re-registration.
    const registry = new RunRegistry();
    const handle = makeHandle(RUN_ID, { status: 'running' });
    registry.register(handle);
    expect(registry.listRuns()).toHaveLength(1);
    expect(registry.listRuns()[0].status).toBe('running');

    handle.status = 'complete';
    handle.summary.status = 'complete';
    expect(registry.listRuns()[0].status).toBe('complete');
  });

  it('listRuns returns summaries for every registered run in insertion order', () => {
    const registry = new RunRegistry();
    registry.register(makeHandle('a'));
    registry.register(makeHandle('b'));
    registry.register(makeHandle('c'));
    const ids = registry.listRuns().map((s) => s.runId);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('values() iterates live handle references', () => {
    const registry = new RunRegistry();
    const a = makeHandle('a');
    const b = makeHandle('b');
    registry.register(a);
    registry.register(b);
    const collected = Array.from(registry.values());
    expect(collected).toContain(a);
    expect(collected).toContain(b);
    expect(collected).toHaveLength(2);
  });

  it('remove deletes a handle from the registry', () => {
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID));
    registry.remove(RUN_ID);
    expect(registry.get(RUN_ID)).toBeUndefined();
    expect(registry.listRuns()).toHaveLength(0);
  });

  it('remove is a no-op for an unknown runId', () => {
    const registry = new RunRegistry();
    expect(() => registry.remove('unknown')).not.toThrow();
  });
});

// ── (2) scheduleReap — reaper guards & firing ───────────────────────────────

describe('RunRegistry.scheduleReap — reaper guards', () => {
  it('fires onReap after delayMs when the run is terminal and has no subscribers', () => {
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    // Not fired immediately — waits for the timer.
    expect(reaped).toBe(false);
    expect(pendingCount()).toBe(1);
    flushPending();
    expect(reaped).toBe(true);
  });

  it('does NOT fire onReap while the run is still running', () => {
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'running' }));
    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    flushPending();
    expect(reaped).toBe(false);
  });

  it('does NOT fire onReap when the run was removed before the timer elapsed', () => {
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    // Simulate the run being removed (e.g. explicit shutdown) before the timer
    // fires. The reaper must NOT invoke onReap for a handle that is no longer
    // registered. Access the private map directly so this test isolates the
    // tick-guard behavior from any timer-cancellation side effect `remove`
    // may gain later.
    (registry as unknown as { runs: Map<string, unknown> }).runs.delete(RUN_ID);
    flushPending();
    expect(reaped).toBe(false);
  });

  it('does NOT fire onReap while a subscriber is present (deferred)', () => {
    const registry = new RunRegistry();
    const ws = makeWs();
    registry.register(makeHandle(RUN_ID, { status: 'complete', subscribers: [ws] }));
    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    // First tick: subscribers present → reschedule, do not reap.
    flushPending();
    expect(reaped).toBe(false);
    expect(pendingCount()).toBe(1);
  });

  it('reaps on the next tick once the last subscriber disconnects', () => {
    const registry = new RunRegistry();
    const ws = makeWs();
    const handle = makeHandle(RUN_ID, { status: 'complete', subscribers: [ws] });
    registry.register(handle);
    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    // Tick 1: subscriber present → reschedule.
    flushPending();
    expect(reaped).toBe(false);
    // Subscriber disconnects.
    handle.subscribers.delete(ws);
    // Tick 2: no subscribers → reap.
    flushPending();
    expect(reaped).toBe(true);
  });

  it('keeps rescheduling every delayMs while subscribers remain (multi-tick defer)', () => {
    const registry = new RunRegistry();
    const ws = makeWs();
    const handle = makeHandle(RUN_ID, { status: 'complete', subscribers: [ws] });
    registry.register(handle);
    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    flushPending();
    expect(reaped).toBe(false);
    flushPending();
    expect(reaped).toBe(false);
    expect(pendingCount()).toBe(1);
    // Now the subscriber leaves and the next tick reaps.
    handle.subscribers.delete(ws);
    flushPending();
    expect(reaped).toBe(true);
  });

  it('does not fire when scheduled for an unknown runId (no-op)', () => {
    const registry = new RunRegistry();
    let reaped = false;
    registry.scheduleReap('never-registered', REAP_DELAY, () => {
      reaped = true;
    });
    flushPending();
    expect(reaped).toBe(false);
  });

  it('passes through the configured delayMs to setTimeout', () => {
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    const spy = (globalThis.setTimeout = jestSpy());
    registry.scheduleReap(RUN_ID, 42_000, () => undefined);
    expect(spy.calls).toContain(42_000);
  });
});

// Local helper: a setTimeout spy that also delegates to the queue-based mock so
// the rest of the harness still works, while recording the delayMs arguments.
function jestSpy(): typeof globalThis.setTimeout & { calls: number[] } {
  const calls: number[] = [];
  const fn = ((callback: () => void, delay?: number) => {
    if (typeof delay === 'number') calls.push(delay);
    const id = nextTimerId++;
    const timer: MockTimer = { id, callback, cleared: false };
    pendingTimers.push(timer);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  return Object.assign(fn, { calls });
}

// ── (3) Timer leak fix — cancelReap / cancelAllReap / remove ────────────────
//
// These tests pin the NEW behavior introduced by the leak fix. They will FAIL
// against the pre-fix code (which lacks `cancelReap` / `cancelAllReap` and does
// not cancel timers in `remove`), driving the implementer's change.

describe('RunRegistry — reap timer cancellation (leak fix)', () => {
  it('cancelReap prevents a pending reap timer from firing onReap', () => {
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    expect(pendingCount()).toBe(1);
    registry.cancelReap(RUN_ID);
    flushPending();
    expect(reaped).toBe(false);
  });

  it('cancelReap is a no-op for a runId with no pending timer', () => {
    const registry = new RunRegistry();
    expect(() => registry.cancelReap('unknown')).not.toThrow();
  });

  it('calling scheduleReap twice for the same runId cancels the first timer', () => {
    // Re-arming must not leave two dangling timers for the same run — the
    // previous one is cleared. Only the LATEST onReap callback should fire.
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    let firstReaped = false;
    let secondReaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      firstReaped = true;
    });
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      secondReaped = true;
    });
    // Only one timer should be armed for this runId.
    expect(pendingCount()).toBe(1);
    flushPending();
    expect(firstReaped).toBe(false);
    expect(secondReaped).toBe(true);
  });

  it('remove cancels the pending reap timer as a side effect', () => {
    // CRITICAL: removing a run from the registry must also cancel its reap
    // timer. Without this, the recursive setTimeout chain keeps rescheduling
    // itself even after the handle is gone — the timer leak.
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    expect(pendingCount()).toBe(1);
    registry.remove(RUN_ID);
    flushPending();
    expect(reaped).toBe(false);
    expect(registry.get(RUN_ID)).toBeUndefined();
  });

  it('remove cancels a deferred (subscriber-pending) reap timer too', () => {
    // The subscriber-deferred reschedule path also arms a tracked timer; remove
    // must clear that one as well.
    const registry = new RunRegistry();
    const ws = makeWs();
    registry.register(makeHandle(RUN_ID, { status: 'complete', subscribers: [ws] }));
    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    // First tick reschedules (subscriber present).
    flushPending();
    expect(pendingCount()).toBe(1);
    registry.remove(RUN_ID);
    flushPending();
    expect(reaped).toBe(false);
  });

  it('cancelAllReap clears every pending reap timer across all runIds', () => {
    const registry = new RunRegistry();
    registry.register(makeHandle('run-a', { status: 'complete' }));
    registry.register(makeHandle('run-b', { status: 'complete' }));
    let reapedA = false;
    let reapedB = false;
    registry.scheduleReap('run-a', REAP_DELAY, () => {
      reapedA = true;
    });
    registry.scheduleReap('run-b', REAP_DELAY, () => {
      reapedB = true;
    });
    expect(pendingCount()).toBe(2);
    registry.cancelAllReap();
    expect(pendingCount()).toBe(0);
    flushPending();
    expect(reapedA).toBe(false);
    expect(reapedB).toBe(false);
  });

  it('cancelAllReap is a no-op when no reap timers are pending', () => {
    const registry = new RunRegistry();
    expect(() => registry.cancelAllReap()).not.toThrow();
  });

  it('cancelReap does not affect timers for other runIds', () => {
    const registry = new RunRegistry();
    registry.register(makeHandle('run-a', { status: 'complete' }));
    registry.register(makeHandle('run-b', { status: 'complete' }));
    let reapedA = false;
    let reapedB = false;
    registry.scheduleReap('run-a', REAP_DELAY, () => {
      reapedA = true;
    });
    registry.scheduleReap('run-b', REAP_DELAY, () => {
      reapedB = true;
    });
    registry.cancelReap('run-a');
    flushPending();
    expect(reapedA).toBe(false);
    expect(reapedB).toBe(true);
  });

  it('after cancelReap, a fresh scheduleReap for the same runId fires normally', () => {
    // Cancellation must not permanently disable reaping for a runId — a later
    // scheduleReap re-arms a working timer.
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    registry.cancelReap(RUN_ID);
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    flushPending();
    expect(reaped).toBe(true);
  });

  it('a reaped run cleans up its timer entry (no dangling tracked timer)', () => {
    // After onReap fires, the internal reapTimers entry for that runId should
    // be cleared so a subsequent cancelAllReap / remove does not hold a stale
    // reference. We observe this indirectly: the fired timer is no longer in
    // the pending queue.
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => undefined);
    flushPending();
    expect(pendingCount()).toBe(0);
    // cancelAllReap after firing is a no-op (nothing to clear).
    expect(() => registry.cancelAllReap()).not.toThrow();
  });
});

// ── (4) Shutdown mode — beginShutdown + scheduleReap immediate execution ────
//
// Race-condition fix. During `shutdownAll()`, RunManager aborts every run and
// calls `cancelAllReap()` to clear pending reapers. But each executor's
// `finally` block calls `scheduleReap(...)` AFTER the cancel — re-arming a NEW
// reaper timer that fires long after shutdown "completed", disposing bridges /
// stores and removing handles well past teardown.
//
// The fix: `RunRegistry.beginShutdown()` arms a `shutdown` flag. Once armed,
// `scheduleReap` executes the reap callback SYNCHRONOUSLY instead of scheduling
// a `setTimeout`. So the late finally-block reap runs immediately and can never
// leak past shutdown.
//
// These tests pin that behavior and will FAIL against the pre-fix code (which
// has no `beginShutdown` method and always arms a timer).

describe('RunRegistry — shutdown mode (beginShutdown)', () => {
  it('exposes a beginShutdown() method that is callable and does not throw', () => {
    const registry = new RunRegistry();
    expect(typeof registry.beginShutdown).toBe('function');
    expect(() => registry.beginShutdown()).not.toThrow();
  });

  it('beginShutdown is idempotent (calling it more than once is harmless)', () => {
    const registry = new RunRegistry();
    expect(() => {
      registry.beginShutdown();
      registry.beginShutdown();
    }).not.toThrow();
  });

  it('scheduleReap during shutdown executes onReap IMMEDIATELY (no timer armed)', () => {
    // TARGET behavior: once beginShutdown() has been called, scheduleReap must
    // fire onReap synchronously instead of arming a setTimeout. This is what
    // closes the shutdown race — the executor's finally-block reap (which runs
    // AFTER cancelAllReap) cannot re-arm a deferred timer that survives
    // shutdown.
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    registry.beginShutdown();

    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });

    // Fired synchronously — no flushPending() needed.
    expect(reaped).toBe(true);
    // And NO timer was armed (the leak is gone).
    expect(pendingCount()).toBe(0);
  });

  it('scheduleReap during shutdown leaves no tracked reap timer behind', () => {
    // The internal reapTimers entry must stay clean so a later cancelAllReap /
    // remove finds nothing dangling.
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    registry.beginShutdown();

    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });
    expect(reaped).toBe(true);

    // Flushing the queue fires nothing — no deferred reaper was armed.
    flushPending();
    expect(reaped).toBe(true);
    expect(pendingCount()).toBe(0);
    // cancelAllReap afterwards is a no-op (nothing pending).
    expect(() => registry.cancelAllReap()).not.toThrow();
  });

  it('scheduleReap during shutdown fires onReap exactly once (no double-reap)', () => {
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));
    registry.beginShutdown();

    let count = 0;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      count += 1;
    });
    // Draining the (empty) timer queue must not fire it a second time.
    flushPending();
    expect(count).toBe(1);
  });

  it('a late re-arm AFTER beginShutdown still fires immediately (executor finally path)', () => {
    // Mirrors the exact shutdown race: a deferred reaper is armed, then
    // cancelAllReap() clears it, then beginShutdown() is set, then the
    // executor's finally re-arms via scheduleReap(). The re-arm must fire
    // immediately rather than starting a fresh deferred timer.
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));

    let firstReaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      firstReaped = true;
    });
    expect(pendingCount()).toBe(1);

    // shutdownAll sequence: cancel every pending reaper, then arm the flag.
    registry.cancelAllReap();
    registry.beginShutdown();
    expect(pendingCount()).toBe(0);

    // The executor's finally-block re-arm arrives AFTER the cancel.
    let secondReaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      secondReaped = true;
    });

    expect(secondReaped).toBe(true);
    expect(pendingCount()).toBe(0);
    // The cancelled first reaper never fired.
    expect(firstReaped).toBe(false);
  });

  it('normal (non-shutdown) scheduleReap still arms a timer and defers onReap', () => {
    // GUARD: when beginShutdown has NOT been called, scheduleReap must behave
    // exactly as before — arm a timer and defer onReap until it fires. The
    // shutdown flag must NOT change the normal (steady-state) path.
    const registry = new RunRegistry();
    registry.register(makeHandle(RUN_ID, { status: 'complete' }));

    let reaped = false;
    registry.scheduleReap(RUN_ID, REAP_DELAY, () => {
      reaped = true;
    });

    // Deferred — not fired yet, a timer IS armed.
    expect(reaped).toBe(false);
    expect(pendingCount()).toBe(1);
    flushPending();
    expect(reaped).toBe(true);
  });
});
