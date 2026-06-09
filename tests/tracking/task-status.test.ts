import { describe, expect, it } from 'bun:test';
import type { Task } from '../../src/core/types.js';
import { TaskTracker } from '../../src/tracking/task-status.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    prompt: `Prompt for ${overrides.id}`,
    profile: 'default',
    files: [],
    dependencies: [],
    status: 'ready',
    ...overrides,
  };
}

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
      expect(task.reviewFeedback).toBe('Needs more work');
    });

    it('throws if task is not in reviewing state', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 't1' }));

      tracker.claimTasks(1);
      expect(() => tracker.rejectTask('t1', 'reason')).toThrow('must be "reviewing"');
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

  // ── areAllDone ─────────────────────────────────────────────────────

  describe('areAllDone', () => {
    it('returns false when tasks are not all done', () => {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'a' }));
      tracker.addTask(makeTask({ id: 'b' }));

      expect(tracker.areAllDone()).toBe(false);
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

      expect(tracker.areAllDone()).toBe(true);
    });

    it('returns false when there are no tasks', () => {
      const tracker = new TaskTracker();
      expect(tracker.areAllDone()).toBe(false);
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
      expect(taskAfterReject.reviewFeedback).toBe('Needs revision');

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
});
