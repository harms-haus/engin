import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { Task } from '../../src/core/types.js';
import type { LanePoolOptions, LanePoolResult, StepDefinition, StepResult } from '../../src/pool/types.js';
import { TaskTracker } from '../../src/tracking/task-status.js';

// ─── StepDefinition ─────────────────────────────────────────────────────────

describe('StepDefinition', () => {
  it('serializes and round-trips with required fields only', () => {
    const step: StepDefinition = {
      name: 'implement',
      profileId: 'coder',
      isReadOnly: false,
    };

    const json = JSON.stringify(step);
    const parsed = JSON.parse(json) as StepDefinition;

    expect(parsed.name).toBe('implement');
    expect(parsed.profileId).toBe('coder');
    expect(parsed.isReadOnly).toBe(false);
    expect(parsed.schema).toBeUndefined();
    expect(parsed.isApproved).toBeUndefined();
    expect(parsed.getFeedback).toBeUndefined();
  });

  it('serializes and round-trips with optional schema-driven fields', () => {
    const reviewSchema = z.object({
      approved: z.boolean(),
      feedback: z.string().optional(),
    });

    const step: StepDefinition<z.infer<typeof reviewSchema>> = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
      schema: reviewSchema,
      isApproved: (result) => result.approved === true,
      getFeedback: (result) => result.feedback ?? 'No feedback provided',
    };

    const json = JSON.stringify({
      name: step.name,
      profileId: step.profileId,
      isReadOnly: step.isReadOnly,
    });
    const parsed = JSON.parse(json) as StepDefinition;

    expect(parsed.name).toBe('review');
    expect(parsed.profileId).toBe('reviewer');
    expect(parsed.isReadOnly).toBe(true);
  });

  it('isApproved function correctly evaluates approval', () => {
    const schema = z.object({ approved: z.boolean(), feedback: z.string().optional() });

    const step: StepDefinition<z.infer<typeof schema>> = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
      schema,
      isApproved: (result) => result.approved === true,
    };

    expect(step.isApproved!({ approved: true, feedback: undefined })).toBe(true);
    expect(step.isApproved!({ approved: false, feedback: 'bad' })).toBe(false);
  });

  it('getFeedback function extracts feedback with fallback', () => {
    const schema = z.object({ approved: z.boolean(), feedback: z.string().optional() });

    const step: StepDefinition<z.infer<typeof schema>> = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
      schema,
      getFeedback: (result) => result.feedback ?? 'No feedback provided',
    };

    expect(step.getFeedback!({ approved: false, feedback: 'Missing tests' })).toBe('Missing tests');
    expect(step.getFeedback!({ approved: false, feedback: undefined })).toBe('No feedback provided');
  });

  it('isReadOnly distinguishes read-only from writable steps', () => {
    const readOnly: StepDefinition = { name: 'review', profileId: 'reviewer', isReadOnly: true };
    const writable: StepDefinition = { name: 'implement', profileId: 'coder', isReadOnly: false };

    expect(readOnly.isReadOnly).toBe(true);
    expect(writable.isReadOnly).toBe(false);
    expect(readOnly.isReadOnly).not.toBe(writable.isReadOnly);
  });
});

// ─── StepResult ─────────────────────────────────────────────────────────────

describe('StepResult', () => {
  it('approved variant narrows correctly in if-statement', () => {
    const result: StepResult = {
      type: 'approved',
      output: { filesChanged: 3 },
    };

    if (result.type === 'approved') {
      expect(result.output).toEqual({ filesChanged: 3 });
    } else {
      expect.unreachable('Should have narrowed to approved');
    }
  });

  it('rejected variant narrows correctly in if-statement', () => {
    const result: StepResult = {
      type: 'rejected',
      feedback: 'Missing test coverage',
    };

    if (result.type === 'rejected') {
      expect(result.feedback).toBe('Missing test coverage');
    } else {
      expect.unreachable('Should have narrowed to rejected');
    }
  });

  it('approved and rejected are distinguishable by type', () => {
    const results: StepResult[] = [
      { type: 'approved', output: null },
      { type: 'rejected', feedback: 'error' },
      { type: 'approved', output: { score: 95 } },
    ];

    const approved = results.filter((r) => r.type === 'approved');
    const rejected = results.filter((r) => r.type === 'rejected');

    expect(approved).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });

  it('output can hold arbitrary structured data', () => {
    const result: StepResult = {
      type: 'approved',
      output: { nested: { deep: [1, 2, 3] } },
    };

    if (result.type === 'approved') {
      expect((result.output as { nested: { deep: number[] } }).nested.deep).toEqual([1, 2, 3]);
    }
  });

  it('rejected variant with output field carries structured review data', () => {
    const result: StepResult = {
      type: 'rejected',
      feedback: 'test',
      output: { approved: false, severity: 'high' },
    };

    if (result.type === 'rejected') {
      expect(result.feedback).toBe('test');
      expect(result.output).toEqual({ approved: false, severity: 'high' });
      const severity = (result.output as { severity: string }).severity;
      expect(severity).toBe('high');
    } else {
      expect.unreachable('Should have narrowed to rejected');
    }
  });

  it('rejected variant without output still works (backward compat)', () => {
    const result: StepResult = {
      type: 'rejected',
      feedback: 'test',
    };

    if (result.type === 'rejected') {
      expect(result.feedback).toBe('test');
      expect(result.output).toBeUndefined();
    } else {
      expect.unreachable('Should have narrowed to rejected');
    }
  });
});

// ─── LanePoolResult ─────────────────────────────────────────────────────────

describe('LanePoolResult', () => {
  it('calculates total tasks from completed and failed counts', () => {
    const result: LanePoolResult = { completedTasks: 7, failedTasks: 2 };

    const total = result.completedTasks + result.failedTasks;
    expect(total).toBe(9);
  });

  it('handles all-success scenario', () => {
    const result: LanePoolResult = { completedTasks: 10, failedTasks: 0 };

    expect(result.completedTasks).toBe(10);
    expect(result.failedTasks).toBe(0);
    expect(result.completedTasks + result.failedTasks).toBe(10);
  });

  it('handles all-failure scenario', () => {
    const result: LanePoolResult = { completedTasks: 0, failedTasks: 5 };

    expect(result.completedTasks).toBe(0);
    expect(result.failedTasks).toBe(5);
    expect(result.completedTasks + result.failedTasks).toBe(5);
  });

  it('serializes to JSON correctly', () => {
    const result: LanePoolResult = { completedTasks: 3, failedTasks: 1 };
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json) as LanePoolResult;

    expect(parsed.completedTasks).toBe(3);
    expect(parsed.failedTasks).toBe(1);
  });
});

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
    tracker.claimTasks(1);
    tracker.startTask('t1', 'agent-1');
    tracker.submitForReview('t1', { schema: 'created' });
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
    tracker.claimTasks(1);
    tracker.startTask('a', 'agent-x');
    tracker.submitForReview('a', { report: 'done' });
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

// ─── LanePoolOptions compilation ────────────────────────────────────────────

describe('LanePoolOptions', () => {
  it('compiles with required and optional fields', () => {
    const tracker = new TaskTracker();

    const options: LanePoolOptions = {
      maxConcurrentLanes: 4,
      profilesDirs: ['./profiles', '~/.config/engin/profiles'],
      sessionBaseDir: '/tmp/sessions',
      cwd: '/home/user/project',
      taskTracker: tracker,
      getStepsForTask: (_task: Task) => [
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        { name: 'review', profileId: 'reviewer', isReadOnly: true },
      ],
    };

    expect(options.maxConcurrentLanes).toBe(4);
    expect(options.profilesDirs).toHaveLength(2);
    expect(options.apiKeys).toBeUndefined();
    expect(options.onStatus).toBeUndefined();
    expect(options.auditLog).toBeUndefined();
    expect(options.maxStepRetries).toBeUndefined();
    expect(options.taskTracker).toBe(tracker);
  });
});

// ─── TaskTracker failed status and reset ────────────────────────────────────

describe('TaskTracker failed status and reset', () => {
  it('failTask transitions implementing → failed', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: 'Do it', profile: 'coder', files: [], dependencies: [] });
    tracker.claimTasks(1);
    tracker.startTask('t1', 'agent-1');

    tracker.failTask('t1', { error: 'timeout' });

    const task = tracker.getTask('t1')!;
    expect(task.status).toBe('failed');
    expect(task.result).toEqual({ error: 'timeout' });
  });

  it('failTask transitions reviewing → failed', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: 'Do it', profile: 'coder', files: [], dependencies: [] });
    tracker.claimTasks(1);
    tracker.startTask('t1', 'agent-1');
    tracker.submitForReview('t1', { output: 'done' });

    tracker.failTask('t1', 'review error');

    const task = tracker.getTask('t1')!;
    expect(task.status).toBe('failed');
    expect(task.result).toBe('review error');
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
    tracker.claimTasks(1);
    tracker.startTask('t1', 'agent-1');
    tracker.failTask('t1', 'oops');

    expect(tracker.getTask('t1')!.status).toBe('failed');

    tracker.resetFailedTasks();

    const task = tracker.getTask('t1')!;
    expect(task.status).toBe('ready');
    expect(task.assignedAgent).toBeUndefined();
    expect(task.result).toBeUndefined();
  });

  it('resetFailedTasks does not touch done tasks', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: 'Do it', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 't2', title: 'T2', prompt: 'Do it too', profile: 'coder', files: [], dependencies: [] });

    // Complete t1
    tracker.claimTasks(1);
    tracker.startTask('t1', 'agent-1');
    tracker.submitForReview('t1', { ok: true });
    tracker.completeTask('t1');

    // Fail t2
    const t2Claimed = tracker.claimTasks(1);
    expect(t2Claimed).toHaveLength(1);
    tracker.startTask('t2', 'agent-2');
    tracker.failTask('t2', 'error');

    tracker.resetFailedTasks();

    expect(tracker.getTask('t1')!.status).toBe('done');
    expect(tracker.getTask('t2')!.status).toBe('ready');
  });

  it('resetStuckTasks resets claimed tasks', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: 'Do it', profile: 'coder', files: [], dependencies: [] });
    tracker.claimTasks(1);

    expect(tracker.getTask('t1')!.status).toBe('claimed');

    tracker.resetStuckTasks();

    expect(tracker.getTask('t1')!.status).toBe('ready');
    expect(tracker.getTask('t1')!.assignedAgent).toBeUndefined();
  });

  it('resetStuckTasks resets implementing tasks', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: 'Do it', profile: 'coder', files: [], dependencies: [] });
    tracker.claimTasks(1);
    tracker.startTask('t1', 'agent-1');

    expect(tracker.getTask('t1')!.status).toBe('implementing');

    tracker.resetStuckTasks();

    expect(tracker.getTask('t1')!.status).toBe('ready');
    expect(tracker.getTask('t1')!.assignedAgent).toBeUndefined();
  });

  it('resetStuckTasks does not touch ready/done/failed tasks', () => {
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
    tracker.claimTasks(1);
    tracker.startTask('done1', 'agent-1');
    tracker.submitForReview('done1', null);
    tracker.completeTask('done1');

    // Claim and fail failed1
    const claimed = tracker.claimTasks(1);
    const failedTask = claimed.find((t) => t.id === 'failed1');
    if (failedTask) {
      tracker.startTask('failed1', 'agent-2');
      tracker.failTask('failed1', 'err');
    }

    const statusesBefore = {
      ready1: tracker.getTask('ready1')!.status,
      done1: tracker.getTask('done1')!.status,
      failed1: tracker.getTask('failed1')!.status,
      blocked1: tracker.getTask('blocked1')!.status,
    };

    tracker.resetStuckTasks();

    // Only claimed/implementing would change — none of these are in those states
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
    tracker.claimTasks(1);
    tracker.startTask('done1', 'agent-1');
    tracker.submitForReview('done1', null);
    tracker.completeTask('done1');

    // Claim both remaining tasks (alphabetical: fail1, impl1)
    tracker.claimTasks(2);

    // Start impl1 (stuck at implementing)
    tracker.startTask('impl1', 'agent-2');

    // Start fail1, then fail it
    tracker.startTask('fail1', 'agent-3');
    tracker.failTask('fail1', 'crashed');

    // Serialize and deserialize
    const json = tracker.toJSON();
    const restored = TaskTracker.fromJSON(json);

    expect(restored.getTask('done1')!.status).toBe('done');
    expect(restored.getTask('impl1')!.status).toBe('ready');
    expect(restored.getTask('impl1')!.assignedAgent).toBeUndefined();
    expect(restored.getTask('fail1')!.status).toBe('ready');
    expect(restored.getTask('fail1')!.assignedAgent).toBeUndefined();
    expect(restored.getTask('fail1')!.result).toBeUndefined();
  });

  it('areAllSettled returns true when all are done or failed', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 't2', title: 'T2', prompt: '...', profile: 'coder', files: [], dependencies: [] });

    // Complete t1
    tracker.claimTasks(1);
    tracker.startTask('t1', 'agent-1');
    tracker.submitForReview('t1', null);
    tracker.completeTask('t1');

    // Fail t2
    const claimed = tracker.claimTasks(1);
    const failTask = claimed.find((t) => t.id === 't2');
    if (failTask) {
      tracker.startTask('t2', 'agent-2');
      tracker.failTask('t2', 'oops');
    }

    expect(tracker.areAllSettled()).toBe(true);
  });

  it('areAllDoneOrBlocked handles failed as terminal', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 't1', title: 'T1', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 't2', title: 'T2', prompt: '...', profile: 'coder', files: [], dependencies: [] });

    // Complete t1
    tracker.claimTasks(1);
    tracker.startTask('t1', 'agent-1');
    tracker.submitForReview('t1', null);
    tracker.completeTask('t1');

    // Fail t2
    const claimed = tracker.claimTasks(1);
    const failTask = claimed.find((t) => t.id === 't2');
    if (failTask) {
      tracker.startTask('t2', 'agent-2');
      tracker.failTask('t2', 'oops');
    }

    expect(tracker.areAllDoneOrBlocked()).toBe(true);
  });

  it('recalculateStatuses unblocks when deps are failed', () => {
    const tracker = new TaskTracker();
    tracker.addTask({ id: 'a', title: 'A', prompt: '...', profile: 'coder', files: [], dependencies: [] });
    tracker.addTask({ id: 'b', title: 'B', prompt: '...', profile: 'coder', files: [], dependencies: ['a'] });

    // b should be blocked
    expect(tracker.getTask('b')!.status).toBe('blocked');

    // Claim and fail a
    tracker.claimTasks(1);
    tracker.startTask('a', 'agent-1');
    tracker.failTask('a', 'failed but ok for deps');

    // After failTask, recalculateStatuses should unblock b
    expect(tracker.getTask('b')!.status).toBe('ready');
  });
});
