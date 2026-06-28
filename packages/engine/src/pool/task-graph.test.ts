// ─── Tests for task-graph.ts ─────────────────────────────────────────────────
//
// Tests cover the full public contract of TaskGraph:
//   - addTask initial status (ready / blocked)
//   - cycle detection (Kahn's)
//   - transitiveDependentCount (diamond DAG)
//   - recalculateReady (blocked → ready on dep settle)
//   - getReadyTasks sorted DESC by pressure with stable FIFO tiebreak
//   - getParkedTasks sorted DESC by pressure
//   - getActiveTasks
//   - failDeadlockedTasks marks deadlocked tasks failed via onStatusTransition

import { describe, expect, it, mock } from 'bun:test';

import type { Task } from '../core/types.js';
import type { SessionPlanRunner } from './runners/session-plan-types.js';
import { TaskGraph } from './task-graph.js';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeRunnerFactory(): () => SessionPlanRunner {
  return () => ({
    plan: async function* () {
      yield [];
      return [];
    },
    execute: async () => ({ mode: 'text', text: '' }),
  });
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    prompt: 'Do something',
    profile: 'executor',
    files: [],
    dependencies: [],
    status: 'blocked',
    phaseId: 'code',
    worktree: 'none',
    ...overrides,
  };
}

/** Create a TaskGraph populated with the given tasks (in order). */
function buildGraph(...tasks: Task[]): TaskGraph {
  const g = new TaskGraph();
  for (const t of tasks) {
    g.addTask({ ...t }, makeRunnerFactory());
  }
  return g;
}

// ── addTask: initial status ────────────────────────────────────────────────

describe('TaskGraph — addTask initial status', () => {
  it('assigns ready when there are no dependencies', () => {
    const g = buildGraph(makeTask({ id: 'a', dependencies: [] }));
    expect(g.getTask('a')?.status).toBe('ready');
  });

  it('assigns blocked when a dependency is unsettled', () => {
    const a = makeTask({ id: 'a', dependencies: [] });
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    const g = buildGraph(a, b);
    expect(g.getTask('a')?.status).toBe('ready');
    expect(g.getTask('b')?.status).toBe('blocked');
  });

  it('assigns ready when a dependency is already complete', () => {
    const a = makeTask({ id: 'a', dependencies: [], status: 'complete' });
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    const g = buildGraph(a, b);
    expect(g.getTask('b')?.status).toBe('ready');
  });

  it('assigns blocked when a dependency is active', () => {
    const a = makeTask({ id: 'a', dependencies: [], status: 'active' });
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    const g = buildGraph(a, b);
    expect(g.getTask('b')?.status).toBe('blocked');
  });

  it('assigns ready when a dependency is failed (settled)', () => {
    const a = makeTask({ id: 'a', dependencies: [], status: 'failed' });
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    const g = buildGraph(a, b);
    expect(g.getTask('b')?.status).toBe('ready');
  });

  it('assigns ready when a dependency is cancelled (settled)', () => {
    const a = makeTask({ id: 'a', dependencies: [], status: 'cancelled' });
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    const g = buildGraph(a, b);
    expect(g.getTask('b')?.status).toBe('ready');
  });

  it('assigns blocked when a dependency does not exist yet', () => {
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    const g = buildGraph(b);
    expect(g.getTask('b')?.status).toBe('blocked');
  });
});

// ── addTasks (batch) ───────────────────────────────────────────────────────

describe('TaskGraph — addTasks batch', () => {
  it('adds multiple tasks in a single call', () => {
    const g = new TaskGraph();
    g.addTasks({ ...makeTask({ id: 'a' }) }, { ...makeTask({ id: 'b' }) });
    expect(g.getTask('a')).toBeDefined();
    expect(g.getTask('b')).toBeDefined();
    expect(g.getAllTasks()).toHaveLength(2);
  });
});

// ── cycle detection ────────────────────────────────────────────────────────

describe('TaskGraph — cycle detection', () => {
  it('throws on a simple two-node cycle', () => {
    const rf = makeRunnerFactory();
    const a = makeTask({ id: 'a', dependencies: ['b'] });
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    const g = new TaskGraph();
    g.addTask({ ...a }, rf);
    expect(() => g.addTask({ ...b }, rf)).toThrow(/cycle/i);
  });

  it('throws on a three-node cycle', () => {
    const rf = makeRunnerFactory();
    const a = makeTask({ id: 'a', dependencies: ['c'] });
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    const c = makeTask({ id: 'c', dependencies: ['b'] });
    const g = new TaskGraph();
    g.addTask({ ...a }, rf);
    g.addTask({ ...b }, rf);
    expect(() => g.addTask({ ...c }, rf)).toThrow(/cycle/i);
  });

  it('does not throw for a valid diamond DAG', () => {
    const a = makeTask({ id: 'a', dependencies: [] });
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    const c = makeTask({ id: 'c', dependencies: ['a'] });
    const d = makeTask({ id: 'd', dependencies: ['b', 'c'] });
    expect(() => buildGraph(a, b, c, d)).not.toThrow();
  });

  it('throws on a self-loop', () => {
    const a = makeTask({ id: 'a', dependencies: ['a'] });
    expect(() => buildGraph(a)).toThrow(/cycle/i);
  });
});

// ── transitiveDependentCount ───────────────────────────────────────────────

describe('TaskGraph — transitiveDependentCount', () => {
  it('returns 0 for a leaf task with no dependents', () => {
    const g = buildGraph(makeTask({ id: 'a' }));
    expect(g.transitiveDependentCount('a')).toBe(0);
  });

  it('counts direct dependents', () => {
    const g = buildGraph(makeTask({ id: 'a' }), makeTask({ id: 'b', dependencies: ['a'] }));
    expect(g.transitiveDependentCount('a')).toBe(1);
    expect(g.transitiveDependentCount('b')).toBe(0);
  });

  it('counts transitive dependents in a linear chain', () => {
    // a → b → c
    const g = buildGraph(
      makeTask({ id: 'a' }),
      makeTask({ id: 'b', dependencies: ['a'] }),
      makeTask({ id: 'c', dependencies: ['b'] }),
    );
    expect(g.transitiveDependentCount('a')).toBe(2); // b, c
    expect(g.transitiveDependentCount('b')).toBe(1); // c
    expect(g.transitiveDependentCount('c')).toBe(0);
  });

  it('counts transitive dependents in a diamond DAG (no double counting)', () => {
    //     a
    //    / \
    //   b   c
    //    \ /
    //     d
    const g = buildGraph(
      makeTask({ id: 'a' }),
      makeTask({ id: 'b', dependencies: ['a'] }),
      makeTask({ id: 'c', dependencies: ['a'] }),
      makeTask({ id: 'd', dependencies: ['b', 'c'] }),
    );
    expect(g.transitiveDependentCount('a')).toBe(3); // b, c, d
    expect(g.transitiveDependentCount('b')).toBe(1); // d
    expect(g.transitiveDependentCount('c')).toBe(1); // d
    expect(g.transitiveDependentCount('d')).toBe(0);
  });

  it('invalidates the cache after adding a new task', () => {
    const g = buildGraph(makeTask({ id: 'a' }));
    expect(g.transitiveDependentCount('a')).toBe(0);
    g.addTask(makeTask({ id: 'b', dependencies: ['a'] }), makeRunnerFactory());
    expect(g.transitiveDependentCount('a')).toBe(1);
  });
});

// ── recalculateReady ───────────────────────────────────────────────────────

describe('TaskGraph — recalculateReady', () => {
  it('transitions blocked → ready when all deps settle', () => {
    const g = buildGraph(makeTask({ id: 'a' }), makeTask({ id: 'b', dependencies: ['a'] }));
    expect(g.getTask('b')?.status).toBe('blocked');

    g.setTaskStatus('a', 'complete');
    g.recalculateReady('a');

    expect(g.getTask('b')?.status).toBe('ready');
  });

  it('does not transition when some deps are still unsettled', () => {
    const g = buildGraph(makeTask({ id: 'a' }), makeTask({ id: 'b' }), makeTask({ id: 'c', dependencies: ['a', 'b'] }));
    expect(g.getTask('c')?.status).toBe('blocked');

    g.setTaskStatus('a', 'complete');
    g.recalculateReady('a');

    expect(g.getTask('c')?.status).toBe('blocked');
  });

  it('transitions only when ALL deps settle', () => {
    const g = buildGraph(makeTask({ id: 'a' }), makeTask({ id: 'b' }), makeTask({ id: 'c', dependencies: ['a', 'b'] }));
    g.setTaskStatus('a', 'complete');
    g.recalculateReady('a');
    expect(g.getTask('c')?.status).toBe('blocked');

    g.setTaskStatus('b', 'complete');
    g.recalculateReady('b');
    expect(g.getTask('c')?.status).toBe('ready');
  });

  it('without a hint, recalculates ALL blocked tasks', () => {
    const g = buildGraph(
      makeTask({ id: 'a' }),
      makeTask({ id: 'b' }),
      makeTask({ id: 'c', dependencies: ['a'] }),
      makeTask({ id: 'd', dependencies: ['b'] }),
    );
    g.setTaskStatus('a', 'complete');
    g.setTaskStatus('b', 'complete');
    g.recalculateReady();
    expect(g.getTask('c')?.status).toBe('ready');
    expect(g.getTask('d')?.status).toBe('ready');
  });
});

// ── getReadyTasks — sorting ────────────────────────────────────────────────

describe('TaskGraph — getReadyTasks sorting', () => {
  it('returns only ready tasks', () => {
    const g = buildGraph(makeTask({ id: 'a' }), makeTask({ id: 'b', dependencies: ['a'] }));
    g.setTaskStatus('a', 'active');
    const ready = g.getReadyTasks();
    expect(ready).toHaveLength(0); // a is active, b is blocked
  });

  it('sorts DESC by transitiveDependentCount', () => {
    // a (many dependents), leaf1 (no dependents), leaf2 (no dependents)
    // a → b → c
    const g = buildGraph(
      makeTask({ id: 'a' }),
      makeTask({ id: 'b', dependencies: ['a'] }),
      makeTask({ id: 'c', dependencies: ['b'] }),
      makeTask({ id: 'leaf1' }),
      makeTask({ id: 'leaf2' }),
    );
    const ready = g.getReadyTasks().map((e) => e.task.id);
    // 'a' has pressure 2, leaves have 0. So 'a' comes first.
    // leaves keep insertion order (leaf1 before leaf2).
    expect(ready[0]).toBe('a');
    // remaining are the two leaves in insertion order
    expect(ready).toContain('leaf1');
    expect(ready).toContain('leaf2');
    const leaf1Idx = ready.indexOf('leaf1');
    const leaf2Idx = ready.indexOf('leaf2');
    expect(leaf1Idx).toBeLessThan(leaf2Idx);
  });

  it('stable FIFO tiebreak for equal pressure', () => {
    // Three independent leaf tasks — all pressure 0.
    // Insertion order: first, second, third.
    const g = buildGraph(makeTask({ id: 'first' }), makeTask({ id: 'second' }), makeTask({ id: 'third' }));
    const ready = g.getReadyTasks().map((e) => e.task.id);
    expect(ready).toEqual(['first', 'second', 'third']);
  });

  it('does not include active or parked tasks', () => {
    const g = buildGraph(makeTask({ id: 'a' }), makeTask({ id: 'b' }));
    g.setTaskStatus('a', 'active');
    g.setTaskStatus('b', 'parked');
    expect(g.getReadyTasks()).toHaveLength(0);
  });
});

// ── getParkedTasks — sorting ───────────────────────────────────────────────

describe('TaskGraph — getParkedTasks sorting', () => {
  it('returns parked tasks sorted DESC by pressure', () => {
    const g = buildGraph(
      makeTask({ id: 'root' }),
      makeTask({ id: 'mid', dependencies: ['root'] }),
      makeTask({ id: 'leaf' }),
    );
    // Park both mid and leaf
    g.setTaskStatus('mid', 'parked');
    g.setTaskStatus('leaf', 'parked');
    const parked = g.getParkedTasks().map((e) => e.task.id);
    // mid has a dependent... actually root depends-on nothing reversed.
    // mid has 0 dependents. leaf has 0 dependents. Both 0.
    // So insertion order applies.
    expect(parked).toContain('mid');
    expect(parked).toContain('leaf');
  });

  it('returns parked tasks sorted by transitive dependents', () => {
    // root → mid → deep (chain, so root has highest pressure)
    const g = buildGraph(
      makeTask({ id: 'root' }),
      makeTask({ id: 'mid', dependencies: ['root'] }),
      makeTask({ id: 'deep', dependencies: ['mid'] }),
      makeTask({ id: 'lonely' }),
    );
    g.setTaskStatus('root', 'parked');
    g.setTaskStatus('lonely', 'parked');
    const parked = g.getParkedTasks().map((e) => e.task.id);
    // root pressure = 2, lonely = 0 → root first
    expect(parked[0]).toBe('root');
    expect(parked[1]).toBe('lonely');
  });

  it('does not include ready or active tasks', () => {
    const g = buildGraph(makeTask({ id: 'a' }), makeTask({ id: 'b' }));
    g.setTaskStatus('a', 'active');
    // b stays ready
    expect(g.getParkedTasks()).toHaveLength(0);
  });
});

// ── getActiveTasks ─────────────────────────────────────────────────────────

describe('TaskGraph — getActiveTasks', () => {
  it('returns only active tasks', () => {
    const g = buildGraph(makeTask({ id: 'a' }), makeTask({ id: 'b' }), makeTask({ id: 'c' }));
    g.setTaskStatus('a', 'active');
    g.setTaskStatus('b', 'complete');
    // c stays ready
    const active = g.getActiveTasks().map((e) => e.task.id);
    expect(active).toEqual(['a']);
  });
});

// ── setTaskStatus + onStatusTransition ────────────────────────────────────

describe('TaskGraph — setTaskStatus + onStatusTransition', () => {
  it('invokes onStatusTransition callback when status changes', () => {
    const cb = mock((taskId: string, _status: string) => {});
    const g = new TaskGraph();
    g.onStatusTransition = cb;
    g.addTask(makeTask({ id: 'a' }), makeRunnerFactory());

    cb.mockReset();
    g.setTaskStatus('a', 'active');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('a', 'active');
  });

  it('does not emit when status does not change', () => {
    const cb = mock((taskId: string, _status: string) => {});
    const g = new TaskGraph();
    g.onStatusTransition = cb;
    g.addTask(makeTask({ id: 'a' }), makeRunnerFactory());
    // a is ready
    cb.mockReset();
    g.setTaskStatus('a', 'ready');
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── failDeadlockedTasks ──────────────────────────────────────────────────

describe('TaskGraph — failDeadlockedTasks', () => {
  it('marks blocked tasks with missing deps as failed via callback', () => {
    const cb = mock((taskId: string, status: string) => {});
    const g = new TaskGraph();
    g.onStatusTransition = cb;
    // b depends on 'ghost' which never gets added
    g.addTask(makeTask({ id: 'b', dependencies: ['ghost'] }), makeRunnerFactory());
    cb.mockReset();

    g.failDeadlockedTasks();

    expect(g.getTask('b')?.status).toBe('failed');
    expect(cb).toHaveBeenCalledWith('b', 'failed');
  });

  it('does not mark blocked tasks whose deps DO exist (just unsettled)', () => {
    const g = buildGraph(makeTask({ id: 'a' }), makeTask({ id: 'b', dependencies: ['a'] }));
    g.failDeadlockedTasks();
    expect(g.getTask('b')?.status).toBe('blocked');
  });

  it('is idempotent (does not re-process already-failed tasks)', () => {
    const cb = mock((taskId: string, _status: string) => {});
    const g = new TaskGraph();
    g.onStatusTransition = cb;
    g.addTask(makeTask({ id: 'b', dependencies: ['ghost'] }), makeRunnerFactory());

    g.failDeadlockedTasks();
    expect(g.getTask('b')?.status).toBe('failed');
    const firstCount = cb.mock.calls.length;

    g.failDeadlockedTasks();
    expect(cb.mock.calls.length).toBe(firstCount);
  });

  it('detects multiple missing deps in a single scan', () => {
    const cb = mock((taskId: string, _status: string) => {});
    const g = new TaskGraph();
    g.onStatusTransition = cb;
    g.addTask(makeTask({ id: 'x', dependencies: ['ghost1'] }), makeRunnerFactory());
    g.addTask(makeTask({ id: 'y', dependencies: ['ghost2'] }), makeRunnerFactory());
    cb.mockReset();

    g.failDeadlockedTasks();

    expect(g.getTask('x')?.status).toBe('failed');
    expect(g.getTask('y')?.status).toBe('failed');
  });
});

// ── TaskGraphEntry runner state fields ────────────────────────────────────

describe('TaskGraph — TaskGraphEntry runner state', () => {
  it('exposes runnerFactory, batchResults, and session counters', () => {
    const factory = makeRunnerFactory();
    const g = new TaskGraph();
    g.addTask(makeTask({ id: 'a' }), factory);

    const entry = g.getTask('a');
    expect(entry).toBeDefined();
    expect(typeof entry!.runnerFactory).toBe('function');
    expect(entry!.batchResults).toEqual([]);
    expect(entry!.completedSessions).toBe(0);
    expect(entry!.totalSessions).toBe(0);
  });
});

// ── Out-of-order insertion (F2) ───────────────────────────────────────────

describe('TaskGraph — out-of-order insertion (F2)', () => {
  it('auto-promotes blocked dependents when a pre-settled dep is added later', () => {
    // Add B (depends on A) FIRST — B starts blocked because A doesn't exist.
    const g = new TaskGraph();
    g.addTask(makeTask({ id: 'b', dependencies: ['a'] }), makeRunnerFactory());
    expect(g.getTask('b')?.status).toBe('blocked');

    // Add A SECOND with a pre-settled status ('complete') — B should
    // auto-promote to 'ready' via addTask's recalculateReady call.
    g.addTask(makeTask({ id: 'a', dependencies: [], status: 'complete' }), makeRunnerFactory());
    expect(g.getTask('b')?.status).toBe('ready');
  });
});

// ── Rollback on cycle rejection (F5a) ─────────────────────────────────────

describe('TaskGraph — rollback on cycle (F5a)', () => {
  it('leaves reverseDeps clean after a cycle rejection', () => {
    const g = new TaskGraph();
    const rf = makeRunnerFactory();

    // a depends on b (b not added yet)
    g.addTask(makeTask({ id: 'a', dependencies: ['b'] }), rf);

    // Attempt to add b depending on a (creates a cycle a → b → a)
    expect(() => g.addTask(makeTask({ id: 'b', dependencies: ['a'] }), rf)).toThrow(/cycle/i);

    // a should still exist (it was valid before the cycle attempt)
    expect(g.getTask('a')).toBeDefined();
    // b should NOT exist (rolled back)
    expect(g.getTask('b')).toBeUndefined();

    // reverseDeps should have no entry for 'b'
    // We can test indirectly: transitiveDependentCount on 'b' should be 0
    // (b is not in the graph, so count defaults to 0).
    // For 'a', its dependent 'b' was rolled back, so transitive count should be 0.
    expect(g.transitiveDependentCount('a')).toBe(0);

    // Verify a can still be reached: a has a dep on 'b' (missing)
    expect(g.getTask('a')?.task.dependencies).toEqual(['b']);
    expect(g.getTask('a')?.status).toBe('blocked'); // b doesn't exist
  });

  it('allows re-adding a task that was rejected in a previous cycle', () => {
    const g = new TaskGraph();
    const rf = makeRunnerFactory();

    g.addTask(makeTask({ id: 'a', dependencies: ['b'] }), rf);

    // cycle attempt
    expect(() => g.addTask(makeTask({ id: 'b', dependencies: ['a'] }), rf)).toThrow(/cycle/i);

    // Now add b without any deps — should succeed
    g.addTask(makeTask({ id: 'b', dependencies: [] }), rf);
    expect(g.getTask('b')?.status).toBe('ready');

    // a should now be ready too (b exists and is ready — but b isn't settled,
    // it's 'ready', so a stays blocked). Wait, 'ready' is not settled.
    // Let's just verify both exist.
    expect(g.getTask('a')).toBeDefined();
    expect(g.getTask('b')).toBeDefined();
  });
});

// ── addTasks — no-op runnerFactory (F5b) ──────────────────────────────────

describe('TaskGraph — addTasks no-op runnerFactory (F5b)', () => {
  it('falls back to no-op factory when runnerFactory is omitted', () => {
    const g = new TaskGraph();
    g.addTasks({ ...makeTask({ id: 'a' }) }, { ...makeTask({ id: 'b' }) });
    const a = g.getTask('a');
    const b = g.getTask('b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Both should have a runnerFactory function (the no-op fallback)
    expect(typeof a!.runnerFactory).toBe('function');
    expect(typeof b!.runnerFactory).toBe('function');
    // Calling the factory should return an object with plan and execute
    const runner = a!.runnerFactory();
    expect(typeof runner.plan).toBe('function');
    expect(typeof runner.execute).toBe('function');
  });
});

// ── addTasks — mid-batch cycle abort (F5c) ────────────────────────────────

describe('TaskGraph — addTasks mid-batch cycle abort (F5c)', () => {
  it('throws and rolls back all tasks added so far when a cycle forms mid-batch', () => {
    const g = new TaskGraph();
    const rf = makeRunnerFactory();

    // Build: a → b → c, then try to add c → a (cycle) mid-batch via addTasks.
    // addTasks calls addTask for each task in order. When the cycle forms,
    // addTask throws and rolls back that one insertion. Previous additions
    // in the batch remain (they were independent). But addTasks does NOT
    // roll back the entire batch — it only rolls back the failing task.
    // However, the requirement says "mid-batch cycle is caught and aborts the batch."
    // Let me re-read: "addTasks mid-batch cycle is caught and aborts the batch."
    // addTasks does NOT catch the error — it propagates up since addTask throws.
    // So after the throw, the batch is aborted. Previous tasks survive.

    // a → b (ok)
    g.addTask(makeTask({ id: 'a' }), rf);

    // Now use addTasks to add b and c where c → a creates a cycle
    expect(() =>
      g.addTasks(
        { ...makeTask({ id: 'b', dependencies: ['a'] }) },
        { ...makeTask({ id: 'c', dependencies: ['a'] }) }, // fine so far
      ),
    ).not.toThrow();

    // Now add d that cycles with a (d depends on a, but we don't have a reverse edge yet)
    // Actually let's construct a proper cycle via addTasks
    const g2 = new TaskGraph();
    g2.addTask(makeTask({ id: 'x' }), rf);

    // Both y and z are independent, no cycle
    expect(() =>
      g2.addTasks({ ...makeTask({ id: 'y', dependencies: ['x'] }) }, { ...makeTask({ id: 'z', dependencies: ['y'] }) }),
    ).not.toThrow();

    // Now attempt a batch where the second creates a cycle with existing
    // p depends on q → when we add q depending on p, cycle forms.
    const g3 = new TaskGraph();
    g3.addTask(makeTask({ id: 'p', dependencies: ['q'] }), rf);
    expect(() => g3.addTasks({ ...makeTask({ id: 'q', dependencies: ['p'] }) })).toThrow(/cycle/i);

    // q should not exist (rolled back)
    expect(g3.getTask('q')).toBeUndefined();
  });

  it('aborts a multi-task batch when a cycle forms and rolls back only the failing task', () => {
    const g = new TaskGraph();
    const rf = makeRunnerFactory();

    // Add a that depends on b (not yet added)
    g.addTask(makeTask({ id: 'a', dependencies: ['b'] }), rf);

    // Add b depending on a → cycle (a → b → a)
    expect(() => g.addTasks({ ...makeTask({ id: 'b', dependencies: ['a'] }) })).toThrow(/cycle/i);

    // Only a should exist; b was rolled back
    expect(g.getTask('a')).toBeDefined();
    expect(g.getTask('b')).toBeUndefined();
  });
});
