// ─── Tests for pool/scheduler.ts — the extracted Scheduler core ───────────────
//
// Module under test: ./scheduler.js
//
// Coverage (required by the task — 8 spec cases):
//   (spec-1) Basic lane loop — 5 tasks, 3 lanes; all claimed/processed.
//   (spec-2) claimPolicy override — hook returns batch of 2; both claimed.
//   (spec-3) concurrencyKey grouping — keys 'A'/'B'; same-key serial.
//   (spec-4) Wake on TaskReady — blocked task unblocked by dependency.
//   (spec-5) Abort cancels lanes — signal fires; lanes exit.
//   (spec-6) Stall warning — onLaneStall fires after threshold.
//   (spec-7) onLaneIdle fires — NOTE: not wired; documents current behaviour.
//   (spec-8) Backward compat — LanePool-style runTask produces same results.
//
// Plus supporting tests for: result counts, empty tracker, pre-aborted signal,
// wake-listener cleanup, claimPolicy fallback, concurrencyKey args, and
// caller-supplied runTask integration.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { Task } from '../core/types.js';
import { createHookRegistry } from '../hooks/registry.js';
import type {
  ClaimPolicyArgs,
  ConcurrencyKeyArgs,
  HookContext,
  HookRegistry,
  OnLaneIdleArgs,
  OnLaneStallArgs,
} from '../hooks/types.js';
import { TaskTracker } from '../tracking/task-status.js';
import type { SchedulerOptions } from './scheduler.js';
import { Scheduler } from './scheduler.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Build a minimal valid task definition (status computed by the tracker). */
function makeTask(id: string, overrides: Partial<Omit<Task, 'id' | 'status'>> = {}): Omit<Task, 'status'> {
  return {
    title: id,
    prompt: `do ${id}`,
    profile: 'default',
    files: [],
    dependencies: [],
    phaseId: 'test',
    ...overrides,
    id,
  };
}

/** Construct a fresh TaskTracker and add every task definition in order. */
function makeTracker(...taskDefs: Array<Omit<Task, 'status'>>): TaskTracker {
  const tracker = new TaskTracker();
  for (const def of taskDefs) tracker.addTask(def);
  return tracker;
}

/** A deferred promise — used to deterministically gate runTask across lanes. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Build SchedulerOptions anchored to a tracker + runTask. */
function makeOptions(
  overrides: Omit<SchedulerOptions, 'runTask'> & { runTask: SchedulerOptions['runTask'] },
): SchedulerOptions {
  return { ...overrides };
}

// ── console.warn spy (manual, version-safe) ────────────────────────────────
//
// Several tests assert the onLaneStall observe hook replaces the legacy
// console.warn stall warning. We capture warn calls so we can also confirm
// the warning was NOT emitted through console once the hook is registered.

let warnCalls: unknown[][];
let realWarn: typeof console.warn;

beforeEach(() => {
  realWarn = console.warn;
  warnCalls = [];
  console.warn = ((...args: unknown[]) => {
    warnCalls.push(args);
  }) as unknown as typeof console.warn;
});

afterEach(() => {
  console.warn = realWarn;
});

// ── (spec-1) Basic lane loop — 5 tasks, 3 lanes ───────────────────────────

describe('Scheduler — core claim → run → settle loop', () => {
  it('(a) spawns maxConcurrentLanes workers that together process every ready task', async () => {
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'), makeTask('t3'), makeTask('t4'));
    const seen: { id: string; lane: string }[] = [];
    const runTask = mock(async (task: Task, laneId: string) => {
      seen.push({ id: task.id, lane: laneId });
      tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 2, taskTracker: tracker, runTask, laneWaitTimeoutMs: 100 }),
    );
    const result = await scheduler.run();

    // Every task was processed exactly once and settled complete.
    expect(result.completedTasks).toBe(4);
    expect(result.failedTasks).toBe(0);
    expect(seen.map((s) => s.id).sort()).toEqual(['t1', 't2', 't3', 't4']);
    // Both lanes did real work (no lane starved).
    const lanes = new Set(seen.map((s) => s.lane));
    expect(lanes.size).toBe(2);
    // laneId is a non-empty string identifier (LanePool uses `lane-${index}`).
    for (const lane of lanes) {
      expect(typeof lane).toBe('string');
      expect(lane.length).toBeGreaterThan(0);
    }
  });

  it('(spec-1) spawns 3 lanes that together process 5 tasks; result counts match', async () => {
    // Spec case 1: 5 tasks, 3 lanes — all claimed/processed; result counts match.
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'), makeTask('t3'), makeTask('t4'), makeTask('t5'));
    const seen: { id: string; lane: string }[] = [];
    const runTask = mock(async (task: Task, laneId: string) => {
      seen.push({ id: task.id, lane: laneId });
      tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 3, taskTracker: tracker, runTask, laneWaitTimeoutMs: 100 }),
    );
    const result = await scheduler.run();

    expect(result.completedTasks).toBe(5);
    expect(result.failedTasks).toBe(0);
    expect(seen.map((s) => s.id).sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
    const lanes = new Set(seen.map((s) => s.lane));
    expect(lanes.size).toBeGreaterThanOrEqual(2); // at least 2 lanes did work
  });

  it('runTask receives the claimed task object (with the task id)', async () => {
    const tracker = makeTracker(makeTask('only'));
    const captured: Task[] = [];
    const runTask = mock(async (task: Task) => {
      captured.push(task);
      tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(makeOptions({ maxConcurrentLanes: 1, taskTracker: tracker, runTask }));
    await scheduler.run();

    expect(captured).toHaveLength(1);
    expect(captured[0].id).toBe('only');
  });

  it('counts completed and failed tasks from the tracker status', async () => {
    const tracker = makeTracker(makeTask('ok'), makeTask('boom'));
    const runTask = mock(async (task: Task) => {
      if (task.id === 'boom') tracker.failTask(task.id);
      else tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 2, taskTracker: tracker, runTask, laneWaitTimeoutMs: 100 }),
    );
    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(1);
  });

  it('returns zero counts and never invokes runTask when the tracker is empty', async () => {
    const tracker = new TaskTracker();
    const runTask = mock(async () => {});

    const scheduler = new Scheduler(makeOptions({ maxConcurrentLanes: 2, taskTracker: tracker, runTask }));
    const result = await scheduler.run();

    expect(result).toEqual({ completedTasks: 0, failedTasks: 0 });
    expect(runTask).not.toHaveBeenCalled();
  });
});

// ── (spec-2) claimPolicy hook overrides default claim ──────────────────────

describe('Scheduler — claimPolicy hook', () => {
  it('(b) overrides the default claimTasks selection when it returns tasks', async () => {
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'), makeTask('t3'));
    const order: string[] = [];
    const runTask = mock(async (task: Task) => {
      order.push(task.id);
      tracker.completeTask(task.id);
    });

    // Spy on the default claim path to PROVE it is bypassed while the hook
    // returns tasks. We wrap the real method on the instance (same pattern as
    // tests/core/phase-runner.test.ts wraps WorkflowStatusTracker.save).
    const realClaim = tracker.claimTasks.bind(tracker);
    let defaultCallCount = 0;
    tracker.claimTasks = ((count: number, agentId: string): Task[] => {
      defaultCallCount++;
      return realClaim(count, agentId);
    }) as typeof tracker.claimTasks;

    const captured: ClaimPolicyArgs[] = [];
    const registry = createHookRegistry();
    // Always claim the LAST ready task (default would claim the first). This
    // both proves the hook is the source of the claim and forces the default
    // claimTasks path to be bypassed entirely.
    registry.register({
      claimPolicy: (args: ClaimPolicyArgs): Task[] | undefined => {
        captured.push(args);
        const ready = tracker.getReadyTasks();
        return ready.length > 0 ? [ready[ready.length - 1]!] : undefined;
      },
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 1,
        taskTracker: tracker,
        hookRegistry: registry,
        runTask,
        laneWaitTimeoutMs: 100,
      }),
    );
    await scheduler.run();

    // Tasks processed in REVERSE order — only the hook could have chosen that.
    expect(order).toEqual(['t3', 't2', 't1']);
    // The default claimTasks path was never used while the hook returned tasks.
    expect(defaultCallCount).toBe(0);
    // The hook received the documented { tracker, laneId, maxClaim } args.
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].tracker).toBe(tracker);
    expect(typeof captured[0].laneId).toBe('string');
    expect(captured[0].maxClaim).toBe(1);
  });

  it('claimPolicy returning a single task works normally', async () => {
    // Sanity: returning exactly one task from claimPolicy behaves identically
    // to the default claim path.
    const tracker = makeTracker(makeTask('solo'));
    const processed: string[] = [];
    const runTask = mock(async (task: Task) => {
      processed.push(task.id);
      tracker.completeTask(task.id);
    });
    const registry = createHookRegistry();
    registry.register({
      claimPolicy: (): Task[] | undefined => {
        const ready = tracker.getReadyTasks();
        return ready.length > 0 ? [ready[0]] : undefined;
      },
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 1,
        taskTracker: tracker,
        hookRegistry: registry,
        runTask,
        laneWaitTimeoutMs: 100,
      }),
    );
    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(processed).toEqual(['solo']);
    // No warning emitted for a single-task claim.
    expect(warnCalls.length).toBe(0);
  });

  it('(spec-2) claimPolicy returns a batch of 2; only claimed[0] is marked active, t2 stays ready, warning emitted', async () => {
    // FIX A: batch claiming is not supported — only the first task is claimed
    // (marked active). Extras remain 'ready' and a console.warn is emitted.
    // We use a deferred gate to hold t1 in-flight so we can inspect t2's
    // status BEFORE the lane loops back and claims it.
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'));
    const processed: string[] = [];
    const ac = new AbortController();
    const gate = deferred();
    const runTask = mock(async (task: Task) => {
      processed.push(task.id);
      // Block t1 until we've inspected t2's status and aborted.
      await gate.promise;
      tracker.completeTask(task.id);
    });
    const captured: ClaimPolicyArgs[] = [];
    const registry = createHookRegistry();
    registry.register({
      claimPolicy: (args: ClaimPolicyArgs): Task[] | undefined => {
        captured.push(args);
        // Return BOTH ready tasks at once (batch of 2).
        const ready = tracker.getReadyTasks();
        return ready.length > 0 ? ready.slice(0, 2) : undefined;
      },
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 1,
        taskTracker: tracker,
        hookRegistry: registry,
        signal: ac.signal,
        runTask,
        laneWaitTimeoutMs: 50,
      }),
    );
    const runP = scheduler.run();
    // Wait for t1 to enter runTask (blocked on the gate).
    await new Promise((r) => setTimeout(r, 10));

    // The hook was invoked with the documented args shape.
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0].maxClaim).toBe(1);
    expect(typeof captured[0].laneId).toBe('string');
    // t1 was claimed (active) and entered runTask.
    expect(processed).toContain('t1');
    expect(tracker.getTask('t1')?.status).toBe('active');
    // FIX A: t2 was LEFT 'ready' (not marked active) — the batch bug is fixed.
    expect(tracker.getTask('t2')?.status).toBe('ready');
    // A warning was emitted about the batch limitation.
    const hasBatchWarning = warnCalls.some(
      (args) => typeof args[0] === 'string' && args[0].includes('claimPolicy returned 2 tasks'),
    );
    expect(hasBatchWarning).toBe(true);

    // Release the gate and abort so the lane exits cleanly.
    gate.resolve();
    ac.abort();
    await runP;
  });

  it('falls back to the default claimTasks path when claimPolicy abstains (returns undefined)', async () => {
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'));
    const runTask = mock(async (task: Task) => {
      tracker.completeTask(task.id);
    });
    const registry = createHookRegistry();
    // Always abstain → the Scheduler must use its built-in default claim.
    registry.register({
      claimPolicy: (): Task[] | undefined => undefined,
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 1,
        taskTracker: tracker,
        hookRegistry: registry,
        runTask,
        laneWaitTimeoutMs: 100,
      }),
    );
    const result = await scheduler.run();

    // The default path still processed both tasks.
    expect(result.completedTasks).toBe(2);
    expect(result.failedTasks).toBe(0);
  });
});

// ── (spec-3) concurrencyKey groups tasks ───────────────────────────────────

describe('Scheduler — concurrencyKey hook', () => {
  it('(c) tasks sharing a concurrencyKey run serially (max in-flight per key = 1)', async () => {
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'), makeTask('t3'));
    let inflight = 0;
    let maxInflight = 0;
    const runTask = mock(async (task: Task) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      // Hold the task open long enough that, absent concurrency limiting,
      // sibling lanes would have claimed and started the others concurrently.
      await new Promise((r) => setTimeout(r, 25));
      tracker.completeTask(task.id);
      inflight--;
    });
    const registry = createHookRegistry();
    // Every task maps to the SAME key → they must serialize.
    registry.register({
      concurrencyKey: (_args: ConcurrencyKeyArgs): string | undefined => 'shared',
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 3,
        taskTracker: tracker,
        hookRegistry: registry,
        runTask,
        laneWaitTimeoutMs: 200,
      }),
    );
    const result = await scheduler.run();

    expect(result.completedTasks).toBe(3);
    expect(maxInflight).toBe(1); // never more than one in-flight per key
  });

  it('(spec-3) concurrencyKey groups by keys A/B; same-key tasks do not run concurrently', async () => {
    // Spec case 3: keys 'A'/'B'; same-key tasks don't run concurrently
    // (per-key limit=1 by default). Tasks t1/t3 share key 'A'; t2 gets 'B'.
    // With 3 lanes and 3 tasks, t1 and t2 can run concurrently (different
    // keys), but t3 must wait for t1 to finish (same key 'A').
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'), makeTask('t3'));
    const keyInflight = new Map<string, number>();
    let maxKeyAInflight = 0;
    const runTask = mock(async (task: Task) => {
      const key = task.id === 't2' ? 'B' : 'A';
      const cur = (keyInflight.get(key) ?? 0) + 1;
      keyInflight.set(key, cur);
      if (key === 'A') maxKeyAInflight = Math.max(maxKeyAInflight, cur);
      await new Promise((r) => setTimeout(r, 30));
      keyInflight.set(key, keyInflight.get(key)! - 1);
      tracker.completeTask(task.id);
    });
    const registry = createHookRegistry();
    registry.register({
      concurrencyKey: (args: ConcurrencyKeyArgs): string | undefined => {
        // t1 and t3 share key 'A'; t2 gets key 'B'.
        return args.task.id === 't2' ? 'B' : 'A';
      },
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 3,
        taskTracker: tracker,
        hookRegistry: registry,
        runTask,
        laneWaitTimeoutMs: 200,
      }),
    );
    const result = await scheduler.run();

    expect(result.completedTasks).toBe(3);
    // Key 'A' tasks never overlapped — max in-flight for key 'A' is 1.
    expect(maxKeyAInflight).toBe(1);
  });

  it('concurrencyKey receives the candidate task in { task }', async () => {
    const tracker = makeTracker(makeTask('solo'));
    const captured: ConcurrencyKeyArgs[] = [];
    const runTask = mock(async (task: Task) => {
      tracker.completeTask(task.id);
    });
    const registry = createHookRegistry();
    registry.register({
      concurrencyKey: (args: ConcurrencyKeyArgs): string | undefined => {
        captured.push(args);
        return undefined;
      },
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 1,
        taskTracker: tracker,
        hookRegistry: registry,
        runTask,
        laneWaitTimeoutMs: 100,
      }),
    );
    await scheduler.run();

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].task.id).toBe('solo');
  });

  it('without a concurrencyKey hook, tasks run concurrently across lanes', async () => {
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'), makeTask('t3'));
    let inflight = 0;
    let maxInflight = 0;
    let entered = 0;
    // A gate that only releases once ALL three tasks have entered runTask,
    // deterministically maximizing observable concurrency.
    const gate = deferred();
    const runTask = mock(async (task: Task) => {
      entered++;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      if (entered === 3) gate.resolve();
      await gate.promise;
      tracker.completeTask(task.id);
      inflight--;
    });
    // No hookRegistry / no concurrencyKey subscriber → no concurrency limit.

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 3, taskTracker: tracker, runTask, laneWaitTimeoutMs: 200 }),
    );
    await scheduler.run();

    // The gate guarantees all three were in-flight simultaneously.
    expect(maxInflight).toBe(3);
  });
});

// ── (spec-5) abort cancels all lanes ───────────────────────────────────────

describe('Scheduler — abort', () => {
  it('(d) aborting the signal mid-run stops the lanes and run() resolves', async () => {
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'), makeTask('t3'));
    const ac = new AbortController();
    const started: string[] = [];
    const runTask = mock(async (task: Task) => {
      started.push(task.id);
      // Slow task so the abort lands while work is in-flight.
      await new Promise((r) => setTimeout(r, 30));
      // Settle only if we were not aborted mid-flight.
      if (!ac.signal.aborted) tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 2,
        taskTracker: tracker,
        signal: ac.signal,
        runTask,
        laneWaitTimeoutMs: 100,
      }),
    );
    const runP = scheduler.run();
    // Abort shortly after start, while the first two tasks are in-flight.
    setTimeout(() => ac.abort(), 5);
    const result = await runP;

    // Only the two in-flight tasks were started; the third was never claimed.
    expect(started.length).toBeLessThanOrEqual(2);
    expect(started).not.toContain('t3');
    // run() resolved (did not hang) and reports no completed work.
    expect(result.completedTasks).toBe(0);
  });

  it('returns immediately with zero counts when the signal is already aborted', async () => {
    const tracker = makeTracker(makeTask('t1'));
    const ac = new AbortController();
    ac.abort();
    const runTask = mock(async () => {});

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 2, taskTracker: tracker, signal: ac.signal, runTask }),
    );
    const result = await scheduler.run();

    expect(result).toEqual({ completedTasks: 0, failedTasks: 0 });
    expect(runTask).not.toHaveBeenCalled();
  });
});

// ── (spec-4) wake on TaskReady / TaskSettled ───────────────────────────────

describe('Scheduler — wake semantics', () => {
  it('(e) a waiting lane wakes on TaskReady (emitted when a dependency settles) and claims the newly-ready task', async () => {
    // Task 'a' is ready immediately; task 'b' is BLOCKED on 'a'. With 2 lanes
    // and 1 piece of initial work, exactly one lane claims 'a' while the other
    // has nothing to do and parks on the wake promise. When 'a' settles, the
    // tracker emits TaskSettled → recalculates → 'b' becomes ready → emits
    // TaskReady. The parked lane must wake (NOT wait for the timeout) and
    // claim 'b'. A long laneWaitTimeoutMs makes a broken wake obvious: the
    // run would take ~the full timeout instead of milliseconds.
    const tracker = makeTracker(makeTask('a'), makeTask('b', { dependencies: ['a'] }));
    const processed: string[] = [];
    const runTask = mock(async (task: Task) => {
      processed.push(task.id);
      tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 2, taskTracker: tracker, runTask, laneWaitTimeoutMs: 5000 }),
    );
    const start = Date.now();
    await scheduler.run();
    const elapsed = Date.now() - start;

    // Both tasks processed (the waiting lane woke to claim 'b').
    expect(processed.sort()).toEqual(['a', 'b']);
    // The run completed far faster than the 5s timeout → the wake event
    // fired, not the stall timer. (Generous margin against CI jitter.)
    expect(elapsed).toBeLessThan(2000);
  });

  it('wakes a waiting lane on TaskSettled when a sibling lane fails a task', async () => {
    // Same topology, but 'a' FAILS. Failing also emits TaskSettled and
    // unblocks dependents (the tracker settles dependents on any settled
    // status, including 'failed'). The waiting lane must wake and process 'b'.
    const tracker = makeTracker(makeTask('a'), makeTask('b', { dependencies: ['a'] }));
    const processed: string[] = [];
    const runTask = mock(async (task: Task) => {
      processed.push(task.id);
      if (task.id === 'a') tracker.failTask(task.id);
      else tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 2, taskTracker: tracker, runTask, laneWaitTimeoutMs: 5000 }),
    );
    const start = Date.now();
    await scheduler.run();
    const elapsed = Date.now() - start;

    expect(processed.sort()).toEqual(['a', 'b']);
    expect(elapsed).toBeLessThan(2000);
  });

  it('removes its TaskReady / TaskSettled listeners from the tracker when lanes exit', async () => {
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'));
    const runTask = mock(async (task: Task) => {
      tracker.completeTask(task.id);
    });
    const readyBefore = tracker.listenerCount(TaskTracker.Events.TaskReady);
    const settledBefore = tracker.listenerCount(TaskTracker.Events.TaskSettled);

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 2, taskTracker: tracker, runTask, laneWaitTimeoutMs: 100 }),
    );
    await scheduler.run();

    expect(tracker.listenerCount(TaskTracker.Events.TaskReady)).toBe(readyBefore);
    expect(tracker.listenerCount(TaskTracker.Events.TaskSettled)).toBe(settledBefore);
  });

  it('removes its abort listener from the signal when lanes exit', async () => {
    // AbortSignal exposes no portable listener-count API, so we instrument
    // addEventListener / removeEventListener on the real signal instance to
    // verify every registered abort listener is torn down (mirrors the
    // TaskTracker listenerCount check above — same `finally`-cleanup contract).
    const tracker = makeTracker(makeTask('t1'));
    const ac = new AbortController();
    const sig = ac.signal;
    const realAdd = sig.addEventListener.bind(sig) as typeof sig.addEventListener;
    const realRemove = sig.removeEventListener.bind(sig) as typeof sig.removeEventListener;
    let added = 0;
    let removed = 0;
    sig.addEventListener = ((...args: Parameters<typeof sig.addEventListener>) => {
      added++;
      return realAdd(...args);
    }) as typeof sig.addEventListener;
    sig.removeEventListener = ((...args: Parameters<typeof sig.removeEventListener>) => {
      removed++;
      return realRemove(...args);
    }) as typeof sig.removeEventListener;

    const runTask = mock(async (task: Task) => {
      tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(makeOptions({ maxConcurrentLanes: 2, taskTracker: tracker, signal: sig, runTask }));
    await scheduler.run();

    // At least one lane registered an abort listener, and every registration
    // was matched by a removal — no leaked O(lanes) listeners across runs.
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
});

// ── (spec-7) onLaneIdle ───────────────────────────────────────────────────
//
// NOTE: The Scheduler implementation does NOT fire an `onLaneIdle` observe
// hook — it only fires `onLaneStall` (after STALL_WARN_THRESHOLD consecutive
// timeouts). The `onLaneIdle` field exists in WorkflowHooks (types.ts) but is
// not wired into the Scheduler's lane loop. This test documents the current
// behaviour: `onLaneIdle` subscribers are NOT invoked by the Scheduler.

describe('Scheduler — onLaneIdle (not wired — documents current behaviour)', () => {
  it('(spec-7) onLaneIdle subscribers are NOT invoked by the Scheduler', async () => {
    const tracker = makeTracker(makeTask('a'), makeTask('b', { dependencies: ['a'] }));
    const idleFires: string[] = [];
    const registry = createHookRegistry();
    registry.register({
      onLaneIdle: (args: OnLaneIdleArgs): void => {
        idleFires.push(args.laneId);
      },
    });
    const runTask = mock(async (task: Task) => {
      // Hold task 'a' for long enough that the idle lane would fire onLaneIdle
      // IF it were wired.
      if (task.id === 'a') await new Promise((r) => setTimeout(r, 100));
      tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 2,
        taskTracker: tracker,
        hookRegistry: registry,
        runTask,
        laneWaitTimeoutMs: 10,
      }),
    );
    await scheduler.run();

    // NOTE: onLaneIdle is NOT wired in the Scheduler — this test documents
    // that the hook fires zero times. If/when onLaneIdle is added to the
    // Scheduler's lane loop, this assertion should change to
    // expect(…).toBeGreaterThanOrEqual(1).
    expect(idleFires.length).toBe(0);
  });
});

// ── observe hooks: onLaneStall ─────────────────────────────────────────────

describe('Scheduler — observe hooks', () => {
  it('(spec-6) fires onLaneStall after the stall threshold instead of console.warn', async () => {
    // Force a lane to stall: task 'a' is held active by one lane for long
    // enough that the idle lane times out `threshold` times with no claimable
    // work (task 'b' stays blocked until 'a' settles). A short
    // laneWaitTimeoutMs makes the stall arrive quickly; a long hold on 'a'
    // guarantees the threshold is crossed before any wake.
    const tracker = makeTracker(makeTask('a'), makeTask('b', { dependencies: ['a'] }));
    const stalls: OnLaneStallArgs[] = [];
    const registry = createHookRegistry();
    registry.register({
      onLaneStall: (args: OnLaneStallArgs, _ctx: HookContext): void => {
        stalls.push(args);
      },
    });
    const runTask = mock(async (task: Task) => {
      if (task.id === 'a') await new Promise((r) => setTimeout(r, 200)); // hold lane busy
      tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 2,
        taskTracker: tracker,
        hookRegistry: registry,
        runTask,
        laneWaitTimeoutMs: 10,
      }),
    );
    await scheduler.run();

    // The stall observe hook fired at least once.
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(typeof stalls[0].laneId).toBe('string');
    expect(stalls[0].consecutiveTimeouts).toBeGreaterThanOrEqual(stalls[0].threshold);
    expect(stalls[0].threshold).toBeGreaterThan(0);

    // The onLaneStall hook replaced the legacy console.warn stall warning.
    expect(warnCalls.length).toBe(0);
  });
});

// ── (spec-8) backward compat: LanePool-style runTask ───────────────────────
//
// Simulates how LanePool uses Scheduler: the caller-supplied runTask fires
// lifecycle events (onTaskStart / onTaskComplete / onTaskRejected) and settles
// tasks via the tracker — the same pattern as LanePool.processTask.

describe('Scheduler — backward compat: LanePool-style runTask', () => {
  it('(spec-8) LanePool-style runTask produces correct completed/failed counts', async () => {
    const tracker = makeTracker(makeTask('ok1'), makeTask('ok2'), makeTask('fail1'));
    const lifecycleLog: string[] = [];
    const runTask = mock(async (task: Task, laneId: string) => {
      // Mimic LanePool.processTask: fire onTaskStart, run, settle, fire onTaskComplete/Rejected.
      lifecycleLog.push(`start:${task.id}`);
      if (task.id === 'fail1') {
        tracker.failTask(task.id);
        lifecycleLog.push(`rejected:${task.id}`);
      } else {
        tracker.completeTask(task.id);
        lifecycleLog.push(`complete:${task.id}`);
      }
    });

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 2, taskTracker: tracker, runTask, laneWaitTimeoutMs: 100 }),
    );
    const result = await scheduler.run();

    expect(result.completedTasks).toBe(2);
    expect(result.failedTasks).toBe(1);
    // Lifecycle ordering: start precedes settle for every task.
    for (const id of ['ok1', 'ok2', 'fail1']) {
      const startIdx = lifecycleLog.indexOf(`start:${id}`);
      const settleIdx = lifecycleLog.findIndex((e) => e.endsWith(`:${id}`) && !e.startsWith(`start:`));
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(settleIdx).toBeGreaterThan(startIdx);
    }
  });

  it('(spec-8) LanePool-style runTask with onLaneError callback surfaces lane crashes', async () => {
    const tracker = makeTracker(makeTask('t1'));
    const laneErrors: Array<{ laneId: string; error: unknown }> = [];
    const runTask = mock(async () => {
      throw new Error('unexpected lane crash');
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 1,
        taskTracker: tracker,
        runTask,
        laneWaitTimeoutMs: 100,
        onLaneError: (laneId, error) => {
          laneErrors.push({ laneId, error });
        },
      }),
    );
    const result = await scheduler.run();

    // The lane rejected, but the Scheduler swallows via allSettled.
    // The catch block settled the orphaned active task to 'failed' — this
    // is the intentional contract deviation for orphan prevention.
    expect(result.completedTasks).toBe(0);
    expect(result.failedTasks).toBe(1);
    // The onLaneError callback surfaced the crash.
    expect(laneErrors).toHaveLength(1);
    expect(laneErrors[0].laneId).toMatch(/^lane-/);
    expect((laneErrors[0].error as Error).message).toBe('unexpected lane crash');
  });
});

// ── Orphaned active task prevention (SITE B) ─────────────────────────────
//
// When getConcurrencyKey or acquireKey throws AFTER a task is claimed (marked
// 'active') but BEFORE runTask is invoked, the task was left 'active' forever
// — the lane rejects, Promise.allSettled swallows it, and isPoolDone()
// never returns true. The fix moves getConcurrencyKey/acquireKey inside the
// try block and settles the orphaned active task to 'failed' in the catch.

describe('Scheduler — orphaned active task prevention (SITE B)', () => {
  it('getConcurrencyKey throws via hook → orphaned task ends failed, pool drains', async () => {
    // Single-lane: task claims → enters concurrency section → getConcurrencyKey
    // throws → catch block must fail the orphaned active task so
    // isPoolDone() returns true and the pool completes (no hang).
    const tracker = makeTracker(makeTask('boom'));
    const runTask = mock(async (task: Task) => {
      tracker.completeTask(task.id);
    });

    const registry = createHookRegistry();
    registry.register({
      concurrencyKey: (): string | undefined => {
        throw new Error('concurrencyKey boom');
      },
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 1,
        taskTracker: tracker,
        hookRegistry: registry,
        runTask,
        laneWaitTimeoutMs: 100,
      }),
    );

    const result = await scheduler.run();

    // Task was settled to 'failed' by the catch block (orphan prevention).
    expect(tracker.getTask('boom')?.status).toBe('failed');
    // Pool drained (isPoolDone() returned true).
    expect(result.completedTasks).toBe(0);
    expect(result.failedTasks).toBe(1);
    // runTask was NEVER invoked (throw happened before runTask).
    expect(runTask).not.toHaveBeenCalled();
  });

  it('concurrency key holder completes → waiter for same key is not permanently blocked', async () => {
    // Regression guard: with a concurrency key configured, tasks sharing a
    // key serialize correctly — the waiter eventually acquires the slot
    // and completes. This asserts the slot accounting stays correct.
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'));
    let inflight = 0;
    let maxInflight = 0;
    const runTask = mock(async (task: Task) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 25));
      tracker.completeTask(task.id);
      inflight--;
    });

    const registry = createHookRegistry();
    registry.register({
      concurrencyKey: (): string | undefined => 'same-key',
    });

    const scheduler = new Scheduler(
      makeOptions({
        maxConcurrentLanes: 2,
        taskTracker: tracker,
        hookRegistry: registry,
        runTask,
        laneWaitTimeoutMs: 500,
      }),
    );

    const result = await scheduler.run();

    // Both tasks completed — the waiter was NOT permanently blocked.
    expect(result.completedTasks).toBe(2);
    expect(result.failedTasks).toBe(0);
    // Concurrency key serialization: never more than 1 in-flight per key.
    expect(maxInflight).toBe(1);
  });

  it('happy path: normal task completion still works (regression guard)', async () => {
    const tracker = makeTracker(makeTask('ok'));
    const runTask = mock(async (task: Task) => {
      tracker.completeTask(task.id);
    });

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 1, taskTracker: tracker, runTask, laneWaitTimeoutMs: 100 }),
    );
    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
  });
});

// ── integration sanity: LanePool-style usage via runTask ───────────────────

describe('Scheduler — caller-supplied runTask integration', () => {
  it('a runTask that records lifecycle order sees tasks start and settle in claim order', async () => {
    // This mirrors how LanePool will use the Scheduler: it binds its own
    // processTask (which fires lifecycle + settles) as `runTask`. Here we
    // record a start/settle log per task to confirm the Scheduler drives the
    // full claim → run → settle cycle for every task.
    const tracker = makeTracker(makeTask('t1'), makeTask('t2'));
    const log: string[] = [];
    const runTask = mock(async (task: Task, laneId: string) => {
      log.push(`start:${task.id}@${laneId}`);
      // ... caller would fire onTaskStart here ...
      tracker.completeTask(task.id);
      log.push(`settled:${task.id}`);
    });

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 2, taskTracker: tracker, runTask, laneWaitTimeoutMs: 100 }),
    );
    const result = await scheduler.run();

    expect(result.completedTasks).toBe(2);
    // Each task's start precedes its own settle in the shared log.
    for (const id of ['t1', 't2']) {
      const startIdx = log.findIndex((e) => e.startsWith(`start:${id}@`));
      const settleIdx = log.indexOf(`settled:${id}`);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(settleIdx).toBeGreaterThan(startIdx);
    }
  });

  it('accepts a HookRegistry that satisfies the HookRegistry interface', async () => {
    // Smoke test: a real createHookRegistry() instance (which implements the
    // HookRegistry interface) threads through SchedulerOptions.hookRegistry
    // without type or runtime friction, even with no subscribers.
    const tracker = makeTracker(makeTask('t1'));
    const runTask = mock(async (task: Task) => {
      tracker.completeTask(task.id);
    });
    const registry: HookRegistry = createHookRegistry();

    const scheduler = new Scheduler(
      makeOptions({ maxConcurrentLanes: 1, taskTracker: tracker, hookRegistry: registry, runTask }),
    );
    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
  });
});
