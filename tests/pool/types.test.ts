import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { Task } from '../../src/core/types.js';
import type { LanePoolOptions, LanePoolResult, StepDefinition, StepResult } from '../../src/pool/types.js';
import type { TaskTracker } from '../../src/tracking/task-status.js';

describe('Pool type definitions (compilation verification)', () => {
  it('StepDefinition compiles with required fields only', () => {
    const step: StepDefinition = {
      name: 'implement',
      profileId: 'coder',
      isReadOnly: false,
    };
    expect(step.name).toBe('implement');
    expect(step.isReadOnly).toBe(false);
    expect(step.schema).toBeUndefined();
    expect(step.isApproved).toBeUndefined();
    expect(step.getFeedback).toBeUndefined();
  });

  it('StepDefinition compiles with optional schema and review functions', () => {
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

    expect(step.name).toBe('review');
    expect(step.isReadOnly).toBe(true);
    expect(step.schema).toBe(reviewSchema);
    expect(step.isApproved!({ approved: true, feedback: undefined })).toBe(true);
    expect(step.getFeedback!({ approved: false, feedback: undefined })).toBe('No feedback provided');
  });

  it('StepResult approved variant compiles', () => {
    const result: StepResult = {
      type: 'approved',
      output: { filesChanged: 3 },
    };
    expect(result.type).toBe('approved');
    if (result.type === 'approved') {
      expect(result.output).toEqual({ filesChanged: 3 });
    }
  });

  it('StepResult rejected variant compiles', () => {
    const result: StepResult = {
      type: 'rejected',
      feedback: 'Missing test coverage',
    };
    expect(result.type).toBe('rejected');
    if (result.type === 'rejected') {
      expect(result.feedback).toBe('Missing test coverage');
    }
  });

  it('LanePoolResult compiles', () => {
    const result: LanePoolResult = {
      completedTasks: 5,
      failedTasks: 1,
    };
    expect(result.completedTasks).toBe(5);
    expect(result.failedTasks).toBe(1);
  });

  it('LanePoolOptions compiles with required and optional fields', () => {
    const mockTaskTracker = {
      addTask: () => {},
      getTask: () => undefined,
      getAllTasks: () => [],
      getReadyTasks: () => [],
      claimTasks: () => [],
      startTask: () => {},
      submitForReview: () => {},
      completeTask: () => {},
      rejectTask: () => {},
      recalculateStatuses: () => {},
      toJSON: () => ({ tasks: [] }),
      areAllDone: () => false,
    } as unknown as TaskTracker;

    const options: LanePoolOptions = {
      maxConcurrentLanes: 4,
      profilesDirs: ['./profiles', '~/.config/engin/profiles'],
      sessionBaseDir: '/tmp/sessions',
      cwd: '/home/user/project',
      taskTracker: mockTaskTracker,
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
  });

  it('StepDefinition getStepsForTask returns typed steps', () => {
    const getStepsForTask = (_task: Task): StepDefinition[] => [
      { name: 'scout', profileId: 'scout', isReadOnly: true },
      { name: 'implement', profileId: 'coder', isReadOnly: false },
      { name: 'review', profileId: 'reviewer', isReadOnly: true },
    ];

    const task: Task = {
      id: 't1',
      title: 'Test task',
      prompt: 'Do something',
      profile: 'coder',
      files: ['src/index.ts'],
      dependencies: [],
      status: 'ready',
    };

    const steps = getStepsForTask(task);
    expect(steps).toHaveLength(3);
    expect(steps[0].name).toBe('scout');
    expect(steps[1].isReadOnly).toBe(false);
    expect(steps[2].profileId).toBe('reviewer');
  });
});
