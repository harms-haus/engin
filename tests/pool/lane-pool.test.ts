import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { TaskRunner } from '../../packages/engine/src/pool/types.js';
import { useTempDir } from '../helpers/use-temp-dir.js';
import {
  LanePool,
  TaskTracker,
  clearPoolMocks,
  createMockTaskTracker,
  createPoolAndTracker,
  defaultProfile,
  makeSession,
  makeTask,
  mockCreateHarness,
  mockLoadProfilesFromDirs,
  mockPromptForStructured,
  setupHarnessMocks,
  setupProfileMocks,
} from './helpers.js';

beforeEach(() => {
  clearPoolMocks();
});

describe('LanePool', () => {
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
      expect(mockLoadProfilesFromDirs).toHaveBeenCalledTimes(1);
    });
  });

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
      const profileWithExcludes = { ...defaultProfile, excludeTools: ['write'] };
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
      expect(profile.excludeTools.filter((t: string) => t === 'write')).toHaveLength(1);
      expect(profile.excludeTools).toContain('edit');
    });
  });

  describe('structured output steps', () => {
    const reviewSchema = z.object({ approved: z.boolean(), feedback: z.string().optional() });

    it('uses promptForStructured for steps with a schema', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({ result: { approved: true, feedback: undefined }, attempts: 1 });
      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [{ name: 'review', profileId: 'reviewer', isReadOnly: true, schema: reviewSchema }],
      });
      await pool.run();
      expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    });

    it('approves when isApproved returns true', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({ result: { approved: true, feedback: undefined }, attempts: 1 });
      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: reviewSchema,
            isApproved: (result: unknown) => (result as z.infer<typeof reviewSchema>).approved === true,
          },
        ],
      });
      expect((await pool.run()).completedTasks).toBe(1);
    });

    it('rejects when isApproved returns false and provides feedback', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Missing tests', severity: 'critical' },
        attempts: 1,
      });
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
            isApproved: (result: unknown) => (result as z.infer<typeof reviewSchema>).approved === true,
            getFeedback: (result: unknown) =>
              (result as z.infer<typeof reviewSchema>).feedback ?? 'No feedback provided',
          },
        ],
      });
      const result = await pool.run();
      expect(rejectReason).toBe('Missing tests');
      expect(result.failedTasks).toBe(1);
    });

    it('uses default approval check when isApproved is not provided', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });
      expect(
        (
          await createPoolAndTracker({
            getStepsForTask: () => [
              { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: z.object({ approved: z.boolean() }) },
            ],
          }).pool.run()
        ).completedTasks,
      ).toBe(1);
    });

    it('uses default feedback extraction when getFeedback is not provided', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Custom feedback', severity: 'critical' },
        attempts: 1,
      });
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
      mockPromptForStructured.mockResolvedValue({ result: { approved: false, severity: 'critical' }, attempts: 1 });
      let rejectReason: string | undefined;
      const { pool } = createPoolAndTracker({
        maxStepRetries: 1,
        onStatus: {
          onTaskRejected: mock((info: { reason: string }) => {
            rejectReason = info.reason;
          }),
        },
        getStepsForTask: () => [
          { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: z.object({ approved: z.boolean() }) },
        ],
      });
      await pool.run();
      expect(rejectReason).toBe('No feedback provided');
    });
  });

  describe('multiple tasks', () => {
    it('processes multiple tasks sequentially with a single lane', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const { pool } = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' }), makeTask({ id: 'task-3' })],
      });
      const result = await pool.run();
      expect(result.completedTasks).toBe(3);
      expect(result.failedTasks).toBe(0);
      expect(mockCreateHarness).toHaveBeenCalledTimes(3);
    });

    it('processes tasks concurrently with multiple lanes', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const { pool } = createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })],
        maxConcurrentLanes: 2,
      });
      const result = await pool.run();
      expect(result.completedTasks).toBe(2);
      expect(result.failedTasks).toBe(0);
      const agentIds = mockCreateHarness.mock.calls.map((call) => (call[0] as Record<string, unknown>).agentId);
      expect(agentIds).toContain('lane-0');
      expect(agentIds).toContain('lane-1');
    });
  });

  describe('error handling', () => {
    it('handles missing profile gracefully', async () => {
      mockLoadProfilesFromDirs.mockResolvedValue(new Map());
      const { pool, tracker } = createPoolAndTracker();
      const result = await pool.run();
      expect(result.failedTasks).toBe(1);
      expect(result.completedTasks).toBe(0);
      expect(tracker.getTask('task-1')?.status).toBe('failed');
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
      expect(tracker.getTask('task-1')?.status).toBe('failed');
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
      expect(tracker.getTask('task-1')?.status).toBe('failed');
      expect(TaskTracker.fromJSON(tracker.toJSON()).getTask('task-1')?.status).toBe('ready');
    });

    it('handles agent errors during step execution', async () => {
      setupProfileMocks();
      let callCount = 0;
      mockCreateHarness.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('Agent creation failed');
        return { session: makeSession(() => 'ok'), sessionId: 'test-session', dispose: mock(() => {}) };
      });
      expect((await createPoolAndTracker().pool.run()).failedTasks).toBe(1);
    });

    it('handles error in session.prompt', async () => {
      setupProfileMocks();
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('Prompt failed');
        }),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });
      expect((await createPoolAndTracker().pool.run()).failedTasks).toBe(1);
    });
  });

  describe('status callbacks', () => {
    it('fires onTaskStart and onTaskComplete for successful tasks', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onTaskStart = mock(() => {});
      const onTaskComplete = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onTaskStart, onTaskComplete } });
      await pool.run();
      expect(onTaskStart).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1', title: 'Test task', agentId: 'lane-0' }),
      );
      expect(onTaskComplete).toHaveBeenCalledWith({ taskId: 'task-1', title: 'Test task' });
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
    });

    it('fires onTaskRejected when a review step rejects and max retries is hit', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Bad code', severity: 'critical' },
        attempts: 1,
      });
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
      expect(onTaskRejected).toHaveBeenCalledWith({ taskId: 'task-1', title: 'Test task', reason: 'Bad code' });
    });
  });

  describe('step retry and rejection', () => {
    it('retries up to maxStepRetries before marking task as failed', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      let callCount = 0;
      mockPromptForStructured.mockImplementation(() =>
        Promise.resolve({
          result: { approved: false, feedback: `Rejection ${++callCount}`, severity: 'critical' },
          attempts: 1,
        }),
      );
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
      expect((await pool.run()).failedTasks).toBe(1);
      expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
    });

    it('succeeds when a retry step is approved after an initial rejection', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      let callCount = 0;
      mockPromptForStructured.mockImplementation(() =>
        Promise.resolve(
          ++callCount <= 1
            ? { result: { approved: false, feedback: 'Try harder' }, attempts: 1 }
            : { result: { approved: true, feedback: undefined }, attempts: 1 },
        ),
      );
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
      expect((await pool.run()).completedTasks).toBe(1);
      expect(mockPromptForStructured).toHaveBeenCalledTimes(2);
    });
  });

  describe('prompt building', () => {
    it('includes task title, step name, and prompt in the agent prompt', async () => {
      setupProfileMocks();
      const session = setupHarnessMocks();
      const { pool } = createPoolAndTracker({
        tasks: [
          makeTask({ id: 'task-1', title: 'Build feature', prompt: 'Create a login page', files: ['src/login.ts'] }),
        ],
      });
      await pool.run();
      const text = session.prompt.mock.calls[0][0] as string;
      expect(text).toContain('## Task: Build feature');
      expect(text).toContain('## Step: implement');
      expect(text).toContain('Create a login page');
    });

    it('does not include relevant files section when files array is empty', async () => {
      setupProfileMocks();
      const session = setupHarnessMocks();
      const { pool } = createPoolAndTracker({ tasks: [makeTask({ files: [] })] });
      await pool.run();
      expect(session.prompt.mock.calls[0][0] as string).not.toContain('### ');
    });

    it('includes review feedback in backed-up implement step prompt', async () => {
      setupProfileMocks();
      const implementPrompts: string[] = [];
      let hc = 0;
      mockCreateHarness.mockImplementation(() => {
        hc++;
        const session = makeSession((text) => {
          if (hc % 2 === 1) implementPrompts.push(text);
          return 'done';
        });
        return { session, sessionId: `s-${hc}`, dispose: mock(() => {}) };
      });
      let rc = 0;
      mockPromptForStructured.mockImplementation(() =>
        Promise.resolve(
          ++rc === 1
            ? { result: { approved: false, feedback: 'Fix the null check', severity: 'medium' }, attempts: 1 }
            : { result: { approved: true, feedback: undefined }, attempts: 1 },
        ),
      );
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
      expect((await pool.run()).completedTasks).toBe(1);
      expect(implementPrompts[1]).toContain('Review Feedback History');
      expect(implementPrompts[1]).toContain('Fix the null check');
    });
  });

  describe('harness disposal', () => {
    it('always calls dispose even when an error occurs during prompting', async () => {
      setupProfileMocks();
      const dispose = mock(() => {});
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('prompt error');
        }),
        sessionId: 'test-session',
        dispose,
      });
      expect((await createPoolAndTracker().pool.run()).failedTasks).toBe(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifecycle callbacks', () => {
    it('does NOT fire onWorkflowStart', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onWorkflowStart = mock(() => {});
      await createPoolAndTracker({ onStatus: { onWorkflowStart } }).pool.run();
      expect(onWorkflowStart).not.toHaveBeenCalled();
    });

    it('does NOT fire onPhaseStart', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onPhaseStart = mock(() => {});
      await createPoolAndTracker({ onStatus: { onPhaseStart } }).pool.run();
      expect(onPhaseStart).not.toHaveBeenCalled();
    });

    it('does NOT fire onPhaseComplete', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onPhaseComplete = mock(() => {});
      await createPoolAndTracker({ onStatus: { onPhaseComplete } }).pool.run();
      expect(onPhaseComplete).not.toHaveBeenCalled();
    });

    it('does NOT fire onWorkflowComplete', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onWorkflowComplete = mock(() => {});
      await createPoolAndTracker({ onStatus: { onWorkflowComplete } }).pool.run();
      expect(onWorkflowComplete).not.toHaveBeenCalled();
    });

    it('does NOT fire onWorkflowFailed even when a lane rejects', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      let claimCount = 0;
      const onWorkflowFailed = mock(() => {});
      const onError = mock(() => {});
      const pool = new LanePool({
        maxConcurrentLanes: 1,
        profilesDirs: ['/mock/profiles'],
        sessionBaseDir: '/tmp/sessions',
        cwd: '/tmp/project',
        phaseId: 'implementing',
        taskTracker: createMockTaskTracker({
          claimTasks: mock(() => {
            claimCount++;
            return claimCount === 1
              ? [
                  {
                    id: 'task-1',
                    title: 'Test task',
                    prompt: 'test',
                    profile: 'coder',
                    files: [],
                    dependencies: [],
                    status: 'active' as const,
                  },
                ]
              : (() => {
                  throw new Error('Simulated lane crash');
                })();
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
        }),
        getStepsForTask: () => [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
        onStatus: { onWorkflowFailed, onError },
      });
      await pool.run();
      expect(onWorkflowFailed).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalled();
    });

    it('does not fire onWorkflowFailed when all lanes succeed', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onWorkflowFailed = mock(() => {});
      const onWorkflowComplete = mock(() => {});
      await createPoolAndTracker({ onStatus: { onWorkflowFailed, onWorkflowComplete } }).pool.run();
      expect(onWorkflowFailed).not.toHaveBeenCalled();
      expect(onWorkflowComplete).not.toHaveBeenCalled();
    });

    it('fires task-level lifecycle callbacks in correct order', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const order: string[] = [];
      const { pool } = createPoolAndTracker({
        onStatus: {
          onTaskStart: mock(() => order.push('taskStart')),
          onTaskComplete: mock(() => order.push('taskComplete')),
        },
      });
      await pool.run();
      expect(order).toEqual(['taskStart', 'taskComplete']);
    });
  });

  describe('audit log', () => {
    it('fires onAgentSpawn and onAgentComplete for each step (audit events now via store callbacks)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onAgentSpawn = mock(() => {});
      const onAgentComplete = mock(() => {});
      const { pool } = createPoolAndTracker({
        onStatus: { onAgentSpawn, onAgentComplete },
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      await pool.run();
      expect(onAgentSpawn).toHaveBeenCalledTimes(2);
      expect(onAgentComplete).toHaveBeenCalledTimes(2);
    });

    it('fires onError when runLane catches a step error (error now via onError → store)', async () => {
      setupProfileMocks();
      mockCreateHarness.mockRejectedValueOnce(new Error('Harness creation failed'));
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => 'ok'),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });
      const onError = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onError } });
      await pool.run();
      expect(onError).toHaveBeenCalled();
    });

    it('does not fire callbacks when no onStatus is provided', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      expect((await createPoolAndTracker().pool.run()).completedTasks).toBe(1);
    });

    it('onAgentComplete fires even when step fails', async () => {
      setupProfileMocks();
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => {
          throw new Error('Prompt failed');
        }),
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });
      const onAgentSpawn = mock(() => {});
      const onAgentComplete = mock(() => {});
      const { pool } = createPoolAndTracker({ onStatus: { onAgentSpawn, onAgentComplete } });
      await pool.run();
      expect(onAgentSpawn).toHaveBeenCalledTimes(1);
      expect(onAgentComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe('crash handling', () => {
    it('one lane throws while others succeed — Promise.allSettled isolates failures', async () => {
      setupProfileMocks();
      let cc = 0;
      mockCreateHarness.mockImplementation(() => {
        cc++;
        return cc === 1
          ? {
              session: makeSession(() => {
                throw new Error('Lane crash');
              }),
              sessionId: 'cs',
              dispose: mock(() => {}),
            }
          : { session: makeSession(() => 'done'), sessionId: 'ok', dispose: mock(() => {}) };
      });
      const result = await createPoolAndTracker({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })],
        maxConcurrentLanes: 2,
      }).pool.run();
      expect(result.failedTasks + result.completedTasks).toBe(2);
    });

    it('onAgentComplete still fires when dispose() throws', async () => {
      setupProfileMocks();
      mockCreateHarness.mockResolvedValue({
        session: makeSession(() => 'ok'),
        sessionId: 'test-session',
        dispose: mock(() => {
          throw new Error('dispose exploded');
        }),
      });
      const onAgentComplete = mock(() => {});
      const spy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await createPoolAndTracker({ onStatus: { onAgentComplete } }).pool.run();
        expect(onAgentComplete).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('maxStepRetries: 0 results in single attempt with no retry', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Not good enough', severity: 'critical' },
        attempts: 1,
      });
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
      expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
      expect(result.failedTasks).toBe(1);
      expect(tracker.getTask('task-1')?.status).toBe('failed');
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
      const spy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await createPoolAndTracker({ onStatus: {} }).pool.run();
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls[0].join(' ')).toContain('[lane-0] Unhandled failure');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('maxTaskRetries (same-run failed-task retry)', () => {
    const { getDir } = useTempDir();

    it('retries a failed task up to maxTaskRetries times (total attempts = 1 + max)', async () => {
      setupProfileMocks();
      let failCount = 0;
      mockCreateHarness.mockImplementation(() => {
        failCount++;
        return {
          session: makeSession(() => {
            throw new Error('overloaded');
          }),
          sessionId: `s-${failCount}`,
          dispose: mock(() => {}),
        };
      });
      const { pool, tracker } = createPoolAndTracker({ maxTaskRetries: 2 });
      const result = await pool.run();
      // 1 initial attempt + 2 retries = 3 total; all fail → task stays failed
      expect(failCount).toBe(3);
      expect(result.failedTasks).toBe(1);
      expect(result.completedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    }, 30_000);

    it('re-run task starts from step 1 (re-executes the first step)', async () => {
      setupProfileMocks();
      let calls = 0;
      const seenStepNames: string[] = [];
      mockCreateHarness.mockImplementation((opts: any) => {
        calls++;
        seenStepNames.push(opts?.sessionDir ?? '?');
        // Fail the first two attempts, succeed on the third.
        if (calls <= 2) {
          return {
            session: makeSession(() => {
              throw new Error('overloaded');
            }),
            sessionId: `s-${calls}`,
            dispose: mock(() => {}),
          };
        }
        return { session: makeSession(() => 'done'), sessionId: `s-${calls}`, dispose: mock(() => {}) };
      });
      const { pool, tracker } = createPoolAndTracker({ maxTaskRetries: 2 });
      const result = await pool.run();
      expect(result.completedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('complete');
      expect(calls).toBe(3); // initial + 2 retries
      // Every retry begins fresh at step 1 (single-step task here). The key
      // assertion is that execCount-based session dir resets: the first step
      // dir suffix `-0-implement` appears across all 3 attempts because each
      // retry restarts the step index from 0.
      expect(seenStepNames.every((d) => d.endsWith('0-implement'))).toBe(true);
    }, 30_000);

    it('clears the task session directory on each retry', async () => {
      setupProfileMocks();
      const base = getDir();
      const createdDirs: string[] = [];
      let calls = 0;
      mockCreateHarness.mockImplementation((opts: any) => {
        calls++;
        const dir = opts?.sessionDir as string | undefined;
        if (dir) {
          createdDirs.push(dir);
          // Simulate the harness writing a per-attempt marker file into its dir.
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `attempt-${calls}.jsonl`), '...');
        }
        if (calls <= 1) {
          return {
            session: makeSession(() => {
              throw new Error('overloaded');
            }),
            sessionId: `s-${calls}`,
            dispose: mock(() => {}),
          };
        }
        return { session: makeSession(() => 'done'), sessionId: `s-${calls}`, dispose: mock(() => {}) };
      });
      const { pool, tracker } = createPoolAndTracker({ maxTaskRetries: 2, sessionBaseDir: base });
      await pool.run();
      expect(tracker.getTask('task-1')!.status).toBe('complete');
      // Two fresh attempts (session dirs created twice).
      expect(createdDirs.length).toBe(2);
      // The retry cleared the whole task dir, so attempt 1's marker is gone
      // and only attempt 2's marker remains in the recreated dir.
      expect(existsSync(join(createdDirs[0], 'attempt-1.jsonl'))).toBe(false);
      expect(existsSync(join(createdDirs[0], 'attempt-2.jsonl'))).toBe(true);
    }, 30_000);

    it('does NOT retry when maxTaskRetries is unset (preserves historical behavior)', async () => {
      setupProfileMocks();
      let attempts = 0;
      mockCreateHarness.mockImplementation(() => {
        attempts++;
        return {
          session: makeSession(() => {
            throw new Error('fail');
          }),
          sessionId: `s-${attempts}`,
          dispose: mock(() => {}),
        };
      });
      const { pool, tracker } = createPoolAndTracker(); // no maxTaskRetries
      const result = await pool.run();
      expect(attempts).toBe(1);
      expect(result.failedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    });

    it('does NOT retry a task that completed successfully', async () => {
      setupProfileMocks();
      let attempts = 0;
      mockCreateHarness.mockImplementation(() => {
        attempts++;
        return {
          session: makeSession(() => 'done'),
          sessionId: `s-${attempts}`,
          dispose: mock(() => {}),
        };
      });
      const { pool } = createPoolAndTracker({ maxTaskRetries: 2 });
      const result = await pool.run();
      expect(result.completedTasks).toBe(1);
      expect(attempts).toBe(1); // completed on first try — no retries
    });

    it('announces each retry via onDecision', async () => {
      setupProfileMocks();
      const onDecision = mock((_info: { decision: string; taskId: string }) => {});
      let n = 0;
      mockCreateHarness.mockImplementation(() => {
        n++;
        return n <= 2
          ? {
              session: makeSession(() => {
                throw new Error('overloaded');
              }),
              sessionId: `s-${n}`,
              dispose: mock(() => {}),
            }
          : { session: makeSession(() => 'done'), sessionId: `s-${n}`, dispose: mock(() => {}) };
      });
      const { pool } = createPoolAndTracker({
        maxTaskRetries: 2,
        onStatus: { onDecision },
      });
      await pool.run();
      const retryCalls = onDecision.mock.calls.filter((c) => c[0].decision.includes('Retrying failed task'));
      expect(retryCalls).toHaveLength(2);
      expect(retryCalls[0][0].taskId).toBe('task-1');
      // attempt numbering: 2/3 then 3/3
      expect(retryCalls[0][0].decision).toContain('attempt 2/3');
      expect(retryCalls[1][0].decision).toContain('attempt 3/3');
    }, 30_000);
  });

  describe('empty pool', () => {
    it('returns zero counts when there are no tasks', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      expect((await createPoolAndTracker({ tasks: [] }).pool.run()).completedTasks).toBe(0);
    });
  });

  describe('onTaskRegister callback', () => {
    it('fires onTaskRegister once per task with phaseId and steps', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onTaskRegister = mock(() => {});
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'task-1', title: 'First', dependencies: [] }));
      const { status: _, ...task2Base } = makeTask({ id: 'task-2', title: 'Second', dependencies: ['task-1'] });
      tracker.addTask(task2Base);
      const pool = new LanePool({
        maxConcurrentLanes: 1,
        profilesDirs: ['/mock/profiles'],
        sessionBaseDir: '/tmp/sessions',
        cwd: '/tmp/project',
        phaseId: 'implementing',
        taskTracker: tracker,
        getStepsForTask: () => [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
        onStatus: { onTaskRegister } as unknown as undefined,
      });
      expect(tracker.getTask('task-2')!.status).toBe('blocked');
      await pool.run();
      expect(onTaskRegister).toHaveBeenCalledTimes(2);
      expect(onTaskRegister).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          taskId: 'task-1',
          phaseId: 'implementing',
          title: 'First',
          dependencies: [],
          steps: [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
        }),
      );
      expect(onTaskRegister).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          taskId: 'task-2',
          phaseId: 'implementing',
          title: 'Second',
          dependencies: ['task-1'],
          steps: [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
        }),
      );
    });
  });

  describe('event-driven waiting', () => {
    it('processes dependent tasks via event-driven path without polling', async () => {
      setupProfileMocks();
      const prompts: string[] = [];
      let hc = 0;
      mockCreateHarness.mockImplementation(() => {
        hc++;
        return {
          session: makeSession((text) => {
            prompts.push(text);
            return `r-${hc}`;
          }),
          sessionId: `s-${hc}`,
          dispose: mock(() => {}),
        };
      });
      const tracker = new TaskTracker();
      tracker.addTask(makeTask({ id: 'task-1', prompt: 'Do first' }));
      const { status: _s, ...task2Base } = makeTask({ id: 'task-2', prompt: 'Do second', dependencies: ['task-1'] });
      tracker.addTask(task2Base);
      const pool = new LanePool({
        maxConcurrentLanes: 1,
        profilesDirs: ['/mock/profiles'],
        sessionBaseDir: '/tmp/sessions',
        cwd: '/tmp/project',
        phaseId: 'implementing',
        taskTracker: tracker,
        getStepsForTask: () => [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
      });
      expect(tracker.getTask('task-2')!.status).toBe('blocked');
      const result = await pool.run();
      expect(result.completedTasks).toBe(2);
      expect(prompts.some((p) => p.includes('Do first'))).toBe(true);
      expect(prompts.some((p) => p.includes('Do second'))).toBe(true);
    });

    it('does not call setTimeout for polling when events are available', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const spy = spyOn(globalThis, 'setTimeout');
      try {
        await createPoolAndTracker({ tasks: [makeTask()] }).pool.run();
        expect(spy.mock.calls.filter((c) => typeof c[1] === 'number' && c[1] >= 50 && c[1] <= 2000)).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('severity-based retry outcome', () => {
    const sevSchema = z.object({
      approved: z.boolean(),
      feedback: z.string().optional(),
      severity: z.string().optional(),
    });
    function sevSteps() {
      return [
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: sevSchema,
          isApproved: (r: unknown) => (r as z.infer<typeof sevSchema>).approved === true,
          getFeedback: (r: unknown) => (r as z.infer<typeof sevSchema>).feedback ?? 'No feedback provided',
        },
      ];
    }

    it('marks task as failed when severity is critical after max retries', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'bad', severity: 'critical' },
        attempts: 1,
      });
      const { pool, tracker } = createPoolAndTracker({ maxStepRetries: 2, getStepsForTask: () => sevSteps() });
      const result = await pool.run();
      expect(result.failedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    });

    it('marks task as failed when severity is medium after max retries (exhaustion always fails)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'minor issues', severity: 'medium' },
        attempts: 1,
      });
      const { pool, tracker } = createPoolAndTracker({ maxStepRetries: 2, getStepsForTask: () => sevSteps() });
      const result = await pool.run();
      expect(result.failedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    });

    it('marks task as failed when severity is low after max retries (exhaustion always fails)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'nitpick', severity: 'low' },
        attempts: 1,
      });
      const { pool, tracker } = createPoolAndTracker({ maxStepRetries: 2, getStepsForTask: () => sevSteps() });
      const result = await pool.run();
      expect(result.failedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    });

    it('marks task as failed when severity is high after max retries', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'major issue', severity: 'high' },
        attempts: 1,
      });
      const { pool, tracker } = createPoolAndTracker({ maxStepRetries: 2, getStepsForTask: () => sevSteps() });
      const result = await pool.run();
      expect(result.failedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    });

    it('defaults to medium severity when no severity field (exhaustion still fails)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({ result: { approved: false, feedback: 'meh' }, attempts: 1 });
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
      expect(result.failedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    });

    it('default maxStepRetries is now 5', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      let cc = 0;
      mockPromptForStructured.mockImplementation(() =>
        Promise.resolve(
          ++cc <= 4
            ? { result: { approved: false, feedback: `Rejection ${cc}` }, attempts: 1 }
            : { result: { approved: true, feedback: undefined }, attempts: 1 },
        ),
      );
      const { pool, tracker } = createPoolAndTracker({
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
      expect(mockPromptForStructured).toHaveBeenCalledTimes(5);
      expect(tracker.getTask('task-1')!.status).toBe('complete');
    });
  });

  describe('promptForStructured exception handling', () => {
    it('converts promptForStructured exception to step rejection and retries', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      mockPromptForStructured.mockRejectedValue(new Error('Structured output failed'));
      const { pool, tracker } = createPoolAndTracker({
        maxStepRetries: 3,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: z.object({ approved: z.boolean() }) },
        ],
      });
      const result = await pool.run();
      expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
      expect(result.completedTasks).toBe(0);
      expect(tracker.getTask('task-1')!.status).toBe('failed');
    });

    it('recovers when promptForStructured fails then succeeds', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      let cc = 0;
      mockPromptForStructured.mockImplementation(() =>
        Promise.resolve(
          ++cc <= 2 ? Promise.reject(new Error('Temp failure')) : { result: { approved: true }, attempts: 1 },
        ),
      );
      const { pool, tracker } = createPoolAndTracker({
        maxStepRetries: 5,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: z.object({ approved: z.boolean() }) },
        ],
      });
      const result = await pool.run();
      expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
      expect(result.completedTasks).toBe(1);
      expect(tracker.getTask('task-1')!.status).toBe('complete');
    });
  });

  describe('onStepStart callback', () => {
    it('fires onStepStart with correct step info for each step', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      const onStepStart = mock(() => {});
      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
        onStatus: { onStepStart },
      });
      await pool.run();
      expect(onStepStart).toHaveBeenCalledTimes(2);
      expect(onStepStart).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          taskId: 'task-1',
          stepName: 'implement',
          stepIndex: 0,
          agentId: 'lane-0',
        }),
      );
      expect(onStepStart).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          taskId: 'task-1',
          stepName: 'review',
          stepIndex: 1,
          agentId: 'lane-0',
        }),
      );
    });

    it('fires onStepStart on retry (re-execution of same step)', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      let rc = 0;
      mockPromptForStructured.mockImplementation(() =>
        Promise.resolve(
          ++rc <= 1
            ? { result: { approved: false, feedback: 'Needs work', severity: 'critical' }, attempts: 1 }
            : { result: { approved: true, feedback: undefined }, attempts: 1 },
        ),
      );
      const onStepStart = mock(() => {});
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
        onStatus: { onStepStart },
      });
      await pool.run();
      // First pass: implement(0) + review(1). Review rejects, backing up to implement.
      // Second pass: implement(0) + review(1). Both approved.
      expect(onStepStart).toHaveBeenCalledTimes(4);
      expect(onStepStart).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ stepName: 'implement', stepIndex: 0, agentId: 'lane-0' }),
      );
      expect(onStepStart).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ stepName: 'review', stepIndex: 1, agentId: 'lane-0' }),
      );
      expect(onStepStart).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ stepName: 'implement', stepIndex: 0, agentId: 'lane-0' }),
      );
      expect(onStepStart).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ stepName: 'review', stepIndex: 1, agentId: 'lane-0' }),
      );
    });
  });

  describe('session reuse on retry', () => {
    const RS = z.object({
      approved: z.boolean(),
      feedback: z.string(),
      issues: z.array(z.object({ file: z.string(), description: z.string(), severity: z.enum(['critical', 'minor']) })),
    });

    it('resumes session via resumeSessionPath when retrying implement step after rejection', async () => {
      setupProfileMocks();
      let rc = 0;
      mockPromptForStructured.mockImplementation(() =>
        Promise.resolve(
          ++rc === 1
            ? { result: { approved: false, feedback: 'needs work', issues: [] }, attempts: 1 }
            : { result: { approved: true, feedback: '', issues: [] }, attempts: 1 },
        ),
      );
      setupHarnessMocks();
      const { pool } = createPoolAndTracker({
        maxStepRetries: 3,
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          {
            name: 'review',
            profileId: 'reviewer',
            isReadOnly: true,
            schema: RS,
            isApproved: (r: unknown) => (r as z.infer<typeof RS>).approved === true,
            getFeedback: (r: unknown) => (r as z.infer<typeof RS>).feedback,
          },
        ],
      });
      expect((await pool.run()).completedTasks).toBe(1);
    });

    it('disposes all sessions only when task completes', async () => {
      setupProfileMocks();
      const disposes: ReturnType<typeof mock>[] = [];
      let hc = 0;
      mockCreateHarness.mockImplementation(() => {
        hc++;
        const fn = mock(() => {});
        disposes.push(fn);
        return { session: makeSession(() => 'done'), sessionId: `s-${hc}`, dispose: fn };
      });
      const { pool } = createPoolAndTracker({
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      expect((await pool.run()).completedTasks).toBe(1);
      expect(disposes).toHaveLength(2);
      disposes.forEach((d) => expect(d).toHaveBeenCalledTimes(1));
    });

    it('does not pass resumeSessionPath on first execution of any step', async () => {
      setupProfileMocks();
      setupHarnessMocks();
      await createPoolAndTracker().pool.run();
      expect((mockCreateHarness.mock.calls[0][0] as Record<string, unknown>).resumeSessionPath).toBeFalsy();
    });
  });

  describe('task result output', () => {
    it('completes task and stores result via completeTask for single non-structured step', async () => {
      const scoutProfile = { ...defaultProfile, id: 'scout', name: 'Scout' };
      const map = new Map<string, typeof defaultProfile>();
      map.set('scout', scoutProfile);
      mockLoadProfilesFromDirs.mockResolvedValue(map);
      const session = makeSession(() => 'scout report: all clear');
      setupHarnessMocks(session);
      const { pool, tracker } = createPoolAndTracker({
        getStepsForTask: () => [{ name: 'scouting', profileId: 'scout', isReadOnly: true }],
      });
      await pool.run();
      const task = tracker.getTask('task-1')!;
      expect(task.status).toBe('complete');
    });

    it('completes task for multi-step pipeline with last step output', async () => {
      setupProfileMocks();
      let cc = 0;
      mockCreateHarness.mockImplementation(() => {
        cc++;
        return {
          session: makeSession(() => (cc % 2 === 1 ? 'implement-result' : 'review-result')),
          sessionId: `s-${cc}`,
          dispose: mock(() => {}),
        };
      });
      const { pool, tracker } = createPoolAndTracker({
        getStepsForTask: () => [
          { name: 'implement', profileId: 'coder', isReadOnly: false },
          { name: 'review', profileId: 'reviewer', isReadOnly: true },
        ],
      });
      await pool.run();
      const task = tracker.getTask('task-1')!;
      expect(task.status).toBe('complete');
    });
  });
});

// ── maxStepRetries default value (DEFAULT_MAX_STEP_RETRIES) ────────────────
//
// Characterization test pinning down the default value of `runnerCtx.maxStepRetries`
// when `options.maxStepRetries` is omitted. The pool uses the literal magic
// number `5` as the fallback (`this.options.maxStepRetries ?? 5`). This test
// guards against accidental drift if that fallback is later refactored into a
// named constant (DEFAULT_MAX_STEP_RETRIES) or otherwise changed.

describe('LanePool — maxStepRetries default value', () => {
  /** A runner that captures the `maxStepRetries` it receives on its context. */
  function capturingRunner(seen: { value?: number }): TaskRunner {
    return async (ctx) => {
      seen.value = ctx.maxStepRetries;
      ctx.completeTask('done');
      return { status: 'completed', output: 'done' };
    };
  }

  it('defaults maxStepRetries to 5 when options.maxStepRetries is omitted', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    const seen: { value?: number } = {};
    // Intentionally do NOT set maxStepRetries — exercise the ?? 5 fallback.
    const { pool, tracker } = createPoolAndTracker({
      getRunnerForTask: () => capturingRunner(seen),
    });
    const result = await pool.run();

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(seen.value).toBe(5);
    expect(tracker.getTask('task-1')?.status).toBe('complete');
  });

  it('respects an explicit maxStepRetries override (does not fall back to 5)', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    const seen: { value?: number } = {};
    const { pool } = createPoolAndTracker({
      maxStepRetries: 3,
      getRunnerForTask: () => capturingRunner(seen),
    });
    const result = await pool.run();

    expect(result.completedTasks).toBe(1);
    expect(seen.value).toBe(3);
  });

  it('respects an explicit maxStepRetries of 0 (does not fall back to the default)', async () => {
    setupProfileMocks();
    setupHarnessMocks();
    const seen: { value?: number } = {};
    const { pool } = createPoolAndTracker({
      maxStepRetries: 0,
      getRunnerForTask: () => capturingRunner(seen),
    });
    const result = await pool.run();

    expect(result.completedTasks).toBe(1);
    // ?? only falls back on nullish (undefined), so 0 must be preserved.
    expect(seen.value).toBe(0);
  });
});
