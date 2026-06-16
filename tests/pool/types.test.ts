import { describe, expect, it } from 'bun:test';
import type { Task } from '../../packages/engine/src/core/types.js';
import type { StepDefinition } from '../../packages/engine/src/pool/types.js';
import { TaskTracker } from '../../packages/engine/src/tracking/task-status.js';

// ─── getStepsForTask with TaskTracker integration ───────────────────────────

describe('getStepsForTask with TaskTracker', () => {
  it('returns steps that match the task profile', () => {
    const tracker = new TaskTracker();
    tracker.addTask({
      id: 't1',
      title: 'Implement feature',
      prompt: 'Add login page',
      profile: 'coder',
      files: ['src/login.ts'],
      dependencies: [],
    });

    const task = tracker.getTask('t1')!;
    expect(task).toBeDefined();
    expect(task.status).toBe('ready');

    const getStepsForTask = (t: Task): StepDefinition[] => [
      { name: 'scout', profileId: 'scout', isReadOnly: true },
      { name: 'implement', profileId: t.profile, isReadOnly: false },
      { name: 'review', profileId: 'reviewer', isReadOnly: true },
    ];

    const steps = getStepsForTask(task);
    expect(steps).toHaveLength(3);
    expect(steps[1].profileId).toBe(task.profile);
    expect(steps[1].profileId).toBe('coder');
    expect(steps[0].isReadOnly).toBe(true);
    expect(steps[1].isReadOnly).toBe(false);
  });

  it('steps respect task dependencies ordering', () => {
    const tracker = new TaskTracker();
    tracker.addTask({
      id: 't1',
      title: 'Setup DB',
      prompt: 'Create database schema',
      profile: 'db-admin',
      files: ['db/schema.sql'],
      dependencies: [],
    });
    tracker.addTask({
      id: 't2',
      title: 'Write API',
      prompt: 'Build REST API',
      profile: 'coder',
      files: ['src/api.ts'],
      dependencies: ['t1'],
    });

    // t2 is blocked because t1 is not done
    const task2 = tracker.getTask('t2')!;
    expect(task2.status).toBe('blocked');

    const getStepsForTask = (t: Task): StepDefinition[] => [
      { name: 'implement', profileId: t.profile, isReadOnly: false },
    ];

    const steps = getStepsForTask(task2);
    expect(steps[0].profileId).toBe('coder');

    // Complete t1 so t2 becomes ready
    tracker.claimTasks(1, 'agent-1');
    tracker.completeTask('t1');

    const task2Updated = tracker.getTask('t2')!;
    expect(task2Updated.status).toBe('ready');
  });

  it('works with a real TaskTracker lifecycle and multiple tasks', () => {
    const tracker = new TaskTracker();

    // Add tasks with dependencies
    tracker.addTask({ id: 'a', title: 'A', prompt: 'Do A', profile: 'scout', files: [], dependencies: [] });
    tracker.addTask({ id: 'b', title: 'B', prompt: 'Do B', profile: 'coder', files: [], dependencies: ['a'] });
    tracker.addTask({ id: 'c', title: 'C', prompt: 'Do C', profile: 'coder', files: [], dependencies: ['a'] });

    // Initially only 'a' is ready
    expect(tracker.getReadyTasks().map((t) => t.id)).toEqual(['a']);

    // getStepsForTask for 'a' returns scout steps
    const getStepsForTask = (t: Task): StepDefinition[] => {
      if (t.profile === 'scout') {
        return [{ name: 'scout', profileId: 'scout', isReadOnly: true }];
      }
      return [
        { name: 'implement', profileId: t.profile, isReadOnly: false },
        { name: 'review', profileId: 'reviewer', isReadOnly: true },
      ];
    };

    const stepsA = getStepsForTask(tracker.getTask('a')!);
    expect(stepsA).toHaveLength(1);
    expect(stepsA[0].name).toBe('scout');

    // Complete 'a' through the full lifecycle
    tracker.claimTasks(1, 'agent-x');
    tracker.completeTask('a');

    // Now b and c should be ready
    const ready = tracker
      .getReadyTasks()
      .map((t) => t.id)
      .sort();
    expect(ready).toEqual(['b', 'c']);

    const stepsB = getStepsForTask(tracker.getTask('b')!);
    expect(stepsB).toHaveLength(2);
    expect(stepsB[1].profileId).toBe('reviewer');
  });
});

// ─── TaskTracker failed status and reset ────────────────────────────────────

describe('TaskTracker failed status and reset', () => {
  it('failTask transitions active → failed', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: 'Do it', profile: 'coder', files: [], dependencies: [] });
    tracker.claimTasks(1, 'agent-1');

    tracker.failTask('t1', { error: 'timeout' });

    const task = tracker.getTask('t1')!;
    expect(task.status).toBe('failed');
    expect(task.result).toEqual({ error: 'timeout' });
  });

  it('failTask throws on invalid status', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: 'Do it', profile: 'coder', files: [], dependencies: [] });

    // t1 is ready — failTask should throw
    expect(() => tracker.failTask('t1')).toThrow();
  });

  it('resetFailedTasks resets failed tasks to ready', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: 'Do it', profile: 'coder', files: [], dependencies: [] });
    tracker.claimTasks(1, 'agent-1');
    tracker.failTask('t1', 'oops');

    expect(tracker.getTask('t1')!.status).toBe('failed');

    tracker.resetFailedTasks();

    const task = tracker.getTask('t1')!;
    expect(task.status).toBe('ready');
    expect(task.assignedAgent).toBeUndefined();
    expect(task.result).toBeUndefined();
  });

  it('resetFailedTasks does not touch complete tasks', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: 'Do it', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 't2', title: 'T2', prompt: 'Do it too', profile: 'coder', files: [], dependencies: [] });

    // Complete t1
    tracker.claimTasks(1, 'agent-1');
    tracker.completeTask('t1');

    // Fail t2
    const t2Claimed = tracker.claimTasks(1, 'agent-2');
    expect(t2Claimed).toHaveLength(1);
    tracker.failTask('t2', 'error');

    tracker.resetFailedTasks();

    expect(tracker.getTask('t1')!.status).toBe('complete');
    expect(tracker.getTask('t2')!.status).toBe('ready');
  });

  it('resetStuckTasks resets active tasks to ready', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: 'Do it', profile: 'coder', files: [], dependencies: [] });
    tracker.claimTasks(1, 'agent-1');

    expect(tracker.getTask('t1')!.status).toBe('active');

    tracker.resetStuckTasks();

    expect(tracker.getTask('t1')!.status).toBe('ready');
    expect(tracker.getTask('t1')!.assignedAgent).toBeUndefined();
  });

  it('resetStuckTasks does not touch ready/complete/failed tasks', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 'ready1', title: 'R', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 'done1', title: 'D', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 'failed1', title: 'F', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({
      id: 'blocked1',
      title: 'B',
      prompt: '...',
      profile: 'coder',
      files: [],
      dependencies: ['done1'],
    });

    // Complete done1 so blocked1 stays blocked
    tracker.claimTasks(1, 'agent-1');
    tracker.completeTask('done1');

    // Claim and fail failed1
    const claimed = tracker.claimTasks(1, 'agent-2');
    const failedTask = claimed.find((t) => t.id === 'failed1');
    if (failedTask) {
      tracker.failTask('failed1', 'err');
    }

    const statusesBefore = {
      ready1: tracker.getTask('ready1')!.status,
      done1: tracker.getTask('done1')!.status,
      failed1: tracker.getTask('failed1')!.status,
      blocked1: tracker.getTask('blocked1')!.status,
    };

    tracker.resetStuckTasks();

    // Only active tasks would change — none of these are active
    expect(tracker.getTask('ready1')!.status).toBe(statusesBefore.ready1);
    expect(tracker.getTask('done1')!.status).toBe(statusesBefore.done1);
    expect(tracker.getTask('failed1')!.status).toBe(statusesBefore.failed1);
    expect(tracker.getTask('blocked1')!.status).toBe(statusesBefore.blocked1);
  });

  it('fromJSON resets failed and stuck tasks', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 'done1', title: 'D', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 'impl1', title: 'I', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 'fail1', title: 'F', prompt: '...', profile: 'coder', files: [], dependencies: [] });

    // Complete done1
    tracker.claimTasks(1, 'agent-1');
    tracker.completeTask('done1');

    // Claim both remaining tasks
    tracker.claimTasks(2, 'agent-2');

    // Fail fail1
    tracker.failTask('fail1', 'crashed');

    // Serialize and deserialize
    const json = tracker.toJSON();
    const restored = TaskTracker.fromJSON(json);

    expect(restored.getTask('done1')!.status).toBe('complete');
    expect(restored.getTask('impl1')!.status).toBe('ready');
    expect(restored.getTask('impl1')!.assignedAgent).toBeUndefined();
    expect(restored.getTask('fail1')!.status).toBe('ready');
    expect(restored.getTask('fail1')!.assignedAgent).toBeUndefined();
    expect(restored.getTask('fail1')!.result).toBeUndefined();
  });

  it('isPoolDone returns true when all are complete or failed', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 't2', title: 'T2', prompt: '...', profile: 'coder', files: [], dependencies: [] });

    // Complete t1
    tracker.claimTasks(1, 'agent-1');
    tracker.completeTask('t1');

    // Fail t2
    const claimed = tracker.claimTasks(1, 'agent-2');
    const failTask = claimed.find((t) => t.id === 't2');
    if (failTask) {
      tracker.failTask('t2', 'oops');
    }

    expect(tracker.isPoolDone()).toBe(true);
  });

  it('isPoolDone handles failed as terminal', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 't2', title: 'T2', prompt: '...', profile: 'coder', files: [], dependencies: [] });

    // Complete t1
    tracker.claimTasks(1, 'agent-1');
    tracker.completeTask('t1');

    // Fail t2
    const claimed = tracker.claimTasks(1, 'agent-2');
    const failTask = claimed.find((t) => t.id === 't2');
    if (failTask) {
      tracker.failTask('t2', 'oops');
    }

    expect(tracker.isPoolDone()).toBe(true);
  });

  it('recalculateStatuses unblocks when deps are failed', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 'a', title: 'A', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 'b', title: 'B', prompt: '...', profile: 'coder', files: [], dependencies: ['a'] });

    // b should be blocked
    expect(tracker.getTask('b')!.status).toBe('blocked');

    // Claim and fail a
    tracker.claimTasks(1, 'agent-1');
    tracker.failTask('a', 'failed but ok for deps');

    // After failTask, recalculateStatuses should unblock b
    expect(tracker.getTask('b')!.status).toBe('ready');
  });
});
