import { describe, expect, it, spyOn } from 'bun:test';
import { TaskTracker } from '../../src/tracking/task-status.js';
import { makeTask } from '../helpers/make-task.js';

describe('TaskTracker', () => {
  // ── addTask auto-status ────────────────────────────────────────────

  describe('addTask auto status', () => {
    it("sets 'ready' when there are no dependencies", () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      expect(tracker.getTask('a')!.status).toBe('ready');
    });

    it("sets 'blocked' when dependencies are unresolved", () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      // b added while a is not complete → blocked
      expect(tracker.getTask('b')!.status).toBe('blocked');
    });

    it("sets 'ready' when all dependencies are already complete", () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      // Complete task a via lifecycle
      const claimed = tracker.claimTasks(1, 'agent-1');
      tracker.completeTask(claimed[0].id);

      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });
      expect(tracker.getTask('b')!.status).toBe('ready');
    });
  });

  // ── addTask with explicit status override ──────────────────────────

  describe('addTask with explicit status override', () => {
    it('uses the provided status over auto-computed one', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      // Auto would be 'blocked' since a is not complete
      tracker.addTask(makeTask({ id: 'b', dependencies: ['a'], status: 'ready' }));

      expect(tracker.getTask('b')!.status).toBe('ready');
    });

    it('rejects duplicate task ids', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      expect(() => tracker.addTask(makeTask({ id: 'a' }))).toThrow('already exists');
    });
  });

  // ── getReadyTasks ──────────────────────────────────────────────────

  describe('getReadyTasks', () => {
    it('returns only ready tasks sorted by dep count then id', () => {
      const tracker = new TaskTracker();
      tracker.addTask({ ...makeTask({ id: 'c', dependencies: ['a', 'b'] }), status: undefined });
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      const ready = tracker.getReadyTasks();

      expect(ready).toHaveLength(2);
      // a and b have 0 deps, sorted alphabetically
      expect(ready[0].id).toBe('a');
      expect(ready[1].id).toBe('b');
      // c is blocked
    });
  });

  // ── claimTasks ─────────────────────────────────────────────────────

  describe('claimTasks', () => {
    it('marks ready tasks as active, assigns agent, and respects count limit', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));
      tracker.addTask(makeTask({ id: 'c' }));

      const claimed = tracker.claimTasks(2, 'agent-1');

      expect(claimed).toHaveLength(2);
      for (const t of claimed) {
        expect(t.status).toBe('active');
        expect(t.assignedAgent).toBe('agent-1');
      }

      // One ready task remains
      const remaining = tracker.getReadyTasks();
      expect(remaining).toHaveLength(1);
    });

    it('returns empty array when no tasks are ready', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      // Claim the only one
      tracker.claimTasks(1, 'agent-1');

      const result = tracker.claimTasks(5, 'agent-2');
      expect(result).toEqual([]);
    });
  });

  // ── full lifecycle: add → claim → complete ─────────────────────────

  describe('full lifecycle', () => {
    it('add → claim → complete', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      const claimed = tracker.claimTasks(1, 'agent-1');
      expect(claimed).toHaveLength(1);
      expect(tracker.getTask('t1')!.status).toBe('active');
      expect(tracker.getTask('t1')!.assignedAgent).toBe('agent-1');

      tracker.completeTask('t1');
      expect(tracker.getTask('t1')!.status).toBe('complete');
    });

    it('add → claim → fail', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.claimTasks(1, 'agent-1');
      tracker.failTask('t1', { error: 'something went wrong' });

      const task = tracker.getTask('t1')!;
      expect(task.status).toBe('failed');
      expect(task.result).toEqual({ error: 'something went wrong' });
      expect(task.assignedAgent).toBeUndefined();
    });

    it('add → claim → cancel', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.claimTasks(1, 'agent-1');
      tracker.cancelTask('t1');

      const task = tracker.getTask('t1')!;
      expect(task.status).toBe('cancelled');
      expect(task.assignedAgent).toBe('agent-1'); // not cleared by cancel
    });
  });

  // ── completeTask ───────────────────────────────────────────────────

  describe('completeTask', () => {
    it('throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.completeTask('nonexistent')).toThrow('not found');
    });

    it('throws if task is not active', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      // t1 has status "ready"
      expect(() => tracker.completeTask('t1')).toThrow('must be "active"');
    });

    it('sets status to complete and emits TaskSettled', async () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.claimTasks(1, 'agent-1');

      const settledPromise = new Promise<void>((resolve) => {
        tracker.once(TaskTracker.Events.TaskSettled, () => resolve());
      });

      tracker.completeTask('t1');

      await settledPromise;

      expect(tracker.getTask('t1')!.status).toBe('complete');
    });
  });

  // ── failTask ───────────────────────────────────────────────────────

  describe('failTask', () => {
    it('throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.failTask('nonexistent')).toThrow('not found');
    });

    it('throws if task is not active', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      expect(() => tracker.failTask('t1')).toThrow('must be "active"');
    });

    it('sets status to failed, clears assignedAgent, stores result', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      tracker.claimTasks(1, 'agent-1');

      tracker.failTask('t1', { error: 'failure' });

      const task = tracker.getTask('t1')!;
      expect(task.status).toBe('failed');
      expect(task.result).toEqual({ error: 'failure' });
      expect(task.assignedAgent).toBeUndefined();
    });

    it('emits TaskSettled', async () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      tracker.claimTasks(1, 'agent-1');

      const settledPromise = new Promise<void>((resolve) => {
        tracker.once(TaskTracker.Events.TaskSettled, () => resolve());
      });

      tracker.failTask('t1');

      await settledPromise;
    });
  });

  // ── cancelTask ─────────────────────────────────────────────────────

  describe('cancelTask', () => {
    it('throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.cancelTask('nonexistent')).toThrow('not found');
    });

    it('throws if task is already settled (complete)', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('t1');

      expect(() => tracker.cancelTask('t1')).toThrow(/already settled/);
    });

    it('throws if task is already settled (failed)', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      tracker.claimTasks(1, 'agent-1');
      tracker.failTask('t1');

      expect(() => tracker.cancelTask('t1')).toThrow(/already settled/);
    });

    it('throws if task is already settled (cancelled)', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      tracker.claimTasks(1, 'agent-1');
      tracker.cancelTask('t1');

      expect(() => tracker.cancelTask('t1')).toThrow(/already settled/);
    });

    it('cancels a ready task directly', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.cancelTask('t1');

      expect(tracker.getTask('t1')!.status).toBe('cancelled');
    });

    it('cancels a blocked task directly', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      tracker.cancelTask('b');

      expect(tracker.getTask('b')!.status).toBe('cancelled');
    });

    it('emits TaskSettled', async () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      const settledPromise = new Promise<void>((resolve) => {
        tracker.once(TaskTracker.Events.TaskSettled, () => resolve());
      });

      tracker.cancelTask('t1');

      await settledPromise;
    });
  });

  // ── rejectTask ─────────────────────────────────────────────────────

  describe('rejectTask', () => {
    it('keeps status active, appends feedback, does not change status', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.claimTasks(1, 'agent-1');

      tracker.rejectTask('t1', 'Needs more work');

      const task = tracker.getTask('t1')!;
      expect(task.status).toBe('active'); // unchanged
      expect(task.reviewFeedback).toEqual(['Needs more work']);
      expect(task.assignedAgent).toBe('agent-1'); // not cleared
    });

    it('throws if task is not in active state', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      expect(() => tracker.rejectTask('t1', 'reason')).toThrow('must be "active"');
    });

    it('accumulates feedback across multiple rejections', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.claimTasks(1, 'agent-1');
      tracker.rejectTask('t1', 'first issue');

      expect(tracker.getTask('t1')!.reviewFeedback).toEqual(['first issue']);

      // Second rejection — status stays active
      tracker.rejectTask('t1', 'second issue');

      expect(tracker.getTask('t1')!.reviewFeedback).toEqual(['first issue', 'second issue']);
      expect(tracker.getTask('t1')!.status).toBe('active');
    });

    it('emits TaskReady', async () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      tracker.claimTasks(1, 'agent-1');

      const readyPromise = new Promise<void>((resolve) => {
        tracker.once(TaskTracker.Events.TaskReady, () => resolve());
      });

      tracker.rejectTask('t1', 'feedback');

      await readyPromise;
    });
  });

  // ── completeTask unblocks dependents (DAG) ─────────────────────────

  describe('completeTask unblocks dependents', () => {
    it('unblocks tasks in a DAG: A→B→C', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });
      tracker.addTask({ ...makeTask({ id: 'c', dependencies: ['b'] }), status: undefined });

      // Initially: a=ready, b=blocked, c=blocked
      expect(tracker.getTask('a')!.status).toBe('ready');
      expect(tracker.getTask('b')!.status).toBe('blocked');
      expect(tracker.getTask('c')!.status).toBe('blocked');

      // Complete a
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('a');

      expect(tracker.getTask('a')!.status).toBe('complete');
      expect(tracker.getTask('b')!.status).toBe('ready');
      expect(tracker.getTask('c')!.status).toBe('blocked'); // b not complete yet

      // Complete b
      tracker.claimTasks(1, 'agent-2');
      tracker.completeTask('b');

      expect(tracker.getTask('b')!.status).toBe('complete');
      expect(tracker.getTask('c')!.status).toBe('ready');
    });
  });

  // ── dependency cycle detection ─────────────────────────────────────

  describe('dependency cycle detection', () => {
    it('throws when adding a task would create a cycle', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a', dependencies: ['b'] }));
      expect(() => tracker.addTask(makeTask({ id: 'b', dependencies: ['a'] }))).toThrow('Dependency cycle detected');
    });

    it('throws for direct self-dependency', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.addTask(makeTask({ id: 'a', dependencies: ['a'] }))).toThrow('Dependency cycle detected');
    });
  });

  // ── toJSON / fromJSON round-trip ───────────────────────────────────

  describe('toJSON / fromJSON round-trip', () => {
    it('preserves tasks through serialization', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      const json = tracker.toJSON();
      const restored = TaskTracker.fromJSON(json);

      expect(restored.getAllTasks()).toHaveLength(2);
      expect(restored.getTask('a')!.status).toBe('ready');
      expect(restored.getTask('b')!.status).toBe('blocked');

      // Mutating restored tracker should not affect original
      restored.claimTasks(1, 'agent-1');
      expect(tracker.getTask('a')!.status).toBe('ready');
    });
  });

  // ── preserve isCode through lifecycle ─────────────────────────────

  describe('preserve isCode through lifecycle', () => {
    it('preserves isCode through the lifecycle', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1', isCode: false }));

      expect(tracker.getTask('t1')!.isCode).toBe(false);

      tracker.claimTasks(1, 'agent-1');
      expect(tracker.getTask('t1')!.isCode).toBe(false);

      tracker.completeTask('t1');
      expect(tracker.getTask('t1')!.isCode).toBe(false);
    });
  });

  // ── preserve isCode through serialization ───────────────────────────

  describe('preserve isCode through serialization', () => {
    it('preserves isCode through toJSON/fromJSON round-trip', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1', isCode: false }));

      const json = tracker.toJSON();
      const restored = TaskTracker.fromJSON(json);

      expect(restored.getTask('t1')!.isCode).toBe(false);
    });
  });

  // ── error paths ────────────────────────────────────────────────────

  describe('error paths', () => {
    it('completeTask throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.completeTask('nonexistent')).toThrow('not found');
    });

    it('failTask throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.failTask('nonexistent')).toThrow('not found');
    });

    it('rejectTask throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.rejectTask('nonexistent', 'reason')).toThrow('not found');
    });

    it('cancelTask throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.cancelTask('nonexistent')).toThrow('not found');
    });

    it('completeTask throws when task is not in active status', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      // t1 has status "ready" from makeTask default
      expect(() => tracker.completeTask('t1')).toThrow('must be "active"');
    });

    it('failTask throws when task is not in active status', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      expect(() => tracker.failTask('t1')).toThrow('must be "active"');
    });
  });

  // ── reject-then-complete lifecycle ─────────────────────────────────

  describe('reject-then-complete lifecycle', () => {
    it('reject → complete', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.claimTasks(1, 'agent-1');
      tracker.rejectTask('t1', 'Needs revision');

      const taskAfterReject = tracker.getTask('t1')!;
      expect(taskAfterReject.status).toBe('active');
      expect(taskAfterReject.reviewFeedback).toEqual(['Needs revision']);

      // Complete the task despite earlier rejection
      tracker.completeTask('t1');

      const taskDone = tracker.getTask('t1')!;
      expect(taskDone.status).toBe('complete');
      expect(taskDone.assignedAgent).toBe('agent-1');
    });
  });

  // ── getTask for non-existent id ────────────────────────────────────

  describe('getTask', () => {
    it('returns undefined for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(tracker.getTask('nonexistent')).toBeUndefined();
    });
  });

  // ── fromJSON with complete dependencies ────────────────────────────

  describe('fromJSON with complete dependencies', () => {
    it('recalculates statuses when deserialized deps are already complete', () => {
      // Manually construct data where b is blocked but its dep a is complete
      const data = {
        tasks: [
          makeTask({ id: 'a', status: 'complete' }),
          { ...makeTask({ id: 'b', dependencies: ['a'] }), status: 'blocked' as const },
        ],
      };
      const restored = TaskTracker.fromJSON(data);
      expect(restored.getTask('a')!.status).toBe('complete');
      expect(restored.getTask('b')!.status).toBe('ready'); // recalculated!
    });

    it('preserves round-trip with completed dependencies', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      // Complete a
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('a');

      const json = tracker.toJSON();
      const restored = TaskTracker.fromJSON(json);
      expect(restored.getTask('a')!.status).toBe('complete');
      expect(restored.getTask('b')!.status).toBe('ready');
    });
  });

  // ── addTask with explicit status:'complete' unblocks dependents ────

  describe("addTask with explicit status:'complete' unblocks dependents", () => {
    it('unblocks existing tasks that depend on a newly added complete task', () => {
      const tracker = new TaskTracker();
      // Add b depending on c before c exists
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['c'] }), status: undefined });
      expect(tracker.getTask('b')!.status).toBe('blocked');

      // Add c with explicit status: "complete"
      tracker.addTask(makeTask({ id: 'c', status: 'complete' }));
      // recalculateStatuses() in addTask should unblock b
      expect(tracker.getTask('b')!.status).toBe('ready');
    });
  });

  // ── duplicate id in fromJSON ───────────────────────────────────────

  describe('duplicate id in fromJSON', () => {
    it('last entry wins when duplicate ids are present', () => {
      const data = {
        tasks: [makeTask({ id: 'a', status: 'ready' }), makeTask({ id: 'a', status: 'complete' })],
      };
      const restored = TaskTracker.fromJSON(data);
      expect(restored.getAllTasks()).toHaveLength(1);
      expect(restored.getTask('a')!.status).toBe('complete');
    });
  });

  // ── fromJSON cycle detection ───────────────────────────────────────

  describe('fromJSON cycle detection', () => {
    it('throws when deserialized data contains a dependency cycle', () => {
      const data = {
        tasks: [
          makeTask({ id: 'a', dependencies: ['b'], status: 'ready' }),
          makeTask({ id: 'b', dependencies: ['a'], status: 'ready' }),
        ],
      };
      expect(() => TaskTracker.fromJSON(data)).toThrow('Cycle detected');
    });
  });

  // ── isPoolDone ────────────────────────────────────────────────────

  describe('isPoolDone', () => {
    it('returns true when there are no tasks', () => {
      const tracker = new TaskTracker();
      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns false when tasks are ready', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      expect(tracker.isPoolDone()).toBe(false);
    });

    it('returns true when all tasks are complete', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      for (const id of ['a', 'b']) {
        tracker.claimTasks(1, 'agent');
        tracker.completeTask(id);
      }

      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns true when all tasks are failed', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      for (const id of ['a', 'b']) {
        tracker.claimTasks(1, 'agent');
        tracker.failTask(id);
      }

      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns true when all tasks are cancelled', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      for (const id of ['a', 'b']) {
        tracker.cancelTask(id);
      }

      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns true for a mix of complete and failed tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      tracker.claimTasks(1, 'agent');
      tracker.completeTask('a');

      tracker.claimTasks(1, 'agent');
      tracker.failTask('b');

      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns true for a mix of complete, failed, and cancelled tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));
      tracker.addTask(makeTask({ id: 'c' }));

      tracker.claimTasks(1, 'agent');
      tracker.completeTask('a');

      tracker.claimTasks(1, 'agent');
      tracker.failTask('b');

      tracker.cancelTask('c');

      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns false when a task is active', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      tracker.claimTasks(1, 'agent');
      // One active, one still ready
      expect(tracker.isPoolDone()).toBe(false);
    });

    it('returns true when task is blocked with missing deps (deadlocked)', () => {
      const tracker = new TaskTracker();
      tracker.addTask({ ...makeTask({ id: 'a', dependencies: ['ghost'] }), status: undefined });

      expect(tracker.getTask('a')!.status).toBe('blocked');
      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns false when a task is blocked but deps exist (not deadlocked)', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      expect(tracker.getTask('b')!.status).toBe('blocked');
      expect(tracker.isPoolDone()).toBe(false);
    });

    it('returns true for a mix of complete tasks and deadlocked tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['ghost'] }), status: undefined });

      tracker.claimTasks(1, 'agent');
      tracker.completeTask('a');

      expect(tracker.getTask('a')!.status).toBe('complete');
      expect(tracker.getTask('b')!.status).toBe('blocked');
      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns false for a mix of complete tasks and ready tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      tracker.claimTasks(1, 'agent');
      tracker.completeTask('a');

      expect(tracker.isPoolDone()).toBe(false); // b is still 'ready'
    });
  });

  // ── dependency validation ───────────────────────────────────────────

  describe('dependency validation', () => {
    it('throws for a circular dependency chain of length 3 (a→b→c→a)', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a', dependencies: ['b'] }));
      tracker.addTask(makeTask({ id: 'b', dependencies: ['c'] }));
      expect(() => tracker.addTask(makeTask({ id: 'c', dependencies: ['a'] }))).toThrow('Dependency cycle detected');
    });

    it('unblocks multiple tasks sharing the same dependency when it completes', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'shared' }));
      tracker.addTask({ ...makeTask({ id: 'x', dependencies: ['shared'] }), status: undefined });
      tracker.addTask({ ...makeTask({ id: 'y', dependencies: ['shared'] }), status: undefined });
      tracker.addTask({ ...makeTask({ id: 'z', dependencies: ['shared'] }), status: undefined });

      // All three should be blocked
      expect(tracker.getTask('x')!.status).toBe('blocked');
      expect(tracker.getTask('y')!.status).toBe('blocked');
      expect(tracker.getTask('z')!.status).toBe('blocked');

      // Complete the shared dependency
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('shared');

      // All three should now be ready
      expect(tracker.getTask('x')!.status).toBe('ready');
      expect(tracker.getTask('y')!.status).toBe('ready');
      expect(tracker.getTask('z')!.status).toBe('ready');
    });

    it('claimTasks(0) returns an empty array', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      const claimed = tracker.claimTasks(0, 'agent-1');
      expect(claimed).toEqual([]);
      // Tasks should still be ready
      expect(tracker.getTask('a')!.status).toBe('ready');
      expect(tracker.getTask('b')!.status).toBe('ready');
    });

    it('transitions from blocked → ready → active → complete', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'root' }));
      tracker.addTask({ ...makeTask({ id: 'child', dependencies: ['root'] }), status: undefined });

      // child starts blocked
      expect(tracker.getTask('child')!.status).toBe('blocked');

      // Complete root → child becomes ready
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('root');
      expect(tracker.getTask('child')!.status).toBe('ready');

      // Claim → active
      tracker.claimTasks(1, 'agent-2');
      expect(tracker.getTask('child')!.status).toBe('active');
      expect(tracker.getTask('child')!.assignedAgent).toBe('agent-2');

      // Complete → complete
      tracker.completeTask('child');
      expect(tracker.getTask('child')!.status).toBe('complete');
    });
  });

  // ── addTask auto-status with failed deps ───────────────────────────

  describe('addTask auto-status with failed deps', () => {
    it('sets ready when all dependencies have failed (not blocked)', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      // Fail task a: claim → failTask
      tracker.claimTasks(1, 'agent-1');
      tracker.failTask('a', 'could not complete');

      expect(tracker.getTask('a')!.status).toBe('failed');

      // Add b depending on a with auto-status (status: undefined)
      // addTask should treat 'failed' deps as settled, same as recalculateStatuses does
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      expect(tracker.getTask('b')!.status).toBe('ready');
    });

    it('sets ready when one dep is complete and another is failed', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      // Complete a
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('a');
      expect(tracker.getTask('a')!.status).toBe('complete');

      // Fail b
      tracker.claimTasks(1, 'agent-2');
      tracker.failTask('b', 'error');
      expect(tracker.getTask('b')!.status).toBe('failed');

      // c depends on both a (complete) and b (failed) — should be ready
      tracker.addTask({ ...makeTask({ id: 'c', dependencies: ['a', 'b'] }), status: undefined });
      expect(tracker.getTask('c')!.status).toBe('ready');
    });
  });

  // ── addTask auto-status with cancelled deps ────────────────────────

  describe('addTask auto-status with cancelled deps', () => {
    it('sets ready when all dependencies are cancelled', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.cancelTask('a');

      expect(tracker.getTask('a')!.status).toBe('cancelled');

      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      expect(tracker.getTask('b')!.status).toBe('ready');
    });
  });

  // ── rejectTask stays active (downstream stays blocked) ─────────────

  describe('rejectTask keeps active status', () => {
    it('task stays active after rejection; downstream stays blocked', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });
      tracker.addTask({ ...makeTask({ id: 'c', dependencies: ['b'] }), status: undefined });

      // Initially: a=ready, b=blocked, c=blocked
      expect(tracker.getTask('a')!.status).toBe('ready');
      expect(tracker.getTask('b')!.status).toBe('blocked');
      expect(tracker.getTask('c')!.status).toBe('blocked');

      // Complete a → b becomes ready, c stays blocked
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('a');
      expect(tracker.getTask('b')!.status).toBe('ready');
      expect(tracker.getTask('c')!.status).toBe('blocked');

      // Claim b, then reject it (keeps active)
      tracker.claimTasks(1, 'agent-2');
      tracker.rejectTask('b', 'try again');

      // b is still active (not complete), so c should remain blocked
      expect(tracker.getTask('b')!.status).toBe('active');
      expect(tracker.getTask('b')!.reviewFeedback).toEqual(['try again']);
      expect(tracker.getTask('c')!.status).toBe('blocked');
    });
  });

  // ── getTasksByPhase ────────────────────────────────────────────────

  describe('getTasksByPhase', () => {
    it('returns tasks matching the given phaseId', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a', phaseId: 'phase-1' }));
      tracker.addTask(makeTask({ id: 'b', phaseId: 'phase-2' }));
      tracker.addTask(makeTask({ id: 'c', phaseId: 'phase-1' }));

      const phase1Tasks = tracker.getTasksByPhase('phase-1');
      expect(phase1Tasks).toHaveLength(2);
      expect(phase1Tasks.map((t) => t.id).sort()).toEqual(['a', 'c']);

      const phase2Tasks = tracker.getTasksByPhase('phase-2');
      expect(phase2Tasks).toHaveLength(1);
      expect(phase2Tasks[0].id).toBe('b');

      const phase3Tasks = tracker.getTasksByPhase('phase-3');
      expect(phase3Tasks).toHaveLength(0);
    });
  });

  // ── getPhases ──────────────────────────────────────────────────────

  describe('getPhases', () => {
    it('returns unique phaseIds in insertion order', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a', phaseId: 'alpha' }));
      tracker.addTask(makeTask({ id: 'b', phaseId: 'beta' }));
      tracker.addTask(makeTask({ id: 'c', phaseId: 'alpha' })); // duplicate
      tracker.addTask(makeTask({ id: 'd', phaseId: 'gamma' }));

      expect(tracker.getPhases()).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('returns empty array when there are no tasks', () => {
      const tracker = new TaskTracker();
      expect(tracker.getPhases()).toEqual([]);
    });

    it('preserves insertion order even when phases repeat', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a', phaseId: 'gamma' }));
      tracker.addTask(makeTask({ id: 'b', phaseId: 'alpha' }));
      tracker.addTask(makeTask({ id: 'c', phaseId: 'beta' }));
      tracker.addTask(makeTask({ id: 'd', phaseId: 'alpha' })); // repeat

      expect(tracker.getPhases()).toEqual(['gamma', 'alpha', 'beta']);
    });
  });

  // ── EventEmitter integration ──────────────────────────────────────

  describe('EventEmitter integration', () => {
    it('emits taskReady when blocked task becomes ready', async () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      expect(tracker.getTask('b')!.status).toBe('blocked');

      const eventPromise = new Promise<unknown>((resolve) => {
        tracker.once('taskReady', resolve);
      });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('taskReady event not emitted within 1000ms')), 1000),
      );

      // Complete task a via lifecycle
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('a');

      await Promise.race([eventPromise, timeout]);

      expect(tracker.getTask('b')!.status).toBe('ready');
    });

    it('emits taskReady when multiple tasks unblock simultaneously', async () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });
      tracker.addTask({ ...makeTask({ id: 'c', dependencies: ['a'] }), status: undefined });

      expect(tracker.getTask('b')!.status).toBe('blocked');
      expect(tracker.getTask('c')!.status).toBe('blocked');

      let emitCount = 0;
      tracker.on('taskReady', () => {
        emitCount++;
      });

      // Set up event-driven wait BEFORE the action
      const readyEvent = new Promise<void>((resolve) => {
        tracker.once('taskReady', () => resolve());
      });

      // Complete task a
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('a');

      // Event is emitted via queueMicrotask, so we await
      await readyEvent;

      expect(emitCount).toBeGreaterThanOrEqual(1);
      expect(tracker.getTask('b')!.status).toBe('ready');
      expect(tracker.getTask('c')!.status).toBe('ready');
    });

    it('does not emit taskReady when no tasks transition', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      // a starts as ready — no blocked tasks to transition
      expect(tracker.getTask('a')!.status).toBe('ready');

      let emitted = false;
      tracker.on('taskReady', () => {
        emitted = true;
      });

      // emit is deferred via queueMicrotask, but since no transition occurs, no emit is queued.
      tracker.recalculateStatuses();

      expect(emitted).toBe(false);
    });

    it('fromJSON produces a working EventEmitter', async () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      const json = tracker.toJSON();
      const restored = TaskTracker.fromJSON(json);

      // b should still be blocked after deserialization
      expect(restored.getTask('b')!.status).toBe('blocked');

      const eventPromise = new Promise<unknown>((resolve) => {
        restored.once('taskReady', resolve);
      });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('taskReady event not emitted within 1000ms')), 1000),
      );

      // Complete task a on the restored tracker
      restored.claimTasks(1, 'agent-1');
      restored.completeTask('a');

      await Promise.race([eventPromise, timeout]);

      expect(restored.getTask('b')!.status).toBe('ready');
    });

    it('emits taskSettled when a task completes', async () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      const settledPromise = new Promise<void>((resolve) => {
        tracker.once('taskSettled', () => resolve());
      });

      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('a');

      await settledPromise;
      expect(tracker.getTask('a')!.status).toBe('complete');
    });

    it('emits taskSettled when a task fails', async () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      const settledPromise = new Promise<void>((resolve) => {
        tracker.once('taskSettled', () => resolve());
      });

      tracker.claimTasks(1, 'agent-1');
      tracker.failTask('a');

      await settledPromise;
      expect(tracker.getTask('a')!.status).toBe('failed');
    });

    it('emits taskSettled when a task is cancelled', async () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      const settledPromise = new Promise<void>((resolve) => {
        tracker.once('taskSettled', () => resolve());
      });

      tracker.cancelTask('a');

      await settledPromise;
      expect(tracker.getTask('a')!.status).toBe('cancelled');
    });
  });

  // ── isPoolDone console.warn ─────────────────────────────────────────

  describe('isPoolDone console.warn', () => {
    it('emits console.warn for blocked task with missing dependencies', () => {
      const tracker = new TaskTracker();
      tracker.addTask({ ...makeTask({ id: 'a', dependencies: ['ghost-x', 'ghost-y'] }), status: undefined });

      expect(tracker.getTask('a')!.status).toBe('blocked');

      const warnCalls: unknown[][] = [];
      const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnCalls.push(args);
      });

      try {
        const result = tracker.isPoolDone();

        expect(result).toBe(true);
        expect(warnCalls.length).toBe(1);
        expect(String(warnCalls[0])).toContain('ghost-x');
        expect(String(warnCalls[0])).toContain('ghost-y');
        expect(String(warnCalls[0])).toContain('a');
      } finally {
        spy.mockRestore();
      }
    });

    it('does not warn when blocked task has dependencies that exist', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      expect(tracker.getTask('b')!.status).toBe('blocked');

      const warnCalls: unknown[][] = [];
      const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnCalls.push(args);
      });

      try {
        const result = tracker.isPoolDone();

        expect(result).toBe(false);
        expect(warnCalls).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── resetStuckTasks / resetFailedTasks / resetForRetry ─────────────

  describe('resetStuckTasks', () => {
    it('resets active tasks to ready', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.claimTasks(1, 'agent-1');
      expect(tracker.getTask('a')!.status).toBe('active');

      tracker.resetStuckTasks();
      expect(tracker.getTask('a')!.status).toBe('ready');
      expect(tracker.getTask('a')!.assignedAgent).toBeUndefined();
    });

    it('does not reset complete tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('a');
      expect(tracker.getTask('a')!.status).toBe('complete');

      tracker.resetStuckTasks();
      expect(tracker.getTask('a')!.status).toBe('complete');
    });

    it('does not reset failed tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.claimTasks(1, 'agent-1');
      tracker.failTask('a');
      expect(tracker.getTask('a')!.status).toBe('failed');

      tracker.resetStuckTasks();
      expect(tracker.getTask('a')!.status).toBe('failed');
    });

    it('does not reset cancelled tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.cancelTask('a');
      expect(tracker.getTask('a')!.status).toBe('cancelled');

      tracker.resetStuckTasks();
      expect(tracker.getTask('a')!.status).toBe('cancelled');
    });
  });

  describe('resetFailedTasks', () => {
    it('resets failed tasks to ready', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.claimTasks(1, 'agent-1');
      tracker.failTask('a', 'error');
      expect(tracker.getTask('a')!.status).toBe('failed');

      tracker.resetFailedTasks();
      const task = tracker.getTask('a')!;
      expect(task.status).toBe('ready');
      expect(task.assignedAgent).toBeUndefined();
      expect(task.result).toBeUndefined();
      expect(task.reviewFeedback).toBeUndefined();
    });

    it('does not affect non-failed tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));
      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('a');
      // b is still ready

      tracker.resetFailedTasks();
      expect(tracker.getTask('a')!.status).toBe('complete');
      expect(tracker.getTask('b')!.status).toBe('ready');
    });
  });

  describe('resetForRetry', () => {
    it('resets both failed and active tasks to ready', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      tracker.claimTasks(1, 'agent-1');
      tracker.failTask('a', 'err');

      tracker.claimTasks(1, 'agent-2');
      // b is now active

      tracker.resetForRetry();
      expect(tracker.getTask('a')!.status).toBe('ready');
      expect(tracker.getTask('b')!.status).toBe('ready');
    });

    it('does not reset complete or cancelled tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));
      tracker.addTask(makeTask({ id: 'c' }));

      tracker.claimTasks(1, 'agent-1');
      tracker.completeTask('a');

      tracker.claimTasks(1, 'agent-2');
      tracker.failTask('b', 'err');

      tracker.cancelTask('c');

      tracker.resetForRetry();
      expect(tracker.getTask('a')!.status).toBe('complete');
      expect(tracker.getTask('b')!.status).toBe('ready'); // failed → ready
      expect(tracker.getTask('c')!.status).toBe('cancelled'); // not reset
    });
  });
});
