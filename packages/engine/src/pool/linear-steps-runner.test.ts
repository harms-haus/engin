// ─── Tests for pool/linear-steps-runner.ts — review-limit exhaustion ────────
//
// Pins the regression fix for the bug where a task whose review step exhausted
// its retry budget was marked COMPLETED (via settleBySeverity's
// "accept-with-caveats" branch for non-failing severity) instead of FAILED.
//
// Contract (pinned by these tests):
//   - When a step is rejected `maxStepRetries` times, the runner MUST return
//     `{ status: 'failed' }` and call `ctx.failTask`, regardless of the
//     severity carried by the reviewer's output. `ctx.completeTask` must NOT
//     be called on the exhaustion path.
//   - The reviewer's severity is still forwarded to `failTask` for downstream
//     signal.
//
// The step execution is MOCKED via `mock.module('./step-execution.js')` so the
// loop logic is exercised without spawning real agents — mirroring the
// mock.module pattern in fix-loop.test.ts.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentProfile, Task } from '../core/types.js';
import type { RunStepParams } from './step-execution.js';
import type { StepDefinition, StepResult, TaskRunnerContext, TrackedSession } from './types.js';

// ─── Capture real step-execution before mocking ────────────────────────────
const realStepExecution = Object.assign({}, await import('./step-execution.js'));

// ─── Mock runStep ──────────────────────────────────────────────────────────
type RunStepResult = { result: StepResult; trackedSession: TrackedSession };

let createdDisposes: Array<ReturnType<typeof mock>> = [];

function makeTrackedSession(): TrackedSession {
  const dispose = mock(() => {});
  createdDisposes.push(dispose);
  return {
    session: {
      abort: mock(async () => {}),
      dispose: mock(() => {}),
      subscribe: mock(() => () => {}),
      prompt: mock(async () => {}),
      getLastAssistantText: mock(() => undefined),
      getLastAssistantMessage: mock(() => undefined),
      sessionId: `sess-${createdDisposes.length}`,
    },
    dispose,
    sessionPath: `/tmp/sessions/sess-${createdDisposes.length}`,
  };
}

const mockRunStep = mock(
  async (..._args: unknown[]): Promise<RunStepResult> => ({
    result: { type: 'approved', output: 'default' },
    trackedSession: makeTrackedSession(),
  }),
);

mock.module('./step-execution.js', () => ({
  ...realStepExecution,
  runStep: (...args: unknown[]) => mockRunStep(...args),
}));

// Import the module under test AFTER the mock is registered.
import { linearStepsRunner } from './linear-steps-runner.js';

afterAll(() => {
  mock.module('./step-execution.js', () => realStepExecution);
});

// ─── Fixture helpers ───────────────────────────────────────────────────────

const task: Task = {
  id: 'task-1',
  title: 'Implement feature X',
  prompt: 'please implement feature X',
  profile: 'coder',
  files: [],
  dependencies: [],
  status: 'active',
  phaseId: 'implementing',
};

const reviewStep: StepDefinition = { name: 'review', profileId: 'reviewer', isReadOnly: true };

function makeProfiles(): Map<string, AgentProfile> {
  const base: AgentProfile = {
    id: 'x',
    name: 'X',
    provider: 'openai',
    model: 'gpt-4',
    thinkingLevel: 'medium',
    systemPrompt: '',
    excludeTools: [],
    includeTools: [],
  };
  const map = new Map<string, AgentProfile>();
  map.set('coder', { ...base, id: 'coder', name: 'Coder' });
  map.set('reviewer', { ...base, id: 'reviewer', name: 'Reviewer' });
  return map;
}

/** Build a TaskRunnerContext with `completeTask`/`failTask` spies. */
function makeCtx(overrides: Partial<TaskRunnerContext> = {}): TaskRunnerContext {
  const completeTask = overrides.completeTask ?? mock((_r?: unknown) => true);
  const failTask = overrides.failTask ?? mock((_r?: unknown) => undefined);
  return {
    task,
    agentId: 'lane-0',
    profiles: makeProfiles(),
    onStatus: undefined,
    activeSessions: new Set(),
    phaseId: 'implementing',
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    maxStepRetries: 3,
    completeTask,
    failTask,
    ...overrides,
  };
}

// ─── StepResult helpers ────────────────────────────────────────────────────

function approved(output: unknown = 'approved-output'): StepResult {
  return { type: 'approved', output };
}

function rejected(feedback: string): StepResult {
  return { type: 'rejected', feedback };
}

/** Script the ordered sequence of `runStep` outcomes. */
function sequence(results: Array<StepResult | Error>): void {
  let i = 0;
  mockRunStep.mockImplementation(async (...args: unknown[]): Promise<RunStepResult> => {
    const idx = i++;
    const next = results[idx];
    if (next === undefined) {
      throw new Error(
        `mockRunStep: unexpected extra call #${idx + 1}; only ${results.length} scripted. ` +
          `step=${(args[0] as RunStepParams | undefined)?.step?.name ?? '?'}`,
      );
    }
    if (next instanceof Error) throw next;
    return { result: next, trackedSession: makeTrackedSession() };
  });
}

function callStepNames(): string[] {
  return mockRunStep.mock.calls.map((c) => (c[0] as RunStepParams).step.name);
}

beforeEach(() => {
  mockRunStep.mockReset();
  createdDisposes = [];
});

afterEach(() => {
  mockRunStep.mockReset();
});

// ─── Happy path (sanity) ───────────────────────────────────────────────────

describe('linearStepsRunner — happy path', () => {
  it('approves on first try → completed, calls completeTask (not failTask)', async () => {
    sequence([approved({ score: 10 })]);
    const ctx = makeCtx();

    const outcome = await linearStepsRunner([reviewStep])(ctx);

    expect(outcome.status).toBe('completed');
    expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    expect(ctx.failTask).not.toHaveBeenCalled();
    expect(callStepNames()).toEqual(['review']);
  });
});

// ─── Review-limit exhaustion (the regression) ──────────────────────────────

describe('linearStepsRunner — review-limit exhaustion', () => {
  it('rejecting maxStepRetries times → FAILED (not completed), even with non-failing severity', async () => {
    // Reviewer rejects on every attempt; the output carries a NON-failing
    // severity ('medium'). Before the fix this was accepted as "completed
    // with caveats". It MUST now fail.
    const alwaysRejectedMedium = (): StepResult => ({
      type: 'rejected',
      feedback: 'tests cannot run: implementation missing',
      output: { severity: 'medium' },
    });
    sequence([alwaysRejectedMedium(), alwaysRejectedMedium(), alwaysRejectedMedium()]);
    const ctx = makeCtx({ maxStepRetries: 3 });

    const outcome = await linearStepsRunner([reviewStep])(ctx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.feedback).toContain('implementation missing');
    }
    // The task MUST be failed, never completed, when the review limit is hit.
    expect(ctx.failTask).toHaveBeenCalledTimes(1);
    expect(ctx.completeTask).not.toHaveBeenCalled();
    // Exactly maxStepRetries attempts before giving up.
    expect(mockRunStep).toHaveBeenCalledTimes(3);
    expect(callStepNames()).toEqual(['review', 'review', 'review']);
  });

  it('exhaustion forwards the reviewer severity to failTask', async () => {
    sequence([
      { type: 'rejected', feedback: 'low-sev nitpick', output: { severity: 'low' } },
      { type: 'rejected', feedback: 'low-sev nitpick', output: { severity: 'low' } },
    ]);
    const ctx = makeCtx({ maxStepRetries: 2 });

    const outcome = await linearStepsRunner([reviewStep])(ctx);

    expect(outcome.status).toBe('failed');
    expect(ctx.failTask).toHaveBeenCalledTimes(1);
    expect(ctx.failTask).toHaveBeenCalledWith({
      completed: false,
      feedback: 'low-sev nitpick',
      severity: 'low',
    });
    expect(ctx.completeTask).not.toHaveBeenCalled();
  });

  it('rejecting maxStepRetries times → FAILED even when severity is failing (critical)', async () => {
    // Characterization: failing severity obviously fails, but pin it so the
    // unconditional-fail behavior holds across the severity spectrum.
    const critical = (): StepResult => ({
      type: 'rejected',
      feedback: 'catastrophic',
      output: { severity: 'critical' },
    });
    sequence([critical(), critical()]);
    const ctx = makeCtx({ maxStepRetries: 2 });

    const outcome = await linearStepsRunner([reviewStep])(ctx);

    expect(outcome.status).toBe('failed');
    expect(ctx.failTask).toHaveBeenCalledTimes(1);
    expect(ctx.completeTask).not.toHaveBeenCalled();
  });

  it('a step that recovers before the limit is reached still completes', async () => {
    // Reject twice, then approve on the 3rd attempt (limit = 3): must NOT fail.
    sequence([rejected('nope'), rejected('nope'), approved('finally')]);
    const ctx = makeCtx({ maxStepRetries: 3 });

    const outcome = await linearStepsRunner([reviewStep])(ctx);

    expect(outcome.status).toBe('completed');
    expect(ctx.completeTask).toHaveBeenCalledTimes(1);
    expect(ctx.failTask).not.toHaveBeenCalled();
    expect(mockRunStep).toHaveBeenCalledTimes(3);
  });
});
