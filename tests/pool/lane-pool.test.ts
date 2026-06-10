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
    areAllDone: mock(() => true),
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
      expect(tracker.areAllDone()).toBe(true);
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

      const reviewResult = { approved: false, feedback: 'Missing tests' };
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

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'Custom feedback' });

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

      mockPromptForStructured.mockResolvedValue({ approved: false });

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
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('handles missing profile gracefully', async () => {
      const emptyMap = new Map<string, typeof defaultProfile>();
      mockLoadProfilesFromDirs.mockResolvedValue(emptyMap);

      const { pool, tracker } = createPoolAndTracker();

      // The pool should not hang — it should mark the task as done (failed)
      const result = await pool.run();

      expect(result.failedTasks).toBe(1);
      // Task should be done (marked as complete via safeSubmitAndComplete after error)
      const task = tracker.getTask('task-1');
      expect(task?.status).toBe('done');
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

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'Bad code' });

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
        return Promise.resolve({ approved: false, feedback: `Rejection ${structuredCallCount}` });
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
    it('fires onWorkflowStart at the beginning of run()', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onWorkflowStart = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onWorkflowStart } });

      await pool.run();

      expect(onWorkflowStart).toHaveBeenCalledTimes(1);
      expect(onWorkflowStart).toHaveBeenCalledWith({
        taskPrompt: '(pool execution)',
        resumed: false,
        workDir: '/tmp/sessions',
      });
    });

    it('fires onPhaseStart with implementing phase and round 1', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onPhaseStart = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onPhaseStart } });

      await pool.run();

      expect(onPhaseStart).toHaveBeenCalledTimes(1);
      expect(onPhaseStart).toHaveBeenCalledWith({ phase: 'implementing', round: 1 });
    });

    it('fires onPhaseComplete after all lanes finish', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onPhaseComplete = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onPhaseComplete } });

      await pool.run();

      expect(onPhaseComplete).toHaveBeenCalledTimes(1);
      expect(onPhaseComplete).toHaveBeenCalledWith({
        phase: 'implementing',
        durationMs: expect.any(Number),
      });
    });

    it('fires onWorkflowComplete on success with no rejected lanes', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const onWorkflowComplete = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onWorkflowComplete } });

      await pool.run();

      expect(onWorkflowComplete).toHaveBeenCalledTimes(1);
      expect(onWorkflowComplete).toHaveBeenCalledWith({
        totalDurationMs: expect.any(Number),
        agentCount: 1,
      });
    });

    it('fires onWorkflowFailed when a lane rejects', async () => {
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
        areAllDone: mock(() => false),
        getAllTasks: mock(() => []),
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

      expect(onWorkflowFailed).toHaveBeenCalledTimes(1);
      expect(onWorkflowFailed).toHaveBeenCalledWith({
        error: expect.any(Error),
        phase: 'implementing',
      });
      // onError also fires for the rejected lane in settled
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
      expect(onWorkflowComplete).toHaveBeenCalledTimes(1);
    });

    it('fires lifecycle callbacks in correct order', async () => {
      setupProfileMocks();
      setupHarnessMocks();

      const callOrder: string[] = [];
      const { pool } = createPoolAndTracker({
        onStatus: {
          onWorkflowStart: mock(() => callOrder.push('workflowStart')),
          onPhaseStart: mock(() => callOrder.push('phaseStart')),
          onTaskStart: mock(() => callOrder.push('taskStart')),
          onTaskComplete: mock(() => callOrder.push('taskComplete')),
          onPhaseComplete: mock(() => callOrder.push('phaseComplete')),
          onWorkflowComplete: mock(() => callOrder.push('workflowComplete')),
        },
      });

      await pool.run();

      expect(callOrder).toEqual([
        'workflowStart',
        'phaseStart',
        'taskStart',
        'taskComplete',
        'phaseComplete',
        'workflowComplete',
      ]);
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

      mockPromptForStructured.mockResolvedValue({ approved: false, feedback: 'Not good enough' });

      const { pool } = createPoolAndTracker({
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
        expect(firstCall).toContain('Task task-1 failed');
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
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../src/core/harness-factory.ts', () => realHarnessFactory);
  mock.module('../../src/core/profile.ts', () => realProfile);
  mock.module('../../src/core/structured-output.ts', () => realStructuredOutput);
});
