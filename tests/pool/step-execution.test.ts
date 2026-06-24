import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { RendererRegistry } from '../../packages/engine/src/core/renderer-registry.js';
import type { AgentProfile } from '../../packages/engine/src/core/types.js';
import type { WorktreeManager } from '../../packages/engine/src/core/worktree-manager.js';
import { buildExecCtx } from '../../packages/engine/src/pool/runner-utils.js';
import type { TaskRunnerContext } from '../../packages/engine/src/pool/types.js';
import { makeMockSession } from '../helpers/make-session.js';
import { makeTask } from '../helpers/make-task.js';

// Capture real modules before mocking
const realHarnessFactory = Object.assign({}, await import('../../packages/engine/src/core/harness-factory.js'));
const realStructuredOutput = Object.assign({}, await import('../../packages/engine/src/core/structured-output.js'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../packages/engine/src/core/harness-factory.ts', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../packages/engine/src/core/structured-output.ts', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
  extractJsonFromText: realStructuredOutput.extractJsonFromText,
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import type { StepExecutionContext } from '../../packages/engine/src/pool/step-execution.js';
import { runStep } from '../../packages/engine/src/pool/step-execution.js';
import type { StepDefinition } from '../../packages/engine/src/pool/types.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

const defaultProfile: AgentProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a coding agent.',
  excludeTools: [] as string[],
  includeTools: [] as string[],
};

const reviewerProfile: AgentProfile = {
  ...defaultProfile,
  id: 'reviewer',
  name: 'Reviewer',
};

interface RunStepContext {
  stepIndex: number;
  attempt: number;
  execCount: number;
}

function makeSession(textFn: (promptText: string) => string | undefined = () => 'done') {
  return makeMockSession(textFn).session;
}

function createStepExecutionContext(overrides?: Partial<StepExecutionContext>): StepExecutionContext {
  return {
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    apiKeys: undefined,
    onStatus: undefined,
    activeSessions: new Set<{ abort(): Promise<void> }>(),
    phaseId: 'implementing',
    ...overrides,
  } as StepExecutionContext;
}

function createProfilesMap(...profiles: AgentProfile[]): Map<string, AgentProfile> {
  const map = new Map<string, AgentProfile>();
  for (const p of profiles) {
    map.set(p.id, p);
  }
  return map;
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

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreateHarness.mockClear();
  mockPromptForStructured.mockClear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runStep (step-execution module)', () => {
  const baseStep: StepDefinition = {
    name: 'implement',
    profileId: 'coder',
    isReadOnly: false,
  };

  const defaultCtx: RunStepContext = {
    stepIndex: 0,
    attempt: 0,
    execCount: 0,
  };

  // ─── Basic Non-Structured Step ────────────────────────────────────────

  describe('non-structured step execution', () => {
    it('returns approved result with assistant text for non-structured steps', async () => {
      const session = makeSession(() => 'implementation complete');
      setupHarnessMocks(session);

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      const { result } = await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(result.type).toBe('approved');
      if (result.type === 'approved') {
        expect(result.output).toBe('implementation complete');
      }
    });

    it('calls session.prompt with the built prompt text', async () => {
      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const task = makeTask({ title: 'Build feature', prompt: 'Create login page' });
      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      await runStep(task, baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(session.prompt).toHaveBeenCalledTimes(1);
      const promptedText = session.prompt.mock.calls[0][0] as string;
      expect(promptedText).toContain('## Task: Build feature');
      expect(promptedText).toContain('Create login page');
    });

    it('does not call promptForStructured for non-schema steps', async () => {
      setupHarnessMocks();

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(mockPromptForStructured).not.toHaveBeenCalled();
    });
  });

  // ─── Structured Output Steps ──────────────────────────────────────────

  describe('structured output step execution', () => {
    const reviewSchema = z.object({
      approved: z.boolean(),
      feedback: z.string().optional(),
    });

    const reviewStep: StepDefinition = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
      schema: reviewSchema,
    };

    it('uses promptForStructured for steps with a schema', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: true, feedback: undefined },
        attempts: 1,
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      await runStep(makeTask(), reviewStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    });

    it('returns approved when structured result is approved', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: true, feedback: undefined },
        attempts: 1,
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      const { result } = await runStep(makeTask(), reviewStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(result.type).toBe('approved');
      if (result.type === 'approved') {
        expect(result.output).toEqual({ approved: true, feedback: undefined });
      }
    });

    it('returns rejected when structured result is not approved', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Missing tests' },
        attempts: 1,
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      const { result } = await runStep(makeTask(), reviewStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(result.type).toBe('rejected');
      if (result.type === 'rejected') {
        expect(result.feedback).toBe('Missing tests');
      }
    });

    it('uses custom isApproved function when provided', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: undefined, score: 8 },
        attempts: 1,
      });

      const customStep: StepDefinition = {
        ...reviewStep,
        isApproved: (result: unknown) => (result as { score: number }).score >= 9,
      };

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      const { result } = await runStep(makeTask(), customStep, 'lane-0', defaultCtx, profiles, execCtx);

      // score 8 < 9 → rejected
      expect(result.type).toBe('rejected');
    });

    it('uses custom getFeedback function when provided', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, issues: ['missing tests'] },
        attempts: 1,
      });

      const customStep: StepDefinition = {
        ...reviewStep,
        schema: z.object({ approved: z.boolean(), issues: z.array(z.string()) }),
        getFeedback: (result: unknown) => (result as { issues: string[] }).issues.join(', '),
      };

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      const { result } = await runStep(makeTask(), customStep, 'lane-0', defaultCtx, profiles, execCtx);

      if (result.type === 'rejected') {
        expect(result.feedback).toBe('missing tests');
      }
    });

    it('uses default approval check (result.approved === true) when isApproved not provided', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: true },
        attempts: 1,
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      const { result } = await runStep(
        makeTask(),
        { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: z.object({ approved: z.boolean() }) },
        'lane-0',
        defaultCtx,
        profiles,
        execCtx,
      );

      expect(result.type).toBe('approved');
    });

    it('uses default feedback extraction when getFeedback not provided', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Custom feedback' },
        attempts: 1,
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      const { result } = await runStep(
        makeTask(),
        {
          name: 'review',
          profileId: 'reviewer',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
        },
        'lane-0',
        defaultCtx,
        profiles,
        execCtx,
      );

      if (result.type === 'rejected') {
        expect(result.feedback).toBe('Custom feedback');
      }
    });

    it('falls back to "No feedback provided" when feedback is absent', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false },
        attempts: 1,
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      const { result } = await runStep(
        makeTask(),
        { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: z.object({ approved: z.boolean() }) },
        'lane-0',
        defaultCtx,
        profiles,
        execCtx,
      );

      if (result.type === 'rejected') {
        expect(result.feedback).toBe('No feedback provided');
      }
    });

    it('returns critical rejection when promptForStructured throws', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockRejectedValue(new Error('Structured output failed'));

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      const { result } = await runStep(makeTask(), reviewStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(result.type).toBe('rejected');
      if (result.type === 'rejected') {
        expect(result.feedback).toContain('Structured output failed');
        expect(result.output).toEqual({ severity: 'critical' });
      }
    });

    it('still returns rejected result when promptForStructured throws', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockRejectedValue(new Error('Parse error'));

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      const { result } = await runStep(makeTask(), reviewStep, 'lane-0', defaultCtx, profiles, execCtx);

      // Audit events now flow via onError → store callbacks, not appendAuditEvent.
      // Verify the rejection result carries the error feedback.
      expect(result.type).toBe('rejected');
      if (result.type === 'rejected') {
        expect(result.feedback).toContain('Parse error');
      }
    });

    it('uses maxRetries: 3 on first attempt and maxRetries: 1 on retries', async () => {
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: true, feedback: undefined },
        attempts: 1,
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      // First attempt (attempt = 0)
      await runStep(makeTask(), reviewStep, 'lane-0', { ...defaultCtx, attempt: 0 }, profiles, execCtx);

      const firstCallOptions = mockPromptForStructured.mock.calls[0][3] as { maxRetries: number };
      expect(firstCallOptions.maxRetries).toBe(3);

      // Retry attempt (attempt = 1)
      await runStep(makeTask(), reviewStep, 'lane-0', { ...defaultCtx, attempt: 1 }, profiles, execCtx);

      const secondCallOptions = mockPromptForStructured.mock.calls[1][3] as { maxRetries: number };
      expect(secondCallOptions.maxRetries).toBe(1);
    });
  });

  // ─── Profile Handling ────────────────────────────────────────────────

  describe('profile handling', () => {
    it('throws when profile is not found', async () => {
      setupHarnessMocks();

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(); // empty — no profiles

      await expect(runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx)).rejects.toThrow(
        /Profile "coder" not found/,
      );
    });

    it('includes profileDirs in error message for missing profile', async () => {
      setupHarnessMocks();

      const execCtx = createStepExecutionContext({
        sessionBaseDir: '/tmp/sessions',
      });
      const profiles = createProfilesMap(); // empty

      await expect(runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx)).rejects.toThrow(
        /not found in directories/,
      );
    });

    it('adjusts profile for read-only steps by excluding write and edit tools', async () => {
      setupHarnessMocks();

      const readOnlyStep: StepDefinition = { name: 'review', profileId: 'coder', isReadOnly: true };
      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), readOnlyStep, 'lane-0', defaultCtx, profiles, execCtx);

      const harnessOpts = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      const profile = harnessOpts.profile as AgentProfile;
      expect(profile.excludeTools).toContain('write');
      expect(profile.excludeTools).toContain('edit');
    });

    it('does not modify excludeTools for non-read-only steps', async () => {
      setupHarnessMocks();

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      const harnessOpts = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      const profile = harnessOpts.profile as AgentProfile;
      expect(profile.excludeTools).not.toContain('write');
      expect(profile.excludeTools).not.toContain('edit');
    });

    it('does not duplicate write/edit if already in excludeTools for read-only step', async () => {
      const profileWithExcludes: AgentProfile = {
        ...defaultProfile,
        excludeTools: ['write'],
      };
      setupHarnessMocks();

      const readOnlyStep: StepDefinition = { name: 'review', profileId: 'coder', isReadOnly: true };
      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(profileWithExcludes);

      await runStep(makeTask(), readOnlyStep, 'lane-0', defaultCtx, profiles, execCtx);

      const harnessOpts = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      const profile = harnessOpts.profile as AgentProfile;
      const writeCount = profile.excludeTools.filter((t: string) => t === 'write').length;
      expect(writeCount).toBe(1);
      expect(profile.excludeTools).toContain('edit');
    });
  });

  // ─── Session Path ────────────────────────────────────────────────────

  describe('session path computation', () => {
    it('creates session directory with task id and step info', async () => {
      setupHarnessMocks();

      const execCtx = createStepExecutionContext({ sessionBaseDir: '/base' });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(
        makeTask({ id: 'task-42' }),
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        'lane-0',
        { stepIndex: 0, attempt: 0, execCount: 0 },
        profiles,
        execCtx,
      );

      const harnessOpts = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      expect(harnessOpts.sessionDir).toContain('task-42');
      expect(harnessOpts.sessionDir).toContain('0-0-implement');
    });

    it('includes execCount in session directory path', async () => {
      setupHarnessMocks();

      const execCtx = createStepExecutionContext({ sessionBaseDir: '/base' });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(
        makeTask({ id: 'task-1' }),
        { name: 'implement', profileId: 'coder', isReadOnly: false },
        'lane-0',
        { stepIndex: 2, attempt: 1, execCount: 3 },
        profiles,
        execCtx,
      );

      const harnessOpts = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      expect(harnessOpts.sessionDir).toContain('3-2-implement');
    });

    it('uses resumeSessionPath when provided', async () => {
      setupHarnessMocks();

      const existingPath = '/base/task-1/0-0-implement';
      const execCtx = createStepExecutionContext({ sessionBaseDir: '/base' });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask({ id: 'task-1' }), baseStep, 'lane-0', defaultCtx, profiles, execCtx, existingPath);

      const harnessOpts = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      expect(harnessOpts.sessionDir).toBeUndefined();
      expect(harnessOpts.resumeSessionPath).toBe(existingPath);
    });

    it('uses sessionDir when no existingSessionPath provided', async () => {
      setupHarnessMocks();

      const execCtx = createStepExecutionContext({ sessionBaseDir: '/base' });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask({ id: 'task-1' }), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      const harnessOpts = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      expect(harnessOpts.sessionDir).toBeDefined();
      expect(harnessOpts.resumeSessionPath).toBeFalsy();
    });
  });

  // ─── Harness Options ────────────────────────────────────────────────

  describe('harness options', () => {
    it('passes cwd from execution context', async () => {
      setupHarnessMocks();

      const execCtx = createStepExecutionContext({ cwd: '/my/project' });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      const harnessOpts = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      expect(harnessOpts.cwd).toBe('/my/project');
    });

    it('passes apiKeys from execution context', async () => {
      setupHarnessMocks();

      const apiKeys = { openai: 'sk-123' };
      const execCtx = createStepExecutionContext({ apiKeys });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      const harnessOpts = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      expect(harnessOpts.apiKeys).toEqual(apiKeys);
    });

    it('passes agentId to harness', async () => {
      setupHarnessMocks();

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-7', defaultCtx, profiles, execCtx);

      const harnessOpts = mockCreateHarness.mock.calls[0][0] as Record<string, unknown>;
      expect(harnessOpts.agentId).toBe('lane-7');
    });
  });

  // ─── Status Callbacks ────────────────────────────────────────────────

  describe('status callbacks', () => {
    it('fires onAgentSpawn with sessionId after harness creation', async () => {
      setupHarnessMocks();

      const onAgentSpawn = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentSpawn } as unknown as StepExecutionContext['onStatus'],
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask({ id: 'task-1' }), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(onAgentSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'lane-0',
          profile: 'coder',
          phaseId: 'implementing',
          taskId: 'task-1',
        }),
      );
      // Verify sessionId is present (from mocked harness)
      const callArg = (onAgentSpawn.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      expect(callArg.sessionId).toBe('test-session');
      expect(typeof callArg.sessionPath).toBe('string');
    });

    it('fires onAgentComplete with sessionId and stepIndex after execution', async () => {
      setupHarnessMocks();

      const onAgentComplete = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentComplete } as unknown as StepExecutionContext['onStatus'],
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask({ id: 'task-1' }), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(onAgentComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'lane-0',
          profile: 'coder',
          phaseId: 'implementing',
          taskId: 'task-1',
          stepIndex: 0,
        }),
      );
      // Verify sessionId is present (from mocked harness)
      const callArg = (onAgentComplete.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      expect(callArg.sessionId).toBe('test-session');
    });

    it('fires onAgentComplete even when prompt throws', async () => {
      const session = makeSession(() => {
        throw new Error('Prompt failed');
      });
      setupHarnessMocks(session);

      const onAgentComplete = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentComplete } as unknown as StepExecutionContext['onStatus'],
      });
      const profiles = createProfilesMap(defaultProfile);

      try {
        await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);
      } catch {
        // Expected — the error propagates
      }

      expect(onAgentComplete).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Active Session Tracking ─────────────────────────────────────────

  describe('active session tracking', () => {
    it('adds session to activeSessions during execution', async () => {
      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const activeSessions = new Set<{ abort(): Promise<void> }>();
      const execCtx = createStepExecutionContext({ activeSessions });
      const profiles = createProfilesMap(defaultProfile);

      // Use a delayed prompt to check mid-execution state
      const _originalPrompt = session.prompt;
      session.prompt = mock(async () => {
        // At this point, session should be in activeSessions
        expect(activeSessions.has(session as unknown as { abort(): Promise<void> })).toBe(true);
      }) as unknown as typeof session.prompt;

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      // After execution, session should be removed
      expect(activeSessions.has(session as unknown as { abort(): Promise<void> })).toBe(false);
    });

    it('removes session from activeSessions after execution', async () => {
      setupHarnessMocks();

      const activeSessions = new Set<{ abort(): Promise<void> }>();
      const execCtx = createStepExecutionContext({ activeSessions });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(activeSessions.size).toBe(0);
    });

    it('removes session from activeSessions even when prompt throws', async () => {
      const session = makeSession(() => {
        throw new Error('Prompt failed');
      });
      setupHarnessMocks(session);

      const activeSessions = new Set<{ abort(): Promise<void> }>();
      const execCtx = createStepExecutionContext({ activeSessions });
      const profiles = createProfilesMap(defaultProfile);

      try {
        await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);
      } catch {
        // Expected
      }

      expect(activeSessions.size).toBe(0);
    });
  });

  // ─── TOCTOU: Session Tracking Order ──────────────────────────────────

  describe('TOCTOU: session tracked before observable side effects', () => {
    /**
     * The abort listener registered in LanePool.run() iterates `activeSessions`
     * and calls `abort()` on each. To close the Time-of-Check-Time-of-Use gap,
     * a freshly-created session MUST be added to `activeSessions` before any
     * status callback fires or any `await` yields control. Otherwise an abort
     * signal firing in that window would miss the (untracked) session and leave
     * it running/leaked.
     */

    function makeSessionWithAbort(textFn: (promptText: string) => string | undefined = () => 'done') {
      return Object.assign(makeSession(textFn), {
        abort: mock(async () => {}),
      });
    }

    it('adds the session to activeSessions before firing onAgentSpawn', async () => {
      const session = makeSessionWithAbort();
      setupHarnessMocks(session);

      const activeSessions = new Set<{ abort(): Promise<void> }>();
      let trackedAtSpawn = false;
      const execCtx = createStepExecutionContext({
        activeSessions,
        onStatus: {
          onAgentSpawn: () => {
            trackedAtSpawn = activeSessions.has(session);
          },
        } as unknown as StepExecutionContext['onStatus'],
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(trackedAtSpawn).toBe(true);
    });

    it('adds the session to activeSessions before firing onStepStart', async () => {
      const session = makeSessionWithAbort();
      setupHarnessMocks(session);

      const activeSessions = new Set<{ abort(): Promise<void> }>();
      let trackedAtStepStart = false;
      const execCtx = createStepExecutionContext({
        activeSessions,
        onStatus: {
          onStepStart: () => {
            trackedAtStepStart = activeSessions.has(session);
          },
        } as unknown as StepExecutionContext['onStatus'],
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(trackedAtStepStart).toBe(true);
    });

    it('keeps the session tracked across the first await (before prompt runs)', async () => {
      const session = makeSessionWithAbort();
      setupHarnessMocks(session);

      const activeSessions = new Set<{ abort(): Promise<void> }>();
      let trackedAtPrompt = false;
      const execCtx = createStepExecutionContext({ activeSessions });
      const profiles = createProfilesMap(defaultProfile);

      // buildPrompt is the first real await after activeSessions.add. If the
      // session were added only after that await resolved, an abort firing
      // during buildPrompt would miss it.
      session.prompt = mock(async () => {
        trackedAtPrompt = activeSessions.has(session);
      }) as unknown as typeof session.prompt;

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(trackedAtPrompt).toBe(true);
    });

    it('an abort triggered from onAgentSpawn reaches the already-tracked session', async () => {
      const abortFn = mock(async () => {});
      const session = Object.assign(
        makeSession(() => 'done'),
        { abort: abortFn },
      );
      setupHarnessMocks(session);

      const activeSessions = new Set<{ abort(): Promise<void> }>();
      const execCtx = createStepExecutionContext({
        activeSessions,
        onStatus: {
          // Mirrors the LanePool abort listener firing immediately after the
          // session is tracked (i.e. abort in the [tracked, prompt] window).
          onAgentSpawn: () => {
            for (const s of activeSessions) {
              s.abort().catch(() => {
                /* swallow — we're shutting down */
              });
            }
          },
        } as unknown as StepExecutionContext['onStatus'],
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(abortFn).toHaveBeenCalledTimes(1);
    });

    it('still removes the session from activeSessions when abort fires mid-run', async () => {
      const abortFn = mock(async () => {});
      const session = Object.assign(
        makeSession(() => 'done'),
        { abort: abortFn },
      );
      setupHarnessMocks(session);

      const activeSessions = new Set<{ abort(): Promise<void> }>();
      const execCtx = createStepExecutionContext({
        activeSessions,
        onStatus: {
          onAgentSpawn: () => {
            for (const s of activeSessions) {
              s.abort().catch(() => {
                /* swallow */
              });
            }
          },
        } as unknown as StepExecutionContext['onStatus'],
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      // The finally block must always remove the session so it can't be
      // re-aborted on a subsequent iteration of the abort listener.
      expect(activeSessions.size).toBe(0);
    });
  });

  // ─── Signal Abort TOCTOU Guard (non-structured step) ───────────────

  describe('signal abort TOCTOU guard', () => {
    /**
     * Right before `session.prompt()`, runStep checks `execCtx.signal?.aborted`
     * and throws AbortError. This closes the [session-tracked, prompt-started]
     * TOCTOU window: `abort()` on an idle (not-yet-streaming) agent is a no-op,
     * so without this explicit check an abort that fired after the session was
     * tracked would still launch an LLM turn. The guard lives in the
     * non-structured branch (structured steps route through promptForStructured).
     */

    it('throws an AbortError (DOMException) when the signal is already aborted before the prompt', async () => {
      const session = makeSession(() => 'should-not-be-used');
      setupHarnessMocks(session);

      const execCtx = createStepExecutionContext({ signal: AbortSignal.abort() });
      const profiles = createProfilesMap(defaultProfile);

      let caught: unknown;
      try {
        await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DOMException);
      expect((caught as DOMException).name).toBe('AbortError');
    });

    it('does not call session.prompt when the signal is already aborted', async () => {
      const session = makeSession(() => 'should-not-be-used');
      setupHarnessMocks(session);

      const execCtx = createStepExecutionContext({ signal: AbortSignal.abort() });
      const profiles = createProfilesMap(defaultProfile);

      await expect(runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx)).rejects.toThrow();

      expect(session.prompt).not.toHaveBeenCalled();
    });

    it('runs the prompt normally when the signal is present but not aborted', async () => {
      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const controller = new AbortController();
      const execCtx = createStepExecutionContext({ signal: controller.signal });
      const profiles = createProfilesMap(defaultProfile);

      const { result } = await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(result.type).toBe('approved');
    });

    it('runs the prompt normally when no signal is provided', async () => {
      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      const { result } = await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(result.type).toBe('approved');
    });

    it('fires onAgentSpawn and onStepStart before throwing (agent is tracked so it is abortable)', async () => {
      const session = makeSession(() => 'unused');
      setupHarnessMocks(session);

      const callOrder: string[] = [];
      const execCtx = createStepExecutionContext({
        signal: AbortSignal.abort(),
        onStatus: {
          onAgentSpawn: () => callOrder.push('spawn'),
          onStepStart: () => callOrder.push('stepStart'),
          onAgentComplete: () => callOrder.push('complete'),
        } as unknown as StepExecutionContext['onStatus'],
      });
      const profiles = createProfilesMap(defaultProfile);

      await expect(runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx)).rejects.toThrow();

      // The signal check is inside the try block AFTER spawn + stepStart, so the
      // agent is observable (and tracked in activeSessions) before the guard runs.
      expect(callOrder).toContain('spawn');
      expect(callOrder).toContain('stepStart');
      expect(callOrder.indexOf('stepStart')).toBeGreaterThan(callOrder.indexOf('spawn'));
    });

    it('still fires onAgentComplete in the finally block when aborted', async () => {
      const session = makeSession(() => 'unused');
      setupHarnessMocks(session);

      const onAgentComplete = mock(() => {});
      const execCtx = createStepExecutionContext({
        signal: AbortSignal.abort(),
        onStatus: { onAgentComplete } as unknown as StepExecutionContext['onStatus'],
      });
      const profiles = createProfilesMap(defaultProfile);

      await expect(runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx)).rejects.toThrow();

      expect(onAgentComplete).toHaveBeenCalledTimes(1);
    });

    it('removes the session from activeSessions even when aborted', async () => {
      const session = makeSession(() => 'unused');
      setupHarnessMocks(session);

      const activeSessions = new Set<{ abort(): Promise<void> }>();
      const execCtx = createStepExecutionContext({
        signal: AbortSignal.abort(),
        activeSessions,
      });
      const profiles = createProfilesMap(defaultProfile);

      await expect(runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx)).rejects.toThrow();

      expect(activeSessions.size).toBe(0);
    });

    it('disposes the session on the abort error path', async () => {
      const dispose = mock(() => {});
      const session = makeSession(() => 'unused');
      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose,
      });

      const execCtx = createStepExecutionContext({ signal: AbortSignal.abort() });
      const profiles = createProfilesMap(defaultProfile);

      await expect(runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx)).rejects.toThrow();

      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Error Handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('disposes session and rethrows when prompt throws', async () => {
      const dispose = mock(() => {});
      const session = makeSession(() => {
        throw new Error('Prompt failed');
      });
      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose,
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      await expect(runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx)).rejects.toThrow(
        'Prompt failed',
      );

      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('rethrows when createHarness throws', async () => {
      mockCreateHarness.mockRejectedValue(new Error('Harness creation failed'));

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      await expect(runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx)).rejects.toThrow(
        'Harness creation failed',
      );
    });
  });

  // ─── Tracked Session Return Value ────────────────────────────────────

  describe('tracked session return value', () => {
    it('returns trackedSession with session and dispose', async () => {
      const session = Object.assign(
        makeSession(() => 'done'),
        {
          abort: mock(async () => {}),
        },
      );
      const dispose = mock(() => {});
      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose,
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      const { trackedSession } = await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(trackedSession.session).toBe(session);
      expect(trackedSession.dispose).toBe(dispose);
    });

    it('returns sessionPath as sessionDir for new sessions', async () => {
      setupHarnessMocks();

      const execCtx = createStepExecutionContext({ sessionBaseDir: '/base' });
      const profiles = createProfilesMap(defaultProfile);

      const { trackedSession } = await runStep(
        makeTask({ id: 'task-1' }),
        baseStep,
        'lane-0',
        defaultCtx,
        profiles,
        execCtx,
      );

      expect(trackedSession.sessionPath).toContain('task-1');
      expect(trackedSession.sessionPath).toContain('implement');
    });

    it('returns existingSessionPath as sessionPath when resuming', async () => {
      setupHarnessMocks();

      const existingPath = '/base/task-1/0-0-implement';
      const execCtx = createStepExecutionContext({ sessionBaseDir: '/base' });
      const profiles = createProfilesMap(defaultProfile);

      const { trackedSession } = await runStep(
        makeTask({ id: 'task-1' }),
        baseStep,
        'lane-0',
        defaultCtx,
        profiles,
        execCtx,
        existingPath,
      );

      expect(trackedSession.sessionPath).toBe(existingPath);
    });
  });

  // ─── Prompt Building Integration ────────────────────────────────────

  describe('prompt building integration', () => {
    it('prompt includes task title, step name, and task prompt', async () => {
      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const task = makeTask({
        title: 'Build feature',
        prompt: 'Create a login page',
        files: ['src/login.ts'],
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      await runStep(task, baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      const promptedText = session.prompt.mock.calls[0][0] as string;
      expect(promptedText).toContain('## Task: Build feature');
      expect(promptedText).toContain('## Step: implement');
      expect(promptedText).toContain('Create a login page');
    });

    it('prompt includes review feedback when present', async () => {
      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const task = makeTask({
        reviewFeedback: ['Fix the null check', 'Add error handling'],
      });

      const execCtx = createStepExecutionContext();
      const profiles = createProfilesMap(defaultProfile);

      await runStep(task, baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      const promptedText = session.prompt.mock.calls[0][0] as string;
      expect(promptedText).toContain('Review Feedback History');
      expect(promptedText).toContain('Attempt 1: Fix the null check');
      expect(promptedText).toContain('Attempt 2: Add error handling');
    });
  });

  // ─── Renderer Invocation in Finally Block ──────────────────────────────

  describe('renderer invocation in runStep finally block', () => {
    const reviewSchema = z.object({
      approved: z.boolean(),
      feedback: z.string().optional(),
    });

    it('does not call onAgentRender when rendererRegistry is undefined', async () => {
      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const onAgentRender = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentRender } as unknown as StepExecutionContext['onStatus'],
        // rendererRegistry intentionally omitted → undefined
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(onAgentRender).not.toHaveBeenCalled();
    });

    it('does not call onAgentRender when no renderer registered for the profile', async () => {
      const registry = new RendererRegistry(); // empty — no renderers registered

      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const onAgentRender = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentRender } as unknown as StepExecutionContext['onStatus'],
        rendererRegistry: registry,
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(onAgentRender).not.toHaveBeenCalled();
    });

    it('calls render function with parsed JSON and fires onAgentRender when assistant text is valid JSON', async () => {
      const renderFn = mock((data: unknown) => `rendered:${JSON.stringify(data)}`);
      const registry = new RendererRegistry();
      registry.register('coder', renderFn);

      const jsonData = { approved: true, score: 9 };
      const session = makeSession(() => JSON.stringify(jsonData));
      setupHarnessMocks(session);

      const onAgentRender = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentRender } as unknown as StepExecutionContext['onStatus'],
        rendererRegistry: registry,
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(renderFn).toHaveBeenCalledTimes(1);
      // extractJsonFromText finds the JSON, JSON.parse parses it → data is the object
      expect(renderFn.mock.calls[0][0]).toEqual(jsonData);
      expect(onAgentRender).toHaveBeenCalledTimes(1);
      expect(onAgentRender).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'lane-0',
          profile: 'coder',
          taskId: 'task-1',
          rendered: `rendered:${JSON.stringify(jsonData)}`,
        }),
      );
    });

    it('calls render function with raw text when assistant text is non-JSON', async () => {
      const renderFn = mock((data: unknown) => `rendered:${JSON.stringify(data)}`);
      const registry = new RendererRegistry();
      registry.register('coder', renderFn);

      const rawText = 'The implementation looks correct but could use more comments.';
      const session = makeSession(() => rawText);
      setupHarnessMocks(session);

      const onAgentRender = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentRender } as unknown as StepExecutionContext['onStatus'],
        rendererRegistry: registry,
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(renderFn).toHaveBeenCalledTimes(1);
      // No JSON found by extractJsonFromText → data is the raw text
      expect(renderFn.mock.calls[0][0]).toBe(rawText);
      expect(onAgentRender).toHaveBeenCalledTimes(1);
      expect(onAgentRender).toHaveBeenCalledWith(
        expect.objectContaining({
          rendered: `rendered:${JSON.stringify(rawText)}`,
        }),
      );
    });

    it('does not fire onAgentRender when render function returns empty string', async () => {
      const registry = new RendererRegistry();
      registry.register('coder', () => '');

      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const onAgentRender = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentRender } as unknown as StepExecutionContext['onStatus'],
        rendererRegistry: registry,
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(onAgentRender).not.toHaveBeenCalled();
    });

    it('does not fire onAgentRender when render function returns undefined', async () => {
      const registry = new RendererRegistry();
      registry.register('coder', () => undefined as unknown as string);

      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const onAgentRender = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentRender } as unknown as StepExecutionContext['onStatus'],
        rendererRegistry: registry,
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(onAgentRender).not.toHaveBeenCalled();
    });

    it('fires onAgentRender before onAgentComplete (ordering)', async () => {
      const callOrder: string[] = [];
      const registry = new RendererRegistry();
      registry.register('coder', () => 'rendered output');

      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const execCtx = createStepExecutionContext({
        onStatus: {
          onAgentRender: () => callOrder.push('render'),
          onAgentComplete: () => callOrder.push('complete'),
        } as unknown as StepExecutionContext['onStatus'],
        rendererRegistry: registry,
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(callOrder).toEqual(['render', 'complete']);
    });

    it('fires onAgentRender on approved step (non-structured)', async () => {
      const registry = new RendererRegistry();
      registry.register('coder', () => 'rendered output');

      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const onAgentRender = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentRender } as unknown as StepExecutionContext['onStatus'],
        rendererRegistry: registry,
      });
      const profiles = createProfilesMap(defaultProfile);

      const { result } = await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      expect(result.type).toBe('approved');
      expect(onAgentRender).toHaveBeenCalledTimes(1);
    });

    it('fires onAgentRender on rejected step (structured)', async () => {
      const registry = new RendererRegistry();
      registry.register('reviewer', () => 'rendered review');

      const session = makeSession(() => 'done');
      // Override getLastAssistantText to return text even though promptForStructured is mocked
      session.getLastAssistantText = mock(() => '{"approved": false}');
      setupHarnessMocks(session);
      mockPromptForStructured.mockResolvedValue({
        result: { approved: false, feedback: 'Missing tests' },
        attempts: 1,
      });

      const onAgentRender = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentRender } as unknown as StepExecutionContext['onStatus'],
        rendererRegistry: registry,
      });
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      const { result } = await runStep(
        makeTask(),
        { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: reviewSchema },
        'lane-0',
        defaultCtx,
        profiles,
        execCtx,
      );

      expect(result.type).toBe('rejected');
      expect(onAgentRender).toHaveBeenCalledTimes(1);
    });

    it('passes correct agentId and taskId to onAgentRender', async () => {
      const registry = new RendererRegistry();
      registry.register('coder', () => 'rendered output');

      const session = makeSession(() => 'done');
      setupHarnessMocks(session);

      const onAgentRender = mock(() => {});
      const execCtx = createStepExecutionContext({
        onStatus: { onAgentRender } as unknown as StepExecutionContext['onStatus'],
        rendererRegistry: registry,
      });
      const profiles = createProfilesMap(defaultProfile);

      await runStep(makeTask({ id: 'my-task-99' }), baseStep, 'lane-3', defaultCtx, profiles, execCtx);

      expect(onAgentRender).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'lane-3',
          profile: 'coder',
          taskId: 'my-task-99',
        }),
      );
    });
  });

  // ─── Per-prompt timeout (stepTimeoutMs) ───────────────────────────────────

  describe('per-prompt timeout (stepTimeoutMs)', () => {
    /**
     * A session whose prompt() never resolves — simulates a hung LLM call.
     * The returned promise hangs forever, so the timeout should fire and abort it.
     */
    function makeNeverResolvingSession() {
      const session = {
        prompt: mock(() => new Promise<void>(() => {})), // never resolves
        getLastAssistantText: mock(() => undefined as string | undefined),
        sessionId: 'hung-session',
        subscribe: mock(() => () => {}),
        abort: mock(async () => {}),
        dispose: mock(() => {}),
      };
      return session;
    }

    it(
      'rejects with a timeout error when stepTimeoutMs is set and prompt hangs',
      async () => {
        const session = makeNeverResolvingSession();
        mockCreateHarness.mockResolvedValue({
          session,
          sessionId: 'hung-session',
          dispose: mock(() => {}),
        });

        const execCtx = createStepExecutionContext({ stepTimeoutMs: 10 });
        const profiles = createProfilesMap(defaultProfile);

        let caught: unknown;
        try {
          await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeDefined();
        expect((caught as Error).message).toMatch(/timed out|timeout/i);
      },
      { timeout: 5000 },
    );

    it(
      'aborts the session when the step timeout fires',
      async () => {
        const session = makeNeverResolvingSession();
        mockCreateHarness.mockResolvedValue({
          session,
          sessionId: 'hung-session',
          dispose: mock(() => {}),
        });

        const execCtx = createStepExecutionContext({ stepTimeoutMs: 10 });
        const profiles = createProfilesMap(defaultProfile);

        try {
          await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);
        } catch {
          // Expected — timeout error
        }

        // The timeout should have aborted the session
        expect(session.abort).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );

    it(
      'does not schedule a timeout when stepTimeoutMs is unset',
      async () => {
        let resolvePrompt!: () => void;
        const session = {
          prompt: mock(
            () =>
              new Promise<void>((resolve) => {
                resolvePrompt = resolve;
              }),
          ),
          getLastAssistantText: mock(() => 'done'),
          sessionId: 'slow-session',
          subscribe: mock(() => () => {}),
          abort: mock(async () => {}),
          dispose: mock(() => {}),
        };
        mockCreateHarness.mockResolvedValue({
          session,
          sessionId: 'slow-session',
          dispose: mock(() => {}),
        });

        const execCtx = createStepExecutionContext(); // no stepTimeoutMs
        const profiles = createProfilesMap(defaultProfile);

        const runPromise = runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

        // Wait 50ms — should NOT reject (no timeout timer)
        const result = await Promise.race([
          runPromise.then(() => 'resolved'),
          new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50)),
        ]);

        expect(result).toBe('pending');

        // Clean up: resolve the prompt so the runStep completes
        resolvePrompt();
        await runPromise;
      },
      { timeout: 5000 },
    );

    it(
      'does not schedule a timeout when stepTimeoutMs is 0',
      async () => {
        let resolvePrompt!: () => void;
        const session = {
          prompt: mock(
            () =>
              new Promise<void>((resolve) => {
                resolvePrompt = resolve;
              }),
          ),
          getLastAssistantText: mock(() => 'done'),
          sessionId: 'slow-session-0',
          subscribe: mock(() => () => {}),
          abort: mock(async () => {}),
          dispose: mock(() => {}),
        };
        mockCreateHarness.mockResolvedValue({
          session,
          sessionId: 'slow-session-0',
          dispose: mock(() => {}),
        });

        const execCtx = createStepExecutionContext({ stepTimeoutMs: 0 });
        const profiles = createProfilesMap(defaultProfile);

        const runPromise = runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

        const result = await Promise.race([
          runPromise.then(() => 'resolved'),
          new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50)),
        ]);

        expect(result).toBe('pending');

        resolvePrompt();
        await runPromise;
      },
      { timeout: 5000 },
    );

    it(
      'does not schedule a timeout when stepTimeoutMs is NaN',
      async () => {
        let resolvePrompt!: () => void;
        const session = {
          prompt: mock(
            () =>
              new Promise<void>((resolve) => {
                resolvePrompt = resolve;
              }),
          ),
          getLastAssistantText: mock(() => 'done'),
          sessionId: 'slow-session-nan',
          subscribe: mock(() => () => {}),
          abort: mock(async () => {}),
          dispose: mock(() => {}),
        };
        mockCreateHarness.mockResolvedValue({
          session,
          sessionId: 'slow-session-nan',
          dispose: mock(() => {}),
        });

        const execCtx = createStepExecutionContext({ stepTimeoutMs: NaN });
        const profiles = createProfilesMap(defaultProfile);

        const runPromise = runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

        const result = await Promise.race([
          runPromise.then(() => 'resolved'),
          new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50)),
        ]);

        expect(result).toBe('pending');

        resolvePrompt();
        await runPromise;
      },
      { timeout: 5000 },
    );

    it(
      'does not schedule a timeout when stepTimeoutMs is negative',
      async () => {
        let resolvePrompt!: () => void;
        const session = {
          prompt: mock(
            () =>
              new Promise<void>((resolve) => {
                resolvePrompt = resolve;
              }),
          ),
          getLastAssistantText: mock(() => 'done'),
          sessionId: 'slow-session-neg',
          subscribe: mock(() => () => {}),
          abort: mock(async () => {}),
          dispose: mock(() => {}),
        };
        mockCreateHarness.mockResolvedValue({
          session,
          sessionId: 'slow-session-neg',
          dispose: mock(() => {}),
        });

        const execCtx = createStepExecutionContext({ stepTimeoutMs: -100 });
        const profiles = createProfilesMap(defaultProfile);

        const runPromise = runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

        const result = await Promise.race([
          runPromise.then(() => 'resolved'),
          new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50)),
        ]);

        expect(result).toBe('pending');

        resolvePrompt();
        await runPromise;
      },
      { timeout: 5000 },
    );

    it('clears the timeout timer when prompt completes normally', async () => {
      const session = makeSession(() => 'done');
      const abortSpy = mock(async () => {});
      // Add abort spy to verify it is NOT called when the timer is properly cleared.
      (session as unknown as { abort: () => Promise<void> }).abort = abortSpy;
      setupHarnessMocks(session);

      const execCtx = createStepExecutionContext({ stepTimeoutMs: 50 });
      const profiles = createProfilesMap(defaultProfile);

      const { result } = await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);

      // The step completed normally — timeout did not fire
      expect(result.type).toBe('approved');

      // Wait past the step timeout to prove the timer was cleared — abort must
      // NOT have been called.
      await new Promise((r) => setTimeout(r, 100));
      expect(abortSpy).not.toHaveBeenCalled();
    });

    it('re-throws the prompt error (not the timeout error) when prompt fails before timeout', async () => {
      const session = makeSession(() => {
        throw new Error('LLM connection reset');
      });
      setupHarnessMocks(session);

      const execCtx = createStepExecutionContext({ stepTimeoutMs: 5000 });
      const profiles = createProfilesMap(defaultProfile);

      await expect(runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx)).rejects.toThrow(
        'LLM connection reset',
      );
    });

    it(
      'still fires onAgentComplete in finally when timeout fires',
      async () => {
        const session = makeNeverResolvingSession();
        mockCreateHarness.mockResolvedValue({
          session,
          sessionId: 'hung-session',
          dispose: mock(() => {}),
        });

        const onAgentComplete = mock(() => {});
        const execCtx = createStepExecutionContext({
          stepTimeoutMs: 10,
          onStatus: { onAgentComplete } as unknown as StepExecutionContext['onStatus'],
        });
        const profiles = createProfilesMap(defaultProfile);

        try {
          await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);
        } catch {
          // Expected
        }

        expect(onAgentComplete).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );

    it(
      'removes session from activeSessions when timeout fires',
      async () => {
        const session = makeNeverResolvingSession();
        mockCreateHarness.mockResolvedValue({
          session,
          sessionId: 'hung-session',
          dispose: mock(() => {}),
        });

        const activeSessions = new Set<{ abort(): Promise<void> }>();
        const execCtx = createStepExecutionContext({ stepTimeoutMs: 10, activeSessions });
        const profiles = createProfilesMap(defaultProfile);

        try {
          await runStep(makeTask(), baseStep, 'lane-0', defaultCtx, profiles, execCtx);
        } catch {
          // Expected
        }

        expect(activeSessions.size).toBe(0);
      },
      { timeout: 5000 },
    );
  });

  // ─── Per-prompt timeout (stepTimeoutMs) — promptForStructured path ────────

  describe('per-prompt timeout (stepTimeoutMs) — structured output path', () => {
    it('uses promptForStructured which respects stepTimeoutMs option', async () => {
      // This verifies that when step.schema is set, the timeout is passed to promptForStructured
      // We verify this via the mock: promptForStructured receives options including stepTimeoutMs
      setupHarnessMocks();
      mockPromptForStructured.mockResolvedValue({
        result: { approved: true },
        attempts: 1,
      });

      const reviewSchema = z.object({ approved: z.boolean() });
      const reviewStep: StepDefinition = {
        name: 'review',
        profileId: 'reviewer',
        isReadOnly: true,
        schema: reviewSchema,
      };

      const execCtx = createStepExecutionContext({ stepTimeoutMs: 3000 });
      const profiles = createProfilesMap(defaultProfile, reviewerProfile);

      await runStep(makeTask(), reviewStep, 'lane-0', defaultCtx, profiles, execCtx);

      // promptForStructured should have been called with stepTimeoutMs in its options
      expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
      const callArgs = mockPromptForStructured.mock.calls[0];
      const options = callArgs[3] as Record<string, unknown>;
      expect(options).toHaveProperty('stepTimeoutMs', 3000);
    });
  });
});

describe('buildExecCtx forwards worktreeManager', () => {
  /**
   * Minimal `TaskRunnerContext` with spyable completeTask/failTask callbacks.
   * Only the fields `buildExecCtx` reads are populated; optional fields default
   * to `undefined` unless overridden.
   */
  function makeRunnerContext(overrides?: Partial<TaskRunnerContext>): TaskRunnerContext {
    return {
      task: makeTask(),
      agentId: 'lane-0',
      profiles: new Map<string, AgentProfile>(),
      onStatus: undefined,
      activeSessions: new Set<{ abort(): Promise<void> }>(),
      phaseId: 'implementing',
      sessionBaseDir: '/tmp/sessions',
      cwd: '/tmp/project',
      maxStepRetries: 5,
      completeTask: mock(() => true),
      failTask: mock(() => {}),
      ...overrides,
    };
  }

  it('forwards worktreeManager from the runner context to the step execution context', () => {
    const wm = {} as WorktreeManager;
    const execCtx = buildExecCtx(makeRunnerContext({ worktreeManager: wm }));

    expect(execCtx.worktreeManager).toBe(wm);
  });

  it('leaves worktreeManager undefined when the runner context omits it', () => {
    const execCtx = buildExecCtx(makeRunnerContext());

    expect(execCtx.worktreeManager).toBeUndefined();
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../packages/engine/src/core/harness-factory.ts', () => realHarnessFactory);
  mock.module('../../packages/engine/src/core/structured-output.ts', () => realStructuredOutput);
});
