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

      // b added while a is not done → blocked
      expect(tracker.getTask('b')!.status).toBe('blocked');
    });

    it("sets 'ready' when all dependencies are already done", () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      // Complete task a via lifecycle
      const claimed = tracker.claimTasks(1);
      tracker.startTask(claimed[0].id, 'agent-1');
      tracker.submitForReview(claimed[0].id, 'done');
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

      // Auto would be 'blocked' since a is not done
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
    it('marks ready tasks as claimed and respects count limit', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));
      tracker.addTask(makeTask({ id: 'c' }));

      const claimed = tracker.claimTasks(2);

      expect(claimed).toHaveLength(2);
      for (const t of claimed) {
        expect(t.status).toBe('claimed');
      }

      // One ready task remains
      const remaining = tracker.getReadyTasks();
      expect(remaining).toHaveLength(1);
    });

    it('returns empty array when no tasks are ready', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      // Claim the only one
      tracker.claimTasks(1);

      const result = tracker.claimTasks(5);
      expect(result).toEqual([]);
    });
  });

  // ── full lifecycle ─────────────────────────────────────────────────

  describe('full lifecycle', () => {
    it('add → claim → start → submit → complete', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      const claimed = tracker.claimTasks(1);
      expect(claimed).toHaveLength(1);
      expect(tracker.getTask('t1')!.status).toBe('claimed');

      tracker.startTask('t1', 'agent-1');
      expect(tracker.getTask('t1')!.status).toBe('implementing');
      expect(tracker.getTask('t1')!.assignedAgent).toBe('agent-1');

      tracker.submitForReview('t1', { summary: 'finished' });
      expect(tracker.getTask('t1')!.status).toBe('reviewing');
      expect(tracker.getTask('t1')!.result).toEqual({ summary: 'finished' });

      tracker.completeTask('t1');
      expect(tracker.getTask('t1')!.status).toBe('done');
    });
  });

  // ── rejectTask ─────────────────────────────────────────────────────

  describe('rejectTask', () => {
    it('moves reviewing → ready and stores feedback', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.claimTasks(1);
      tracker.startTask('t1', 'agent-1');
      tracker.submitForReview('t1', 'result');

      tracker.rejectTask('t1', 'Needs more work');

      const task = tracker.getTask('t1')!;
      expect(task.status).toBe('ready');
      expect(task.reviewFeedback).toEqual(['Needs more work']);
    });

    it('throws if task is not in reviewing state', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.claimTasks(1);
      expect(() => tracker.rejectTask('t1', 'reason')).toThrow('must be "reviewing"');
    });

    it('accumulates feedback across multiple rejections', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      // First rejection
      tracker.claimTasks(1);
      tracker.startTask('t1', 'agent-1');
      tracker.submitForReview('t1', 'first attempt');
      tracker.rejectTask('t1', 'first issue');

      expect(tracker.getTask('t1')!.reviewFeedback).toEqual(['first issue']);

      // Second rejection
      tracker.claimTasks(1);
      tracker.startTask('t1', 'agent-2');
      tracker.submitForReview('t1', 'second attempt');
      tracker.rejectTask('t1', 'second issue');

      expect(tracker.getTask('t1')!.reviewFeedback).toEqual(['first issue', 'second issue']);
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
      tracker.claimTasks(1);
      tracker.startTask('a', 'agent-1');
      tracker.submitForReview('a', null);
      tracker.completeTask('a');

      expect(tracker.getTask('a')!.status).toBe('done');
      expect(tracker.getTask('b')!.status).toBe('ready');
      expect(tracker.getTask('c')!.status).toBe('blocked'); // b not done yet

      // Complete b
      tracker.claimTasks(1);
      tracker.startTask('b', 'agent-2');
      tracker.submitForReview('b', null);
      tracker.completeTask('b');

      expect(tracker.getTask('b')!.status).toBe('done');
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
      restored.claimTasks(1);
      expect(tracker.getTask('a')!.status).toBe('ready');
    });
  });

  // ── preserve isCode through lifecycle ─────────────────────────────

  describe('preserve isCode through lifecycle', () => {
    it('preserves isCode through the lifecycle', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1', isCode: false }));

      expect(tracker.getTask('t1')!.isCode).toBe(false);

      const _claimed = tracker.claimTasks(1);
      tracker.startTask('t1', 'agent-1');
      expect(tracker.getTask('t1')!.isCode).toBe(false);

      tracker.submitForReview('t1', 'result');
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
    it('startTask throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.startTask('nonexistent', 'agent')).toThrow('not found');
    });

    it('submitForReview throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.submitForReview('nonexistent', null)).toThrow('not found');
    });

    it('completeTask throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.completeTask('nonexistent')).toThrow('not found');
    });

    it('rejectTask throws for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(() => tracker.rejectTask('nonexistent', 'reason')).toThrow('not found');
    });

    it('startTask throws when task is not in claimed status', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      // t1 has status "ready" from makeTask default
      expect(() => tracker.startTask('t1', 'agent')).toThrow('must be "claimed"');
    });

    it('submitForReview throws when task is not in implementing status', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      expect(() => tracker.submitForReview('t1', null)).toThrow('must be "implementing"');
    });

    it('completeTask throws when task is not in reviewing status', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));
      expect(() => tracker.completeTask('t1')).toThrow('must be "reviewing"');
    });
  });

  // ── reject-then-restart lifecycle ──────────────────────────────────

  describe('reject-then-restart lifecycle', () => {
    it('reject → startTask → submitForReview → completeTask', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.claimTasks(1);
      tracker.startTask('t1', 'agent-1');
      tracker.submitForReview('t1', 'first attempt');
      tracker.rejectTask('t1', 'Needs revision');

      const taskAfterReject = tracker.getTask('t1')!;
      expect(taskAfterReject.status).toBe('ready');
      expect(taskAfterReject.reviewFeedback).toEqual(['Needs revision']);

      // Reclaim and restart after rejection
      tracker.claimTasks(1);
      tracker.startTask('t1', 'agent-2');
      tracker.submitForReview('t1', 'revised');
      tracker.completeTask('t1');

      const taskDone = tracker.getTask('t1')!;
      expect(taskDone.status).toBe('done');
      expect(taskDone.assignedAgent).toBe('agent-2');
      expect(taskDone.result).toBe('revised');
    });
  });

  // ── getTask for non-existent id ────────────────────────────────────

  describe('getTask', () => {
    it('returns undefined for non-existent id', () => {
      const tracker = new TaskTracker();
      expect(tracker.getTask('nonexistent')).toBeUndefined();
    });
  });

  // ── fromJSON with done dependencies ────────────────────────────────

  describe('fromJSON with done dependencies', () => {
    it('recalculates statuses when deserialized deps are already done', () => {
      // Manually construct data where b is blocked but its dep a is done
      const data = {
        tasks: [
          makeTask({ id: 'a', status: 'done' }),
          { ...makeTask({ id: 'b', dependencies: ['a'] }), status: 'blocked' as const },
        ],
      };
      const restored = TaskTracker.fromJSON(data);
      expect(restored.getTask('a')!.status).toBe('done');
      expect(restored.getTask('b')!.status).toBe('ready'); // recalculated!
    });

    it('preserves round-trip with completed dependencies', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      // Complete a
      tracker.claimTasks(1);
      tracker.startTask('a', 'agent-1');
      tracker.submitForReview('a', null);
      tracker.completeTask('a');

      const json = tracker.toJSON();
      const restored = TaskTracker.fromJSON(json);
      expect(restored.getTask('a')!.status).toBe('done');
      expect(restored.getTask('b')!.status).toBe('ready');
    });
  });

  // ── addTask with explicit status:'done' unblocks dependents ────────

  describe("addTask with explicit status:'done' unblocks dependents", () => {
    it('unblocks existing tasks that depend on a newly added done task', () => {
      const tracker = new TaskTracker();
      // Add b depending on c before c exists
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['c'] }), status: undefined });
      expect(tracker.getTask('b')!.status).toBe('blocked');

      // Add c with explicit status: "done"
      tracker.addTask(makeTask({ id: 'c', status: 'done' }));
      // recalculateStatuses() in addTask should unblock b
      expect(tracker.getTask('b')!.status).toBe('ready');
    });
  });

  // ── duplicate id in fromJSON ───────────────────────────────────────

  describe('duplicate id in fromJSON', () => {
    it('last entry wins when duplicate ids are present', () => {
      const data = {
        tasks: [makeTask({ id: 'a', status: 'ready' }), makeTask({ id: 'a', status: 'done' })],
      };
      const restored = TaskTracker.fromJSON(data);
      expect(restored.getAllTasks()).toHaveLength(1);
      expect(restored.getTask('a')!.status).toBe('done');
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

    it('returns true when all tasks are done', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      for (const id of ['a', 'b']) {
        tracker.claimTasks(1);
        tracker.startTask(id, 'agent');
        tracker.submitForReview(id, null);
        tracker.completeTask(id);
      }

      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns true when all tasks are failed', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      for (const id of ['a', 'b']) {
        tracker.claimTasks(1);
        tracker.startTask(id, 'agent');
        tracker.failTask(id);
      }

      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns true for a mix of done and failed tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      tracker.claimTasks(1);
      tracker.startTask('a', 'agent');
      tracker.submitForReview('a', null);
      tracker.completeTask('a');

      tracker.claimTasks(1);
      tracker.startTask('b', 'agent');
      tracker.failTask('b');

      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns false when a task is claimed', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      tracker.claimTasks(1);
      // One claimed, one still ready
      expect(tracker.isPoolDone()).toBe(false);
    });

    it('returns false when a task is implementing', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      tracker.claimTasks(1);
      tracker.startTask('a', 'agent');
      expect(tracker.isPoolDone()).toBe(false);
    });

    it('returns false when a task is reviewing', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      tracker.claimTasks(1);
      tracker.startTask('a', 'agent');
      tracker.submitForReview('a', 'result');
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

    it('returns true for a mix of done tasks and deadlocked tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['ghost'] }), status: undefined });

      tracker.claimTasks(1);
      tracker.startTask('a', 'agent');
      tracker.submitForReview('a', null);
      tracker.completeTask('a');

      expect(tracker.getTask('a')!.status).toBe('done');
      expect(tracker.getTask('b')!.status).toBe('blocked');
      expect(tracker.isPoolDone()).toBe(true);
    });

    it('returns false for a mix of done tasks and ready tasks', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      tracker.claimTasks(1);
      tracker.startTask('a', 'agent');
      tracker.submitForReview('a', null);
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
      tracker.claimTasks(1);
      tracker.startTask('shared', 'agent-1');
      tracker.submitForReview('shared', null);
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

      const claimed = tracker.claimTasks(0);
      expect(claimed).toEqual([]);
      // Tasks should still be ready
      expect(tracker.getTask('a')!.status).toBe('ready');
      expect(tracker.getTask('b')!.status).toBe('ready');
    });

    it('transitions from blocked → ready → claimed → implementing → reviewing → done', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'root' }));
      tracker.addTask({ ...makeTask({ id: 'child', dependencies: ['root'] }), status: undefined });

      // child starts blocked
      expect(tracker.getTask('child')!.status).toBe('blocked');

      // Complete root → child becomes ready
      tracker.claimTasks(1);
      tracker.startTask('root', 'agent-1');
      tracker.submitForReview('root', null);
      tracker.completeTask('root');
      expect(tracker.getTask('child')!.status).toBe('ready');

      // Claim → claimed
      tracker.claimTasks(1);
      expect(tracker.getTask('child')!.status).toBe('claimed');

      // Start → implementing
      tracker.startTask('child', 'agent-2');
      expect(tracker.getTask('child')!.status).toBe('implementing');

      // Submit → reviewing
      tracker.submitForReview('child', 'final result');
      expect(tracker.getTask('child')!.status).toBe('reviewing');

      // Complete → done
      tracker.completeTask('child');
      expect(tracker.getTask('child')!.status).toBe('done');
    });
  });

  // ── addTask auto-status with failed deps ───────────────────────────

  describe('addTask auto-status with failed deps', () => {
    it('sets ready when all dependencies have failed (not blocked)', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));

      // Fail task a: claim → start → failTask
      tracker.claimTasks(1);
      tracker.startTask('a', 'agent-1');
      tracker.failTask('a', 'could not complete');

      expect(tracker.getTask('a')!.status).toBe('failed');

      // Add b depending on a with auto-status (status: undefined)
      // addTask should treat 'failed' deps as settled, same as recalculateStatuses does
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });

      expect(tracker.getTask('b')!.status).toBe('ready');
    });

    it('sets ready when one dep is done and another is failed', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      // Complete a
      tracker.claimTasks(1);
      tracker.startTask('a', 'agent-1');
      tracker.submitForReview('a', null);
      tracker.completeTask('a');
      expect(tracker.getTask('a')!.status).toBe('done');

      // Fail b
      tracker.claimTasks(1);
      tracker.startTask('b', 'agent-2');
      tracker.failTask('b', 'error');
      expect(tracker.getTask('b')!.status).toBe('failed');

      // c depends on both a (done) and b (failed) — should be ready
      tracker.addTask({ ...makeTask({ id: 'c', dependencies: ['a', 'b'] }), status: undefined });
      expect(tracker.getTask('c')!.status).toBe('ready');
    });
  });

  // ── rejectTask resets dependent to ready ────────────────────────────

  describe('rejectTask resets dependent to ready', () => {
    it('reject moves child from reviewing back to ready', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'parent' }));
      tracker.addTask({ ...makeTask({ id: 'child', dependencies: ['parent'] }), status: undefined });

      // Complete parent → child becomes ready
      tracker.claimTasks(1);
      tracker.startTask('parent', 'agent-1');
      tracker.submitForReview('parent', null);
      tracker.completeTask('parent');
      expect(tracker.getTask('child')!.status).toBe('ready');

      // Claim, start, submit child for review
      tracker.claimTasks(1);
      tracker.startTask('child', 'agent-2');
      tracker.submitForReview('child', 'first attempt');
      expect(tracker.getTask('child')!.status).toBe('reviewing');

      // Reject child — should go back to ready
      tracker.rejectTask('child', 'redo');
      expect(tracker.getTask('child')!.status).toBe('ready');
      expect(tracker.getTask('child')!.reviewFeedback).toEqual(['redo']);
    });
  });

  // ── rejectTask edge case: downstream stays blocked ─────────────────

  describe('rejectTask edge case: downstream stays blocked', () => {
    it('c remains blocked after b is rejected (b is ready, not done)', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask({ ...makeTask({ id: 'b', dependencies: ['a'] }), status: undefined });
      tracker.addTask({ ...makeTask({ id: 'c', dependencies: ['b'] }), status: undefined });

      // Initially: a=ready, b=blocked, c=blocked
      expect(tracker.getTask('a')!.status).toBe('ready');
      expect(tracker.getTask('b')!.status).toBe('blocked');
      expect(tracker.getTask('c')!.status).toBe('blocked');

      // Complete a → b becomes ready, c stays blocked
      tracker.claimTasks(1);
      tracker.startTask('a', 'agent-1');
      tracker.submitForReview('a', null);
      tracker.completeTask('a');
      expect(tracker.getTask('b')!.status).toBe('ready');
      expect(tracker.getTask('c')!.status).toBe('blocked');

      // Claim/start/submit b, then reject it
      tracker.claimTasks(1);
      tracker.startTask('b', 'agent-2');
      tracker.submitForReview('b', 'attempt');
      tracker.rejectTask('b', 'try again');

      // b is now ready (not done), so c should remain blocked
      expect(tracker.getTask('b')!.status).toBe('ready');
      expect(tracker.getTask('c')!.status).toBe('blocked');
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
        (tracker as unknown as { once: (event: string, cb: (...args: unknown[]) => void) => void }).once(
          'taskReady',
          resolve,
        );
      });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('taskReady event not emitted within 1000ms')), 1000),
      );

      // Complete task a via full lifecycle
      tracker.claimTasks(1);
      tracker.startTask('a', 'agent-1');
      tracker.submitForReview('a', 'done');
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
      (tracker as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void }).on('taskReady', () => {
        emitCount++;
      });

      // Set up event-driven wait BEFORE the action
      const readyEvent = new Promise<void>((resolve) => {
        (tracker as unknown as { once: (event: string, cb: (...args: unknown[]) => void) => void }).once(
          'taskReady',
          () => resolve(),
        );
      });

      // Complete task a
      tracker.claimTasks(1);
      tracker.startTask('a', 'agent-1');
      tracker.submitForReview('a', 'done');
      tracker.completeTask('a');

      // Event is emitted synchronously, so this resolves immediately
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
      (tracker as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void }).on('taskReady', () => {
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
        (restored as unknown as { once: (event: string, cb: (...args: unknown[]) => void) => void }).once(
          'taskReady',
          resolve,
        );
      });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('taskReady event not emitted within 1000ms')), 1000),
      );

      // Complete task a on the restored tracker
      restored.claimTasks(1);
      restored.startTask('a', 'agent-1');
      restored.submitForReview('a', 'done');
      restored.completeTask('a');

      await Promise.race([eventPromise, timeout]);

      expect(restored.getTask('b')!.status).toBe('ready');
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
});
