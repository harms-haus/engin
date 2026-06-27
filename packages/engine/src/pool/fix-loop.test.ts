// ─── Tests for pool/fix-loop.ts — fixLoop primitive + default hooks ────────
//
// `fixLoop` (§5 item #7) collapses the ~400-line final-review fixer loop into
// a hook-driven primitive. It composes with `runStep` (from step-execution.ts)
// for BOTH the review and fixer steps — it does NOT re-implement agent
// spawning or session management.
//
// Loop contract (pinned by these tests):
//   1. Run the review step via `runStep`. If approved → { status: 'completed' }.
//   2. If rejected, enter the fix loop (up to `maxRounds`, default 3):
//        a. BEFORE each fixer attempt, invoke `shouldIsolate` (first-wins).
//           If it returns true → ISOLATE: do NOT run the fixer, preserve the
//           worktree (do not cull it), and return { status: 'failed' }.
//        b. Run each fixer step via `runStep` (in order). If a fixer step is
//           rejected or throws → fire `onLaneError` (observe) with the error.
//        c. Re-run the review. If approved → { status: 'completed' }.
//   3. If maxRounds is exhausted → { status: 'failed' }, and (when a worktree
//      is in use) CULL the task worktree via
//      `worktreeManager.cullTaskWorktree(task.id)` — UNLESS `shouldIsolate`
//      returned true at the point of failure, in which case the worktree is
//      PRESERVED (cull is skipped).
//
// `defaultOnLaneError` (ObserveHook<OnLaneErrorArgs>) logs the error via
// `console.warn`. `defaultShouldIsolate` (FirstWinsHook<boolean | undefined,
// ShouldIsolateArgs>) returns `false` (don't isolate — cull by default).
//
// NOTE: `./fix-loop.js` does not exist yet — this is the write-tests step.
// The tests are RED until the implementation lands; they serve as the
// executable spec for fix-loop.ts.
//
// The review/fixer steps are MOCKED via `mock.module('./step-execution.js')`
// so the loop logic is exercised without spawning real sessions — mirroring the
// mock.module pattern in core/phase-tasks-hooks.test.ts.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentProfile, Task } from '../core/types.js';
import type { WorktreeManager } from '../core/worktree-manager.js';
import { createHookRegistry } from '../hooks/registry.js';
import type { HookContext, OnLaneErrorArgs, ShouldIsolateArgs, WorkflowHooks } from '../hooks/types.js';
import type { RunStepParams, StepExecutionContext } from './step-execution.js';
import type { StepDefinition, StepResult, TrackedSession } from './types.js';

// ─── Capture real step-execution before mocking ────────────────────────────
//
// `fixLoop` composes with `runStep` for both review and fixer steps. We mock
// `runStep` so each test can script the exact sequence of review/fixer
// outcomes. The rest of the step-execution module (clearTaskSessions, types)
// is preserved via spread so other consumers stay intact.
const realStepExecution = Object.assign({}, await import('./step-execution.js'));

// ─── Mock runStep ──────────────────────────────────────────────────────────
//
// `runStep` returns `{ result: StepResult; trackedSession: TrackedSession }`.
// The default implementation returns an approval so a misconfigured test
// surfaces an obvious "unexpected extra call" error rather than a hang; each
// test scripts its own sequence via `sequence(...)`.

type RunStepResult = { result: StepResult; trackedSession: TrackedSession };

/** Disposal spies created for every TrackedSession returned by the mock. */
let createdDisposes: Array<ReturnType<typeof mock>> = [];

/** Build a minimal TrackedSession whose `dispose` is a tracked mock. */
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

// ─── Import the module under test (AFTER the mock is registered) ───────────
//
// Static import placement mirrors core/phase-tasks-hooks.test.ts: the
// top-level `await import` captures the real module, `mock.module` registers
// the replacement, and only THEN does the static import resolve the
// module-under-test against the mocked dependency.
import type { FixLoopOptions } from './fix-loop.js';
import { defaultOnLaneError, defaultShouldIsolate, fixLoop } from './fix-loop.js';

// Restore the real step-execution module once the suite finishes.
afterAll(() => {
  mock.module('./step-execution.js', () => realStepExecution);
});

// ─── console.warn spy (manual, version-safe) ───────────────────────────────
//
// `defaultOnLaneError` logs via console.warn. We capture warn calls so tests
// can assert on them without polluting test output. Mirrors the console.error
// spy in pool/runner-utils.test.ts.
let warnCalls: unknown[][] = [];
let realWarn: typeof console.warn;

// ─── Fixture helpers ───────────────────────────────────────────────────────

const task: Task = {
  id: 'task-1',
  title: 'Implement feature X',
  prompt: 'please implement feature X',
  profile: 'coder',
  files: [],
  dependencies: [],
  status: 'active',
  phaseId: 'review',
  worktree: 'none',
};

const reviewStep: StepDefinition = {
  name: 'review',
  profileId: 'reviewer',
  isReadOnly: true,
};

const fixerStep: StepDefinition = {
  name: 'fix',
  profileId: 'implementer',
  isReadOnly: false,
};

const fixerSteps: StepDefinition[] = [fixerStep];

const secondFixerStep: StepDefinition = {
  name: 'verify',
  profileId: 'implementer',
  isReadOnly: false,
};

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
  map.set('implementer', { ...base, id: 'implementer', name: 'Implementer' });
  return map;
}

/** Build a StepExecutionContext. Optional worktreeManager/worktreeCwd simulate
 *  isolated worktree execution (used by the cull/preserve tests). `onStatus` is
 *  a required key on StepExecutionContext (its VALUE may be undefined); we set
 *  it to undefined so no status callbacks fire during the loop. */
function makeExecCtx(overrides: Partial<StepExecutionContext> = {}): StepExecutionContext {
  return {
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    onStatus: undefined,
    activeSessions: new Set(),
    phaseId: 'review',
    ...overrides,
  };
}

/**
 * Build a mock WorktreeManager exposing `cullTaskWorktree` AND the new
 * `cullOrPreserve` method (a spy that delegates to `cullTaskWorktree`,
 * mirroring the real WorktreeManager's implementation).
 *
 * After the refactor, `fixLoop` calls `cullOrPreserve(task.id, isolated)`
 * instead of `cullTaskWorktree(task.id)` directly. The delegation means the
 * EXISTING assertions on `cull` (cullTaskWorktree) remain valid both before
 * AND after the refactor — the observable behavior (cull happens on
 * exhaustion, is skipped on isolation) is preserved. The `cullOrPreserve`
 * spy additionally lets tests assert the new delegation contract directly.
 */
function makeWorktreeManager(): {
  instance: WorktreeManager;
  cull: ReturnType<typeof mock>;
  cullOrPreserve: ReturnType<typeof mock>;
} {
  const cull = mock(async (_taskId: string) => {});
  const cullOrPreserve = mock(async (taskId: string, preserve: boolean) => {
    if (preserve) return;
    await cull(taskId);
  });
  const instance = { cullTaskWorktree: cull, cullOrPreserve } as unknown as WorktreeManager;
  return { instance, cull, cullOrPreserve };
}

/** Minimal HookContext for directly invoking default hooks. */
function makeHookCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: createHookRegistry(),
    cwd: '/tmp/project',
    workDir: '/tmp/project',
    ...overrides,
  };
}

function makeOptions(overrides: Partial<FixLoopOptions> = {}): FixLoopOptions {
  return {
    task,
    reviewStep,
    fixerSteps,
    profiles: makeProfiles(),
    execCtx: makeExecCtx(),
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

/**
 * Script the ordered sequence of `runStep` outcomes. Each entry is either a
 * StepResult (returned) or an Error (thrown). A call beyond the scripted
 * length throws — surfacing unexpected extra loop iterations as test failures.
 */
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

/** The ordered list of StepDefinitions passed to each runStep call. */
function callSteps(): StepDefinition[] {
  return mockRunStep.mock.calls.map((c) => (c[0] as RunStepParams).step);
}

/** Convenience: the ordered list of step names passed to each runStep call. */
function callStepNames(): string[] {
  return callSteps().map((s) => s.name);
}

// ─── per-test reset ────────────────────────────────────────────────────────

beforeEach(() => {
  mockRunStep.mockReset();
  createdDisposes = [];
  realWarn = console.warn;
  warnCalls = [];
  console.warn = ((...args: unknown[]) => {
    warnCalls.push(args);
  }) as unknown as typeof console.warn;
});

afterEach(() => {
  console.warn = realWarn;
});

// ─── fixLoop — happy path ──────────────────────────────────────────────────

describe('fixLoop — (a) approved on first review', () => {
  it('returns { status: "completed" } with the review output', async () => {
    sequence([approved({ score: 10 })]);

    const outcome = await fixLoop(makeOptions());

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.output).toEqual({ score: 10 });
    }
  });

  it('runs ONLY the review step (no fixer steps)', async () => {
    sequence([approved()]);

    await fixLoop(makeOptions());

    expect(callStepNames()).toEqual(['review']);
    expect(mockRunStep).toHaveBeenCalledTimes(1);
  });

  it('returns a TaskOutcome (status ∈ completed | failed)', async () => {
    sequence([approved()]);
    const outcome = await fixLoop(makeOptions());
    expect(['completed', 'failed']).toContain(outcome.status);
  });
});

// ─── fixLoop — (b) rejected → fixer runs → re-reviewed → approved ──────────

describe('fixLoop — (b) rejected → fix → re-review → approved', () => {
  it('runs review, then fixer, then review again, and completes', async () => {
    // review(reject) → fix(approve) → review(approve)
    sequence([rejected('needs fix'), approved('fix done'), approved({ ok: true })]);

    const outcome = await fixLoop(makeOptions());

    expect(outcome.status).toBe('completed');
    expect(callStepNames()).toEqual(['review', 'fix', 'review']);
  });

  it('completes with the second review output', async () => {
    sequence([rejected('nope'), approved('fixed'), approved({ final: true })]);

    const outcome = await fixLoop(makeOptions());

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.output).toEqual({ final: true });
    }
  });

  it('runs ALL fixer steps in order before re-reviewing (multi-step fixer)', async () => {
    // review(reject) → fix(approve) → verify(approve) → review(approve)
    sequence([rejected('bad'), approved('fix1'), approved('fix2'), approved('done')]);

    const outcome = await fixLoop(makeOptions({ fixerSteps: [fixerStep, secondFixerStep] }));

    expect(outcome.status).toBe('completed');
    expect(callStepNames()).toEqual(['review', 'fix', 'verify', 'review']);
  });

  it('does NOT fire onLaneError when the fixer step succeeds', async () => {
    const onLaneError = mock(async (_args: unknown, _ctx: unknown) => {});
    const reg = createHookRegistry();
    reg.defineHook('onLaneError', 'observe');
    reg.register({ onLaneError });
    sequence([rejected('bad'), approved('fixed'), approved('done')]);

    await fixLoop(makeOptions({ hookRegistry: reg }));

    expect(onLaneError).not.toHaveBeenCalled();
  });
});

// ─── fixLoop — (c) maxRounds exhausted → failed ────────────────────────────

describe('fixLoop — (c) maxRounds exhausted', () => {
  it('returns { status: "failed" } when the review never approves', async () => {
    // maxRounds=2 → initial review + 2 fix cycles = 3 reviews, 2 fixer runs
    sequence([rejected('r1'), approved('f1'), rejected('r2'), approved('f2'), rejected('r3')]);

    const outcome = await fixLoop(makeOptions({ maxRounds: 2 }));

    expect(outcome.status).toBe('failed');
  });

  it('runs exactly maxRounds fixer attempts (and maxRounds+1 reviews)', async () => {
    // maxRounds=2 → review, fix, review, fix, review (3 reviews, 2 fixers)
    sequence([rejected('r1'), approved('f1'), rejected('r2'), approved('f2'), rejected('r3')]);

    await fixLoop(makeOptions({ maxRounds: 2 }));

    expect(callStepNames()).toEqual(['review', 'fix', 'review', 'fix', 'review']);
    expect(mockRunStep).toHaveBeenCalledTimes(5);
  });

  it('carries the last review feedback on the failed outcome', async () => {
    const lastFeedback = 'still not good enough';
    sequence([rejected('r1'), approved('f1'), rejected(lastFeedback)]);

    const outcome = await fixLoop(makeOptions({ maxRounds: 1 }));

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      // The failed outcome surfaces the review feedback via either `feedback`
      // or `error` — both are acceptable per TaskOutcome.
      const text = outcome.feedback ?? outcome.error ?? '';
      expect(text).toContain(lastFeedback);
    }
  });

  it('default maxRounds is 3 (4 reviews + 3 fixer attempts when never approved)', async () => {
    // No maxRounds passed → default 3. Always-reject review, always-succeed fixer.
    sequence([
      rejected('1'),
      approved('f1'),
      rejected('2'),
      approved('f2'),
      rejected('3'),
      approved('f3'),
      rejected('4'),
    ]);

    const outcome = await fixLoop(makeOptions());

    expect(outcome.status).toBe('failed');
    // 4 reviews + 3 fixer runs = 7 calls
    expect(mockRunStep).toHaveBeenCalledTimes(7);
    expect(callStepNames()).toEqual(['review', 'fix', 'review', 'fix', 'review', 'fix', 'review']);
  });

  it('respects a custom maxRounds of 1 (1 fixer attempt, 2 reviews)', async () => {
    sequence([rejected('r1'), approved('f1'), rejected('r2')]);

    const outcome = await fixLoop(makeOptions({ maxRounds: 1 }));

    expect(outcome.status).toBe('failed');
    expect(callStepNames()).toEqual(['review', 'fix', 'review']);
    expect(mockRunStep).toHaveBeenCalledTimes(3);
  });

  it('default maxRounds is exactly 3 — pinning the shared DEFAULT_MAX_ROUNDS value', async () => {
    // CHARACTERIZATION: the fixLoop default MUST remain 3 after the
    // consolidation refactor (the shared DEFAULT_MAX_ROUNDS constant). We run
    // the loop to exhaustion with NO maxRounds option and verify it makes
    // exactly 7 calls (4 reviews + 3 fixer runs) — proving the default is the
    // historical magic number 3, not a local copy that could drift.
    sequence([
      rejected('r1'),
      approved('f1'),
      rejected('r2'),
      approved('f2'),
      rejected('r3'),
      approved('f3'),
      rejected('r4'),
    ]);

    await fixLoop(makeOptions());

    // 4 reviews + 3 fixer runs = 7 calls (maxRounds=3 → maxRounds+1 reviews).
    expect(mockRunStep).toHaveBeenCalledTimes(7);
    // The last call is always a review (re-review after the final fixer round).
    expect(callStepNames()[callStepNames().length - 1]).toBe('review');
  });

  it('maxRounds=0 means no fixer rounds: a rejected initial review fails immediately', async () => {
    // Edge: zero fixer rounds → the loop body never executes; the initial
    // rejected review is the terminal state. Pins the boundary so a refactor
    // of the default does not alter the zero-rounds semantics.
    sequence([rejected('nope')]);

    const outcome = await fixLoop(makeOptions({ maxRounds: 0 }));

    expect(outcome.status).toBe('failed');
    expect(callStepNames()).toEqual(['review']);
    expect(mockRunStep).toHaveBeenCalledTimes(1);
  });
});

// ─── fixLoop — (d) shouldIsolate preserves the worktree ────────────────────

describe('fixLoop — (d) shouldIsolate', () => {
  it('shouldIsolate=true → does NOT run the fixer (task isolated immediately)', async () => {
    // review rejects; shouldIsolate=true short-circuits before the fixer runs.
    const reg = createHookRegistry();
    reg.defineHook('shouldIsolate', 'first-wins');
    reg.register({ shouldIsolate: async () => true });
    sequence([rejected('catastrophic')]);

    const outcome = await fixLoop(makeOptions({ hookRegistry: reg }));

    expect(outcome.status).toBe('failed');
    // Only the initial review ran — the fixer was skipped.
    expect(callStepNames()).toEqual(['review']);
    expect(mockRunStep).toHaveBeenCalledTimes(1);
  });

  it('shouldIsolate=true → worktree is PRESERVED (cullTaskWorktree not called)', async () => {
    const reg = createHookRegistry();
    reg.defineHook('shouldIsolate', 'first-wins');
    reg.register({ shouldIsolate: async () => true });
    const { instance, cull } = makeWorktreeManager();
    sequence([rejected('boom')]);

    await fixLoop(
      makeOptions({
        hookRegistry: reg,
        execCtx: makeExecCtx({ worktreeManager: instance, worktreeCwd: '/tmp/wt/task-1' }),
      }),
    );

    expect(cull).not.toHaveBeenCalled();
  });

  it('shouldIsolate=false (default) on exhaustion → worktree is CULLED', async () => {
    // shouldIsolate abstains/false → fixers run → exhausted → cull.
    const reg = createHookRegistry();
    reg.defineHook('shouldIsolate', 'first-wins');
    reg.register({ shouldIsolate: async () => false });
    const { instance, cull } = makeWorktreeManager();
    sequence([rejected('r1'), approved('f1'), rejected('r2')]);

    await fixLoop(
      makeOptions({
        hookRegistry: reg,
        maxRounds: 1,
        execCtx: makeExecCtx({ worktreeManager: instance, worktreeCwd: '/tmp/wt/task-1' }),
      }),
    );

    expect(cull).toHaveBeenCalledTimes(1);
    expect(cull).toHaveBeenCalledWith(task.id);
  });

  it('no shouldIsolate subscribers → defaults to NOT isolating (fixers run, worktree culled)', async () => {
    // No hookRegistry: shouldIsolate is implicitly false.
    const { instance, cull } = makeWorktreeManager();
    sequence([rejected('r1'), approved('f1'), rejected('r2')]);

    await fixLoop(
      makeOptions({
        maxRounds: 1,
        execCtx: makeExecCtx({ worktreeManager: instance, worktreeCwd: '/tmp/wt/task-1' }),
      }),
    );

    expect(cull).toHaveBeenCalledTimes(1);
    expect(cull).toHaveBeenCalledWith(task.id);
  });

  it('no worktreeManager → failure does not attempt culling (no throw)', async () => {
    // No worktree in use → nothing to cull. Must not throw.
    sequence([rejected('r1'), approved('f1'), rejected('r2')]);

    await expect(fixLoop(makeOptions({ maxRounds: 1 }))).resolves.toMatchObject({
      status: 'failed',
    });
  });

  it('shouldIsolate is invoked BEFORE each fixer attempt (once per round)', async () => {
    const shouldIsolate = mock(async () => false);
    const reg = createHookRegistry();
    reg.defineHook('shouldIsolate', 'first-wins');
    reg.register({ shouldIsolate });
    // maxRounds=3, always-reject review, always-succeed fixer → 3 fixer attempts.
    sequence([
      rejected('1'),
      approved('f1'),
      rejected('2'),
      approved('f2'),
      rejected('3'),
      approved('f3'),
      rejected('4'),
    ]);

    await fixLoop(makeOptions({ hookRegistry: reg }));

    expect(shouldIsolate).toHaveBeenCalledTimes(3);
  });

  it('shouldIsolate receives the task, the review feedback, and a laneId', async () => {
    // Typed args so .mock.calls[0][0] is ShouldIsolateArgs (not an empty tuple).
    const shouldIsolate = mock(async (_args: ShouldIsolateArgs, _ctx: HookContext) => false);
    const reg = createHookRegistry();
    reg.defineHook('shouldIsolate', 'first-wins');
    reg.register({ shouldIsolate });
    const feedback = 'reviewer says no';
    sequence([rejected(feedback), approved('f'), approved('done')]);

    await fixLoop(makeOptions({ hookRegistry: reg }));

    expect(shouldIsolate).toHaveBeenCalledTimes(1);
    const args = shouldIsolate.mock.calls[0][0];
    expect(args.task).toBe(task);
    expect(args.error).toBe(feedback);
    expect(typeof args.laneId).toBe('string');
    expect(args.laneId.length).toBeGreaterThan(0);
  });

  it('shouldIsolate=true on the SECOND round still isolates (late isolation)', async () => {
    // Round 1: shouldIsolate=false → fixer runs. Round 2: shouldIsolate=true → isolate.
    let call = 0;
    const reg = createHookRegistry();
    reg.defineHook('shouldIsolate', 'first-wins');
    reg.register({
      shouldIsolate: async () => {
        call += 1;
        return call >= 2; // isolate on the second consultation
      },
    });
    sequence([rejected('r1'), approved('f1'), rejected('r2')]);

    const outcome = await fixLoop(makeOptions({ hookRegistry: reg, maxRounds: 3 }));

    expect(outcome.status).toBe('failed');
    // review(r1) → fix(f1) → review(r2) → [shouldIsolate=true, no further fixer]
    expect(callStepNames()).toEqual(['review', 'fix', 'review']);
  });
});

// ─── fixLoop — (e) onLaneError fires on fixer failure ──────────────────────

describe('fixLoop — (e) onLaneError', () => {
  it('fires onLaneError when a fixer step THROWS', async () => {
    const onLaneError = mock(async (_args: unknown, _ctx: unknown) => {});
    const reg = createHookRegistry();
    reg.defineHook('onLaneError', 'observe');
    reg.register({ onLaneError });
    // review(reject) → fix(THROWS) → review(reject) → exhausted
    sequence([rejected('bad'), new Error('fixer crashed'), rejected('still bad')]);

    await fixLoop(makeOptions({ hookRegistry: reg, maxRounds: 1 }));

    expect(onLaneError).toHaveBeenCalledTimes(1);
    const args = onLaneError.mock.calls[0][0] as OnLaneErrorArgs;
    expect(args.task).toBe(task);
    expect(args.error).toContain('fixer crashed');
    expect(args.phaseId).toBe('review');
    expect(typeof args.laneId).toBe('string');
  });

  it('fires onLaneError when a fixer step is REJECTED', async () => {
    const onLaneError = mock(async (_args: unknown, _ctx: unknown) => {});
    const reg = createHookRegistry();
    reg.defineHook('onLaneError', 'observe');
    reg.register({ onLaneError });
    // review(reject) → fix(REJECTED) → review(reject) → exhausted
    sequence([rejected('bad'), rejected('fixer could not repair'), rejected('still bad')]);

    await fixLoop(makeOptions({ hookRegistry: reg, maxRounds: 1 }));

    expect(onLaneError).toHaveBeenCalledTimes(1);
    const args = onLaneError.mock.calls[0][0] as OnLaneErrorArgs;
    expect(args.error).toContain('fixer could not repair');
  });

  it('does NOT fire onLaneError when only the REVIEW rejects', async () => {
    // Review rejection triggers a fixer attempt; it is NOT itself a lane error.
    const onLaneError = mock(async (_args: unknown, _ctx: unknown) => {});
    const reg = createHookRegistry();
    reg.defineHook('onLaneError', 'observe');
    reg.register({ onLaneError });
    sequence([rejected('review says no'), approved('fixed'), approved('done')]);

    await fixLoop(makeOptions({ hookRegistry: reg }));

    expect(onLaneError).not.toHaveBeenCalled();
  });

  it('fires onLaneError once per fixer failure across multiple rounds', async () => {
    const onLaneError = mock(async (_args: unknown, _ctx: unknown) => {});
    const reg = createHookRegistry();
    reg.defineHook('onLaneError', 'observe');
    reg.register({ onLaneError });
    // maxRounds=2, fixer fails both rounds.
    sequence([
      rejected('r1'),
      new Error('fixer crashed #1'),
      rejected('r2'),
      new Error('fixer crashed #2'),
      rejected('r3'),
    ]);

    await fixLoop(makeOptions({ hookRegistry: reg, maxRounds: 2 }));

    expect(onLaneError).toHaveBeenCalledTimes(2);
    const first = onLaneError.mock.calls[0][0] as OnLaneErrorArgs;
    const second = onLaneError.mock.calls[1][0] as OnLaneErrorArgs;
    expect(first.error).toContain('#1');
    expect(second.error).toContain('#2');
  });

  it('continues to re-review after a fixer failure (does not short-circuit)', async () => {
    const onLaneError = mock(async (_args: unknown, _ctx: unknown) => {});
    const reg = createHookRegistry();
    reg.defineHook('onLaneError', 'observe');
    reg.register({ onLaneError });
    // review(reject) → fix(THROWS) → review(APPROVE) → completed
    sequence([rejected('bad'), new Error('fixer crashed'), approved('surprisingly ok')]);

    const outcome = await fixLoop(makeOptions({ hookRegistry: reg, maxRounds: 1 }));

    expect(onLaneError).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('completed');
  });
});

// ─── fixLoop — session disposal ────────────────────────────────────────────

describe('fixLoop — session disposal', () => {
  it('disposes the review session on first-review approval', async () => {
    sequence([approved()]);

    await fixLoop(makeOptions());

    expect(createdDisposes).toHaveLength(1);
    expect(createdDisposes[0]).toHaveBeenCalledTimes(1);
  });

  it('disposes every step session created during the loop (on completion)', async () => {
    // review, fix, review → 3 sessions
    sequence([rejected('bad'), approved('fixed'), approved('done')]);

    await fixLoop(makeOptions());

    expect(createdDisposes).toHaveLength(3);
    for (const dispose of createdDisposes) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('disposes every step session created during the loop (on failure)', async () => {
    sequence([rejected('r1'), approved('f1'), rejected('r2')]);

    await fixLoop(makeOptions({ maxRounds: 1 }));

    expect(createdDisposes).toHaveLength(3);
    for (const dispose of createdDisposes) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });
});

// ─── fixLoop — empty fixerSteps ────────────────────────────────────────────

describe('fixLoop — edge cases', () => {
  it('with empty fixerSteps, a rejected review cannot be fixed → exhausts and fails', async () => {
    // No fixer steps to run; review keeps rejecting.
    sequence([rejected('1'), rejected('2'), rejected('3'), rejected('4')]);

    const outcome = await fixLoop(makeOptions({ fixerSteps: [], maxRounds: 3 }));

    expect(outcome.status).toBe('failed');
    // Only reviews ran (no fixer steps to invoke).
    expect(callStepNames()).toEqual(['review', 'review', 'review', 'review']);
  });
});

// ─── defaultOnLaneError ────────────────────────────────────────────────────

describe('defaultOnLaneError', () => {
  it('is a function (an ObserveHook)', () => {
    expect(typeof defaultOnLaneError).toBe('function');
  });

  it('is assignable to WorkflowHooks.onLaneError (type-level + identity)', () => {
    const hooks: WorkflowHooks = { onLaneError: defaultOnLaneError };
    expect(hooks.onLaneError).toBe(defaultOnLaneError);
  });

  it('logs the error via console.warn', async () => {
    const args: OnLaneErrorArgs = {
      laneId: 'lane-7',
      task,
      error: 'agent exploded',
      phaseId: 'review',
    };

    await defaultOnLaneError(args, makeHookCtx());

    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    const flat = String(warnCalls[0]);
    expect(flat).toContain('agent exploded');
  });

  it('does not throw (observe hooks are fire-and-forget)', async () => {
    const args: OnLaneErrorArgs = {
      laneId: 'lane-1',
      task,
      error: 'boom',
      phaseId: 'review',
    };
    await expect(defaultOnLaneError(args, makeHookCtx())).resolves.toBeUndefined();
  });

  it('logs regardless of the laneId / phaseId values', async () => {
    await defaultOnLaneError({ laneId: 'any-lane', task, error: 'e1', phaseId: 'p1' }, makeHookCtx());
    await defaultOnLaneError({ laneId: 'other', task, error: 'e2', phaseId: 'p2' }, makeHookCtx());
    expect(warnCalls.length).toBe(2);
    expect(String(warnCalls[0])).toContain('e1');
    expect(String(warnCalls[1])).toContain('e2');
  });
});

// ─── defaultShouldIsolate ──────────────────────────────────────────────────

describe('defaultShouldIsolate', () => {
  it('is a function (a FirstWinsHook)', () => {
    expect(typeof defaultShouldIsolate).toBe('function');
  });

  it('is assignable to WorkflowHooks.shouldIsolate (type-level + identity)', () => {
    const hooks: WorkflowHooks = { shouldIsolate: defaultShouldIsolate };
    expect(hooks.shouldIsolate).toBe(defaultShouldIsolate);
  });

  it('returns false by default (do NOT isolate — cull the failed task worktree)', async () => {
    const args: ShouldIsolateArgs = { task, error: 'some failure', laneId: 'lane-1' };
    const result = await defaultShouldIsolate(args, makeHookCtx());
    expect(result).toBe(false);
  });

  it('returns a non-undefined value (wins in first-wins composition)', async () => {
    const result = await defaultShouldIsolate({ task, error: 'x', laneId: 'l' }, makeHookCtx());
    expect(result).not.toBeUndefined();
  });

  it('returns false regardless of the task / error / laneId args', async () => {
    const a = await defaultShouldIsolate({ task, error: 'catastrophic', laneId: 'lane-a' }, makeHookCtx());
    const b = await defaultShouldIsolate({ task, error: 'minor', laneId: 'lane-b' }, makeHookCtx());
    expect(a).toBe(false);
    expect(b).toBe(false);
  });
});

// ─── Defaults compose through the HookRegistry ─────────────────────────────
//
// These verify the defaults satisfy their declared composition rule when wired
// into a real HookRegistry (the engine's invocation path). Mirrors the
// registry-composition block in hooks/defaults/worktree-defaults.test.ts.

describe('defaults compose through the HookRegistry', () => {
  it('shouldIsolate: default returns false via invokeFirstWins', async () => {
    const reg = createHookRegistry();
    reg.defineHook('shouldIsolate', 'first-wins');
    reg.register({ shouldIsolate: defaultShouldIsolate });

    const result = await reg.invokeFirstWins(
      'shouldIsolate',
      { task, error: 'fail', laneId: 'lane-1' } satisfies ShouldIsolateArgs,
      makeHookCtx({ registry: reg }),
    );

    expect(result).toBe(false);
  });

  it('shouldIsolate: a workflow override registered BEFORE the default short-circuits it', async () => {
    const reg = createHookRegistry();
    reg.defineHook('shouldIsolate', 'first-wins');
    reg.register({
      shouldIsolate: [async () => true, defaultShouldIsolate],
    });

    const result = await reg.invokeFirstWins(
      'shouldIsolate',
      { task, error: 'fail', laneId: 'lane-1' } satisfies ShouldIsolateArgs,
      makeHookCtx({ registry: reg }),
    );

    expect(result).toBe(true);
  });

  it('onLaneError: default logs via invokeObserve', async () => {
    const reg = createHookRegistry();
    reg.defineHook('onLaneError', 'observe');
    reg.register({ onLaneError: defaultOnLaneError });

    await reg.invokeObserve(
      'onLaneError',
      { laneId: 'lane-1', task, error: 'hook-path boom', phaseId: 'review' } satisfies OnLaneErrorArgs,
      makeHookCtx({ registry: reg }),
    );

    expect(warnCalls.length).toBe(1);
    expect(String(warnCalls[0])).toContain('hook-path boom');
  });

  it('onLaneError: default runs alongside a custom observe subscriber (fan-out)', async () => {
    const custom = mock(async (_args: unknown, _ctx: unknown) => {});
    const reg = createHookRegistry();
    reg.defineHook('onLaneError', 'observe');
    reg.register({ onLaneError: [custom, defaultOnLaneError] });

    await reg.invokeObserve(
      'onLaneError',
      { laneId: 'lane-1', task, error: 'fan', phaseId: 'review' } satisfies OnLaneErrorArgs,
      makeHookCtx({ registry: reg }),
    );

    expect(custom).toHaveBeenCalledTimes(1);
    expect(warnCalls.length).toBe(1);
  });
});

// ─── fixLoop — (f) fixer step composition (runStep contract) ────────────────
//
// `fixLoop` does NOT re-implement agent spawning — it composes with `runStep`
// for BOTH the review and the fixer steps (§5 item #7). A "tooled fix-up"
// fixer (the edit + re-stage + self-verify agent materialized by
// `runTooledFixup` in core/worktree-fixup.ts) is, from fixLoop's perspective,
// just another fixer StepDefinition: an implementer-profile step with write
// tools that runs in the worktree cwd and returns a StepResult. These tests
// pin the `runStep` INVOCATION CONTRACT that makes that composition correct:
//   - the fixer StepDefinition is forwarded unchanged (profileId / isReadOnly
//     preserved so spawnAgent arms the fixer with write tools),
//   - a stable laneId (`fixLoop:<taskId>`) is passed to every call for audit
//     correlation,
//   - stepIndex / execCount are threaded so each fixer step lands in a unique
//     persisted session directory,
//   - the SAME profiles map + execCtx (incl. worktreeCwd) are forwarded so the
//     fixer agent runs in the isolated worktree — the precondition for a
//     tooled edit/re-stage/self-verify fixer.
//
// runStep receives a single RunStepParams object (c[0] in mock calls).

describe('fixLoop — (f) fixer step composition (runStep contract for tooled fix-up)', () => {
  // A tooled-fix-up-style fixer: implementer profile + write tools enabled.
  const tooledFixStep: StepDefinition = {
    name: 'tooled-fix',
    profileId: 'implementer',
    isReadOnly: false,
  };

  it('forwards the fixer StepDefinition unchanged (profileId + isReadOnly preserved)', async () => {
    sequence([rejected('bad'), approved('fixed'), approved('done')]);

    await fixLoop(makeOptions({ fixerSteps: [tooledFixStep] }));

    // calls[1] is the fixer call — a single RunStepParams object at c[0].
    const fixerCall = mockRunStep.mock.calls[1];
    expect(fixerCall).toBeDefined();
    const fixerParams = fixerCall[0] as RunStepParams;
    expect(fixerParams.step).toBe(tooledFixStep);
    // isReadOnly:false → spawnAgent arms the fixer with write/edit/bash tools,
    // the precondition for an edit + re-stage + self-verify fixer.
    expect(fixerParams.step.isReadOnly).toBe(false);
    expect(fixerParams.step.profileId).toBe('implementer');
  });

  it('passes a stable laneId (fixLoop:<taskId>) to every runStep call', async () => {
    sequence([rejected('bad'), approved('fixed'), approved('done')]);

    await fixLoop(makeOptions({ fixerSteps: [tooledFixStep] }));

    const laneIds = mockRunStep.mock.calls.map((c) => (c[0] as RunStepParams).agentId);
    expect(laneIds).toEqual([`fixLoop:${task.id}`, `fixLoop:${task.id}`, `fixLoop:${task.id}`]);
  });

  it('threads stepIndex/execCount so each fixer step gets a unique session position', async () => {
    // review → tooled-fix → verify → review
    sequence([rejected('bad'), approved('f1'), approved('f2'), approved('done')]);

    await fixLoop(makeOptions({ fixerSteps: [tooledFixStep, secondFixerStep] }));

    const ctxs = mockRunStep.mock.calls.map((c) => (c[0] as RunStepParams).ctx);
    // After C1/C2, the session primitive manages its own identity (runnerRole/attempt);
    // fixLoop passes a constant ctx { stepIndex: 0, attempt: 0, execCount: 0 }.
    expect(ctxs[0]).toEqual({ stepIndex: 0, attempt: 0, execCount: 0 });
    expect(ctxs[1]).toEqual({ stepIndex: 0, attempt: 0, execCount: 0 });
    expect(ctxs[2]).toEqual({ stepIndex: 0, attempt: 0, execCount: 0 });
    expect(ctxs[3]).toEqual({ stepIndex: 0, attempt: 0, execCount: 0 });
  });

  it('forwards the same profiles map to runStep for review and fixer', async () => {
    const profiles = makeProfiles();
    sequence([rejected('bad'), approved('fixed'), approved('done')]);

    await fixLoop(makeOptions({ profiles, fixerSteps: [tooledFixStep] }));

    for (const c of mockRunStep.mock.calls) {
      expect((c[0] as RunStepParams).profiles).toBe(profiles);
    }
  });

  it('forwards execCtx (incl. worktreeCwd) so the tooled fix-up agent runs in the worktree', async () => {
    const execCtx = makeExecCtx({ worktreeCwd: '/tmp/wt/task-1/tooled' });
    sequence([rejected('bad'), approved('fixed'), approved('done')]);

    await fixLoop(makeOptions({ execCtx, fixerSteps: [tooledFixStep] }));

    // Every step receives the SAME execCtx instance; the fixer call's execCtx
    // carries the worktree cwd the tooled fix-up agent must operate in.
    for (const c of mockRunStep.mock.calls) {
      expect((c[0] as RunStepParams).execCtx).toBe(execCtx);
    }
    const fixerExecCtx = (mockRunStep.mock.calls[1][0] as RunStepParams).execCtx;
    expect(fixerExecCtx.worktreeCwd).toBe('/tmp/wt/task-1/tooled');
  });

  it('runStep receives no existingSessionPath (every round is a fresh agent turn)', async () => {
    sequence([rejected('bad'), approved('fixed'), approved('done')]);

    await fixLoop(makeOptions({ fixerSteps: [tooledFixStep] }));

    for (const c of mockRunStep.mock.calls) {
      // existingSessionPath is omitted → undefined.
      expect((c[0] as RunStepParams).existingSessionPath).toBeUndefined();
    }
  });

  it('a tooled-fix-up-style fixer that "repairs and self-verifies" completes the loop', async () => {
    // Conceptually the fixer edited files, re-staged, and self-verified
    // (tsc + eslint), then returned approved; the re-review agrees.
    sequence([rejected('fails tsc'), approved({ repaired: true }), approved({ ok: true })]);

    const outcome = await fixLoop(makeOptions({ fixerSteps: [tooledFixStep] }));

    expect(outcome.status).toBe('completed');
    expect(callStepNames()).toEqual(['review', 'tooled-fix', 'review']);
  });
});

// ─── fixLoop — (g) hookRegistry absent (default behavior) ───────────────────
//
// When NO hookRegistry is provided (neither the option nor execCtx.hookRegistry),
// fixLoop runs with the default behavior:
//   - shouldIsolate effectively returns false → fixers run, and on exhaustion
//     the worktree is CULLED (when a worktreeManager is present).
//   - a fixer step that REJECTS or THROWS does NOT propagate: the lane error is
//     swallowed and the loop continues to the re-review.
//
// NOTE on "errors logged via console": fixLoop does NOT auto-wire its exported
// `defaultOnLaneError`. When no registry is present, lane errors are silently
// swallowed (by design — see fireOnLaneError's `if (!hookRegistry) return`).
// The console.warn logging behavior is OBTAINED BY registering
// `defaultOnLaneError` as the `onLaneError` subscriber (tested below). This
// keeps the "no hooks → zero behavior change" guarantee symmetric with
// runStep's hook seams.

describe('fixLoop — (g) hookRegistry absent (default behavior)', () => {
  it('no hookRegistry → shouldIsolate defaults to false (the fixer still runs)', async () => {
    sequence([rejected('bad'), approved('fixed'), approved('done')]);

    const outcome = await fixLoop(makeOptions());

    expect(outcome.status).toBe('completed');
    expect(callStepNames()).toContain('fix');
  });

  it('no hookRegistry → a fixer THROW is swallowed and the loop continues', async () => {
    // review(reject) → fix(THROWS) → review(approve) → completed
    sequence([rejected('bad'), new Error('fixer crashed'), approved('recovered')]);

    const outcome = await fixLoop(makeOptions({ maxRounds: 1 }));

    expect(outcome.status).toBe('completed');
    // The re-review still ran after the thrown fixer (no propagation).
    expect(callStepNames()).toEqual(['review', 'fix', 'review']);
  });

  it('no hookRegistry → fixer failure does not throw and surfaces a failed outcome on exhaustion', async () => {
    sequence([rejected('r1'), new Error('fixer crashed'), rejected('r2')]);

    const outcome = await fixLoop(makeOptions({ maxRounds: 1 }));

    expect(outcome.status).toBe('failed');
  });

  it('no hookRegistry → exhaustion CULLS the worktree (default = do not isolate)', async () => {
    const { instance, cull } = makeWorktreeManager();
    sequence([rejected('r1'), approved('f1'), rejected('r2')]);

    await fixLoop(
      makeOptions({
        maxRounds: 1,
        execCtx: makeExecCtx({ worktreeManager: instance, worktreeCwd: '/tmp/wt/task-1' }),
      }),
    );

    expect(cull).toHaveBeenCalledTimes(1);
    expect(cull).toHaveBeenCalledWith(task.id);
  });

  it('registering defaultOnLaneError wires console.warn logging for fixer errors', async () => {
    // The default hook provides the "errors logged via console" capability —
    // but only when a caller opts in by registering it as a subscriber.
    const reg = createHookRegistry();
    reg.defineHook('onLaneError', 'observe');
    reg.register({ onLaneError: defaultOnLaneError });
    sequence([rejected('bad'), new Error('fixer boom'), rejected('still bad')]);

    await fixLoop(makeOptions({ hookRegistry: reg, maxRounds: 1 }));

    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(warnCalls[0])).toContain('fixer boom');
  });

  it('registering defaultShouldIsolate yields the default (false → cull on exhaustion)', async () => {
    const reg = createHookRegistry();
    reg.defineHook('shouldIsolate', 'first-wins');
    reg.register({ shouldIsolate: defaultShouldIsolate });
    const { instance, cull } = makeWorktreeManager();
    sequence([rejected('r1'), approved('f1'), rejected('r2')]);

    await fixLoop(
      makeOptions({
        hookRegistry: reg,
        maxRounds: 1,
        execCtx: makeExecCtx({ worktreeManager: instance, worktreeCwd: '/tmp/wt/task-1' }),
      }),
    );

    // defaultShouldIsolate returns false → not isolated → worktree culled.
    expect(cull).toHaveBeenCalledTimes(1);
    expect(cull).toHaveBeenCalledWith(task.id);
  });

  it('hookRegistry threaded via execCtx (not the option) is still picked up', async () => {
    // fixLoop resolves hookRegistry from options.hookRegistry ?? execCtx.hookRegistry.
    const onLaneError = mock(async (_args: unknown, _ctx: unknown) => {});
    const reg = createHookRegistry();
    reg.defineHook('onLaneError', 'observe');
    reg.register({ onLaneError });
    sequence([rejected('bad'), new Error('fixer boom'), rejected('still bad')]);

    await fixLoop(
      makeOptions({
        // hookRegistry option NOT set; registry threaded via execCtx only.
        execCtx: makeExecCtx({ hookRegistry: reg }),
        maxRounds: 1,
      }),
    );

    expect(onLaneError).toHaveBeenCalledTimes(1);
    expect((onLaneError.mock.calls[0][0] as OnLaneErrorArgs).error).toContain('fixer boom');
  });
});

// ─── fixLoop — (h) cullOrPreserve delegation contract ───────────────────────
//
// After the separation-of-concerns refactor, `fixLoop` delegates worktree
// culling to `worktreeManager.cullOrPreserve(taskId, preserve)` instead of
// calling `cullTaskWorktree` inline (the try/catch + console.warn now lives in
// WorktreeManager). These tests pin the NEW delegation contract:
//   - On exhaustion (not isolated): `cullOrPreserve` is called with
//     `(task.id, false)` — the worktree IS culled.
//   - On isolation (shouldIsolate=true): `cullOrPreserve` is called with
//     `(task.id, true)` — the worktree is PRESERVED.
//   - On approval (completed): `cullOrPreserve` is NOT called at all — the
//     worktree is preserved for the merge step.
//
// The mock `makeWorktreeManager` exposes BOTH `cullOrPreserve` (delegating to
// `cullTaskWorktree`) so the EXISTING cull/preserve assertions remain valid
// before AND after the refactor, while these NEW assertions lock the exact
// `(taskId, preserve)` args passed through the new delegation seam.

describe('fixLoop — (h) cullOrPreserve delegation contract', () => {
  it('on exhaustion → calls cullOrPreserve(task.id, false)', async () => {
    const { instance, cullOrPreserve } = makeWorktreeManager();
    sequence([rejected('r1'), approved('f1'), rejected('r2')]);

    await fixLoop(
      makeOptions({
        maxRounds: 1,
        execCtx: makeExecCtx({ worktreeManager: instance, worktreeCwd: '/tmp/wt/task-1' }),
      }),
    );

    expect(cullOrPreserve).toHaveBeenCalledTimes(1);
    expect(cullOrPreserve).toHaveBeenCalledWith(task.id, false);
  });

  it('on isolation (shouldIsolate=true) → calls cullOrPreserve(task.id, true)', async () => {
    const reg = createHookRegistry();
    reg.defineHook('shouldIsolate', 'first-wins');
    reg.register({ shouldIsolate: async () => true });
    const { instance, cullOrPreserve } = makeWorktreeManager();
    sequence([rejected('boom')]);

    await fixLoop(
      makeOptions({
        hookRegistry: reg,
        execCtx: makeExecCtx({ worktreeManager: instance, worktreeCwd: '/tmp/wt/task-1' }),
      }),
    );

    expect(cullOrPreserve).toHaveBeenCalledTimes(1);
    expect(cullOrPreserve).toHaveBeenCalledWith(task.id, true);
  });

  it('on approval → does NOT call cullOrPreserve (worktree preserved for merge)', async () => {
    const { instance, cullOrPreserve } = makeWorktreeManager();
    sequence([approved('done')]);

    await fixLoop(
      makeOptions({
        execCtx: makeExecCtx({ worktreeManager: instance, worktreeCwd: '/tmp/wt/task-1' }),
      }),
    );

    expect(cullOrPreserve).not.toHaveBeenCalled();
  });

  it('on exhaustion WITHOUT a worktreeManager → does not throw (no cull path)', async () => {
    // No worktreeManager → cullOrPreserve is unreachable; the loop must not throw.
    sequence([rejected('r1'), approved('f1'), rejected('r2')]);

    await expect(fixLoop(makeOptions({ maxRounds: 1 }))).resolves.toMatchObject({
      status: 'failed',
    });
  });
});
