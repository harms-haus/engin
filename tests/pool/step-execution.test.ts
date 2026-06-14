import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import type { AgentProfile } from '../../src/core/types.js';
import { makeMockSession } from '../helpers/make-session.js';
import { makeTask } from '../helpers/make-task.js';

// Capture real modules before mocking
const realHarnessFactory = Object.assign({}, await import('../../src/core/harness-factory.ts'));
const realStructuredOutput = Object.assign({}, await import('../../src/core/structured-output.ts'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/harness-factory.ts', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/structured-output.ts', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import type { StepExecutionContext } from '../../src/pool/step-execution.js';
import { runStep } from '../../src/pool/step-execution.ts';
import type { StepDefinition } from '../../src/pool/types.js';

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
          phase: 'implementing',
          taskId: 'task-1',
        }),
      );
      // Verify sessionId is present (from mocked harness)
      const callArg = onAgentSpawn.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.sessionId).toBe('test-session');
      expect(typeof callArg.sessionPath).toBe('string');
    });

    it('fires onAgentComplete with sessionId after execution', async () => {
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
          phase: 'implementing',
          taskId: 'task-1',
        }),
      );
      // Verify sessionId is present (from mocked harness)
      const callArg = onAgentComplete.mock.calls[0][0] as Record<string, unknown>;
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
      const session = makeSession(() => 'done');
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
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../src/core/harness-factory.ts', () => realHarnessFactory);
  mock.module('../../src/core/structured-output.ts', () => realStructuredOutput);
});
