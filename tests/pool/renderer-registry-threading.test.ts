/**
 * @fileoverview Tests for threading the optional `rendererRegistry` field
 * through the pool layer.
 *
 * Threading chain under test:
 *
 *   LanePoolOptions.rendererRegistry        (types.ts)
 *     -> TaskRunnerContext.rendererRegistry (built in lane-pool.ts runLane)
 *       -> StepExecutionContext.rendererRegistry (built in linear-steps-runner.ts)
 *         -> runStep(execCtx)               (step-execution.ts)
 *
 * The field is OPTIONAL at every layer, so existing code compiles unchanged.
 * These tests assert the field propagates the exact same instance reference
 * end-to-end and defaults to `undefined` when omitted.
 *
 * To observe the `StepExecutionContext` that linear-steps-runner builds and
 * hands to `runStep`, the `step-execution.js` module's `runStep` export is
 * replaced with a mock via `mock.module` (same technique used by
 * council-runner.test.ts). The mock records its arguments so we can inspect
 * the `execCtx` (the 6th positional argument) passed through.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real modules before mocking ───────────────────────────────────

const realStepExecution = Object.assign({}, await import('../../packages/engine/src/pool/step-execution.js'));
const realProfile = Object.assign({}, await import('../../packages/engine/src/core/profile.js'));

// ─── Mock definitions + mock.module ────────────────────────────────────────

// runStep mock — returns the 6th arg (execCtx) observable. Signature:
//   runStep(task, step, agentId, ctx, profiles, execCtx, existingSessionPath?)
// so execCtx lives at index 5.
export const mockRunStep = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module('../../packages/engine/src/pool/step-execution.js', () => ({
  runStep: (...args: unknown[]) => mockRunStep(...args),
}));

// LanePool.run() calls loadProfilesFromDirs + clearProfileCache from profile.js.
// Mock them so the tests never touch the filesystem.
mock.module('../../packages/engine/src/core/profile.js', () => ({
  loadProfilesFromDirs: async () => new Map(),
  clearProfileCache: () => {},
}));

// ─── Imports that resolve through the mocks above ─────────────────────────

import type { RendererRegistry as RendererRegistryType } from '../../packages/engine/src/core/renderer-registry.js';
import { RendererRegistry } from '../../packages/engine/src/core/renderer-registry.js';
import type { Task } from '../../packages/engine/src/core/types.js';
import { LanePool } from '../../packages/engine/src/pool/lane-pool.js';
import { linearStepsRunner } from '../../packages/engine/src/pool/linear-steps-runner.js';
import type { StepExecutionContext } from '../../packages/engine/src/pool/step-execution.js';
import type {
  StepDefinition,
  TaskRunner,
  TaskRunnerContext,
  TrackedSession,
} from '../../packages/engine/src/pool/types.js';
import { TaskTracker } from '../../packages/engine/src/tracking/task-status.js';
import { makeTask } from '../helpers/make-task.js';

// ─── Type-level documentation (compile-time) ───────────────────────────────
//
// Same Equal<> / assertEqual trick used in tests/core/renderer-registry.test.ts
// and tests/core/types.test.ts. These pin the exact field shapes: the field
// must exist and be exactly `RendererRegistry | undefined` (optional) on each
// of the three context interfaces.

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type HasKey<T, K extends string> = K extends keyof T ? true : false;

function assertEqual<T extends true>(_desc?: string): void {}

assertEqual<HasKey<LanePoolOptionsLike, 'rendererRegistry'>>('LanePoolOptions declares rendererRegistry');
assertEqual<Equal<LanePoolOptionsLike['rendererRegistry'], RendererRegistryType | undefined>>(
  'LanePoolOptions.rendererRegistry is RendererRegistry | undefined',
);

assertEqual<HasKey<TaskRunnerContext, 'rendererRegistry'>>('TaskRunnerContext declares rendererRegistry');
assertEqual<Equal<TaskRunnerContext['rendererRegistry'], RendererRegistryType | undefined>>(
  'TaskRunnerContext.rendererRegistry is RendererRegistry | undefined',
);

assertEqual<HasKey<StepExecutionContext, 'rendererRegistry'>>('StepExecutionContext declares rendererRegistry');
assertEqual<Equal<StepExecutionContext['rendererRegistry'], RendererRegistryType | undefined>>(
  'StepExecutionContext.rendererRegistry is RendererRegistry | undefined',
);

// Local structural alias for LanePoolOptions so this file does not need to
// import the (potentially heavier) options type transitively; it is still a
// genuine structural comparison against the real type because we assign the
// real type below.
type LanePoolOptionsLike = ConstructorParameters<typeof LanePool>[0];

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeRegistry(): RendererRegistry {
  const registry = new RendererRegistry();
  registry.register('coder', (data) => `rendered:${JSON.stringify(data)}`);
  registry.register('reviewer', () => 'review-rendered');
  return registry;
}

function makeTrackedSession(): TrackedSession {
  return {
    session: {
      abort: mock(async () => {}),
      dispose: mock(() => {}),
      subscribe: mock(() => () => {}),
      prompt: mock(async () => {}),
      getLastAssistantText: mock(() => 'step-output'),
      getLastAssistantMessage: mock(() => undefined),
      sessionId: 'test-session',
    },
    dispose: mock(() => {}),
    sessionPath: '/tmp/sessions/test.jsonl',
  };
}

/** Build a TaskRunnerContext with mock complete/fail. */
function createCtx(overrides?: Partial<TaskRunnerContext>): TaskRunnerContext {
  return {
    task: makeTask(),
    agentId: 'lane-0',
    profiles: new Map(),
    onStatus: undefined,
    activeSessions: new Set<{ abort(): Promise<void> }>(),
    phaseId: 'implementing',
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    maxStepRetries: 5,
    completeTask: mock(() => true) as () => boolean,
    failTask: mock(() => {}) as (result?: unknown) => void,
    ...overrides,
  };
}

/** Build a LanePoolOptions literal; only fields relevant to these tests vary. */
function createPoolOptions(overrides: {
  taskTracker: TaskTracker;
  getRunnerForTask?: (task: Task) => TaskRunner;
  getStepsForTask?: (task: Task) => StepDefinition[];
  rendererRegistry?: RendererRegistry;
}): LanePoolOptionsLike {
  return {
    maxConcurrentLanes: 1,
    profilesDirs: ['/mock/profiles'],
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    phaseId: 'implementing',
    taskTracker: overrides.taskTracker,
    getRunnerForTask: overrides.getRunnerForTask,
    getStepsForTask: overrides.getStepsForTask,
    rendererRegistry: overrides.rendererRegistry,
  };
}

// ─── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  mockRunStep.mockReset();
  // Default: every runStep call approves and returns a tracked session.
  mockRunStep.mockResolvedValue({
    result: { type: 'approved', output: 'step-output' },
    trackedSession: makeTrackedSession(),
  });
});

afterAll(() => {
  // Restore the real modules so no other test file is affected.
  mock.module('../../packages/engine/src/pool/step-execution.js', () => realStepExecution);
  mock.module('../../packages/engine/src/core/profile.js', () => realProfile);
});

// ═══════════════════════════════════════════════════════════════════════════
// LanePoolOptions -> TaskRunnerContext
// ═══════════════════════════════════════════════════════════════════════════

describe('LanePoolOptions.rendererRegistry -> TaskRunnerContext', () => {
  it('threads the rendererRegistry instance into the TaskRunnerContext built by runLane', async () => {
    const registry = makeRegistry();
    let capturedCtx: TaskRunnerContext | undefined;

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        rendererRegistry: registry,
        getRunnerForTask: () => async (ctx) => {
          capturedCtx = ctx;
          ctx.completeTask();
          return { status: 'completed' };
        },
      }),
    );

    await pool.run();

    expect(capturedCtx).toBeDefined();
    // Identity must be preserved — the exact same instance reference.
    expect(capturedCtx!.rendererRegistry).toBe(registry);
  });

  it('sets TaskRunnerContext.rendererRegistry to undefined when the option is omitted', async () => {
    let capturedCtx: TaskRunnerContext | undefined;

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        // rendererRegistry intentionally NOT provided
        getRunnerForTask: () => async (ctx) => {
          capturedCtx = ctx;
          ctx.completeTask();
          return { status: 'completed' };
        },
      }),
    );

    await pool.run();

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.rendererRegistry).toBeUndefined();
  });

  it('preserves registry behaviour after threading (the threaded instance still renders)', async () => {
    const registry = makeRegistry();
    let capturedCtx: TaskRunnerContext | undefined;

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        rendererRegistry: registry,
        getRunnerForTask: () => async (ctx) => {
          capturedCtx = ctx;
          ctx.completeTask();
          return { status: 'completed' };
        },
      }),
    );

    await pool.run();

    // The object threaded into the context is a fully functional RendererRegistry,
    // not a stripped/empty copy.
    const threaded = capturedCtx!.rendererRegistry!;
    expect(threaded.render('coder', { x: 1 })).toBe('rendered:{"x":1}');
    expect(threaded.render('reviewer', null)).toBe('review-rendered');
    expect(threaded.render('missing', {})).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TaskRunnerContext -> StepExecutionContext -> runStep
// ═══════════════════════════════════════════════════════════════════════════

describe('TaskRunnerContext.rendererRegistry -> StepExecutionContext (via linearStepsRunner)', () => {
  it('passes ctx.rendererRegistry as execCtx.rendererRegistry to runStep', async () => {
    const registry = makeRegistry();

    const runner = linearStepsRunner([{ name: 'implement', profileId: 'coder', isReadOnly: false }]);
    await runner(createCtx({ rendererRegistry: registry }));

    expect(mockRunStep).toHaveBeenCalledTimes(1);
    const execCtx = mockRunStep.mock.calls[0][5] as StepExecutionContext;
    expect(execCtx.rendererRegistry).toBe(registry);
  });

  it('passes undefined execCtx.rendererRegistry when the TaskRunnerContext omits it', async () => {
    const runner = linearStepsRunner([{ name: 'implement', profileId: 'coder', isReadOnly: false }]);
    await runner(createCtx()); // no rendererRegistry

    expect(mockRunStep).toHaveBeenCalledTimes(1);
    const execCtx = mockRunStep.mock.calls[0][5] as StepExecutionContext;
    expect(execCtx.rendererRegistry).toBeUndefined();
  });

  it('threads the registry for every step when there are multiple steps', async () => {
    const registry = makeRegistry();

    const runner = linearStepsRunner([
      { name: 'implement', profileId: 'coder', isReadOnly: false },
      { name: 'review', profileId: 'coder', isReadOnly: true },
    ]);
    await runner(createCtx({ rendererRegistry: registry }));

    expect(mockRunStep).toHaveBeenCalledTimes(2);
    for (const call of mockRunStep.mock.calls) {
      const execCtx = call[5] as StepExecutionContext;
      expect(execCtx.rendererRegistry).toBe(registry);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Full end-to-end chain
// ═══════════════════════════════════════════════════════════════════════════

describe('end-to-end: LanePoolOptions -> TaskRunnerContext -> StepExecutionContext -> runStep', () => {
  it('delivers the registry from LanePoolOptions all the way to runStep execCtx', async () => {
    const registry = makeRegistry();

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        rendererRegistry: registry,
        // Uses the linearStepsRunner path (not getRunnerForTask), so the
        // registry must transit runLane -> TaskRunnerContext -> execCtx -> runStep.
        getStepsForTask: () => [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
      }),
    );

    const result = await pool.run();

    expect(result.completedTasks).toBe(1);
    expect(mockRunStep).toHaveBeenCalledTimes(1);
    const execCtx = mockRunStep.mock.calls[0][5] as StepExecutionContext;
    expect(execCtx.rendererRegistry).toBe(registry);
  });

  it('delivers undefined to runStep execCtx when LanePoolOptions omits rendererRegistry', async () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        // rendererRegistry intentionally NOT provided
        getStepsForTask: () => [{ name: 'implement', profileId: 'coder', isReadOnly: false }],
      }),
    );

    await pool.run();

    expect(mockRunStep).toHaveBeenCalledTimes(1);
    const execCtx = mockRunStep.mock.calls[0][5] as StepExecutionContext;
    expect(execCtx.rendererRegistry).toBeUndefined();
  });
});
