// ─── Tests for pool/lane-pool.ts — beforeTask hook wiring ───────────────────
//
// Verifies the `beforeTask` first-wins hook seam in `LanePool.resolveRunner`:
//
//   When a `hookRegistry` with at least one `beforeTask` subscriber is threaded
//   through `LanePoolOptions`, `resolveRunner` invokes the hook seeded with
//   `{ task, steps }` BEFORE building the runner. A subscriber may:
//     • return `{ steps: [...] }` → override the seed step list (the hook's
//       steps are passed to `linearStepsRunner`).
//     • return `{ skip: true }`  → the task is CANCELLED in the tracker
//       (terminal `cancelled` status) without running any steps.
//     • return `undefined`       → abstain (the seed from `getStepsForTask`
//       drives the steps).
//
//   Zero behavior change when NO `hookRegistry` is provided: `getStepsForTask`
//   drives the steps exactly as before (backward compat).
//
// Required scenarios:
//   (1) hookRegistry + beforeTask subscriber returning {steps} ⇒ LanePool
//       passes those steps to `linearStepsRunner`.
//   (2) beforeTask subscriber returning {skip:true} ⇒ task reaches `cancelled`.
//   (3) no hookRegistry ⇒ getStepsForTask steps reach `linearStepsRunner`
//       (backward compat).
//   (4) beforeTask subscriber returning undefined ⇒ getStepsForTask seed is
//       used (abstain path).
//
// Approach: drive a REAL TaskTracker + REAL HookRegistry and mock
// `linear-steps-runner` (to capture the steps it receives) and profile loading
// (to avoid real FS reads). The mocked runner immediately settles its task, so
// run() terminates quickly. maxConcurrentLanes=1 + laneWaitTimeoutMs=100 keeps
// the suite fast.

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StepDefinition, Task } from '../core/types.js';
import { createHookRegistry } from '../hooks/registry.js';
import type { HookRegistry } from '../hooks/types.js';
import { TaskTracker } from '../tracking/task-status.js';
import type { LanePoolOptions, TaskOutcome, TaskRunnerContext } from './types.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realLinearStepsRunner = Object.assign({}, await import('./linear-steps-runner.js'));
const realProfile = Object.assign({}, await import('../core/profile.js'));

// ─── Mock linear-steps-runner (capture the steps it receives) ──────────────
//
// The mock records every `steps` array handed to `linearStepsRunner` and
// returns a runner that immediately settles its task as completed — so the
// pool terminates without spawning any real agents. Tests assert against
// `capturedStepsCalls` to verify which steps the pool actually used.

const capturedStepsCalls: StepDefinition[][] = [];
const mockLinearStepsRunner = mock((steps: StepDefinition[]): ((ctx: TaskRunnerContext) => Promise<TaskOutcome>) => {
  capturedStepsCalls.push(steps);
  return async (ctx: TaskRunnerContext): Promise<TaskOutcome> => {
    ctx.completeTask({ steps });
    return { status: 'completed', output: { steps } };
  };
});

mock.module('./linear-steps-runner.js', () => ({
  linearStepsRunner: (steps: StepDefinition[]) => mockLinearStepsRunner(steps),
}));

// ─── Mock profile loading (avoid real FS reads) ────────────────────────────

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((dirs: unknown) => unknown);
const mockClearProfileCache = mock(() => {});
mock.module('../core/profile.js', () => ({
  loadProfilesFromDirs: (dirs: unknown) => mockLoadProfilesFromDirs(dirs),
  clearProfileCache: () => mockClearProfileCache(),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

const { LanePool } = await import('./lane-pool.js');

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function makeTask(id = 'task-1'): Task {
  return {
    id,
    title: 'Do the thing',
    prompt: 'please do the thing',
    profile: 'coder',
    files: [],
    dependencies: [],
    status: 'ready',
    phaseId: 'implement',
    worktree: 'none',
  };
}

const SEED_STEPS: StepDefinition[] = [{ name: 'seed-execute', profileId: 'implementer', isReadOnly: false }];

const HOOK_STEPS: StepDefinition[] = [
  { name: 'hook-write-tests', profileId: 'test-writer', isReadOnly: false },
  { name: 'hook-execute', profileId: 'implementer', isReadOnly: false },
  { name: 'hook-review', profileId: 'implement-reviewer', isReadOnly: true },
];

/** Build LanePoolOptions. Optional hookRegistry / getStepsForTask default to omitted. */
function makeOptions(overrides: Partial<LanePoolOptions> = {}): LanePoolOptions {
  const taskTracker = overrides.taskTracker ?? new TaskTracker();
  return {
    maxConcurrentLanes: 1,
    profilesDirs: ['/tmp/profiles'],
    sessionBaseDir: join(tmpdir(), 'before-task-sessions'),
    cwd: '/tmp/project',
    taskTracker,
    phaseId: 'implement',
    maxStepRetries: 1,
    laneWaitTimeoutMs: 100,
    ...overrides,
  };
}

/** Build a real HookRegistry with `beforeTask` declared as first-wins. */
function makeRegistry(): HookRegistry {
  const reg = createHookRegistry();
  reg.defineHook('beforeTask', 'first-wins');
  return reg;
}

beforeEach(() => {
  mockLoadProfilesFromDirs.mockReset();
  mockClearProfileCache.mockReset();
  // mockClear (not mockReset) preserves the implementation — only clears
  // call history so per-test assertions on captured steps stay isolated.
  mockLinearStepsRunner.mockClear();
  capturedStepsCalls.length = 0;
  // Default: profile loading returns an empty map (the mocked runner ignores it).
  mockLoadProfilesFromDirs.mockResolvedValue(new Map());
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LanePool.resolveRunner — beforeTask hook', () => {
  // ── (1) hook returning {steps} overrides the seed ─────────────────────

  it('(1) uses the steps returned by a beforeTask subscriber (overrides getStepsForTask seed)', async () => {
    const hookRegistry = makeRegistry();
    const seenArgs: { task: Task; steps: StepDefinition[] }[] = [];
    hookRegistry.register({
      beforeTask: (args) => {
        seenArgs.push(args);
        return { steps: HOOK_STEPS };
      },
    });

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        hookRegistry,
        // A seed is provided; the hook should override it.
        getStepsForTask: () => SEED_STEPS,
      }),
    );

    const result = await pool.run();

    // The hook fired once for the single task, seeded with getStepsForTask's steps.
    expect(seenArgs).toHaveLength(1);
    expect(seenArgs[0].task.id).toBe('task-1');

    // linearStepsRunner received the HOOK's steps (not the seed).
    expect(capturedStepsCalls).toHaveLength(1);
    expect(capturedStepsCalls[0]).toBe(HOOK_STEPS);

    // The task completed.
    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(tracker.getTask('task-1')?.status).toBe('complete');
  });

  // ── (2) hook returning {skip:true} cancels the task ───────────────────

  it('(2) cancels the task and fires onTaskRejected with default reason when beforeTask returns { skip: true }', async () => {
    const hookRegistry = makeRegistry();
    hookRegistry.register({
      beforeTask: () => ({ skip: true }),
    });

    const rejectedReasons: string[] = [];
    const tracker = new TaskTracker();
    tracker.addTask(makeTask('skip-me'));
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        hookRegistry,
        getStepsForTask: () => SEED_STEPS,
        onStatus: {
          onTaskRejected: (args: { taskId: string; title: string; reason: string }) => {
            rejectedReasons.push(args.reason);
          },
        },
      }),
    );

    const result = await pool.run();

    // The task reached the terminal `cancelled` status (skip semantics).
    expect(tracker.getTask('skip-me')?.status).toBe('cancelled');

    // A cancelled task is neither completed nor failed.
    expect(result.completedTasks).toBe(0);
    expect(result.failedTasks).toBe(0);

    // linearStepsRunner was NEVER called — no steps ran.
    expect(capturedStepsCalls).toHaveLength(0);
    expect(mockLinearStepsRunner).not.toHaveBeenCalled();

    // FIX B: onTaskRejected fires with the default skip reason so the
    // TUI/web status projection does not show the task stuck at 'active'.
    expect(rejectedReasons).toHaveLength(1);
    expect(rejectedReasons[0]).toBe('Skipped by beforeTask hook');
  });

  it('(2b) passes the hook-provided reason through to onTaskRejected when beforeTask returns { skip: true, reason }', async () => {
    const hookRegistry = makeRegistry();
    hookRegistry.register({
      beforeTask: () => ({ skip: true, reason: 'Out of scope for this phase' }),
    });

    const rejectedReasons: string[] = [];
    const tracker = new TaskTracker();
    tracker.addTask(makeTask('skip-me'));
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        hookRegistry,
        getStepsForTask: () => SEED_STEPS,
        onStatus: {
          onTaskRejected: (args: { taskId: string; title: string; reason: string }) => {
            rejectedReasons.push(args.reason);
          },
        },
      }),
    );

    const result = await pool.run();

    expect(tracker.getTask('skip-me')?.status).toBe('cancelled');
    expect(result.completedTasks).toBe(0);
    expect(result.failedTasks).toBe(0);

    // FIX B: the custom reason from the hook is surfaced to onTaskRejected.
    expect(rejectedReasons).toHaveLength(1);
    expect(rejectedReasons[0]).toBe('Out of scope for this phase');
  });

  // ── (3) no hookRegistry ⇒ getStepsForTask drives steps (backward compat)

  it('(3) uses getStepsForTask steps when no hookRegistry is provided (backward compat)', async () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask());
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        // No hookRegistry — identical to pre-hook behavior.
        getStepsForTask: () => SEED_STEPS,
      }),
    );

    const result = await pool.run();

    // linearStepsRunner received getStepsForTask's steps.
    expect(capturedStepsCalls).toHaveLength(1);
    expect(capturedStepsCalls[0]).toBe(SEED_STEPS);

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(tracker.getTask('task-1')?.status).toBe('complete');
  });

  // ── (4) hook returning undefined ⇒ seed is used (abstain) ─────────────

  it('(4) falls back to the getStepsForTask seed when the beforeTask subscriber abstains (returns undefined)', async () => {
    const hookRegistry = makeRegistry();
    hookRegistry.register({
      // Abstain — return undefined so the seed is kept.
      beforeTask: () => undefined,
    });

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        hookRegistry,
        getStepsForTask: () => SEED_STEPS,
      }),
    );

    const result = await pool.run();

    // linearStepsRunner received the SEED (the hook abstained).
    expect(capturedStepsCalls).toHaveLength(1);
    expect(capturedStepsCalls[0]).toBe(SEED_STEPS);

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
  });

  // ── (5) hookRegistry with no beforeTask subscribers ⇒ seed is used ────
  //
  // Mirrors the `hasSubscribers` gate: an empty/no-subscriber registry must
  // NOT trigger a pointless `invokeFirstWins` round-trip and must fall through
  // to the seed (same as no registry at all).

  it('(5) uses the getStepsForTask seed when hookRegistry has no beforeTask subscribers', async () => {
    const hookRegistry = makeRegistry();
    // No beforeTask subscriber registered.

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        hookRegistry,
        getStepsForTask: () => SEED_STEPS,
      }),
    );

    const result = await pool.run();

    expect(capturedStepsCalls).toHaveLength(1);
    expect(capturedStepsCalls[0]).toBe(SEED_STEPS);
    expect(result.completedTasks).toBe(1);
  });

  // ── (6) hook returning {steps: []} ⇒ seed is kept (empty override ignored)

  it('(6) ignores an empty steps override and keeps the seed', async () => {
    const hookRegistry = makeRegistry();
    hookRegistry.register({
      // Returning an empty steps array is treated as "no override" so the
      // seed is preserved (avoids a confusing "No steps" failure).
      beforeTask: () => ({ steps: [] }),
    });

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        hookRegistry,
        getStepsForTask: () => SEED_STEPS,
      }),
    );

    const result = await pool.run();

    expect(capturedStepsCalls).toHaveLength(1);
    expect(capturedStepsCalls[0]).toBe(SEED_STEPS);
    expect(result.completedTasks).toBe(1);
  });
});

// ─── Restore real modules ─────────────────────────────────────────────────

afterAll(() => {
  mock.module('./linear-steps-runner.js', () => realLinearStepsRunner);
  mock.module('../core/profile.js', () => realProfile);
});
