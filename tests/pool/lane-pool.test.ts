import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { z } from 'zod';
import type { Task } from '../../src/core/types.js';
import { TaskTracker } from '../../src/tracking/task-status.js';
import { makeMockSession } from '../helpers/make-session.js';
import { makeTask } from '../helpers/make-task.js';

// Capture real modules before mocking so we can restore them in afterAll.
const realHarnessFactory = Object.assign({}, await import('../../src/core/harness-factory.ts'));
const realProfile = Object.assign({}, await import('../../src/core/profile.ts'));
const realStructuredOutput = Object.assign({}, await import('../../src/core/structured-output.ts'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/harness-factory.ts', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/profile.ts', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/structured-output.ts', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { LanePool } from '../../src/pool/lane-pool.ts';
import type { StepDefinition } from '../../src/pool/types.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

const defaultProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a coding agent.',
  excludeTools: [] as string[],
  includeTools: [] as string[],
};

const reviewerProfile = {
  ...defaultProfile,
  id: 'reviewer',
  name: 'Reviewer',
};

function makeSession(textFn: (promptText: string) => string | undefined) {
  return makeMockSession(textFn).session;
}

function setupProfileMocks() {
  const profilesMap = new Map<string, typeof defaultProfile>();
  profilesMap.set('coder', defaultProfile);
  profilesMap.set('reviewer', reviewerProfile);
  mockLoadProfilesFromDirs.mockResolvedValue(profilesMap);
}

function setupHarnessMocks(session?: ReturnType<typeof makeSession>) {
  const sess = session ?? makeSession(() => 'done');
  mockCreateHarness.mockResolvedValue({
    session: sess,
    sessionId: 'test-session',
    dispose: mock(() => {}),
  });
  return sess;
}

function createMockAuditLog() {
  const events: unknown[] = [];
  return {
    append: mock(async (event: unknown) => {
      events.push(event);
    }),
    events,
  };
}

function createMockTaskTracker(overrides: Record<string, unknown> = {}) {
  return {
    claimTasks: mock(() => []),
    startTask: mock(() => {}),
    submitForReview: mock(() => {}),
    completeTask: mock(() => {}),
    isPoolDone: mock(() => true),
    getAllTasks: mock(() => []),
    getReadyTasks: mock(() => []),
    addTask: mock(() => {}),
    getTask: mock(() => undefined),
    ...overrides,
  } as unknown as TaskTracker;
}

interface PoolOptionsOverrides {
  maxConcurrentLanes?: number;
  maxStepRetries?: number;
  onStatus?: Record<string, ReturnType<typeof mock>>;
  getStepsForTask?: (task: Task) => StepDefinition[];
  tasks?: Task[];
}

function createPoolAndTracker(overrides?: PoolOptionsOverrides) {
  const tracker = new TaskTracker();

  const tasks = overrides?.tasks ?? [makeTask()];
  for (const task of tasks) {
    tracker.addTask(task);
  }

  const getStepsForTask =
    overrides?.getStepsForTask ??
    ((_task: Task): StepDefinition[] => [{ name: 'implement', profileId: 'coder', isReadOnly: false }]);

  const pool = new LanePool({
    maxConcurrentLanes: overrides?.maxConcurrentLanes ?? 1,
    profilesDirs: ['/mock/profiles'],
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    taskTracker: tracker,
    getStepsForTask,
    maxStepRetries: overrides?.maxStepRetries,
    onStatus: overrides?.onStatus as unknown as undefined,
    auditLog: overrides?.auditLog as unknown as undefined,
  });

  return { pool, tracker };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreateHarness.mockClear();
  mockLoadProfilesFromDirs.mockClear();
  mockPromptForStructured.mockClear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('LanePool', () => {
  // ─── Basic Functionality ────────────────────────────────────────────────

  describe('basic single-task processing', () => {
    it('processes a single task with one step through to completion', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const { pool, tracker } = createPoolAndTracker();

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);
      expect(tracker.isPoolDone()).toBe(true);
    });

    it('calls createHarness with the correct profile and options', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const { pool } = createPoolAndTracker();

      await pool.run();

      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      const callArgs = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.cwd).toBe('/tmp/project');
      expect(callArgs.profile).toMatchObject({ id: 'coder' });
      expect(callArgs.agentId).toBe('lane-0');
    });

    it('creates a session directory with task id and step info', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const { pool } = createPoolAndTracker();

      await pool.run();

      const callArgs = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.sessionDir).toContain('task-1');
      expect(callArgs.sessionDir).toContain('0-implement');
    });
  });

  // ─── Multi-Step Processing ──────────────────────────────────────────────

  describe('multi-step processing', () => {
    it('executes multiple steps in sequence for a task', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);
      expect(mockCreateHarness).toHaveBeenCalledTimes(2);
    });

    it('loads profiles once in run() instead of per step', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });

      await pool.run();

      // loadProfilesFromDirs is called once in run(), not per step
      expect(mockLoadProfilesFromDirs).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Read-Only Profile Adjustment ──────────────────────────────────────

  describe('read-only step profile adjustment', () => {
    it('adds write and edit to excludeTools for read-only steps', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [{ name: 'review', profileId: 'coder', isReadOnly: true }],
      });

      await pool.run();

      const callArgs = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      const profile = callArgs.profile as { excludeTools: string[] };
      expect(profile.excludeTools).toContain('write');
      expect(profile.excludeTools).toContain('edit');
    });

    it('does not modify excludeTools for non-read-only steps', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
      });

      await pool.run();

      const callArgs = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      const profile = callArgs.profile as { excludeTools: string[] };
      expect(profile.excludeTools).not.toContain('write');
      expect(profile.excludeTools).not.toContain('edit');
    });

    it('does not duplicate write/edit in excludeTools if already present', async () => {
      const profileWithExcludes = {
        ...defaultProfile,
        excludeTools: ['write'],
      };
      const profilesMap = new Map<string, typeof defaultProfile>();
      profilesMap.set('coder', profileWithExcludes);
      mockLoadProfilesFromDirs.mockResolvedValue(profilesMap);
      setupHarnessMocks();

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [{ name: 'review', profileId: 'coder', isReadOnly: true }],
      });

      await pool.run();

      const callArgs = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      const profile = callArgs.profile as { excludeTools: string[] };
      // 'write' should appear exactly once
      const writeCount = profile.excludeTools.filter((t: string) => t === 'write').length;
      expect(writeCount).toBe(1);
      expect(profile.excludeTools).toContain('edit');
    });
  });

  // ─── Structured Output Steps ────────────────────────────────────────────

  describe('structured output steps', () => {
    const reviewSchema = z.object({
      approved: z.boolean(),
      feedback: z.string().optional(),
    });

    it('uses promptForStructured for steps with a schema', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: true, feedback: undefined });

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: reviewSchema,
          },
        ],
      });

      await pool.run();

      expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    });

    it('approves when isApproved returns true', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: true, feedback: undefined });

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: reviewSchema,
            isApproved: (result: z.infer<typeof reviewSchema>) => result.approved === true,
          },
        ],
      });

      const result = await pool.run();
      expect(result.completedTasks).toBe(1);
    });

    it('rejects when isApproved returns false and provides feedback', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const reviewResult = { approved: false, feedback: 'Missing tests', severity: 'critical' };
      mockPromptForStructured.mockResolvedValue(reviewResult);

      let rejectReason: string | undefined;
      const { pool } = createPoolAndTracker({
        maxStepRetries: 1,
        onStatus: {
          onTaskRejected: mock((info: { reason: string }) => {
            rejectReason = info.reason;
          }),
        },
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: reviewSchema,
            isApproved: (result: z.infer<typeof reviewSchema>) => result.approved === true,
            getFeedback: (result: z.infer<typeof reviewSchema>) => result.feedback ?? 'No feedback provided',
          },
        ],
      });

      const result = await pool.run();

      // The task should have been rejected after maxStepRetries
      expect(rejectReason).toBe('Missing tests');
      expect(result.failedTasks).toBe(1);
    });

    it('uses default approval check (result.approved === true) when isApproved is not provided', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: true });

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean() }),
          },
        ],
      });

      const result = await pool.run();
      expect(result.completedTasks).toBe(1);
    });

    it('uses default feedback extraction when getFeedback is not provided', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'Custom feedback', severity: 'critical' });

      let rejectReason: string | undefined;
      const { pool } = createPoolAndTracker({
        maxStepRetries: 1,
        onStatus: {
          onTaskRejected: mock((info: { reason: string }) => {
            rejectReason = info.reason;
          }),
        },
        getStepsForTask: () => [
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
          },
        ],
      });

      await pool.run();
      expect(rejectReason).toBe('Custom feedback');
    });

    it('uses "No feedback provided" as default when feedback is absent', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: false, severity: 'critical' });

      let rejectReason: string | undefined;
      const { pool } = createPoolAndTracker({
        maxStepRetries: 1,
        onStatus: {
          onTaskRejected: mock((info: { reason: string }) => {
            rejectReason = info.reason;
          }),
        },
        getStepsForTask: () => [
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean() }),
          },
        ],
      });

      await pool.run();
      expect(rejectReason).toBe('No feedback provided');
    });
  });

  // ─── Multiple Tasks ─────────────────────────────────────────────────────

  describe('multiple tasks', () => {
    it('processes multiple tasks sequentially with a single lane', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const tasks = [
        makeTask({ id: 'task-1', title: 'First' }),
        makeTask({ id: 'task-2', title: 'Second' }),
        makeTask({ id: 'task-3', title: 'Third' }),
      ];

      const { pool } = createPoolAndTracker({ tasks });

      const result = await pool.run();

      expect(result.completedTasks).toBe(3);
      expect(result.failedTasks).toBe(0);
      expect(mockCreateHarness).toHaveBeenCalledTimes(3);
    });

    it('processes tasks concurrently with multiple lanes', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })];

      const { pool } = createPoolAndTracker({ tasks, maxConcurrentLanes: 2 });

      const result = await pool.run();

      expect(result.completedTasks).toBe(2);
      expect(result.failedTasks).toBe(0);

      // Each lane should pass its own agentId to the harness
      const agentIds = mockCreateHarness.mock.calls.map((call) => (call[0] as Record<string, unknown>).agentId);
      expect(agentIds).toContain('lane-0');
      expect(agentIds).toContain('lane-1');
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('handles missing profile gracefully', async () => {
      const emptyMap = new Map<string, typeof defaultProfile>();
      mockLoadProfilesFromDirs.mockResolvedValue(emptyMap);

      const { pool, tracker } = createPoolAndTracker();

      // The pool should not hang — it should mark the task as failed
      const result = await pool.run();

      expect(result.failedTasks).toBe(1);
      expect(result.completedTasks).toBe(0);
      // Task should be in 'failed' status
      const task = tracker.getTask('task-1');
      expect(task?.status).toBe('failed');
    });

    it('failed tasks have status failed not done', async () => {
      setupProfileMocks();

      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('Agent crashed');
        }),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const { pool, tracker } = createPoolAndTracker();

      const result = await pool.run();

      expect(result.completedTasks).toBe(0);
      expect(result.failedTasks).toBe(1);
      const task = tracker.getTask('task-1');
      expect(task?.status).toBe('failed');
    });

    it('failed tasks are not retried within same run', async () => {
      setupProfileMocks();

      const dispose = mock(() => {});
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('Always fails');
        }),
        sessionId: 'test-session',
        dispose,
      });

      const { pool } = createPoolAndTracker();

      const result = await pool.run();

      // Harness should only be created once — the failed task is not retried
      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(result.failedTasks).toBe(1);
    });

    it('fromJSON resets failed tasks for retry', async () => {
      setupProfileMocks();

      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('Crash');
        }),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const { pool, tracker } = createPoolAndTracker();

      await pool.run();

      // Task should be failed after the pool run
      expect(tracker.getTask('task-1')?.status).toBe('failed');

      // Serialize and deserialize
      const json = tracker.toJSON();
      const newTracker = TaskTracker.fromJSON(json);

      // fromJSON resets failed tasks to ready
      expect(newTracker.getTask('task-1')?.status).toBe('ready');
    });

    it('handles agent errors during step execution', async () => {
      setupProfileMocks();

      let callCount = 0;
      mockCreateHarness.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Agent creation failed');
        }
        return {
          session: makeSession(() => 'ok'),
          sessionId: 'test-session',
          dispose: mock(() => {}),
        };
      });

      const { pool } = createPoolAndTracker();

      const result = await pool.run();

      // Error in processTask triggers the catch in runLane
      expect(result.failedTasks).toBe(1);
    });

    it('handles error in session.prompt', async () => {
      setupProfileMocks();

      const session = makeSession(() => {
        throw new Error('Prompt failed');
      });
      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const { pool } = createPoolAndTracker();

      const result = await pool.run();
      expect(result.failedTasks).toBe(1);
    });
  });

  // ─── Status Callbacks ──────────────────────────────────────────────────

  describe('status callbacks', () => {
    it('fires onTaskStart and onTaskComplete for successful tasks', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onTaskStart = mock(() => {});
      const onTaskComplete = mock(() => {});

      const { pool } = createPoolAndTracker({
        onStatus: { onTaskStart, onTaskComplete },
      });

      await pool.run();

      expect(onTaskStart).toHaveBeenCalledTimes(1);
      expect(onTaskStart).toHaveBeenCalledWith({
        taskId: 'task-1',
        title: 'Test task',
        agentId: 'lane-0',
      });

      expect(onTaskComplete).toHaveBeenCalledTimes(1);
      expect(onTaskComplete).toHaveBeenCalledWith({
        taskId: 'task-1',
        title: 'Test task',
      });
    });

    it('fires onAgentSpawn and onAgentComplete for each step', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onAgentSpawn = mock(() => {});
      const onAgentComplete = mock(() => {});

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
        onStatus: { onAgentSpawn, onAgentComplete },
      });

      await pool.run();

      expect(onAgentSpawn).toHaveBeenCalledTimes(2);
      expect(onAgentComplete).toHaveBeenCalledTimes(2);

      expect(onAgentSpawn).toHaveBeenCalledWith({
        agentId: 'lane-0',
        profile: 'coder',
        phase: 'implementing',
        taskId: 'task-1',
      });
    });

    it('fires onTaskRejected when a review step rejects and max retries is hit', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'Bad code', severity: 'critical' });

      const onTaskRejected = mock(() => {});

      const { pool } = createPoolAndTracker({
        maxStepRetries: 1,
        onStatus: { onTaskRejected },
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
          },
        ],
      });

      await pool.run();

      expect(onTaskRejected).toHaveBeenCalledTimes(1);
      expect(onTaskRejected).toHaveBeenCalledWith({
        taskId: 'task-1',
        title: 'Test task',
        reason: 'Bad code',
      });
    });
  });

  // ─── Step Retry / Rejection Logic ──────────────────────────────────────

  describe('step retry and rejection', () => {
    it('retries up to maxStepRetries before marking task as failed', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      let structuredCallCount = 0;
      mockPromptForStructured.mockImplementation(() => {
        structuredCallCount++;
        return Promise.resolve({ approved: false, feedback: `Rejection ${structuredCallCount}`, severity: 'critical' });
      });

      const { pool } = createPoolAndTracker({
        maxStepRetries: 3,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean(), feedback: z.string() }),
          },
        ],
      });

      const result = await pool.run();

      // The review step should be called 3 times (maxStepRetries)
      expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
      expect(result.failedTasks).toBe(1);
    });

    it('succeeds when a retry step is approved after an initial rejection', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      let structuredCallCount = 0;
      mockPromptForStructured.mockImplementation(() => {
        structuredCallCount++;
        if (structuredCallCount <= 1) {
          return Promise.resolve({ approved: false, feedback: 'Try harder' });
        }
        return Promise.resolve({ approved: true, feedback: undefined });
      });

      const { pool } = createPoolAndTracker({
        maxStepRetries: 3,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
          },
        ],
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);
      // First call: rejected, second call: approved
      expect(mockPromptForStructured).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Prompt Building ───────────────────────────────────────────────────

  describe('prompt building', () => {
    it('includes task title, step name, and prompt in the agent prompt', async () => {
      setupProfileMocks();
      const session = setupHarnessMocks();

      const { pool } = createPoolAndTracker({
        tasks: [
          makeTask({
            id: 'task-1',
            title: 'Build feature',
            prompt: 'Create a login page',
            files: ['src/login.ts', 'src/auth.ts'],
          }),
        ],
      });

      await pool.run();

      const promptedText = session.prompt.mock.calls[0][0] as string;
      expect(promptedText).toContain('## Task: Build feature');
      expect(promptedText).toContain('## Step: implement');
      expect(promptedText).toContain('Create a login page');
      expect(promptedText).toContain('src/login.ts');
      expect(promptedText).toContain('src/auth.ts');
    });

    it('does not include relevant files section when files array is empty', async () => {
      setupProfileMocks();
      const session = setupHarnessMocks();

      const { pool } = createPoolAndTracker({
        tasks: [makeTask({ files: [] })],
      });

      await pool.run();

      const promptedText = session.prompt.mock.calls[0][0] as string;
      expect(promptedText).not.toContain('## Relevant Files');
    });

    it('includes review feedback in backed-up implement step prompt', async () => {
      setupProfileMocks();

      const implementPrompts: string[] = [];
      let harnessCallCount = 0;

      mockCreateHarness.mockImplementation(() => {
        harnessCallCount++;
        const isImplementStep = harnessCallCount % 2 === 1;
        const session = makeSession((text) => {
          if (isImplementStep) {
            implementPrompts.push(text);
          }
          return 'done';
        });
        return {
          session,
          sessionId: `session-${harnessCallCount}`,
          dispose: mock(() => {}),
        };
      });

      // Review rejects first time, then approves
      let reviewCallCount = 0;
      mockPromptForStructured.mockImplementation(() => {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          return Promise.resolve({ approved: false, feedback: 'Fix the null check', severity: 'medium' });
        }
        return Promise.resolve({ approved: true, feedback: undefined });
      });

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
          },
        ],
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);

      // Implement step called twice: initial + retry after review rejection
      expect(implementPrompts.length).toBe(2);

      // The retry prompt should include review feedback in the new format
      const retryPrompt = implementPrompts[1];
      expect(retryPrompt).toContain('Review Feedback History');
      expect(retryPrompt).toContain('Attempt 1:');
      expect(retryPrompt).toContain('Fix the null check');
    });

    it('accumulates feedback from multiple rejections in prompt', async () => {
      setupProfileMocks();

      const implementPrompts: string[] = [];
      let harnessCallCount = 0;

      mockCreateHarness.mockImplementation(() => {
        harnessCallCount++;
        const isImplementStep = harnessCallCount % 2 === 1;
        const session = makeSession((text) => {
          if (isImplementStep) {
            implementPrompts.push(text);
          }
          return 'done';
        });
        return {
          session,
          sessionId: `session-${harnessCallCount}`,
          dispose: mock(() => {}),
        };
      });

      // Review rejects twice, then approves on the third attempt
      let reviewCallCount = 0;
      mockPromptForStructured.mockImplementation(() => {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          return Promise.resolve({ approved: false, feedback: 'Missing error handling', severity: 'medium' });
        }
        if (reviewCallCount === 2) {
          return Promise.resolve({ approved: false, feedback: 'Needs input validation', severity: 'medium' });
        }
        return Promise.resolve({ approved: true, feedback: undefined });
      });

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
          },
        ],
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);

      // Implement step called three times: initial + 2 retries after rejections
      expect(implementPrompts.length).toBe(3);

      // The third implement prompt should contain accumulated feedback from both rejections
      const thirdPrompt = implementPrompts[2];
      expect(thirdPrompt).toContain('Review Feedback History');
      expect(thirdPrompt).toContain('Attempt 1: Missing error handling');
      expect(thirdPrompt).toContain('Attempt 2: Needs input validation');
    });
  });

  // ─── Harness Disposal ──────────────────────────────────────────────────

  describe('harness disposal', () => {
    it('always calls dispose even when an error occurs during prompting', async () => {
      setupProfileMocks();

      const dispose = mock(() => {});
      const session = makeSession(() => {
        throw new Error('prompt error');
      });

      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose,
      });

      const { pool } = createPoolAndTracker();

      // Should not hang — the error is caught in runLane
      const result = await pool.run();

      expect(dispose).toHaveBeenCalledTimes(1);
      expect(result.failedTasks).toBe(1);
    });
  });

  // ─── Lifecycle Callbacks ────────────────────────────────────────────────

  describe('lifecycle callbacks', () => {
    it('does NOT fire onWorkflowStart', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onWorkflowStart = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onWorkflowStart } });

      await pool.run();

      expect(onWorkflowStart).not.toHaveBeenCalled();
    });

    it('does NOT fire onPhaseStart', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onPhaseStart = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onPhaseStart } });

      await pool.run();

      expect(onPhaseStart).not.toHaveBeenCalled();
    });

    it('does NOT fire onPhaseComplete', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onPhaseComplete = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onPhaseComplete } });

      await pool.run();

      expect(onPhaseComplete).not.toHaveBeenCalled();
    });

    it('does NOT fire onWorkflowComplete', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onWorkflowComplete = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onWorkflowComplete } });

      await pool.run();

      expect(onWorkflowComplete).not.toHaveBeenCalled();
    });

    it('does NOT fire onWorkflowFailed even when a lane rejects', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      let claimCount = 0;
      const mockTracker = createMockTaskTracker({
        claimTasks: mock(() => {
          claimCount++;
          if (claimCount === 1) {
            return [
              {
                id: 'task-1',
                title: 'Test task',
                prompt: 'test',
                profile: 'coder',
                files: [],
                dependencies: [],
                status: 'claimed' as const,
              },
            ];
          }
          throw new Error('Simulated lane crash');
        }),
        isPoolDone: mock(() => false),
        getAllTasks: mock(() => [
          {
            id: 'task-1',
            title: 'Test task',
            prompt: 'test',
            profile: 'coder',
            files: [],
            dependencies: [],
            status: 'ready' as const,
          },
        ]),
      });

      const onWorkflowFailed = mock(() => {});
      const onError = mock(() => {});

      const pool = new LanePool({
        maxConcurrentLanes: 1,
        profilesDirs: ['/mock/profiles'],
        sessionBaseDir: '/tmp/sessions',
        cwd: '/tmp/project',
        taskTracker: mockTracker,
        getStepsForTask: () => [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
        onStatus: { onWorkflowFailed, onError },
      });

      await pool.run();

      expect(onWorkflowFailed).not.toHaveBeenCalled();
      // onError still fires for the rejected lane in settled
      expect(onError).toHaveBeenCalled();
    });

    it('does not fire onWorkflowFailed when all lanes succeed', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onWorkflowFailed = mock(() => {});
      const onWorkflowComplete = mock(() => {});
      const { pool } = createPoolAndTracker({
        onStatus: { onWorkflowFailed, onWorkflowComplete },
      });

      await pool.run();

      expect(onWorkflowFailed).not.toHaveBeenCalled();
      expect(onWorkflowComplete).not.toHaveBeenCalled();
    });

    it('fires task-level lifecycle callbacks in correct order', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const callOrder: string[] = [];
      const { pool } = createPoolAndTracker({
        onStatus: {
          onTaskStart: mock(() => callOrder.push('taskStart')),
          onTaskComplete: mock(() => callOrder.push('taskComplete')),
        },
      });

      await pool.run();

      expect(callOrder).toEqual(['taskStart', 'taskComplete']);
    });
  });

  // ─── Audit Log ────────────────────────────────────────────────────────

  describe('audit log', () => {
    it('appends agent_start and agent_end events for each step', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const auditLog = createMockAuditLog();

      const { pool } = createPoolAndTracker({
        auditLog: auditLog as unknown as undefined,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });

      await pool.run();

      // 2 agent_start + 2 agent_end = 4 events
      expect(auditLog.events).toHaveLength(4);
      expect(auditLog.events[0]).toMatchObject({ type: 'agent_start', agentId: 'coder', taskId: 'task-1' });
      expect(auditLog.events[1]).toMatchObject({ type: 'agent_end', agentId: 'coder', taskId: 'task-1' });
      expect(auditLog.events[2]).toMatchObject({ type: 'agent_start', agentId: 'reviewer', taskId: 'task-1' });
      expect(auditLog.events[3]).toMatchObject({ type: 'agent_end', agentId: 'reviewer', taskId: 'task-1' });
    });

    it('appends error audit event when runLane catches a step error', async () => {
      setupProfileMocks();

      mockCreateHarness.mockRejectedValueOnce(new Error('Harness creation failed'));
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => 'ok'),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const auditLog = createMockAuditLog();

      const { pool } = createPoolAndTracker({
        auditLog: auditLog as unknown as undefined,
      });

      await pool.run();

      // agent_start is appended before createHarness, then error in runLane's catch
      const errorEvents = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        type: 'error',
        agentId: 'lane-0',
        error: expect.stringContaining('Harness creation failed'),
        taskId: 'task-1',
      });
    });

    it('does not append audit events when no audit log is provided', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      // No auditLog in options — should not throw
      const { pool } = createPoolAndTracker();
      const result = await pool.run();

      expect(result.completedTasks).toBe(1);
    });

    it('agent_end event is appended even when step fails', async () => {
      setupProfileMocks();

      const auditLog = createMockAuditLog();

      // First harness creation succeeds, prompting throws
      const session = makeSession(() => {
        throw new Error('Prompt failed');
      });
      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const { pool } = createPoolAndTracker({
        auditLog: auditLog as unknown as undefined,
      });

      await pool.run();

      // agent_start is appended, then the prompt error is caught in runLane,
      // but agent_end is NOT appended because createHarness succeeded
      // and the error happens inside the try block before finally.
      // Actually — the try/finally in runStep means finally DOES run.
      const startEvents = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_start');
      const endEvents = auditLog.events.filter((e: Record<string, unknown>) => e.type === 'agent_end');
      expect(startEvents).toHaveLength(1);
      expect(endEvents).toHaveLength(1);
    });
  });

  // ─── Crash Handling ──────────────────────────────────────────────────────

  describe('crash handling', () => {
    it('one lane throws while others succeed — Promise.allSettled isolates failures', async () => {
      setupProfileMocks();

      let createCount = 0;
      mockCreateHarness.mockImplementation(() => {
        createCount++;
        if (createCount === 1) {
          // First lane (lane-0) will crash during processTask
          return {
            session: makeSession(() => {
              throw new Error('Lane crash');
            }),
            sessionId: 'crash-session',
            dispose: mock(() => {}),
          };
        }
        return {
          session: makeSession(() => 'done'),
          sessionId: 'ok-session',
          dispose: mock(() => {}),
        };
      });

      const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })];

      const { pool } = createPoolAndTracker({ tasks, maxConcurrentLanes: 2 });

      const result = await pool.run();

      // One task failed, one succeeded
      expect(result.failedTasks + result.completedTasks).toBe(2);
    });

    it('onAgentComplete still fires when dispose() throws', async () => {
      setupProfileMocks();

      const badDispose = mock(() => {
        throw new Error('dispose exploded');
      });
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => 'ok'),
        sessionId: 'test-session',
        dispose: badDispose,
      });

      const onAgentComplete = mock(() => {});
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      try {
        const { pool } = createPoolAndTracker({
          onStatus: { onAgentComplete },
        });

        await pool.run();

        // onAgentComplete must still fire even though dispose threw
        expect(onAgentComplete).toHaveBeenCalledTimes(1);
        expect(badDispose).toHaveBeenCalledTimes(1);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('maxStepRetries: 0 results in single attempt with no retry', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'Not good enough', severity: 'critical' });

      const { pool, tracker } = createPoolAndTracker({
        maxStepRetries: 0,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
          },
        ],
      });

      const result = await pool.run();

      // With maxStepRetries: 0, the review step runs once then fails
      expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
      expect(result.failedTasks).toBe(1);
      expect(result.completedTasks).toBe(0);
      const task = tracker.getTask('task-1');
      expect(task?.status).toBe('failed');
    });

    it('falls back to console.error when no onError callback is provided', async () => {
      setupProfileMocks();

      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('Unhandled failure');
        }),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      try {
        const { pool } = createPoolAndTracker({
          // No onStatus.onError → should fall back to console.error
          onStatus: {},
        });

        await pool.run();

        expect(consoleSpy).toHaveBeenCalled();
        const firstCall = consoleSpy.mock.calls[0].join(' ');
        expect(firstCall).toContain('[lane-0] Unhandled failure');
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  // ─── Empty Pool ────────────────────────────────────────────────────────

  describe('empty pool', () => {
    it('returns zero counts when there are no tasks', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const { pool } = createPoolAndTracker({ tasks: [] });

      const result = await pool.run();

      expect(result.completedTasks).toBe(0);
      expect(result.failedTasks).toBe(0);
    });
  });

  // ─── onTasksAdded Callback ──────────────────────────────────────────────

  describe('onTasksAdded callback', () => {
    it('fires onTasksAdded with all initial task statuses', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onTasksAdded = mock(() => {});

      const tasks = [
        makeTask({ id: 'task-1', title: 'First', dependencies: [] }),
        { ...makeTask({ id: 'task-2', title: 'Second', dependencies: ['task-1'] }), status: undefined as const },
      ];

      const { pool, tracker } = createPoolAndTracker({
        tasks,
        onStatus: { onTasksAdded },
      });

      // task-2 should start as blocked since task-1 is not done
      expect(tracker.getTask('task-2')!.status).toBe('blocked');

      await pool.run();

      expect(onTasksAdded).toHaveBeenCalledTimes(1);
      const callArg = onTasksAdded.mock.calls[0][0] as {
        tasks: { id: string; title: string; status: string; dependencies: string[] }[];
      };

      expect(callArg.tasks).toHaveLength(2);
      expect(callArg.tasks[0]).toEqual({
        id: 'task-1',
        title: 'First',
        status: 'ready',
        dependencies: [],
      });
      expect(callArg.tasks[1]).toEqual({
        id: 'task-2',
        title: 'Second',
        status: 'blocked',
        dependencies: ['task-1'],
      });
    });

    it('does not fire onTasksAdded when no tasks', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onTasksAdded = mock(() => {});

      const { pool } = createPoolAndTracker({
        tasks: [],
        onStatus: { onTasksAdded },
      });

      await pool.run();

      expect(onTasksAdded).not.toHaveBeenCalled();
    });
  });

  // ─── Event-Driven Waiting ──────────────────────────────────────────────

  describe('event-driven waiting', () => {
    it('processes dependent tasks via event-driven path without polling', async () => {
      setupProfileMocks();

      const promptCalls: string[] = [];
      const harnessCount = { value: 0 };

      mockCreateHarness.mockImplementation(() => {
        harnessCount.value++;
        const session = makeSession((text) => {
          promptCalls.push(text);
          return `result-${harnessCount.value}`;
        });
        return {
          session,
          sessionId: `session-${harnessCount.value}`,
          dispose: mock(() => {}),
        };
      });

      const task1 = makeTask({ id: 'task-1', title: 'First task', prompt: 'Do first' });
      const task2 = {
        ...makeTask({ id: 'task-2', title: 'Second task', prompt: 'Do second', dependencies: ['task-1'] }),
        status: undefined as const,
      };

      const { pool, tracker } = createPoolAndTracker({
        tasks: [task1, task2],
        maxConcurrentLanes: 1,
        getStepsForTask: () => [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
      });

      // task-2 should start as blocked since task-1 is not done
      expect(tracker.getTask('task-2')!.status).toBe('blocked');

      const result = await pool.run();

      // Both tasks should have been processed
      expect(result.completedTasks).toBe(2);
      expect(result.failedTasks).toBe(0);
      expect(harnessCount.value).toBe(2);

      // Both prompts should contain the correct task content
      expect(promptCalls.some((p) => p.includes('Do first'))).toBe(true);
      expect(promptCalls.some((p) => p.includes('Do second'))).toBe(true);

      // Both tasks should be done
      expect(tracker.getTask('task-1')!.status).toBe('done');
      expect(tracker.getTask('task-2')!.status).toBe('done');
    });

    it('does not call setTimeout for polling when events are available', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

      try {
        const tasks = [makeTask({ id: 'task-1' })];
        const { pool } = createPoolAndTracker({ tasks });

        await pool.run();

        // With a single task and no waiting needed, setTimeout should not
        // be called with the old polling backoff values (50, 75, etc.)
        const pollingCalls = setTimeoutSpy.mock.calls.filter((call) => {
          const delay = call[1];
          return typeof delay === 'number' && delay >= 50 && delay <= 2000;
        });
        expect(pollingCalls).toHaveLength(0);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });

  // ─── Severity-Based Retry Outcome ────────────────────────────────────────

  describe('severity-based retry outcome', () => {
    const severitySchema = z.object({
      approved: z.boolean(),
      feedback: z.string().optional(),
      severity: z.string().optional(),
    });

    function severitySteps() {
      return [
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: severitySchema,
          isApproved: (result: z.infer<typeof severitySchema>) => result.approved === true,
          getFeedback: (result: z.infer<typeof severitySchema>) => result.feedback ?? 'No feedback provided',
        },
      ];
    }

    it('marks task as failed when severity is critical after max retries', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'bad', severity: 'critical' });

      const { pool, tracker } = createPoolAndTracker({
        maxStepRetries: 2,
        getStepsForTask: () => severitySteps(),
      });

      const result = await pool.run();

      expect(result.failedTasks).toBe(1);
      expect(result.completedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    });

    it('marks task as completed when severity is medium after max retries', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'minor issues', severity: 'medium' });

      const { pool, tracker } = createPoolAndTracker({
        maxStepRetries: 2,
        getStepsForTask: () => severitySteps(),
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('done');
    });

    it('marks task as completed when severity is low after max retries', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'nitpick', severity: 'low' });

      const { pool, tracker } = createPoolAndTracker({
        maxStepRetries: 2,
        getStepsForTask: () => severitySteps(),
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('done');
    });

    it('marks task as failed when severity is high after max retries', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'major issue', severity: 'high' });

      const { pool, tracker } = createPoolAndTracker({
        maxStepRetries: 2,
        getStepsForTask: () => severitySteps(),
      });

      const result = await pool.run();

      expect(result.failedTasks).toBe(1);
      expect(result.completedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    });

    it('defaults to medium severity (completed) when no severity field', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'meh' });

      const { pool, tracker } = createPoolAndTracker({
        maxStepRetries: 2,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
          },
        ],
      });

      const result = await pool.run();

      // No severity field → defaults to medium → completed
      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('done');
    });

    it('default maxStepRetries is now 5', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      let structuredCallCount = 0;
      mockPromptForStructured.mockImplementation(() => {
        structuredCallCount++;
        if (structuredCallCount <= 4) {
          return Promise.resolve({ approved: false, feedback: `Rejection ${structuredCallCount}` });
        }
        return Promise.resolve({ approved: true, feedback: undefined });
      });

      const { pool, tracker } = createPoolAndTracker({
        // Do NOT specify maxStepRetries — should default to 5
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
          },
        ],
      });

      const result = await pool.run();

      // 4 rejections < 5 default max → task should complete on 5th attempt
      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);
      expect(mockPromptForStructured).toHaveBeenCalledTimes(5);
      expect(tracker.getTask('task-1')!.status).toBe('done');
    });
  });

  // ─── promptForStructured Exception Handling ──────────────────────────────

  describe('promptForStructured exception handling', () => {
    it('converts promptForStructured exception to step rejection and retries', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      // promptForStructured always throws
      mockPromptForStructured.mockRejectedValue(new Error('Structured output failed'));

      const { pool, tracker } = createPoolAndTracker({
        maxStepRetries: 3,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean() }),
          },
        ],
      });

      const result = await pool.run();

      // The exception should be converted to a rejection, engaging the retry
      // system. The review step should be attempted maxStepRetries times.
      expect(mockPromptForStructured).toHaveBeenCalledTimes(3);

      // Severity is 'critical' (fail-safe for infrastructure failures), so
      // the task is marked as failed after max retries are exhausted.
      expect(result.completedTasks).toBe(0);
      expect(result.failedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    });

    it('recovers when promptForStructured fails then succeeds', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      let structuredCallCount = 0;
      mockPromptForStructured.mockImplementation(() => {
        structuredCallCount++;
        if (structuredCallCount <= 2) {
          return Promise.reject(new Error('Temporary structured output failure'));
        }
        return Promise.resolve({ approved: true });
      });

      const { pool, tracker } = createPoolAndTracker({
        maxStepRetries: 5,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: z.object({ approved: z.boolean() }),
          },
        ],
      });

      const result = await pool.run();

      // Two failures then success on the third attempt
      expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('done');
    });
  });

  // ─── Session Reuse on Retry ─────────────────────────────────────────────

  describe('session reuse on retry', () => {
    const ReviewResultSchema = z.object({
      approved: z.boolean(),
      feedback: z.string(),
      issues: z.array(
        z.object({
          file: z.string(),
          description: z.string(),
          severity: z.enum(['critical', 'minor']),
        }),
      ),
    });

    function twoStepPipeline() {
      return [
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: ReviewResultSchema,
          isApproved: (result: z.infer<typeof ReviewResultSchema>) => result.approved === true,
          getFeedback: (result: z.infer<typeof ReviewResultSchema>) => result.feedback,
        },
      ];
    }

    it('resumes session via resumeSessionPath when retrying implement step after rejection', async () => {
      setupProfileMocks();

      // Review rejects once, then approves
      let reviewCount = 0;
      mockPromptForStructured.mockImplementation(() => {
        reviewCount++;
        if (reviewCount === 1) {
          return Promise.resolve({ approved: false, feedback: 'needs work', issues: [] });
        }
        return Promise.resolve({ approved: true, feedback: '', issues: [] });
      });

      setupHarnessMocks();

      const { pool } = createPoolAndTracker({
        maxStepRetries: 3,
        getStepsForTask: () => twoStepPipeline(),
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);

      // The implement step is executed twice (original + retry after rejection)
      // Find all createHarness calls for the implement step
      const implementCalls = mockCreateHarness.mock.calls.filter((call) => {
        const opts = call[0] as Record<string, unknown>;
        const path = (opts.sessionDir ?? opts.resumeSessionPath) as string;
        return path?.includes('implement');
      });

      expect(implementCalls.length).toBe(2);

      // First call: has sessionDir, no resumeSessionPath
      const firstCallOpts = implementCalls[0][0] as Record<string, unknown>;
      expect(firstCallOpts.sessionDir).toContain('implement');
      expect(firstCallOpts.resumeSessionPath).toBeFalsy();

      // Second call: no sessionDir, resumeSessionPath points to implement's original session dir
      const secondCallOpts = implementCalls[1][0] as Record<string, unknown>;
      expect(secondCallOpts.sessionDir).toBeUndefined();
      expect(secondCallOpts.resumeSessionPath).toBe(firstCallOpts.sessionDir);
    });

    it('creates new session for first execution, resumes on retry', async () => {
      setupProfileMocks();

      // Review rejects twice, then approves on the third attempt
      let reviewCount = 0;
      mockPromptForStructured.mockImplementation(() => {
        reviewCount++;
        if (reviewCount <= 2) {
          return Promise.resolve({ approved: false, feedback: 'not good', issues: [] });
        }
        return Promise.resolve({ approved: true, feedback: '', issues: [] });
      });

      setupHarnessMocks();

      const { pool } = createPoolAndTracker({
        maxStepRetries: 3,
        getStepsForTask: () => twoStepPipeline(),
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);

      // Capture all createHarness calls in order
      const allCalls = mockCreateHarness.mock.calls.map((call) => {
        const opts = call[0] as Record<string, unknown>;
        return {
          sessionDir: opts.sessionDir as string | undefined,
          resumeSessionPath: opts.resumeSessionPath as string | undefined,
        };
      });

      // Expected call pattern:
      // Call 0: implement (first) — sessionDir with '0-0-implement', resumeSessionPath undefined
      // Call 1: review (first)    — sessionDir with '0-1-review', resumeSessionPath undefined
      // Call 2: implement (retry) — no sessionDir, resumeSessionPath → call 0 sessionDir
      // Call 3: review (retry)    — no sessionDir, resumeSessionPath → call 1 sessionDir
      // Call 4: implement (retry) — no sessionDir, resumeSessionPath → call 2's sessionPath (= call 0 sessionDir)
      // Call 5: review (retry)    — no sessionDir, resumeSessionPath → call 3's sessionPath (= call 1 sessionDir)

      expect(allCalls.length).toBe(6);

      // Call 0: implement (first)
      expect(allCalls[0].sessionDir).toContain('0-0-implement');
      expect(allCalls[0].resumeSessionPath).toBeFalsy();

      // Call 1: review (first)
      expect(allCalls[1].sessionDir).toContain('0-1-review');
      expect(allCalls[1].resumeSessionPath).toBeFalsy();

      // Call 2: implement (retry) — no sessionDir, resumes from call 0
      expect(allCalls[2].sessionDir).toBeUndefined();
      expect(allCalls[2].resumeSessionPath).toBe(allCalls[0].sessionDir);

      // Call 3: review (retry) — no sessionDir, resumes from call 1
      expect(allCalls[3].sessionDir).toBeUndefined();
      expect(allCalls[3].resumeSessionPath).toBe(allCalls[1].sessionDir);

      // Call 4: implement (retry) — no sessionDir, resumes from call 2's sessionPath
      expect(allCalls[4].sessionDir).toBeUndefined();
      expect(allCalls[4].resumeSessionPath).toBe(allCalls[2].resumeSessionPath);

      // Call 5: review (retry) — no sessionDir, resumes from call 3's sessionPath
      expect(allCalls[5].sessionDir).toBeUndefined();
      expect(allCalls[5].resumeSessionPath).toBe(allCalls[3].resumeSessionPath);
    });

    it('disposes all sessions only when task completes', async () => {
      setupProfileMocks();

      const disposes: ReturnType<typeof mock>[] = [];
      let harnessCount = 0;

      mockCreateHarness.mockImplementation(() => {
        harnessCount++;
        const disposeFn = mock(() => {});
        disposes.push(disposeFn);
        return {
          session: makeSession(() => 'done'),
          sessionId: `session-${harnessCount}`,
          dispose: disposeFn,
        };
      });

      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);

      // After pool.run() completes, all sessions should have been disposed exactly once
      expect(disposes.length).toBe(2);
      for (const disposeFn of disposes) {
        expect(disposeFn).toHaveBeenCalledTimes(1);
      }
    });

    it('disposes all sessions when task fails', async () => {
      setupProfileMocks();

      const disposeFn = mock(() => {});

      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('Step threw an error');
        }),
        sessionId: 'test-session',
        dispose: disposeFn,
      });

      const { pool } = createPoolAndTracker();

      const result = await pool.run();

      expect(result.failedTasks).toBe(1);
      expect(disposeFn).toHaveBeenCalledTimes(1);
    });

    it('resumes both implement and review sessions when backing up after rejection', async () => {
      setupProfileMocks();

      // Review rejects once, then approves
      let reviewCount = 0;
      mockPromptForStructured.mockImplementation(() => {
        reviewCount++;
        if (reviewCount === 1) {
          return Promise.resolve({ approved: false, feedback: 'fix this', issues: [] });
        }
        return Promise.resolve({ approved: true, feedback: '', issues: [] });
      });

      setupHarnessMocks();

      const { pool } = createPoolAndTracker({
        maxStepRetries: 3,
        getStepsForTask: () => twoStepPipeline(),
      });

      const result = await pool.run();

      expect(result.completedTasks).toBe(1);

      // After one rejection and one retry: implement(0), review(0), implement(retry), review(retry)
      const allCalls = mockCreateHarness.mock.calls.map((call) => {
        const opts = call[0] as Record<string, unknown>;
        return {
          sessionDir: opts.sessionDir as string,
          resumeSessionPath: opts.resumeSessionPath as string | undefined,
        };
      });

      expect(allCalls.length).toBe(4);

      // Implement step (retry) uses resumeSessionPath pointing to original implement session dir
      expect(allCalls[2].resumeSessionPath).toBe(allCalls[0].sessionDir);

      // Review step (retry) uses resumeSessionPath pointing to original review session dir
      expect(allCalls[3].resumeSessionPath).toBe(allCalls[1].sessionDir);
    });

    it('does not pass resumeSessionPath on first execution of any step', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const { pool } = createPoolAndTracker();

      await pool.run();

      const callArgs = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.resumeSessionPath).toBeFalsy();
    });
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../src/core/harness-factory.ts', () => realHarnessFactory);
  mock.module('../../src/core/profile.ts', () => realProfile);
  mock.module('../../src/core/structured-output.ts', () => realStructuredOutput);
});
