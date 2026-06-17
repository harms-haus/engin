// ─── runStepTask Tests ──────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { RenderFunction } from '../../packages/engine/src/core/renderer-registry.js';
import { RendererRegistry } from '../../packages/engine/src/core/renderer-registry.js';
import type { AgentProfile, AgentStatusCallbacks, StatusCallbacks } from '../../packages/engine/src/core/types.js';
import { makeMockSession } from '../helpers/make-session.js';

// Capture real modules before mocking so we can restore them in afterAll.
// Without the restore, these relative-path mock.module() registrations leak
// into sibling test files (harness-factory.subscribe.test.ts,
// structured-output.test.ts) under CI's parallel scheduling.
const realProfile = Object.assign({}, await import('../../packages/engine/src/core/profile.js'));
const realHarnessFactory = Object.assign({}, await import('../../packages/engine/src/core/harness-factory.js'));
const realStructuredOutput = Object.assign({}, await import('../../packages/engine/src/core/structured-output.js'));

// ─── Mock Dependencies ─────────────────────────────────────────────────────

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../packages/engine/src/core/profile.js', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../packages/engine/src/core/harness-factory.js', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
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
import { runStepTask } from '../../packages/engine/src/core/phase-tasks.js';

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

function createStatusCallbacksSpy(): StatusCallbacks & {
  callOrder: string[];
  onTaskRegister: ReturnType<typeof mock>;
  onTaskStart: ReturnType<typeof mock>;
  onTaskComplete: ReturnType<typeof mock>;
  onTaskRejected: ReturnType<typeof mock>;
  onAgentSpawn: ReturnType<typeof mock>;
  onAgentComplete: ReturnType<typeof mock>;
  onAgentRender: ReturnType<typeof mock>;
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
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../packages/engine/src/core/profile.js', () => realProfile);
  mock.module('../../packages/engine/src/core/harness-factory.js', () => realHarnessFactory);
  mock.module('../../packages/engine/src/core/structured-output.js', () => realStructuredOutput);
});
