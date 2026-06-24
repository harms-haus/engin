// ─── Tests for tracking/task-status.ts — isPoolDone deadlocked task failure ──
//
// Verifies that when `isPoolDone()` detects a 'blocked' task whose dependency
// references a non-existent task (deadlocked), it:
//   1. Marks the task as 'failed' with a descriptive result.
//   2. Emits `TaskSettled`.
//   3. Returns `true` (pool is done).
//   4. Is idempotent: a second call does NOT re-emit or re-fail.
//
// Also verifies that a normal blocked task (whose deps exist and are not yet
// settled) is NOT failed.
//
// Module under test: ./task-status.js

import { beforeEach, describe, expect, it } from 'bun:test';

import type { Task } from '../core/types.js';
import { TaskTracker } from './task-status.js';

// ─── Fixture helpers ─────────────────────────────────────────────────────

function makeTask(id: string, overrides: Partial<Omit<Task, 'id' | 'status'>> = {}): Omit<Task, 'status'> {
  return {
    id,
    title: `Task ${id}`,
    prompt: `do ${id}`,
    profile: 'default',
    files: [],
    dependencies: [],
    phaseId: 'test',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('TaskTracker.isPoolDone — deadlocked tasks', () => {
  let tracker: TaskTracker;

  beforeEach(() => {
    tracker = new TaskTracker();
  });

  // ── Core deadlock detection ─────────────────────────────────────────

  it('marks a blocked task with a missing dependency as failed', () => {
    // Task A depends on B, but B does not exist in the tracker → A is deadlocked.
    tracker.addTask(makeTask('a', { dependencies: ['missing-b'] }));

    // Before isPoolDone: task is 'blocked'.
    const before = tracker.getTask('a');
    expect(before?.status).toBe('blocked');

    const done = tracker.isPoolDone();

    // After isPoolDone: task is 'failed'.
    const after = tracker.getTask('a');
    expect(after?.status).toBe('failed');
    expect(done).toBe(true);
  });

  it('sets a descriptive result on the deadlocked task', () => {
    tracker.addTask(makeTask('dead', { dependencies: ['ghost'] }));

    tracker.isPoolDone();

    const task = tracker.getTask('dead');
    expect(task?.status).toBe('failed');
    // Result must mention the missing dependency.
    const result = task?.result as { completed?: boolean; error?: string } | undefined;
    expect(result).toBeDefined();
    expect(result?.completed).toBe(false);
    expect(result?.error).toContain('deadlocked');
    expect(result?.error).toContain('ghost');
  });

  it('emits TaskSettled when a deadlocked task is failed', async () => {
    tracker.addTask(makeTask('x', { dependencies: ['nope'] }));

    const settledEvents: string[] = [];
    tracker.on(TaskTracker.Events.TaskSettled, () => {
      settledEvents.push('settled');
    });

    tracker.isPoolDone();

    // The emit is queued via queueMicrotask, so we wait one tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(settledEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('isPoolDone returns true after deadlocking', () => {
    tracker.addTask(makeTask('only', { dependencies: ['missing'] }));

    expect(tracker.isPoolDone()).toBe(true);
  });

  // ── Idempotency ─────────────────────────────────────────────────────

  it('calling isPoolDone again does NOT re-emit TaskSettled (idempotent)', async () => {
    tracker.addTask(makeTask('idem', { dependencies: ['gone'] }));

    // First call: should emit.
    tracker.isPoolDone();
    await new Promise((r) => setTimeout(r, 0));

    let emitCount = 0;
    tracker.on(TaskTracker.Events.TaskSettled, () => {
      emitCount++;
    });

    // Second call: the task is already 'failed', so warnedDeadlocked prevents
    // re-acting, and no new TaskSettled should be emitted.
    tracker.isPoolDone();
    await new Promise((r) => setTimeout(r, 0));

    expect(emitCount).toBe(0);
  });

  it('calling isPoolDone again does NOT change the task status (already failed)', () => {
    tracker.addTask(makeTask('idem2', { dependencies: ['gone'] }));

    tracker.isPoolDone();
    const first = tracker.getTask('idem2');
    expect(first?.status).toBe('failed');

    // Second call — status must not change again.
    tracker.isPoolDone();
    const second = tracker.getTask('idem2');
    expect(second?.status).toBe('failed');
  });

  // ── Multiple deadlocked tasks ───────────────────────────────────────

  it('multiple tasks with missing deps are all failed', () => {
    tracker.addTask(makeTask('a', { dependencies: ['missing-x'] }));
    tracker.addTask(makeTask('b', { dependencies: ['missing-y'] }));
    tracker.addTask(makeTask('c', { dependencies: ['missing-x', 'missing-y'] }));

    const done = tracker.isPoolDone();

    expect(done).toBe(true);
    expect(tracker.getTask('a')?.status).toBe('failed');
    expect(tracker.getTask('b')?.status).toBe('failed');
    expect(tracker.getTask('c')?.status).toBe('failed');
  });

  // ── Normal blocked task is NOT failed ───────────────────────────────

  it('a blocked task whose dependencies exist but are not settled is NOT failed', () => {
    // Task B depends on A; A exists but is still 'active' → B is 'blocked' but NOT deadlocked.
    tracker.addTask(makeTask('a'));
    tracker.addTask(makeTask('b', { dependencies: ['a'] }));

    // B should be 'blocked' because A is 'ready' (not settled).
    expect(tracker.getTask('b')?.status).toBe('blocked');

    const done = tracker.isPoolDone();

    // isPoolDone must NOT return true — there's still a live blocked task.
    expect(done).toBe(false);
    // B must still be 'blocked' (not failed).
    expect(tracker.getTask('b')?.status).toBe('blocked');
  });

  it('a blocked task whose dep is active (not settled) is NOT failed', () => {
    tracker.addTask(makeTask('runner'));
    tracker.addTask(makeTask('waiter', { dependencies: ['runner'] }));

    // Claim runner so it goes active.
    tracker.claimTasks(1, 'agent-1');
    expect(tracker.getTask('runner')?.status).toBe('active');

    // Waiter depends on active runner → blocked, not deadlocked.
    expect(tracker.getTask('waiter')?.status).toBe('blocked');

    const done = tracker.isPoolDone();
    expect(done).toBe(false);
    expect(tracker.getTask('waiter')?.status).toBe('blocked');
  });

  // ── Mixed: some deadlocked, some normal ─────────────────────────────

  it('does NOT fail a blocked task whose deps exist and are merely unsettled', () => {
    // Only test the non-deadlocked path: 'good' is blocked on an existing
    // but unsettled dep. isPoolDone must NOT return true and must NOT fail
    // the blocked task.
    tracker.addTask(makeTask('dep'));
    tracker.addTask(makeTask('good', { dependencies: ['dep'] }));

    const done = tracker.isPoolDone();

    // 'good' is blocked on an existing (but unsettled) dep → NOT failed.
    expect(tracker.getTask('good')?.status).toBe('blocked');
    // Pool is NOT done — 'good' is still blocked and alive.
    expect(done).toBe(false);
  });

  it('deadlocked task is failed while sibling blocked task with real deps stays blocked', () => {
    // Two tasks: 'bad' has a missing dep (deadlocked), 'good' has a real
    // but unsettled dep. isPoolDone should fail 'bad' but leave 'good' alone.
    // We add 'bad' FIRST so it is iterated and failed before the early return
    // on 'good-dep' (which is 'ready' and causes isPoolDone to return false).
    tracker.addTask(makeTask('bad', { dependencies: ['nonexistent'] }));
    tracker.addTask(makeTask('good-dep'));
    tracker.addTask(makeTask('good', { dependencies: ['good-dep'] }));

    const done = tracker.isPoolDone();

    // 'bad' is deadlocked → failed.
    expect(tracker.getTask('bad')?.status).toBe('failed');
    // 'good' is blocked on an existing (but unsettled) dep → NOT failed.
    expect(tracker.getTask('good')?.status).toBe('blocked');
    // Pool is NOT done — 'good' is still blocked and alive.
    expect(done).toBe(false);
  });

  // ── Empty tracker ───────────────────────────────────────────────────

  it('empty tracker: isPoolDone returns true', () => {
    expect(tracker.isPoolDone()).toBe(true);
  });

  // ── Ready + complete tasks are unaffected ───────────────────────────

  it('ready and complete tasks are not affected by isPoolDone', () => {
    // One task claimed and completed → settled.
    tracker.addTask(makeTask('done-one'));
    tracker.claimTasks(1, 'agent-x');
    tracker.completeTask('done-one');

    const done = tracker.isPoolDone();

    expect(done).toBe(true);
    expect(tracker.getTask('done-one')?.status).toBe('complete');
  });

  // ── Cancelled task with missing dep → already settled, unaffected ───

  it('a cancelled task with missing dep is not re-failed (already settled)', () => {
    tracker.addTask(makeTask('cancelled', { dependencies: ['missing'] }));
    tracker.cancelTask('cancelled');

    const done = tracker.isPoolDone();

    // Already settled (cancelled) — isPoolDone treats it as done, does NOT fail it.
    expect(tracker.getTask('cancelled')?.status).toBe('cancelled');
    expect(done).toBe(true);
  });
});
