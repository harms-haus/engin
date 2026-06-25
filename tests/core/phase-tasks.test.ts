// ─── runStepTask Tests ──────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { RenderFunction } from '../../packages/engine/src/core/renderer-registry.js';
import { RendererRegistry } from '../../packages/engine/src/core/renderer-registry.js';
import type { AgentProfile, AgentStatusCallbacks, StatusCallbacks } from '../../packages/engine/src/core/types.js';
import type { WorktreeManager } from '../../packages/engine/src/core/worktree-manager.js';
import { makeMockSession } from '../helpers/make-session.js';

// Capture real modules before mocking so we can restore them in afterAll.
// Without the restore, these relative-path mock.module() registrations leak
// into sibling test files (structured-output.test.ts, etc.) under CI's
// parallel scheduling.
const realProfile = Object.assign({}, await import('../../packages/engine/src/core/profile.js'));
const realAgentRegistry = Object.assign({}, await import('../../packages/engine/src/core/agent-registry.js'));
const realStructuredOutput = Object.assign({}, await import('../../packages/engine/src/core/structured-output.js'));

// ─── Mock Dependencies ─────────────────────────────────────────────────────

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../packages/engine/src/core/profile.js', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

// Compatibility shim: the production code resolves sessions via
// `requireAgentPlugin(profile.agent).createSession(opts)`. We mock the
// registry so `createSession` delegates to `mockCreateHarness` — whose
// return value `{ session, sessionId, dispose }` is unwrapped to the inner
// `session` (the AgentRuntime), matching the real `createSession` contract.
const mockRequireAgentPlugin = mock((..._args: unknown[]) => ({
  id: 'pi-coding-agent',
  createSession: async (opts: unknown) => {
    const w = (await mockCreateHarness(opts)) as {
      session: Record<string, unknown>;
      sessionId?: string;
      dispose?: () => void;
      contextWindow?: number;
    };
    // Propagate wrapper-level fields onto the inner session IN-PLACE so the
    // same object reference is tracked in activeSessions AND spawnAgent's
    // session.dispose() / session.sessionId observe the wrapper's mock.
    if (w.dispose) (w.session as { dispose: () => void }).dispose = w.dispose;
    if (w.sessionId) (w.session as { sessionId: string }).sessionId = w.sessionId;
    if (w.contextWindow !== undefined) (w.session as { contextWindow: number }).contextWindow = w.contextWindow;
    return w.session;
  },
}));
mock.module('../../packages/engine/src/core/agent-registry.js', () => ({
  requireAgentPlugin: (...args: unknown[]) => mockRequireAgentPlugin(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../packages/engine/src/core/structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
  // Expose the real extractJsonFromText so the renderer-invocation logic can
  // exercise realistic JSON extraction without an extra mock to maintain.
  extractJsonFromText: realStructuredOutput.extractJsonFromText,
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import type { RunStepTaskOptions } from '../../packages/engine/src/core/phase-tasks.js';
import { runMultiStepTask, runStepTask } from '../../packages/engine/src/core/phase-tasks.js';
import type { HookRegistry } from '../../packages/engine/src/hooks/types.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

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

/**
 * Test-only augmentation so `rendererRegistry` can be supplied before the
 * production RunStepTaskOptions type declares it. Once the field is added to
 * RunStepTaskOptions this intersection becomes a harmless no-op.
 */
type StepTaskOptionsWithRenderer = RunStepTaskOptions & { rendererRegistry?: RendererRegistry };

function makeDefaultOptions(overrides?: Partial<StepTaskOptionsWithRenderer>): StepTaskOptionsWithRenderer {
  return {
    profilesDirs: ['/tmp/profiles'],
    phaseId: 'test-phase',
    taskId: 'task-1',
    title: 'Test Task',
    stepName: 'implement',
    profileId: 'coder',
    cwd: '/tmp/project',
    prompt: 'Do the thing',
    ...overrides,
  };
}

function setupProfilesMock(...profiles: AgentProfile[]) {
  const map = new Map<string, AgentProfile>();
  for (const p of profiles) {
    map.set(p.id, p);
  }
  mockLoadProfilesFromDirs.mockResolvedValue(map);
}

function setupHarnessMock(session?: ReturnType<typeof makeMockSession>['session']) {
  const sess = session ?? makeMockSession().session;
  mockCreateHarness.mockResolvedValue({
    session: sess,
    sessionId: 'test-session',
    dispose: mock(() => {}),
  });
  return sess;
}

/**
 * Minimal mock WorktreeManager exposing only the three per-task lifecycle
 * methods that phase-tasks.ts consumes (`createTaskWorktree`,
 * `mergeTaskBranch`, `cullTaskWorktree`). Each is a `bun:test` mock so tests
 * can assert call counts/args and the create→spawn→merge/cull ordering.
 *
 * Cast to `WorktreeManager` at the call site (it only implements the subset
 * of methods phase-tasks touches).
 */
function makeMockWorktreeManager(opts?: {
  worktreePath?: string;
  mainWorktreePath?: string;
  mergeResult?: { success: boolean; conflictsResolved: boolean };
  mergeError?: Error;
  createError?: Error;
}) {
  const worktreePath = opts?.worktreePath ?? '/tmp/worktree/task-1';
  const createTaskWorktree = mock(async (_taskId: string, _prompt?: string) => {
    if (opts?.createError) throw opts.createError;
    return worktreePath;
  });
  const mergeTaskBranch = mock(async (_taskId: string) => {
    if (opts?.mergeError) throw opts.mergeError;
    return opts?.mergeResult ?? { success: true, conflictsResolved: false };
  });
  const cullTaskWorktree = mock(async (_taskId: string) => undefined);
  return {
    createTaskWorktree,
    mergeTaskBranch,
    cullTaskWorktree,
    mainWorktreePath: opts?.mainWorktreePath ?? '/tmp/worktree',
  };
}

function createStatusCallbacksSpy(): StatusCallbacks & {
  callOrder: string[];
  onTaskRegister: ReturnType<typeof mock>;
  onTaskStart: ReturnType<typeof mock>;
  onTaskComplete: ReturnType<typeof mock>;
  onTaskRejected: ReturnType<typeof mock>;
  onAgentSpawn: ReturnType<typeof mock>;
  onAgentComplete: ReturnType<typeof mock>;
  onAgentRender: ReturnType<typeof mock>;
  onDecision: ReturnType<typeof mock>;
  onStepStart: ReturnType<typeof mock>;
  onTurnStart: ReturnType<typeof mock>;
  onTurnEnd: ReturnType<typeof mock>;
  onToolCallStart: ReturnType<typeof mock>;
  onToolCallEnd: ReturnType<typeof mock>;
} {
  const callOrder: string[] = [];
  const track = (name: string) => {
    callOrder.push(name);
  };

  const callbacks = {
    callOrder,
    onTaskRegister: mock(() => {
      track('onTaskRegister');
    }),
    onTaskStart: mock(() => {
      track('onTaskStart');
    }),
    onTaskComplete: mock(() => {
      track('onTaskComplete');
    }),
    onTaskRejected: mock(() => {
      track('onTaskRejected');
    }),
    onAgentSpawn: mock(() => {
      track('onAgentSpawn');
    }),
    onAgentComplete: mock(() => {
      track('onAgentComplete');
    }),
    onAgentRender: mock(() => {
      track('onAgentRender');
    }),
    onDecision: mock(() => {
      track('onDecision');
    }),
    onStepStart: mock(() => {
      track('onStepStart');
    }),
    onTurnStart: mock(() => {
      track('onTurnStart');
    }),
    onTurnEnd: mock(() => {
      track('onTurnEnd');
    }),
    onToolCallStart: mock(() => {
      track('onToolCallStart');
    }),
    onToolCallEnd: mock(() => {
      track('onToolCallEnd');
    }),
  };

  return callbacks as unknown as StatusCallbacks & {
    callOrder: string[];
    onTaskRegister: ReturnType<typeof mock>;
    onTaskStart: ReturnType<typeof mock>;
    onTaskComplete: ReturnType<typeof mock>;
    onTaskRejected: ReturnType<typeof mock>;
    onAgentSpawn: ReturnType<typeof mock>;
    onAgentComplete: ReturnType<typeof mock>;
    onAgentRender: ReturnType<typeof mock>;
    onDecision: ReturnType<typeof mock>;
    onStepStart: ReturnType<typeof mock>;
    onTurnStart: ReturnType<typeof mock>;
    onTurnEnd: ReturnType<typeof mock>;
    onToolCallStart: ReturnType<typeof mock>;
    onToolCallEnd: ReturnType<typeof mock>;
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockLoadProfilesFromDirs.mockClear();
  mockCreateHarness.mockClear();
  mockPromptForStructured.mockClear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runStepTask', () => {
  // ─── Early Abort ──────────────────────────────────────────────────────

  describe('early abort', () => {
    it('throws AbortError without firing any callbacks when signal is already aborted', async () => {
      const signal = AbortSignal.abort();
      const onStatus = createStatusCallbacksSpy();

      const opts = makeDefaultOptions({ signal, onStatus: onStatus as unknown as StatusCallbacks });

      await expect(runStepTask(opts)).rejects.toThrow(DOMException);
      expect(onStatus.onTaskRegister).not.toHaveBeenCalled();
      expect(onStatus.onTaskStart).not.toHaveBeenCalled();
      expect(onStatus.onAgentSpawn).not.toHaveBeenCalled();
      expect(onStatus.onStepStart).not.toHaveBeenCalled();
      expect(onStatus.onTaskRejected).not.toHaveBeenCalled();
      expect(onStatus.onTaskComplete).not.toHaveBeenCalled();
    });
  });

  // ─── Registration and Start ───────────────────────────────────────────

  describe('registration and start callbacks', () => {
    it('fires onTaskRegister with correct structure before any other callbacks', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(onStatus.onTaskRegister).toHaveBeenCalledTimes(1);
      const registerCall = onStatus.onTaskRegister.mock.calls[0]![0] as Record<string, unknown>;
      expect(registerCall.taskId).toBe('task-1');
      expect(registerCall.phaseId).toBe('test-phase');
      expect(registerCall.title).toBe('Test Task');
      expect(registerCall.dependencies).toEqual([]);
      expect(registerCall.steps).toEqual([{ name: 'implement', profileId: 'coder', isReadOnly: false }]);

      expect(onStatus.onTaskStart).toHaveBeenCalledTimes(1);
      const startCall = onStatus.onTaskStart.mock.calls[0]![0] as Record<string, unknown>;
      expect(startCall.taskId).toBe('task-1');
      expect(startCall.title).toBe('Test Task');
      expect(startCall.agentId).toBe('task-1');
      expect(startCall.phaseId).toBe('test-phase');
      expect(typeof startCall.startedAt).toBe('number');
    });

    it('fires onTaskRegister before onTaskStart', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      const registerIdx = onStatus.callOrder.indexOf('onTaskRegister');
      const startIdx = onStatus.callOrder.indexOf('onTaskStart');
      expect(registerIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThan(registerIdx);
    });
  });

  // ─── Profile Loading ──────────────────────────────────────────────────

  describe('profile loading', () => {
    it('loads profiles from the specified directories', async () => {
      const profiles = new Map<string, AgentProfile>();
      profiles.set('coder', defaultProfile);
      mockLoadProfilesFromDirs.mockResolvedValue(profiles);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions({ profilesDirs: ['/custom/path'] }));

      expect(mockLoadProfilesFromDirs).toHaveBeenCalledWith(['/custom/path']);
    });

    it('throws when profile is not found and fires onTaskRejected', async () => {
      setupProfilesMock(defaultProfile); // only 'coder' is loaded
      const onStatus = createStatusCallbacksSpy();

      const opts = makeDefaultOptions({
        profileId: 'nonexistent',
        onStatus: onStatus as unknown as StatusCallbacks,
      });

      await expect(runStepTask(opts)).rejects.toThrow('Profile "nonexistent" not found');
      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      const rejectCall = onStatus.onTaskRejected.mock.calls[0]![0] as Record<string, unknown>;
      expect(rejectCall.taskId).toBe('task-1');
      expect(rejectCall.title).toBe('Test Task');
      expect(rejectCall.reason).toContain('Profile "nonexistent" not found');
    });
  });

  // ─── Read-Only Profile Adjustment ─────────────────────────────────────

  describe('isReadOnly profile adjustment', () => {
    it('strips write and edit tools when isReadOnly is true', async () => {
      const profileWithTools: AgentProfile = {
        ...defaultProfile,
        excludeTools: ['bash'],
      };
      setupProfilesMock(profileWithTools);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions({ isReadOnly: true }));

      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      const adjustedProfile = harnessCall.profile as AgentProfile;
      expect(adjustedProfile.excludeTools).toContain('bash');
      expect(adjustedProfile.excludeTools).toContain('write');
      expect(adjustedProfile.excludeTools).toContain('edit');
    });

    it('does not modify excludeTools when isReadOnly is false', async () => {
      const profileWithTools: AgentProfile = {
        ...defaultProfile,
        excludeTools: ['bash'],
      };
      setupProfilesMock(profileWithTools);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions({ isReadOnly: false }));

      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      const adjustedProfile = harnessCall.profile as AgentProfile;
      expect(adjustedProfile.excludeTools).toEqual(['bash']);
      expect(adjustedProfile.excludeTools).not.toContain('write');
    });

    it('defaults isReadOnly to false', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions({ isReadOnly: undefined }));

      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      const adjustedProfile = harnessCall.profile as AgentProfile;
      expect(adjustedProfile.excludeTools).not.toContain('write');
      expect(adjustedProfile.excludeTools).not.toContain('edit');
    });
  });

  // ─── Harness Creation ────────────────────────────────────────────────

  describe('harness creation', () => {
    it('creates harness with adjusted profile and correct options', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      const apiKeys = { openai: 'sk-test' };
      await runStepTask(makeDefaultOptions({ apiKeys }));

      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessCall.cwd).toBe('/tmp/project');
      expect(harnessCall.apiKeys).toEqual({ openai: 'sk-test' });
      expect(harnessCall.agentId).toBe('task-1');
      expect(harnessCall.profile).toBeDefined();
    });

    it('forwards agent status callbacks via forwardAgentStatus', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      // onAgentStatus should be an object with turn/ tool callbacks
      expect(harnessCall.onAgentStatus).toBeDefined();
      expect(typeof (harnessCall.onAgentStatus as AgentStatusCallbacks).onTurnStart).toBe('function');
      expect(typeof (harnessCall.onAgentStatus as AgentStatusCallbacks).onTurnEnd).toBe('function');
      expect(typeof (harnessCall.onAgentStatus as AgentStatusCallbacks).onToolCallStart).toBe('function');
      expect(typeof (harnessCall.onAgentStatus as AgentStatusCallbacks).onToolCallEnd).toBe('function');
    });

    it('passes undefined onAgentStatus when onStatus is not provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions({ onStatus: undefined }));

      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessCall.onAgentStatus).toBeUndefined();
    });

    it('derives a persisted sessionDir from sessionBaseDir and passes it to the harness', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions({ sessionBaseDir: '/work/sessions' }));

      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      // Mirrors runMultiStepTask: {sessionBaseDir}/{taskId}/{stepName}
      expect(harnessCall.sessionDir).toBe(join('/work/sessions', 'task-1', 'implement'));
    });

    it('does not pass sessionDir when sessionBaseDir is absent (in-memory session)', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions());

      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessCall.sessionDir).toBeUndefined();
    });
  });

  // ─── Agent Spawn and Step Start ──────────────────────────────────────

  describe('agent spawn and step start callbacks', () => {
    it('fires onAgentSpawn with correct fields', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(onStatus.onAgentSpawn).toHaveBeenCalledTimes(1);
      const spawnCall = onStatus.onAgentSpawn.mock.calls[0]![0] as Record<string, unknown>;
      expect(spawnCall.agentId).toBe('task-1');
      expect(spawnCall.profile).toBe('coder');
      expect(spawnCall.phaseId).toBe('test-phase');
      expect(spawnCall.taskId).toBe('task-1');
      expect(spawnCall.stepIndex).toBe(0);
      expect(spawnCall.sessionId).toBe('test-session');
      expect(spawnCall.sessionPath).toBe('test-session');
    });

    it('fires onStepStart with correct fields', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(onStatus.onStepStart).toHaveBeenCalledTimes(1);
      const stepStartCall = onStatus.onStepStart.mock.calls[0]![0] as Record<string, unknown>;
      expect(stepStartCall.taskId).toBe('task-1');
      expect(stepStartCall.stepIndex).toBe(0);
      expect(stepStartCall.stepName).toBe('implement');
      expect(stepStartCall.agentId).toBe('task-1');
    });

    it('fires onAgentSpawn before onStepStart', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      const spawnIdx = onStatus.callOrder.indexOf('onAgentSpawn');
      const stepStartIdx = onStatus.callOrder.indexOf('onStepStart');
      expect(spawnIdx).toBeGreaterThanOrEqual(0);
      expect(stepStartIdx).toBeGreaterThan(spawnIdx);
    });
  });

  // ─── Non-Structured Execution ────────────────────────────────────────

  describe('non-structured execution', () => {
    it('calls session.prompt with the prompt text and returns assistant text', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => 'implementation done').session;
      setupHarnessMock(session);

      const result = await runStepTask<string>(makeDefaultOptions());

      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(session.prompt).toHaveBeenCalledWith('Do the thing');
      expect(session.getLastAssistantText).toHaveBeenCalledTimes(1);
      expect(result).toBe('implementation done');
    });

    it('does not call promptForStructured when schema is not provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions());

      expect(mockPromptForStructured).not.toHaveBeenCalled();
    });
  });

  // ─── Structured Execution ────────────────────────────────────────────

  describe('structured execution', () => {
    it('calls promptForStructured with the correct schema and returns the result', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession().session;
      setupHarnessMock(session);

      const schema = z.object({ approved: z.boolean() });
      const expectedResult = { approved: true };
      mockPromptForStructured.mockResolvedValue({ result: expectedResult, attempts: 1 });

      const result = await runStepTask(makeDefaultOptions({ schema: schema as unknown as ZodType<unknown> }));

      expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
      const structuredCall = mockPromptForStructured.mock.calls[0];
      expect(structuredCall[0]).toBe(session); // harness
      expect(structuredCall[1]).toBe('Do the thing'); // prompt
      expect(structuredCall[2]).toBe(schema); // schema
      expect(structuredCall[3]).toEqual({ maxRetries: 3 }); // options
      expect(result).toEqual(expectedResult);
    });

    it('does not call session.prompt when schema is provided', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession().session;
      setupHarnessMock(session);
      mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });

      await runStepTask(
        makeDefaultOptions({ schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown> }),
      );

      expect(session.prompt).not.toHaveBeenCalled();
    });
  });

  // ─── validateOutput (file-based output) ──────────────────────────────

  describe('validateOutput (file-based output)', () => {
    it('re-prompts within the same session when validateOutput fails, then succeeds', async () => {
      setupProfilesMock(defaultProfile);
      let calls = 0;
      const session = makeMockSession(() => `attempt ${++calls}`).session;
      setupHarnessMock(session);

      let gateCalls = 0;
      const validateOutput = mock(() => {
        gateCalls++;
        // Fail twice, succeed on the third.
        return gateCalls < 3 ? { error: 'plan missing' } : undefined;
      });

      const result = await runStepTask<string>(makeDefaultOptions({ validateOutput: validateOutput as never }));

      // 3 agent turns total: initial + 2 retries.
      expect(session.prompt).toHaveBeenCalledTimes(3);
      // Retry prompts append the error feedback.
      const prompts = (session.prompt as ReturnType<typeof mock>).mock.calls.map((c) => c[0] as string);
      expect(prompts[0]).toBe('Do the thing'); // first attempt is the bare prompt
      expect(prompts[1]).toContain('Previous attempt failed validation');
      expect(prompts[1]).toContain('plan missing');
      expect(prompts[2]).toContain('Previous attempt failed validation');
      // validateOutput called once per turn.
      expect(validateOutput).toHaveBeenCalledTimes(3);
      // Returns the last assistant text.
      expect(result).toBe('attempt 3');
    });

    it('throws and fires onTaskRejected when validateOutput never succeeds (3 attempts)', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => 'still bad').session;
      setupHarnessMock(session);

      const validateOutput = mock(() => ({ error: 'invalid schema' }));
      const onStatus = createStatusCallbacksSpy();

      await expect(
        runStepTask(
          makeDefaultOptions({
            validateOutput: validateOutput as never,
            onStatus: onStatus as unknown as StatusCallbacks,
          }),
        ),
      ).rejects.toThrow(/failed validation after 3 attempts: invalid schema/);

      expect(session.prompt).toHaveBeenCalledTimes(3);
      expect(validateOutput).toHaveBeenCalledTimes(3);
      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      expect((onStatus.onTaskRejected.mock.calls[0]![0] as Record<string, unknown>).reason).toContain('invalid schema');
    });

    it('does not re-prompt when validateOutput passes on the first attempt', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => 'done').session;
      setupHarnessMock(session);

      const validateOutput = mock(() => undefined);
      await runStepTask(makeDefaultOptions({ validateOutput: validateOutput as never }));

      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(validateOutput).toHaveBeenCalledTimes(1);
    });

    it('supports async validateOutput', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => 'done').session;
      setupHarnessMock(session);

      const validateOutput = mock(async () => undefined);
      await runStepTask(makeDefaultOptions({ validateOutput: validateOutput as never }));

      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(validateOutput).toHaveBeenCalledTimes(1);
    });

    it('is ignored when schema is also provided (structured output wins)', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession().session;
      setupHarnessMock(session);
      mockPromptForStructured.mockResolvedValue({ result: { ok: true }, attempts: 1 });

      const validateOutput = mock(() => undefined);
      await runStepTask(
        makeDefaultOptions({
          schema: z.object({ ok: z.boolean() }) as unknown as ZodType<unknown>,
          validateOutput: validateOutput as never,
        }),
      );

      // Structured path taken; validateOutput never consulted.
      expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
      expect(validateOutput).not.toHaveBeenCalled();
    });
  });

  // ─── Error Handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('fires onTaskRejected and re-throws when profile loading fails', async () => {
      const onStatus = createStatusCallbacksSpy();
      mockLoadProfilesFromDirs.mockRejectedValue(new Error('Disk error'));

      await expect(
        runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks })),
      ).rejects.toThrow('Disk error');

      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      const rejectCall = onStatus.onTaskRejected.mock.calls[0]![0] as Record<string, unknown>;
      expect(rejectCall.taskId).toBe('task-1');
      expect(rejectCall.reason).toBe('Disk error');
    });

    it('fires onTaskRejected and re-throws when createHarness fails', async () => {
      setupProfilesMock(defaultProfile);
      mockCreateHarness.mockRejectedValue(new Error('Model not found'));

      const onStatus = createStatusCallbacksSpy();

      await expect(
        runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks })),
      ).rejects.toThrow('Model not found');

      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      const rejectCall = onStatus.onTaskRejected.mock.calls[0]![0] as Record<string, unknown>;
      expect(rejectCall.reason).toBe('Model not found');
    });

    it('fires onTaskRejected and re-throws when prompt fails', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession().session;
      setupHarnessMock(session);
      (session.prompt as ReturnType<typeof mock>).mockRejectedValue(new Error('API error'));

      const onStatus = createStatusCallbacksSpy();

      await expect(
        runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks })),
      ).rejects.toThrow('API error');

      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      const rejectCall = onStatus.onTaskRejected.mock.calls[0]![0] as Record<string, unknown>;
      expect(rejectCall.reason).toBe('API error');
    });

    it('fires onTaskRejected and re-throws when promptForStructured fails', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession().session;
      setupHarnessMock(session);
      mockPromptForStructured.mockRejectedValue(new Error('Schema validation failed'));

      const onStatus = createStatusCallbacksSpy();

      await expect(
        runStepTask(
          makeDefaultOptions({
            schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown>,
            onStatus: onStatus as unknown as StatusCallbacks,
          }),
        ),
      ).rejects.toThrow('Schema validation failed');

      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      const rejectCall = onStatus.onTaskRejected.mock.calls[0]![0] as Record<string, unknown>;
      expect(rejectCall.reason).toBe('Schema validation failed');
    });

    it('does not fire onTaskComplete when an error occurs', async () => {
      setupProfilesMock(defaultProfile);
      mockCreateHarness.mockRejectedValue(new Error('fail'));

      const onStatus = createStatusCallbacksSpy();

      await expect(
        runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks })),
      ).rejects.toThrow();

      expect(onStatus.onTaskComplete).not.toHaveBeenCalled();
    });
  });

  // ─── Finally Block ──────────────────────────────────────────────────

  describe('finally block', () => {
    it('fires onAgentComplete and disposes harness even on success', async () => {
      setupProfilesMock(defaultProfile);
      const disposeMock = mock(() => {});
      mockCreateHarness.mockResolvedValue({
        session: makeMockSession().session,
        sessionId: 'test-session',
        dispose: disposeMock,
      });

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(onStatus.onAgentComplete).toHaveBeenCalledTimes(1);
      const completeCall = onStatus.onAgentComplete.mock.calls[0]![0] as Record<string, unknown>;
      expect(completeCall.agentId).toBe('task-1');
      expect(completeCall.profile).toBe('coder');
      expect(completeCall.phaseId).toBe('test-phase');
      expect(completeCall.taskId).toBe('task-1');
      expect(completeCall.stepIndex).toBe(0);

      expect(disposeMock).toHaveBeenCalledTimes(1);
    });

    it('fires onAgentComplete and disposes harness even on error', async () => {
      setupProfilesMock(defaultProfile);
      const disposeMock = mock(() => {});
      mockCreateHarness.mockResolvedValue({
        session: makeMockSession().session,
        sessionId: 'test-session',
        dispose: disposeMock,
      });
      // Make prompt fail
      const session = makeMockSession().session;
      (session.prompt as ReturnType<typeof mock>).mockRejectedValue(new Error('fail'));
      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose: disposeMock,
      });

      const onStatus = createStatusCallbacksSpy();

      await expect(
        runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks })),
      ).rejects.toThrow('fail');

      expect(onStatus.onAgentComplete).toHaveBeenCalledTimes(1);
      const completeCall = onStatus.onAgentComplete.mock.calls[0]![0] as Record<string, unknown>;
      expect(completeCall.stepIndex).toBe(0);
      expect(disposeMock).toHaveBeenCalledTimes(1);
    });

    it('fires onAgentComplete before disposing the harness', async () => {
      setupProfilesMock(defaultProfile);
      const callOrder: string[] = [];
      const disposeMock = mock(() => {
        callOrder.push('dispose');
      });
      const onStatusSpy = {
        ...createStatusCallbacksSpy(),
        onAgentComplete: mock(() => {
          callOrder.push('onAgentComplete');
        }),
      };
      mockCreateHarness.mockResolvedValue({
        session: makeMockSession().session,
        sessionId: 'test-session',
        dispose: disposeMock,
      });

      await runStepTask(makeDefaultOptions({ onStatus: onStatusSpy as unknown as StatusCallbacks }));

      expect(callOrder).toEqual(['onAgentComplete', 'dispose']);
    });
  });

  // ─── Success Path ────────────────────────────────────────────────────

  describe('success path', () => {
    it('fires onTaskComplete after the result is ready', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      const onStatus = createStatusCallbacksSpy();
      const result = await runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      // onTaskComplete should be the last callback
      const completeIdx = onStatus.callOrder.indexOf('onTaskComplete');
      const agentCompleteIdx = onStatus.callOrder.indexOf('onAgentComplete');
      expect(completeIdx).toBeGreaterThan(agentCompleteIdx);

      expect(onStatus.onTaskComplete).toHaveBeenCalledTimes(1);
      const completeCall = onStatus.onTaskComplete.mock.calls[0]![0] as Record<string, unknown>;
      expect(completeCall.taskId).toBe('task-1');
      expect(completeCall.title).toBe('Test Task');

      expect(result).toBe('ok');
    });

    it('returns the result from the agent', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => 'custom result').session;
      setupHarnessMock(session);

      const result = await runStepTask<string>(makeDefaultOptions());
      expect(result).toBe('custom result');
    });

    it('returns structured result when schema is provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const structuredResult = { approved: true, feedback: 'Looks good' };
      mockPromptForStructured.mockResolvedValue({ result: structuredResult, attempts: 1 });

      const result = await runStepTask(
        makeDefaultOptions({
          schema: z.object({ approved: z.boolean(), feedback: z.string() }) as unknown as ZodType<unknown>,
        }),
      );
      expect(result).toEqual(structuredResult);
    });
  });

  // ─── Full Lifecycle Order ───────────────────────────────────────────

  describe('callback lifecycle order', () => {
    it('fires callbacks in the correct order on success', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      const expectedOrder = [
        'onTaskRegister',
        'onTaskStart',
        'onAgentSpawn',
        'onStepStart',
        'onAgentComplete',
        'onTaskComplete',
      ];

      // Get the actual order of events that were fired
      const actualOrder = onStatus.callOrder.filter((name) => expectedOrder.includes(name));
      expect(actualOrder).toEqual(expectedOrder);
    });

    it('fires onTaskRejected instead of onTaskComplete on failure', async () => {
      setupProfilesMock(defaultProfile);
      mockCreateHarness.mockRejectedValue(new Error('fail'));

      const onStatus = createStatusCallbacksSpy();
      await expect(
        runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks })),
      ).rejects.toThrow();

      // onTaskComplete should NOT be fired
      expect(onStatus.onTaskComplete).not.toHaveBeenCalled();
      // onTaskRejected should be fired
      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
    });
  });

  // ─── No Status Callbacks ─────────────────────────────────────────────

  describe('without status callbacks', () => {
    it('completes successfully when onStatus is undefined', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => 'no callbacks').session;
      setupHarnessMock(session);

      const result = await runStepTask(makeDefaultOptions({ onStatus: undefined }));
      expect(result).toBe('no callbacks');
    });

    it('re-throws error when onStatus is undefined', async () => {
      setupProfilesMock(defaultProfile);
      mockCreateHarness.mockRejectedValue(new Error('fail no status'));

      await expect(runStepTask(makeDefaultOptions({ onStatus: undefined }))).rejects.toThrow('fail no status');
    });
  });

  // ─── API Keys ────────────────────────────────────────────────────────

  describe('apiKeys', () => {
    it('passes apiKeys through to createHarness', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions({ apiKeys: { anthropic: 'sk-test' } }));

      expect(mockCreateHarness).toHaveBeenCalledWith(expect.objectContaining({ apiKeys: { anthropic: 'sk-test' } }));
    });

    it('works when apiKeys is not provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions({ apiKeys: undefined }));

      expect(mockCreateHarness).toHaveBeenCalledWith(expect.objectContaining({ apiKeys: undefined }));
    });
  });

  // ─── Renderer Invocation ─────────────────────────────────────────────

  describe('renderer invocation', () => {
    it('fires onAgentRender with the rendered output when rendererRegistry has a renderer for the profileId', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => '{"summary":"done"}').session;
      setupHarnessMock(session);

      const registry = new RendererRegistry();
      registry.register('coder', (data) => {
        const d = data as { summary?: string };
        return `## ${d.summary ?? 'unknown'}`;
      });

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(
        makeDefaultOptions({ rendererRegistry: registry, onStatus: onStatus as unknown as StatusCallbacks }),
      );

      expect(onStatus.onAgentRender).toHaveBeenCalledTimes(1);
      const renderCall = onStatus.onAgentRender.mock.calls[0]![0] as Record<string, unknown>;
      expect(renderCall.agentId).toBe('task-1');
      expect(renderCall.profile).toBe('coder');
      expect(renderCall.taskId).toBe('task-1');
      expect(renderCall.rendered).toBe('## done');
    });

    it('does not fire onAgentRender when rendererRegistry is not provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(makeDefaultOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(onStatus.onAgentRender).not.toHaveBeenCalled();
    });

    it('does not fire onAgentRender when rendererRegistry has no renderer for the profileId', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => '{"x":1}').session;
      setupHarnessMock(session);

      const renderSpy = mock((_data: unknown) => 'should-not-be-called');
      const registry = new RendererRegistry();
      registry.register('other-profile', renderSpy as unknown as RenderFunction);

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(
        makeDefaultOptions({ rendererRegistry: registry, onStatus: onStatus as unknown as StatusCallbacks }),
      );

      expect(renderSpy).not.toHaveBeenCalled();
      expect(onStatus.onAgentRender).not.toHaveBeenCalled();
    });

    it('passes parsed JSON data to the render function', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => '{"approved":true,"count":3}').session;
      setupHarnessMock(session);

      const renderSpy = mock((_data: unknown) => 'rendered');
      const registry = new RendererRegistry();
      registry.register('coder', renderSpy as unknown as RenderFunction);

      await runStepTask(makeDefaultOptions({ rendererRegistry: registry }));

      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(renderSpy).toHaveBeenCalledWith({ approved: true, count: 3 });
    });

    it('does not fire onAgentRender when the render function returns an empty string', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => '{"x":1}').session;
      setupHarnessMock(session);

      const renderSpy = mock((_data: unknown) => '');
      const registry = new RendererRegistry();
      registry.register('coder', renderSpy as unknown as RenderFunction);

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(
        makeDefaultOptions({ rendererRegistry: registry, onStatus: onStatus as unknown as StatusCallbacks }),
      );

      // The renderer is still invoked...
      expect(renderSpy).toHaveBeenCalledTimes(1);
      // ...but an empty result suppresses the render event.
      expect(onStatus.onAgentRender).not.toHaveBeenCalled();
    });

    it('returns the original result unchanged when a renderer is invoked', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => 'raw assistant text').session;
      setupHarnessMock(session);

      const registry = new RendererRegistry();
      registry.register('coder', () => 'RENDERED OUTPUT');

      const result = await runStepTask<string>(makeDefaultOptions({ rendererRegistry: registry }));

      // runStepTask must return the agent result, not the rendered string.
      expect(result).toBe('raw assistant text');
    });

    it('does not invoke the renderer when getLastAssistantText returns no text', async () => {
      setupProfilesMock(defaultProfile);
      // Structured path: the mocked promptForStructured never calls session.prompt,
      // so getLastAssistantText() returns undefined.
      const session = makeMockSession().session;
      setupHarnessMock(session);
      mockPromptForStructured.mockResolvedValue({ result: { ok: true }, attempts: 1 });

      const renderSpy = mock((_data: unknown) => 'rendered');
      const registry = new RendererRegistry();
      registry.register('coder', renderSpy as unknown as RenderFunction);

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(
        makeDefaultOptions({
          schema: z.object({ ok: z.boolean() }) as unknown as ZodType<unknown>,
          rendererRegistry: registry,
          onStatus: onStatus as unknown as StatusCallbacks,
        }),
      );

      expect(renderSpy).not.toHaveBeenCalled();
      expect(onStatus.onAgentRender).not.toHaveBeenCalled();
    });

    it('invokes the renderer in the structured path when getLastAssistantText returns text', async () => {
      setupProfilesMock(defaultProfile);
      const jsonText = '{"approved":true,"count":3}';
      const session = {
        prompt: mock(async () => {}),
        getLastAssistantText: mock(() => jsonText),
        sessionId: 'test-session',
        subscribe: mock(() => () => {}),
        dispose: mock(() => {}),
      };
      mockCreateHarness.mockResolvedValue({
        session,
        sessionId: 'test-session',
        dispose: mock(() => {}),
      });
      mockPromptForStructured.mockResolvedValue({ result: { approved: true, count: 3 }, attempts: 1 });

      const renderSpy = mock((_data: unknown) => 'RENDERED');
      const registry = new RendererRegistry();
      registry.register('coder', renderSpy as unknown as RenderFunction);

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(
        makeDefaultOptions({
          schema: z.object({ approved: z.boolean(), count: z.number() }) as unknown as ZodType<unknown>,
          rendererRegistry: registry,
          onStatus: onStatus as unknown as StatusCallbacks,
        }),
      );

      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(renderSpy).toHaveBeenCalledWith({ approved: true, count: 3 });
      expect(onStatus.onAgentRender).toHaveBeenCalledTimes(1);
      expect((onStatus.onAgentRender.mock.calls[0]![0] as Record<string, unknown>).rendered).toBe('RENDERED');
    });

    it('fires onAgentRender after the prompt completes and before onAgentComplete', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => '{"summary":"done"}').session;
      setupHarnessMock(session);

      const registry = new RendererRegistry();
      registry.register('coder', () => '## done');

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(
        makeDefaultOptions({ rendererRegistry: registry, onStatus: onStatus as unknown as StatusCallbacks }),
      );

      const renderIdx = onStatus.callOrder.indexOf('onAgentRender');
      const stepStartIdx = onStatus.callOrder.indexOf('onStepStart');
      const agentCompleteIdx = onStatus.callOrder.indexOf('onAgentComplete');
      const taskCompleteIdx = onStatus.callOrder.indexOf('onTaskComplete');

      expect(renderIdx).toBeGreaterThanOrEqual(0);
      expect(renderIdx).toBeGreaterThan(stepStartIdx);
      expect(agentCompleteIdx).toBeGreaterThan(renderIdx);
      expect(taskCompleteIdx).toBeGreaterThan(renderIdx);
    });
  });

  // ─── Worktree Lifecycle ─────────────────────────────────────────────
  //
  // When `worktreeManager` is provided, runStepTask must: create a per-task
  // worktree BEFORE spawning the agent, run the agent with cwd = the worktree
  // path (and allowedWriteDirs = [worktreePath]), merge the task branch on
  // success (rejecting the task if the merge fails), and cull the worktree on
  // any error. The persisted sessionDir is derived from sessionBaseDir and
  // must NOT be rewired to the worktree path.

  describe('worktree lifecycle', () => {
    // ── creation & cwd/write-dir wiring ──────────────────────────────

    it('calls createTaskWorktree(taskId, prompt) before spawnAgent when worktreeManager is provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      await runStepTask(
        makeDefaultOptions({
          worktreeManager: wtm as unknown as WorktreeManager,
          taskId: 'task-1',
          prompt: 'Do the thing',
        }),
      );

      // createTaskWorktree receives BOTH the taskId and the prompt.
      expect(wtm.createTaskWorktree).toHaveBeenCalledTimes(1);
      expect(wtm.createTaskWorktree).toHaveBeenCalledWith('task-1', 'Do the thing');
      // ...and the harness was spawned exactly once afterwards.
      expect(mockCreateHarness).toHaveBeenCalledTimes(1);
    });

    it('uses the returned worktree path as the agent cwd when worktreeManager is provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      await runStepTask(makeDefaultOptions({ worktreeManager: wtm as unknown as WorktreeManager }));

      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessCall.cwd).toBe('/wt/task-1');
      // The caller's original cwd is NOT passed through.
      expect(harnessCall.cwd).not.toBe('/tmp/project');
    });

    it('sets allowedWriteDirs to [worktreePath] when worktreeManager is provided and caller omits allowedWriteDirs', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      await runStepTask(
        makeDefaultOptions({
          worktreeManager: wtm as unknown as WorktreeManager,
          allowedWriteDirs: undefined,
        }),
      );

      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessCall.allowedWriteDirs).toEqual(['/wt/task-1']);
    });

    it('overrides caller-provided allowedWriteDirs with [worktreePath] when worktreeManager is provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      await runStepTask(
        makeDefaultOptions({
          worktreeManager: wtm as unknown as WorktreeManager,
          allowedWriteDirs: ['/caller/dir'],
        }),
      );

      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      // The worktree path replaces any caller-supplied write dirs.
      expect(harnessCall.allowedWriteDirs).toEqual(['/wt/task-1']);
      expect(harnessCall.allowedWriteDirs).not.toContain('/caller/dir');
    });

    // ── success path: merge ──────────────────────────────────────────

    it('calls mergeTaskBranch(taskId) on success and fires onTaskComplete when worktreeManager is provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      const onStatus = createStatusCallbacksSpy();
      await runStepTask(
        makeDefaultOptions({
          worktreeManager: wtm as unknown as WorktreeManager,
          onStatus: onStatus as unknown as StatusCallbacks,
        }),
      );

      expect(wtm.mergeTaskBranch).toHaveBeenCalledTimes(1);
      expect(wtm.mergeTaskBranch).toHaveBeenCalledWith('task-1');
      // phase-tasks does NOT cull on the success path (the real mergeTaskBranch
      // culls internally on success; that is out of scope here).
      expect(wtm.cullTaskWorktree).not.toHaveBeenCalled();
      expect(onStatus.onTaskComplete).toHaveBeenCalledTimes(1);
    });

    it('returns the agent result unchanged when worktreeManager is provided and the merge succeeds', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => 'agent output').session;
      setupHarnessMock(session);
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      const result = await runStepTask<string>(
        makeDefaultOptions({ worktreeManager: wtm as unknown as WorktreeManager }),
      );

      expect(result).toBe('agent output');
    });

    // ── absence: behavior unchanged ──────────────────────────────────

    it('does not invoke any worktree methods when worktreeManager is absent', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager();

      await runStepTask(makeDefaultOptions({ worktreeManager: undefined }));

      expect(wtm.createTaskWorktree).not.toHaveBeenCalled();
      expect(wtm.mergeTaskBranch).not.toHaveBeenCalled();
      expect(wtm.cullTaskWorktree).not.toHaveBeenCalled();
    });

    it('uses the caller-provided cwd (no worktree substitution) when worktreeManager is absent', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();

      await runStepTask(makeDefaultOptions({ worktreeManager: undefined, allowedWriteDirs: ['/keep'] }));

      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessCall.cwd).toBe('/tmp/project');
      expect(harnessCall.allowedWriteDirs).toEqual(['/keep']);
    });

    // ── interactions with other features ─────────────────────────────

    it('keeps sessionDir derived from sessionBaseDir (not the worktree path) when worktreeManager is provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      await runStepTask(
        makeDefaultOptions({
          worktreeManager: wtm as unknown as WorktreeManager,
          sessionBaseDir: '/work/sessions',
        }),
      );

      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      // cwd is the worktree path...
      expect(harnessCall.cwd).toBe('/wt/task-1');
      // ...but the persisted session dir still points at the run dir (NOT the worktree).
      expect(harnessCall.sessionDir).toBe(join('/work/sessions', 'task-1', 'implement'));
      expect(harnessCall.sessionDir).not.toContain('/wt/task-1');
    });

    it('merges after structured (schema) output succeeds when worktreeManager is provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      await runStepTask(
        makeDefaultOptions({
          worktreeManager: wtm as unknown as WorktreeManager,
          schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown>,
        }),
      );

      // Structured path ran in the worktree cwd, then merged on success.
      expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessCall.cwd).toBe('/wt/task-1');
      expect(wtm.mergeTaskBranch).toHaveBeenCalledTimes(1);
    });

    it('merges after validateOutput retries succeed when worktreeManager is provided', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession(() => 'plan written').session;
      setupHarnessMock(session);
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      const validateOutput = mock(() => undefined);
      await runStepTask(
        makeDefaultOptions({
          worktreeManager: wtm as unknown as WorktreeManager,
          validateOutput: validateOutput as never,
        }),
      );

      // File-output path ran in the worktree cwd, then merged on success.
      expect(validateOutput).toHaveBeenCalledTimes(1);
      const harnessCall = mockCreateHarness.mock.calls[0]![0] as Record<string, unknown>;
      expect(harnessCall.cwd).toBe('/wt/task-1');
      expect(wtm.mergeTaskBranch).toHaveBeenCalledTimes(1);
    });

    it('runs assertSafeName on the taskId when sessionBaseDir and worktreeManager are both provided (valid name passes)', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      // A safe taskId with sessionBaseDir must NOT throw from assertSafeName.
      await expect(
        runStepTask(
          makeDefaultOptions({
            worktreeManager: wtm as unknown as WorktreeManager,
            taskId: 'task-1',
            stepName: 'implement',
            sessionBaseDir: '/work/sessions',
          }),
        ),
      ).resolves.toBe('ok');
    });

    it('throws via assertSafeName for a path-traversal taskId when sessionBaseDir and worktreeManager are both provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      // An unsafe taskId must be rejected by assertSafeName (it interpolates
      // into the sessionBaseDir path). This guards path-traversal even when
      // a worktreeManager is in play.
      await expect(
        runStepTask(
          makeDefaultOptions({
            worktreeManager: wtm as unknown as WorktreeManager,
            taskId: 'task/../evil',
            sessionBaseDir: '/work/sessions',
          }),
        ),
      ).rejects.toThrow(/unsafe characters/i);

      // The session dir is never built, so no merge should be attempted.
      expect(wtm.mergeTaskBranch).not.toHaveBeenCalled();
    });

    // ── failure paths: cull + reject ─────────────────────────────────

    it('throws the createTaskWorktree error when worktree creation fails (worktreeManager provided)', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1', createError: new Error('wt create failed') });

      await expect(
        runStepTask(makeDefaultOptions({ worktreeManager: wtm as unknown as WorktreeManager })),
      ).rejects.toThrow('wt create failed');

      // Creation was attempted...
      expect(wtm.createTaskWorktree).toHaveBeenCalledTimes(1);
      // ...but since no worktree was created, nothing is merged.
      expect(wtm.mergeTaskBranch).not.toHaveBeenCalled();
      // (Whether the cull/reject path engages on a creation failure depends on
      // whether createTaskWorktree sits inside or before the try block — the
      // spec places it before the try block, so those are intentionally not
      // asserted here to avoid over-constraining the implementation.)
    });

    it('culls the worktree and fires onTaskRejected (not onTaskComplete) when worktreeManager is provided and the agent prompt fails', async () => {
      setupProfilesMock(defaultProfile);
      const session = makeMockSession().session;
      setupHarnessMock(session);
      (session.prompt as ReturnType<typeof mock>).mockRejectedValue(new Error('API error'));
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      const onStatus = createStatusCallbacksSpy();
      await expect(
        runStepTask(
          makeDefaultOptions({
            worktreeManager: wtm as unknown as WorktreeManager,
            onStatus: onStatus as unknown as StatusCallbacks,
          }),
        ),
      ).rejects.toThrow('API error');

      // Worktree was created (before the failure)...
      expect(wtm.createTaskWorktree).toHaveBeenCalledTimes(1);
      // ...the agent failed, so no merge is attempted...
      expect(wtm.mergeTaskBranch).not.toHaveBeenCalled();
      // ...and the failure path force-culls the worktree (best-effort).
      expect(wtm.cullTaskWorktree).toHaveBeenCalledTimes(1);
      expect(wtm.cullTaskWorktree).toHaveBeenCalledWith('task-1');

      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      const rejectCall = onStatus.onTaskRejected.mock.calls[0]![0] as Record<string, unknown>;
      expect(rejectCall.reason).toBe('API error');
      expect(onStatus.onTaskComplete).not.toHaveBeenCalled();
    });

    it('culls the worktree when worktreeManager is provided and createHarness fails', async () => {
      setupProfilesMock(defaultProfile);
      mockCreateHarness.mockRejectedValue(new Error('harness boom'));
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/task-1' });

      await expect(
        runStepTask(makeDefaultOptions({ worktreeManager: wtm as unknown as WorktreeManager })),
      ).rejects.toThrow('harness boom');

      expect(wtm.createTaskWorktree).toHaveBeenCalledTimes(1);
      expect(wtm.mergeTaskBranch).not.toHaveBeenCalled();
      expect(wtm.cullTaskWorktree).toHaveBeenCalledTimes(1);
      expect(wtm.cullTaskWorktree).toHaveBeenCalledWith('task-1');
    });

    it('rejects the task (not completes) when mergeTaskBranch returns failure (conflicts unresolved) and worktreeManager is provided', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({
        worktreePath: '/wt/task-1',
        mergeResult: { success: false, conflictsResolved: false },
      });

      const onStatus = createStatusCallbacksSpy();
      await expect(
        runStepTask(
          makeDefaultOptions({
            worktreeManager: wtm as unknown as WorktreeManager,
            onStatus: onStatus as unknown as StatusCallbacks,
          }),
        ),
      ).rejects.toThrow(/merge failed/i);

      // The agent produced its result, so a merge was attempted...
      expect(wtm.mergeTaskBranch).toHaveBeenCalledTimes(1);
      expect(wtm.mergeTaskBranch).toHaveBeenCalledWith('task-1');
      // ...but it failed, so the task is rejected rather than completed.
      expect(onStatus.onTaskComplete).not.toHaveBeenCalled();
      // Exactly one rejection: the catch block owns onTaskRejected. A second
      // call would indicate the merge-failure path is redundantly firing it.
      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      const rejectReasons = onStatus.onTaskRejected.mock.calls.map((c) => (c[0] as { reason?: string }).reason ?? '');
      expect(rejectReasons.some((r) => r.toLowerCase().includes('merge failed'))).toBe(true);
    });

    it('culls the worktree and fires onTaskRejected when mergeTaskBranch throws on the success path (worktreeManager provided)', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      const wtm = makeMockWorktreeManager({
        worktreePath: '/wt/task-1',
        mergeError: new Error('merge threw'),
      });

      const onStatus = createStatusCallbacksSpy();
      await expect(
        runStepTask(
          makeDefaultOptions({
            worktreeManager: wtm as unknown as WorktreeManager,
            onStatus: onStatus as unknown as StatusCallbacks,
          }),
        ),
      ).rejects.toThrow('merge threw');

      // Merge was attempted (the agent had succeeded)...
      expect(wtm.mergeTaskBranch).toHaveBeenCalledTimes(1);
      expect(wtm.mergeTaskBranch).toHaveBeenCalledWith('task-1');
      // ...but it threw, so the task is rejected and the worktree culled.
      expect(onStatus.onTaskComplete).not.toHaveBeenCalled();
      expect(onStatus.onTaskRejected).toHaveBeenCalled();
      const rejectReasons = onStatus.onTaskRejected.mock.calls.map((c) => (c[0] as { reason?: string }).reason ?? '');
      expect(rejectReasons.some((r) => r.toLowerCase().includes('merge threw'))).toBe(true);
      expect(wtm.cullTaskWorktree).toHaveBeenCalledTimes(1);
      expect(wtm.cullTaskWorktree).toHaveBeenCalledWith('task-1');
    });

    // ── path relativization ─────────────────────────────────────────

    it('relativizes absolute worktree paths in the structured result (runStepTask)', async () => {
      setupProfilesMock(defaultProfile);
      setupHarnessMock();
      mockPromptForStructured.mockResolvedValue({
        result: { files: ['/wt/task-1/src/changed.ts'], summary: '/wt/main/README.md' },
        attempts: 1,
      });
      const wtm = makeMockWorktreeManager({
        worktreePath: '/wt/task-1',
        mainWorktreePath: '/wt/main',
      });

      const result = await runStepTask(
        makeDefaultOptions({
          worktreeManager: wtm as unknown as WorktreeManager,
          schema: z.object({ files: z.array(z.string()), summary: z.string() }) as unknown as ZodType<unknown>,
        }),
      );

      // Pins the contract: the structured result's absolute worktree paths
      // are relativized to repo-relative tails before the step returns.
      expect(result).toEqual({
        files: ['src/changed.ts'],
        summary: 'README.md',
      });
    });
  });
});

// ─── runMultiStepTask Tests ────────────────────────────────────────────────

describe('runMultiStepTask', () => {
  // Two profiles so each step gets a distinct agent, mirroring plan → review-plan.
  const plannerProfile: AgentProfile = { ...defaultProfile, id: 'planner', name: 'Planner' };
  const reviewerProfile: AgentProfile = { ...defaultProfile, id: 'reviewer', name: 'Reviewer' };

  // Map profile id → session so createHarness returns the right session per step.
  function setupSessionPerProfile(sessions: {
    planner?: ReturnType<typeof makeMockSession>['session'];
    reviewer?: ReturnType<typeof makeMockSession>['session'];
  }) {
    const planner = sessions.planner ?? makeMockSession(() => 'plan-text').session;
    const reviewer = sessions.reviewer ?? makeMockSession().session;
    mockCreateHarness.mockImplementation(async (opts: { profile: AgentProfile }) => ({
      session: opts.profile.id === 'planner' ? planner : reviewer,
      sessionId: opts.profile.id,
      dispose: mock(() => {}),
    }));
    return { planner, reviewer };
  }

  function makeTwoStepOptions(overrides?: {
    reviewerResult?: unknown;
    isApproved?: (r: unknown) => boolean;
    getFeedback?: (r: unknown) => string;
    onStatus?: StatusCallbacks;
    maxStepRetries?: number;
  }) {
    return {
      profilesDirs: ['/tmp/profiles'],
      phaseId: 'plan-phase',
      taskId: 'planning',
      title: 'Plan & Review',
      cwd: '/tmp/project',
      steps: [
        { stepName: 'plan', profileId: 'planner', prompt: 'Write the plan', isReadOnly: false },
        {
          stepName: 'review-plan',
          profileId: 'reviewer',
          prompt: 'Review the plan',
          isReadOnly: true,
          schema: z.object({ ready: z.boolean() }) as unknown as ZodType<unknown>,
          isApproved: overrides?.isApproved ?? ((r: unknown) => (r as { ready?: boolean }).ready === true),
          getFeedback: overrides?.getFeedback ?? ((r: unknown) => (r as { feedback?: string }).feedback ?? 'rejected'),
        },
      ],
      onStatus: overrides?.onStatus,
      maxStepRetries: overrides?.maxStepRetries,
    };
  }

  beforeEach(() => {
    // mockClear() (file-level beforeEach) does NOT reset implementations, so
    // reset explicitly — these tests rely on precise mockResolvedValueOnce chains.
    mockLoadProfilesFromDirs.mockReset();
    mockCreateHarness.mockReset();
    mockPromptForStructured.mockReset();
    mockLoadProfilesFromDirs.mockResolvedValue(
      new Map([
        ['planner', plannerProfile],
        ['reviewer', reviewerProfile],
      ]),
    );
    // Happy-path default: the reviewer step (structured output) approves.
    mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });
  });

  // ── Registration ──────────────────────────────────────────────────────

  describe('registration', () => {
    it('registers ONE task with every step', async () => {
      setupSessionPerProfile({});
      const onStatus = createStatusCallbacksSpy();
      await runMultiStepTask(makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(onStatus.onTaskRegister).toHaveBeenCalledTimes(1);
      const reg = onStatus.onTaskRegister.mock.calls[0]![0] as Record<string, unknown>;
      expect(reg.taskId).toBe('planning');
      expect(reg.phaseId).toBe('plan-phase');
      expect(reg.title).toBe('Plan & Review');
      expect(reg.dependencies).toEqual([]);
      expect(reg.steps).toEqual([
        { name: 'plan', profileId: 'planner', isReadOnly: false },
        { name: 'review-plan', profileId: 'reviewer', isReadOnly: true },
      ]);
    });

    it('fires onTaskStart exactly once and onTaskComplete exactly once on success', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });
      const onStatus = createStatusCallbacksSpy();
      const res = await runMultiStepTask(makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(onStatus.onTaskStart).toHaveBeenCalledTimes(1);
      expect(onStatus.onTaskComplete).toHaveBeenCalledTimes(1);
      expect(res.approved).toBe(true);
      expect(res.results).toHaveLength(2);
    });
  });

  // ── One agent per step ──────────────────────────────────────────────

  describe('per-step agents', () => {
    it('creates a fresh harness (own session) per step, each with the step profile', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });
      const onStatus = createStatusCallbacksSpy();
      await runMultiStepTask(makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      // Two steps → two distinct agent spawns with distinct profiles + stepIndex.
      expect(mockCreateHarness).toHaveBeenCalledTimes(2);
      const profilesUsed = mockCreateHarness.mock.calls.map((c) => (c[0] as { profile: AgentProfile }).profile.id);
      expect(profilesUsed).toEqual(['planner', 'reviewer']);

      expect(onStatus.onAgentSpawn).toHaveBeenCalledTimes(2);
      const spawn0 = onStatus.onAgentSpawn.mock.calls[0]![0] as Record<string, unknown>;
      const spawn1 = onStatus.onAgentSpawn.mock.calls[1]![0] as Record<string, unknown>;
      expect(spawn0.profile).toBe('planner');
      expect(spawn0.stepIndex).toBe(0);
      expect(spawn1.profile).toBe('reviewer');
      expect(spawn1.stepIndex).toBe(1);
      expect(onStatus.onStepStart).toHaveBeenCalledTimes(2);
    });

    it('strips write/edit for read-only steps but not write steps', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });
      await runMultiStepTask(makeTwoStepOptions());

      const planProfile = (mockCreateHarness.mock.calls[0]![0] as { profile: AgentProfile }).profile;
      const reviewProfile = (mockCreateHarness.mock.calls[1]![0] as { profile: AgentProfile }).profile;
      expect(planProfile.excludeTools).not.toContain('write');
      expect(reviewProfile.excludeTools).toContain('write');
      expect(reviewProfile.excludeTools).toContain('edit');
    });

    it('fires onAgentComplete + disposes once per step (two harnesses disposed)', async () => {
      const disposeMock = mock(() => {});
      mockCreateHarness.mockImplementation(async (opts: { profile: AgentProfile }) => ({
        session: makeMockSession().session,
        sessionId: opts.profile.id,
        dispose: disposeMock,
      }));
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });
      const onStatus = createStatusCallbacksSpy();
      await runMultiStepTask(makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(onStatus.onAgentComplete).toHaveBeenCalledTimes(2);
      // Each step should carry the correct stepIndex
      const step0Call = onStatus.onAgentComplete.mock.calls[0]![0] as Record<string, unknown>;
      const step1Call = onStatus.onAgentComplete.mock.calls[1]![0] as Record<string, unknown>;
      expect(step0Call.stepIndex).toBe(0);
      expect(step1Call.stepIndex).toBe(1);
      expect(disposeMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── Lazy prompts ─────────────────────────────────────────────────────

  describe('lazy prompt functions', () => {
    it('evaluates a step prompt function at run time with prior step results', async () => {
      const planner = makeMockSession(() => 'PLAN-OUTPUT').session;
      const reviewer = makeMockSession().session;
      mockCreateHarness.mockImplementation(async (opts: { profile: AgentProfile }) => ({
        session: opts.profile.id === 'planner' ? planner : reviewer,
        sessionId: opts.profile.id,
        dispose: mock(() => {}),
      }));
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });

      const reviewerPrompt = mock((prior: unknown[]) => `Review: ${JSON.stringify(prior)}`);
      await runMultiStepTask({
        profilesDirs: ['/tmp/profiles'],
        phaseId: 'plan-phase',
        taskId: 'planning',
        title: 'Plan & Review',
        cwd: '/tmp',
        steps: [
          { stepName: 'plan', profileId: 'planner', prompt: 'Write the plan' },
          {
            stepName: 'review-plan',
            profileId: 'reviewer',
            prompt: reviewerPrompt as unknown as string,
            isReadOnly: true,
            schema: z.object({ ready: z.boolean() }) as unknown as ZodType<unknown>,
            isApproved: (r) => (r as { ready?: boolean }).ready === true,
            getFeedback: (r) => (r as { feedback?: string }).feedback ?? 'rejected',
          },
        ],
      });

      // The review prompt saw the planner step's result.
      expect(reviewerPrompt).toHaveBeenCalledTimes(1);
      expect(reviewerPrompt.mock.calls[0][0]).toEqual(['PLAN-OUTPUT']);
      // promptForStructured received the resolved (string) prompt, not the function.
      expect(typeof mockPromptForStructured.mock.calls[0][1]).toBe('string');
      expect(mockPromptForStructured.mock.calls[0][1]).toContain('Review:');
    });
  });

  // ── Approval gate + back-up ─────────────────────────────────────────

  describe('approval gate and back-up', () => {
    it('backs up to the previous step and re-runs it with feedback when a gate rejects', async () => {
      const planner = makeMockSession(() => 'plan-text').session;
      setupSessionPerProfile({ planner });
      // Reviewer rejects twice, then approves.
      mockPromptForStructured
        .mockResolvedValueOnce({ result: { ready: false, feedback: 'too vague' }, attempts: 1 })
        .mockResolvedValueOnce({ result: { ready: false, feedback: 'still vague' }, attempts: 1 })
        .mockResolvedValueOnce({ result: { ready: true }, attempts: 1 });

      const onStatus = createStatusCallbacksSpy();
      const res = await runMultiStepTask(makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(res.approved).toBe(true);
      // 2 rejections → planner re-ran twice after the initial = 3 planner runs.
      const plannerPrompts = (planner.prompt as ReturnType<typeof mock>).mock.calls.map((c) => c[0] as string);
      expect(plannerPrompts).toHaveLength(3);
      expect(plannerPrompts[0]).not.toContain('Review Feedback History');
      expect(plannerPrompts[1]).toContain('Review Feedback History');
      expect(plannerPrompts[1]).toContain('too vague');
      expect(plannerPrompts[2]).toContain('still vague');
      // A decision was logged for each rejection (2).
      expect(onStatus.onDecision).toHaveBeenCalledTimes(2);
    });

    it('returns approved=false and fires onTaskRejected when retries exhaust', async () => {
      setupSessionPerProfile({});
      // Reviewer always rejects.
      mockPromptForStructured.mockResolvedValue({ result: { ready: false, feedback: 'nope' }, attempts: 1 });

      const onStatus = createStatusCallbacksSpy();
      const res = await runMultiStepTask(makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }));

      expect(res.approved).toBe(false);
      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      expect(onStatus.onTaskComplete).not.toHaveBeenCalled();
      // default maxStepRetries=3 → 3 rejections.
      expect(onStatus.onDecision).toHaveBeenCalledTimes(3);
    });

    it('respects a custom maxStepRetries', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: false, feedback: 'nope' }, attempts: 1 });

      const onStatus = createStatusCallbacksSpy();
      const res = await runMultiStepTask({
        ...makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }),
        maxStepRetries: 1,
      });

      expect(res.approved).toBe(false);
      expect(onStatus.onDecision).toHaveBeenCalledTimes(1);
    });
  });

  // ── validateOutput step ─────────────────────────────────────────────

  describe('validateOutput step', () => {
    it('runs a file-output step (no schema) and returns its assistant text', async () => {
      const session = makeMockSession(() => 'wrote plan.json').session;
      mockCreateHarness.mockResolvedValue({ session, sessionId: 's', dispose: mock(() => {}) });
      const validateOutput = mock(() => undefined);

      const res = await runMultiStepTask({
        profilesDirs: ['/tmp/profiles'],
        phaseId: 'p',
        taskId: 't',
        title: 'T',
        cwd: '/tmp',
        steps: [
          { stepName: 'plan', profileId: 'planner', prompt: 'write it', validateOutput: validateOutput as never },
        ],
      });

      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(validateOutput).toHaveBeenCalledTimes(1);
      expect(res.results[0]).toBe('wrote plan.json');
      expect(res.approved).toBe(true);
    });
  });

  // ── Abort & empty steps ──────────────────────────────────────────────

  describe('edge cases', () => {
    it('throws AbortError with no callbacks when signal is already aborted', async () => {
      const onStatus = createStatusCallbacksSpy();
      await expect(
        runMultiStepTask({
          ...makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }),
          signal: AbortSignal.abort(),
        }),
      ).rejects.toThrow(DOMException);
      expect(onStatus.onTaskRegister).not.toHaveBeenCalled();
    });

    it('throws when no steps are provided', async () => {
      const onStatus = createStatusCallbacksSpy();
      await expect(
        runMultiStepTask({
          profilesDirs: ['/tmp'],
          phaseId: 'p',
          taskId: 't',
          title: 'T',
          cwd: '/tmp',
          steps: [],
          onStatus: onStatus as unknown as StatusCallbacks,
        }),
      ).rejects.toThrow('no steps');
      expect(onStatus.onTaskRegister).not.toHaveBeenCalled();
    });
  });

  // ── Worktree lifecycle ─────────────────────────────────────────────

  describe('worktree lifecycle', () => {
    it('creates one task worktree before the first step when worktreeManager is provided, and runs every step in it', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/planning' });

      await runMultiStepTask({
        ...makeTwoStepOptions(),
        worktreeManager: wtm as unknown as WorktreeManager,
      });

      // Exactly ONE worktree for the whole task (not one per step).
      expect(wtm.createTaskWorktree).toHaveBeenCalledTimes(1);
      expect(wtm.createTaskWorktree.mock.calls[0]![0]).toBe('planning');

      // Every step's agent runs with cwd = the worktree path.
      const cwds = mockCreateHarness.mock.calls.map((c) => (c[0] as { cwd: string }).cwd);
      expect(cwds).toEqual(['/wt/planning', '/wt/planning']);
    });

    it('calls mergeTaskBranch once and fires onTaskComplete after all steps approve when worktreeManager is provided', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/planning' });

      const onStatus = createStatusCallbacksSpy();
      const res = await runMultiStepTask({
        ...makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }),
        worktreeManager: wtm as unknown as WorktreeManager,
      });

      // Merged once after success; phase-tasks does not cull on success.
      expect(wtm.mergeTaskBranch).toHaveBeenCalledTimes(1);
      expect(wtm.mergeTaskBranch).toHaveBeenCalledWith('planning');
      expect(wtm.cullTaskWorktree).not.toHaveBeenCalled();
      expect(res.approved).toBe(true);
      expect(onStatus.onTaskComplete).toHaveBeenCalledTimes(1);
    });

    it('does not invoke any worktree methods and keeps caller cwd when worktreeManager is absent', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });
      const wtm = makeMockWorktreeManager();

      await runMultiStepTask(makeTwoStepOptions());

      expect(wtm.createTaskWorktree).not.toHaveBeenCalled();
      expect(wtm.mergeTaskBranch).not.toHaveBeenCalled();
      expect(wtm.cullTaskWorktree).not.toHaveBeenCalled();

      // cwd stays as the caller provided for every step.
      const cwds = mockCreateHarness.mock.calls.map((c) => (c[0] as { cwd: string }).cwd);
      expect(cwds).toEqual(['/tmp/project', '/tmp/project']);
    });

    it('culls the worktree and fires onTaskRejected (not complete) when worktreeManager is provided and a step throws', async () => {
      setupSessionPerProfile({});
      // The reviewer step (structured output) blows up.
      mockPromptForStructured.mockRejectedValue(new Error('reviewer blew up'));
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/planning' });

      const onStatus = createStatusCallbacksSpy();
      await expect(
        runMultiStepTask({
          ...makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }),
          worktreeManager: wtm as unknown as WorktreeManager,
        }),
      ).rejects.toThrow('reviewer blew up');

      expect(wtm.createTaskWorktree).toHaveBeenCalledTimes(1);
      expect(wtm.mergeTaskBranch).not.toHaveBeenCalled();
      expect(wtm.cullTaskWorktree).toHaveBeenCalledTimes(1);
      expect(wtm.cullTaskWorktree).toHaveBeenCalledWith('planning');
      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      expect(onStatus.onTaskComplete).not.toHaveBeenCalled();
    });

    it('fails the task (not completes) when mergeTaskBranch returns failure after all steps approve (worktreeManager provided)', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });
      const wtm = makeMockWorktreeManager({
        worktreePath: '/wt/planning',
        mergeResult: { success: false, conflictsResolved: false },
      });

      const onStatus = createStatusCallbacksSpy();
      await expect(
        runMultiStepTask({
          ...makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }),
          worktreeManager: wtm as unknown as WorktreeManager,
        }),
      ).rejects.toThrow(/merge failed/i);

      expect(wtm.mergeTaskBranch).toHaveBeenCalledTimes(1);
      expect(wtm.mergeTaskBranch).toHaveBeenCalledWith('planning');
      expect(onStatus.onTaskComplete).not.toHaveBeenCalled();
      // Exactly one rejection: the catch block owns onTaskRejected. A second
      // call would indicate the merge-failure path is redundantly firing it.
      expect(onStatus.onTaskRejected).toHaveBeenCalledTimes(1);
      const rejectReasons = onStatus.onTaskRejected.mock.calls.map((c) => (c[0] as { reason?: string }).reason ?? '');
      expect(rejectReasons.some((r) => r.toLowerCase().includes('merge failed'))).toBe(true);
    });

    it('culls the worktree and fires onTaskRejected when mergeTaskBranch throws after all steps approve (worktreeManager provided)', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });
      const wtm = makeMockWorktreeManager({
        worktreePath: '/wt/planning',
        mergeError: new Error('merge threw'),
      });

      const onStatus = createStatusCallbacksSpy();
      await expect(
        runMultiStepTask({
          ...makeTwoStepOptions({ onStatus: onStatus as unknown as StatusCallbacks }),
          worktreeManager: wtm as unknown as WorktreeManager,
        }),
      ).rejects.toThrow('merge threw');

      // Merge was attempted (all steps had approved)...
      expect(wtm.mergeTaskBranch).toHaveBeenCalledTimes(1);
      expect(wtm.mergeTaskBranch).toHaveBeenCalledWith('planning');
      // ...but it threw, so the task is rejected and the worktree culled.
      expect(onStatus.onTaskComplete).not.toHaveBeenCalled();
      expect(onStatus.onTaskRejected).toHaveBeenCalled();
      const rejectReasons = onStatus.onTaskRejected.mock.calls.map((c) => (c[0] as { reason?: string }).reason ?? '');
      expect(rejectReasons.some((r) => r.toLowerCase().includes('merge threw'))).toBe(true);
      expect(wtm.cullTaskWorktree).toHaveBeenCalledTimes(1);
      expect(wtm.cullTaskWorktree).toHaveBeenCalledWith('planning');
    });

    // ── path relativization ─────────────────────────────────────────

    it('relativizes absolute worktree paths in step results and flows relativized results to lazy prompts', async () => {
      // Planner session returns text containing an absolute worktree path.
      const planner = makeMockSession(() => '/wt/task-1/plan.md').session;

      // Reviewer uses a lazy prompt that reads the prior step's result.
      const reviewerLazyPrompt = mock((priorResults: unknown[]) => `Review file: ${String(priorResults[0])}`);

      const reviewerSession = {
        prompt: mock(async () => {}),
        getLastAssistantText: mock(() => ''),
        sessionId: 'reviewer-session',
        subscribe: mock(() => () => {}),
        dispose: mock(() => {}),
      };

      mockCreateHarness.mockImplementation(async (opts: { profile: AgentProfile }) => ({
        session: opts.profile.id === 'planner' ? planner : reviewerSession,
        sessionId: opts.profile.id,
        dispose: mock(() => {}),
      }));

      // Reviewer structured output contains absolute worktree paths.
      mockPromptForStructured.mockResolvedValue({
        result: { ready: true, files: ['/wt/task-1/src/app.ts'] },
        attempts: 1,
      });

      const wtm = makeMockWorktreeManager({
        worktreePath: '/wt/task-1',
        mainWorktreePath: '/wt/main',
      });

      const res = await runMultiStepTask({
        profilesDirs: ['/tmp/profiles'],
        phaseId: 'p',
        taskId: 't',
        title: 'T',
        cwd: '/tmp/project',
        steps: [
          { stepName: 'plan', profileId: 'planner', prompt: 'Write the plan' },
          {
            stepName: 'review',
            profileId: 'reviewer',
            prompt: reviewerLazyPrompt as unknown as string,
            isReadOnly: true,
            schema: z.object({ ready: z.boolean(), files: z.array(z.string()) }) as unknown as ZodType<unknown>,
            isApproved: (r) => (r as { ready?: boolean }).ready === true,
          },
        ],
        worktreeManager: wtm as unknown as WorktreeManager,
      });

      // The planner step's string result is relativized.
      expect(res.results[0]).toBe('plan.md');

      // The reviewer structured result is relativized.
      expect(res.results[1]).toEqual({ ready: true, files: ['src/app.ts'] });

      // The lazy prompt received the ALREADY-RELATIVE planner result.
      expect(reviewerLazyPrompt).toHaveBeenCalledTimes(1);
      expect(reviewerLazyPrompt.mock.calls[0]![0]).toEqual(['plan.md']);
    });
  });

  // ── onDecision observe hook (hookRegistry) ──────────────────────────
  //
  // runMultiStepTask fires the `onDecision` OBSERVE hook (audit-log sink)
  // ALONGSIDE the `onStatus.onDecision` callback (event-store sink) on each
  // step rejection. These tests pin down the hook-firing behavior so the
  // extraction of fireOnDecisionHook() is provably behavior-preserving.
  // phase-tasks uses `effectiveCwd` (worktree path or original cwd) as the
  // hook context `cwd` and the original `cwd` as `workDir`.

  describe('onDecision observe hook (hookRegistry)', () => {
    /** Minimal fake HookRegistry. `hasSubscribers` returns true ONLY for
     *  'onDecision' so other seams stay dormant. */
    function makeFakeRegistry(hasSubs: boolean) {
      return {
        register: mock(() => {}),
        invokeObserve: mock(async () => {}),
        invokePipeline: mock(async () => undefined),
        invokeFirstWins: mock(async () => undefined),
        invokeAllRun: mock(async () => undefined),
        hasSubscribers: mock((name: string) => hasSubs && name === 'onDecision'),
      };
    }

    it('invokes the onDecision observe hook on each step rejection', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: false, feedback: 'too vague' }, attempts: 1 });

      const registry = makeFakeRegistry(true);
      const res = await runMultiStepTask({
        ...makeTwoStepOptions({ maxStepRetries: 2 }),
        hookRegistry: registry as unknown as HookRegistry,
      });

      // 2 rejections (maxStepRetries=2) → 2 observe-hook invocations.
      expect(res.approved).toBe(false);
      expect(registry.invokeObserve).toHaveBeenCalledTimes(2);
    });

    it('passes agentId=taskId, taskId, phaseId, decision and reasoning into the args', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: false, feedback: 'too vague' }, attempts: 1 });

      const registry = makeFakeRegistry(true);
      await runMultiStepTask({
        ...makeTwoStepOptions({ maxStepRetries: 1 }),
        hookRegistry: registry as unknown as HookRegistry,
      });

      expect(registry.invokeObserve).toHaveBeenCalledWith(
        'onDecision',
        expect.objectContaining({
          agentId: 'planning',
          taskId: 'planning',
          phaseId: 'plan-phase',
          decision: 'Step "review-plan" rejected (attempt 1/1)',
          reasoning: 'too vague',
        }),
        expect.anything(),
      );
    });

    it('fires both onStatus.onDecision AND the observe hook (two separate sinks)', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: false, feedback: 'too vague' }, attempts: 1 });

      const registry = makeFakeRegistry(true);
      const onStatus = createStatusCallbacksSpy();
      await runMultiStepTask({
        ...makeTwoStepOptions({ maxStepRetries: 1, onStatus: onStatus as unknown as StatusCallbacks }),
        hookRegistry: registry as unknown as HookRegistry,
      });

      expect(onStatus.onDecision).toHaveBeenCalledTimes(1);
      expect(registry.invokeObserve).toHaveBeenCalledTimes(1);
    });

    it('does NOT invoke the observe hook when hookRegistry has no subscribers', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: false, feedback: 'too vague' }, attempts: 1 });

      const registry = makeFakeRegistry(false);
      await runMultiStepTask({
        ...makeTwoStepOptions({ maxStepRetries: 1 }),
        hookRegistry: registry as unknown as HookRegistry,
      });

      expect(registry.invokeObserve).not.toHaveBeenCalled();
    });

    it('does NOT invoke the observe hook when no hookRegistry is provided', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: false, feedback: 'too vague' }, attempts: 1 });

      const res = await runMultiStepTask(makeTwoStepOptions({ maxStepRetries: 1 }));

      // Smoke test — completes without error.
      expect(res.approved).toBe(false);
    });

    it('does NOT invoke the observe hook when no step is rejected', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: true }, attempts: 1 });

      const registry = makeFakeRegistry(true);
      await runMultiStepTask({
        ...makeTwoStepOptions(),
        hookRegistry: registry as unknown as HookRegistry,
      });

      expect(registry.invokeObserve).not.toHaveBeenCalled();
    });

    it('passes hook context with cwd = effectiveCwd and workDir = cwd (no worktree)', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: false, feedback: 'too vague' }, attempts: 1 });

      const registry = makeFakeRegistry(true);
      await runMultiStepTask({
        ...makeTwoStepOptions({ maxStepRetries: 1 }),
        hookRegistry: registry as unknown as HookRegistry,
      });

      const hookCtx = (registry.invokeObserve.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
      expect(hookCtx.registry).toBe(registry);
      expect(hookCtx.cwd).toBe('/tmp/project');
      expect(hookCtx.workDir).toBe('/tmp/project');
    });

    it('uses the worktree path as cwd and original cwd as workDir when a worktree is active', async () => {
      setupSessionPerProfile({});
      mockPromptForStructured.mockResolvedValue({ result: { ready: false, feedback: 'too vague' }, attempts: 1 });

      const registry = makeFakeRegistry(true);
      const wtm = makeMockWorktreeManager({ worktreePath: '/wt/planning' });
      await runMultiStepTask({
        ...makeTwoStepOptions({ maxStepRetries: 1 }),
        worktreeManager: wtm as unknown as WorktreeManager,
        hookRegistry: registry as unknown as HookRegistry,
      });

      const hookCtx = (registry.invokeObserve.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
      // effectiveCwd becomes the worktree path; workDir stays the original cwd.
      expect(hookCtx.cwd).toBe('/wt/planning');
      expect(hookCtx.workDir).toBe('/tmp/project');
    });
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../packages/engine/src/core/profile.js', () => realProfile);
  mock.module('../../packages/engine/src/core/agent-registry.js', () => realAgentRegistry);
  mock.module('../../packages/engine/src/core/structured-output.js', () => realStructuredOutput);
});
