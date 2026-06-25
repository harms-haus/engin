// ─── Characterization tests for the phase-tasks public API surface ─────────
//
// These tests pin down the OBSERVABLE contract of `phase-tasks.ts` so that the
// planned split into `one-step-task.ts` + `multi-step-task.ts` (with
// `phase-tasks.ts` becoming a barrel re-export) is provably behavior-
// preserving.
//
// Two concerns:
//   (1) PUBLIC API SURFACE — every named export (functions AND type-only
//       exports) that `phase-tasks.ts` currently provides must survive the
//       barrel re-export. `index.ts` does `export * from './core/phase-tasks.js'`,
//       so dropping any export would break downstream consumers silently.
//       Runtime exports are checked with `expect`; type-only exports are
//       pinned by USING them in annotated positions — if the barrel drops a
//       type re-export, this file no longer compiles (a build-time failure).
//   (2) BEHAVIOR GAPS — edge cases / error paths NOT already covered by
//       phase-tasks.test.ts or phase-tasks-hooks.test.ts: early abort,
//       profile-not-found, empty-steps guard, callback ordering, and the
//       maxStepRetries exhaustion path.

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { AgentProfile } from './types.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realProfile = Object.assign({}, await import('./profile.js'));
const realAgentRegistry = Object.assign({}, await import('./agent-registry.js'));
const realStructuredOutput = Object.assign({}, await import('./structured-output.js'));

// ─── Mock dependencies ───────────────────────────────────────────────────

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./profile.js', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

const mockRequireAgentPlugin = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./agent-registry.js', () => ({
  requireAgentPlugin: (...args: unknown[]) => mockRequireAgentPlugin(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
  extractJsonFromText: realStructuredOutput.extractJsonFromText,
}));

// ─── Import the module under test (ALL named exports) ─────────────────────
//
// Importing every named export here is itself part of the characterization:
// after the refactor, `phase-tasks.ts` must still re-export all of these.

import { runMultiStepTask, runStepTask } from './phase-tasks.js';
// Type-only imports — if the barrel drops a `export type` these fail to
// compile, which is exactly the failure we want to catch.
import type {
  MultiStepDefinition,
  MultiStepTaskResult,
  RunMultiStepTaskOptions,
  RunStepTaskOptions,
} from './phase-tasks.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const coderProfile: AgentProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium' as const,
  systemPrompt: 'You are a coding agent.',
  excludeTools: [],
  includeTools: [],
};

const plannerProfile: AgentProfile = { ...coderProfile, id: 'planner', name: 'Planner' };
const reviewerProfile: AgentProfile = { ...coderProfile, id: 'reviewer', name: 'Reviewer' };

function setupProfiles(profiles: AgentProfile[]) {
  const map = new Map<string, AgentProfile>();
  for (const p of profiles) map.set(p.id, p);
  mockLoadProfilesFromDirs.mockResolvedValue(map);
}

function makeMockSession(profileId: string, lastText = 'assistant-output') {
  return {
    prompt: mock(async () => {}),
    getLastAssistantText: mock(() => lastText),
    getLastAssistantMessage: mock(() => undefined),
    sessionId: `${profileId}-session`,
    sessionFile: undefined as string | undefined,
    contextWindow: 8000,
    subscribe: mock(() => () => {}),
    dispose: mock(() => {}),
    abort: mock(async () => {}),
  };
}

let mockPlugin: { id: string; createSession: ReturnType<typeof mock> };

beforeEach(() => {
  mockLoadProfilesFromDirs.mockReset();
  mockRequireAgentPlugin.mockReset();
  mockPromptForStructured.mockReset();
  mockPlugin = { id: 'pi-coding-agent', createSession: mock() };
  mockRequireAgentPlugin.mockReturnValue(mockPlugin);
});

// ─── (1) Public API surface ──────────────────────────────────────────────

describe('phase-tasks public API surface', () => {
  it('exports runStepTask as an async function', () => {
    expect(typeof runStepTask).toBe('function');
    // runStepTask is declared `async`, so its prototype has no extra marker,
    // but it must return a promise when called. We don't await — just verify
    // the shape without triggering real work (no profiles loaded → it will
    // reject, which is fine; we only inspect the return type here).
    const p = runStepTask({
      profilesDirs: [],
      phaseId: 'p',
      taskId: 't',
      title: 'T',
      stepName: 's',
      profileId: 'coder',
      cwd: '/tmp',
      prompt: 'x',
      // Abort immediately so it rejects cheaply without callbacks.
      signal: AbortSignal.abort(),
    });
    expect(p).toBeInstanceOf(Promise);
    // Swallow the expected AbortError rejection so bun doesn't report an
    // unhandled rejection.
    p.catch(() => {});
  });

  it('exports runMultiStepTask as an async function', () => {
    expect(typeof runMultiStepTask).toBe('function');
    const p = runMultiStepTask({
      profilesDirs: [],
      phaseId: 'p',
      taskId: 't',
      title: 'T',
      cwd: '/tmp',
      steps: [],
      signal: AbortSignal.abort(),
    });
    expect(p).toBeInstanceOf(Promise);
    p.catch(() => {});
  });

  it('type-only exports are usable in annotated positions (compile-time pin)', () => {
    // If the barrel drops any `export type`, this file fails to compile.
    const stepOpts: RunStepTaskOptions = {
      profilesDirs: ['/tmp'],
      phaseId: 'phase',
      taskId: 'task',
      title: 'Title',
      stepName: 'step',
      profileId: 'coder',
      cwd: '/tmp',
      prompt: 'do work',
    };
    expect(stepOpts.prompt).toBe('do work');

    const stepDef: MultiStepDefinition = {
      stepName: 'plan',
      profileId: 'planner',
      prompt: 'plan it',
    };
    expect(stepDef.stepName).toBe('plan');

    const multiOpts: RunMultiStepTaskOptions = {
      profilesDirs: ['/tmp'],
      phaseId: 'phase',
      taskId: 'task',
      title: 'Title',
      cwd: '/tmp',
      steps: [stepDef],
    };
    expect(multiOpts.steps).toHaveLength(1);

    const result: MultiStepTaskResult = { results: [], approved: true };
    expect(result.approved).toBe(true);
  });
});

// ─── (2a) runStepTask behavior gaps ──────────────────────────────────────

describe('runStepTask — early abort + error paths', () => {
  it('throws an AbortError (DOMException) when signal is already aborted, before any callback', async () => {
    // A status callback that, if invoked, would record the call. Because the
    // abort check fires FIRST, none of these should be called.
    const onTaskRegister = mock((_info: unknown) => {});
    const onTaskStart = mock((_info: unknown) => {});

    let err: unknown;
    try {
      await runStepTask({
        profilesDirs: ['/tmp'],
        phaseId: 'p',
        taskId: 't',
        title: 'T',
        stepName: 's',
        profileId: 'coder',
        cwd: '/tmp',
        prompt: 'x',
        signal: AbortSignal.abort(),
        onStatus: { onTaskRegister, onTaskStart },
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    // Abort fires before ANY status callback.
    expect(onTaskRegister).not.toHaveBeenCalled();
    expect(onTaskStart).not.toHaveBeenCalled();
  });

  it('throws a descriptive error when the profile is not found in the profiles directories', async () => {
    setupProfiles([]); // no profiles loaded

    let err: unknown;
    try {
      await runStepTask({
        profilesDirs: ['/tmp/profiles', '/tmp/other'],
        phaseId: 'p',
        taskId: 't',
        title: 'T',
        stepName: 's',
        profileId: 'missing-profile',
        cwd: '/tmp',
        prompt: 'x',
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('missing-profile');
    // The error must reference BOTH directories (runStepTask-specific context).
    expect(msg).toContain('/tmp/profiles');
    expect(msg).toContain('/tmp/other');
  });

  it('fires onTaskRegister (single step) and onTaskStart before the agent runs, onTaskComplete on success', async () => {
    setupProfiles([coderProfile]);
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeMockSession(o.profile.id, 'done'),
    );

    const onTaskRegister = mock((_info: unknown) => {});
    const onTaskStart = mock((_info: unknown) => {});
    const onTaskComplete = mock((_info: unknown) => {});
    const onTaskRejected = mock((_info: unknown) => {});

    const result = await runStepTask<string>({
      profilesDirs: ['/tmp'],
      phaseId: 'my-phase',
      taskId: 'task-42',
      title: 'My Task',
      stepName: 'scout',
      profileId: 'coder',
      cwd: '/tmp/project',
      prompt: 'explore',
      onStatus: { onTaskRegister, onTaskStart, onTaskComplete, onTaskRejected },
    });

    expect(result).toBe('done');

    // onTaskRegister: single-step definition with the step's metadata.
    expect(onTaskRegister).toHaveBeenCalledTimes(1);
    const reg = onTaskRegister.mock.calls[0][0] as Record<string, unknown>;
    expect(reg.taskId).toBe('task-42');
    expect(reg.phaseId).toBe('my-phase');
    expect(reg.title).toBe('My Task');
    expect(reg.dependencies).toEqual([]);
    const steps = reg.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ name: 'scout', profileId: 'coder', isReadOnly: false });

    // onTaskStart fires.
    expect(onTaskStart).toHaveBeenCalledTimes(1);
    const start = onTaskStart.mock.calls[0][0] as Record<string, unknown>;
    expect(start.taskId).toBe('task-42');
    expect(start.agentId).toBe('task-42'); // agentId === taskId for runStepTask
    expect(start.phaseId).toBe('my-phase');

    // Success path.
    expect(onTaskComplete).toHaveBeenCalledTimes(1);
    expect(onTaskComplete.mock.calls[0][0]).toEqual({ taskId: 'task-42', title: 'My Task' });
    expect(onTaskRejected).not.toHaveBeenCalled();
  });

  it('fires onTaskRejected (not onTaskComplete) when the profile is missing', async () => {
    setupProfiles([]);

    const onTaskComplete = mock((_info: unknown) => {});
    const onTaskRejected = mock((_info: unknown) => {});

    await expect(
      runStepTask({
        profilesDirs: ['/tmp'],
        phaseId: 'p',
        taskId: 'task-9',
        title: 'T',
        stepName: 's',
        profileId: 'nope',
        cwd: '/tmp',
        prompt: 'x',
        onStatus: { onTaskComplete, onTaskRejected },
      }),
    ).rejects.toThrow();

    expect(onTaskRejected).toHaveBeenCalledTimes(1);
    const rej = onTaskRejected.mock.calls[0][0] as Record<string, unknown>;
    expect(rej.taskId).toBe('task-9');
    expect(rej.title).toBe('T');
    expect(typeof rej.reason).toBe('string');
    expect(onTaskComplete).not.toHaveBeenCalled();
  });

  it('returns structured output (schema path) as the typed result', async () => {
    setupProfiles([reviewerProfile]);
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeMockSession(o.profile.id, 'irrelevant'),
    );
    mockPromptForStructured.mockResolvedValue({ result: { approved: true, comment: 'good' }, attempts: 1 });

    const result = await runStepTask<{ approved: boolean; comment: string }>({
      profilesDirs: ['/tmp'],
      phaseId: 'p',
      taskId: 't',
      title: 'T',
      stepName: 'review',
      profileId: 'reviewer',
      cwd: '/tmp',
      prompt: 'review',
      schema: z.object({ approved: z.boolean(), comment: z.string() }) as unknown as ZodType<unknown>,
    });

    expect(result).toEqual({ approved: true, comment: 'good' });
  });
});

// ─── (2b) runMultiStepTask behavior gaps ─────────────────────────────────

describe('runMultiStepTask — guards + exhaustion + registration', () => {
  it('throws on early abort before any callback', async () => {
    const onTaskRegister = mock((_info: unknown) => {});
    const onTaskStart = mock((_info: unknown) => {});

    let err: unknown;
    try {
      await runMultiStepTask({
        profilesDirs: ['/tmp'],
        phaseId: 'p',
        taskId: 't',
        title: 'T',
        cwd: '/tmp',
        steps: [{ stepName: 's', profileId: 'coder', prompt: 'x' }],
        signal: AbortSignal.abort(),
        onStatus: { onTaskRegister, onTaskStart },
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(onTaskRegister).not.toHaveBeenCalled();
    expect(onTaskStart).not.toHaveBeenCalled();
  });

  it('throws when steps array is empty', async () => {
    setupProfiles([coderProfile]);

    let err: unknown;
    try {
      await runMultiStepTask({
        profilesDirs: ['/tmp'],
        phaseId: 'p',
        taskId: 'task-empty',
        title: 'T',
        cwd: '/tmp',
        steps: [],
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('task-empty');
    expect((err as Error).message).toMatch(/no steps/i);
  });

  it('registers ALL steps at once via onTaskRegister and signals onTaskStart', async () => {
    setupProfiles([plannerProfile, reviewerProfile]);
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeMockSession(o.profile.id, 'out'),
    );

    const onTaskRegister = mock((_info: unknown) => {});
    const onTaskStart = mock((_info: unknown) => {});
    const onTaskComplete = mock((_info: unknown) => {});

    await runMultiStepTask({
      profilesDirs: ['/tmp'],
      phaseId: 'impl',
      taskId: 'task-multi',
      title: 'Multi',
      cwd: '/tmp/project',
      steps: [
        { stepName: 'plan', profileId: 'planner', prompt: 'plan', isReadOnly: true },
        { stepName: 'execute', profileId: 'reviewer', prompt: 'exec' },
      ],
      onStatus: { onTaskRegister, onTaskStart, onTaskComplete },
    });

    // Registered exactly once, with both steps.
    expect(onTaskRegister).toHaveBeenCalledTimes(1);
    const reg = onTaskRegister.mock.calls[0][0] as Record<string, unknown>;
    expect(reg.taskId).toBe('task-multi');
    const steps = reg.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ name: 'plan', profileId: 'planner', isReadOnly: true });
    expect(steps[1]).toEqual({ name: 'execute', profileId: 'reviewer', isReadOnly: false });

    expect(onTaskStart).toHaveBeenCalledTimes(1);
    expect(onTaskComplete).toHaveBeenCalledTimes(1);
  });

  it('returns { approved: false } and fires onTaskRejected when a gate exhausts maxStepRetries', async () => {
    setupProfiles([plannerProfile, reviewerProfile]);
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeMockSession(o.profile.id, 'out'),
    );

    // Reviewer ALWAYS rejects.
    mockPromptForStructured.mockResolvedValue({ result: { approved: false }, attempts: 1 });

    const onTaskRejected = mock((_info: unknown) => {});
    const onTaskComplete = mock((_info: unknown) => {});
    const onDecision = mock((_info: unknown) => {});

    const res = await runMultiStepTask({
      profilesDirs: ['/tmp'],
      phaseId: 'p',
      taskId: 'task-exhaust',
      title: 'Exhaust',
      cwd: '/tmp',
      maxStepRetries: 2,
      steps: [
        { stepName: 'plan', profileId: 'planner', prompt: 'plan' },
        {
          stepName: 'review',
          profileId: 'reviewer',
          prompt: 'review',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown>,
          isApproved: (r) => (r as { approved?: boolean }).approved === true,
          getFeedback: () => 'no good',
        },
      ],
      onStatus: { onTaskRejected, onTaskComplete, onDecision },
    });

    // Exhausted → not approved, but returns best-effort results.
    expect(res.approved).toBe(false);
    expect(res.results.length).toBeGreaterThan(0);

    // onDecision fired once per rejection (maxStepRetries = 2 → 2 rejections).
    expect(onDecision).toHaveBeenCalledTimes(2);
    // The final rejection message references the limit.
    const lastDecision = onDecision.mock.calls[1][0] as Record<string, unknown>;
    expect(String(lastDecision.decision)).toContain('2/2');

    // onTaskRejected fires on exhaustion; onTaskComplete does NOT.
    expect(onTaskRejected).toHaveBeenCalledTimes(1);
    const rej = onTaskRejected.mock.calls[0][0] as Record<string, unknown>;
    expect(rej.taskId).toBe('task-exhaust');
    expect(rej.reason).toBe('no good');
    expect(onTaskComplete).not.toHaveBeenCalled();
  });

  it('uses default feedback text when getFeedback is omitted on rejection', async () => {
    setupProfiles([plannerProfile, reviewerProfile]);
    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeMockSession(o.profile.id, 'out'),
    );
    mockPromptForStructured.mockResolvedValue({ result: { approved: false }, attempts: 1 });

    const onDecision = mock((_info: unknown) => {});

    const res = await runMultiStepTask({
      profilesDirs: ['/tmp'],
      phaseId: 'p',
      taskId: 't',
      title: 'T',
      cwd: '/tmp',
      maxStepRetries: 1,
      steps: [
        { stepName: 'plan', profileId: 'planner', prompt: 'plan' },
        {
          stepName: 'review',
          profileId: 'reviewer',
          prompt: 'review',
          isReadOnly: true,
          schema: z.object({ approved: z.boolean() }) as unknown as ZodType<unknown>,
          isApproved: (r) => (r as { approved?: boolean }).approved === true,
          // No getFeedback — should fall back to generic message.
        },
      ],
      onStatus: { onDecision },
    });

    expect(res.approved).toBe(false);
    const decision = onDecision.mock.calls[0][0] as Record<string, unknown>;
    expect(decision.reasoning).toBe('Step rejected without feedback');
  });

  it('throws a descriptive error when a step profile is not found', async () => {
    setupProfiles([plannerProfile]); // reviewer NOT loaded

    mockPlugin.createSession.mockImplementation(async (o: { profile: AgentProfile }) =>
      makeMockSession(o.profile.id, 'out'),
    );

    let err: unknown;
    try {
      await runMultiStepTask({
        profilesDirs: ['/tmp/a', '/tmp/b'],
        phaseId: 'p',
        taskId: 'task-missing',
        title: 'T',
        cwd: '/tmp',
        steps: [
          { stepName: 'plan', profileId: 'planner', prompt: 'plan' },
          { stepName: 'review', profileId: 'reviewer', prompt: 'review' },
        ],
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('reviewer');
    expect(msg).toContain('/tmp/a');
    expect(msg).toContain('/tmp/b');
  });
});

// ─── Restore real modules ───────────────────────────────────────────────

afterAll(() => {
  mock.module('./profile.js', () => realProfile);
  mock.module('./agent-registry.js', () => realAgentRegistry);
  mock.module('./structured-output.js', () => realStructuredOutput);
});
