// ─── runStepTask Tests ──────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { AgentProfile, AgentStatusCallbacks, StatusCallbacks } from '../../src/core/types.js';
import { makeMockSession } from '../helpers/make-session.js';

// ─── Mock Dependencies ─────────────────────────────────────────────────────

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/profile.js', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/harness-factory.js', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../src/core/structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import type { RunStepTaskOptions } from '../../src/core/phase-tasks.js';
import { runStepTask } from '../../src/core/phase-tasks.js';

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

function makeDefaultOptions(overrides?: Partial<RunStepTaskOptions>): RunStepTaskOptions {
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
});
