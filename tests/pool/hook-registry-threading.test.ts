/**
 * @fileoverview Tests for threading the optional `hookRegistry` field through
 * the pool layer, plus the `beforeStepPrompt` seam in runStep.
 *
 * Threading chain (task-10):
 *
 *   LanePoolOptions.hookRegistry         (types.ts)
 *     -> TaskRunnerContext.hookRegistry   (built in lane-pool.ts runLane)
 *       -> StepExecutionContext.hookRegistry (built in runner-utils.ts buildExecCtx)
 *         -> runStep({ task: execCtx })             (step-execution.ts)
 *
 * Parallel `worktreeCwd` chain: when a LanePool creates a per-task worktree it
 * sets `worktreeCwd` on the TaskRunnerContext; `buildExecCtx` forwards it to
 * `StepExecutionContext.worktreeCwd`; the seam passes it to the
 * `beforeStepPrompt` hook args so subscribers can resolve files inside the
 * isolated worktree.
 *
 * The `beforeStepPrompt` seam in `runStep`:
 *   - When `execCtx.hookRegistry?.hasSubscribers('beforeStepPrompt')` is true,
 *     the prompt is built via
 *     `registry.invokePipeline('beforeStepPrompt', task.prompt, args, ctx)`
 *     instead of `buildPrompt(...)`. The pipeline return value becomes the
 *     prompt text handed to `session.prompt()` / `promptForStructured()`.
 *   - Otherwise (no registry, or no subscribers) `buildPrompt(...)` is called
 *     directly — ZERO behavior change. The seam only activates when BOTH (a)
 *     the engine constructs a hookRegistry AND (b) the workflow forwards it to
 *     LanePool via `hookRegistry: options.hookRegistry`.
 *
 * TEST-FIRST: this file is written BEFORE the source lands. Source-reading
 * assertions (tryReadSource) are RED until the declarations/code appear in the
 * four files; the runtime behavioral assertions are RED until the
 * threading/seam is implemented. Once task-10's source changes are applied,
 * every assertion goes GREEN. Mirrors the dual-layer pattern used by
 * tests/hooks/step-hooks.test.ts (source-reading) and
 * tests/pool/renderer-registry-threading.test.ts (behavioral threading).
 *
 * The field is OPTIONAL at every layer, so existing code compiles/runs
 * unchanged (hookRegistry === undefined → buildPrompt path).
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// ─── Capture real modules before mocking ───────────────────────────────────

const realAgentRegistry = Object.assign({}, await import('../../packages/engine/src/core/agent-registry.js'));
const realStructuredOutput = Object.assign({}, await import('../../packages/engine/src/core/structured-output.js'));
const realPromptBuilder = Object.assign({}, await import('../../packages/engine/src/pool/prompt-builder.js'));
const realProfile = Object.assign({}, await import('../../packages/engine/src/core/profile.js'));

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// runStep must run for real (we are exercising the seam inside it), so we mock
// only its leaf dependencies: the agent registry (session creation), the
// structured-output prompt, the prompt-builder (so we can observe whether the
// seam bypassed it), and profile loading (so LanePool.run never touches the FS).

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

// Compatibility shim: runStep calls spawnAgent which resolves sessions via
// requireAgentPlugin(profile.agent).createSession(opts). We mock the
// registry so createSession delegates to mockCreateHarness, unwrapping the
// return value to the inner session (AgentRuntime).
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
  extractJsonFromText: realStructuredOutput.extractJsonFromText,
}));

// buildPrompt is the "fallback" path. Mocking it lets us assert the seam took
// the hook branch (buildPrompt NOT called) vs. the fallback branch (called).
const mockBuildPrompt = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../packages/engine/src/pool/prompt-builder.js', () => ({
  buildPrompt: (...args: unknown[]) => mockBuildPrompt(...args),
}));

// LanePool.run() always calls loadProfilesFromDirs + clearProfileCache.
mock.module('../../packages/engine/src/core/profile.js', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
  clearProfileCache: () => {},
}));
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import type { AgentProfile } from '../../packages/engine/src/core/types.js';
import { createHookRegistry } from '../../packages/engine/src/hooks/registry.js';
import type { HookRegistry } from '../../packages/engine/src/hooks/types.js';
import { LanePool } from '../../packages/engine/src/pool/lane-pool.js';
import { buildExecCtx } from '../../packages/engine/src/pool/runner-utils.js';
import type { StepExecutionContext } from '../../packages/engine/src/pool/step-execution.js';
import { runStep } from '../../packages/engine/src/pool/step-execution.js';
import type {
  LanePoolOptions,
  StepDefinition,
  TaskRunner,
  TaskRunnerContext,
} from '../../packages/engine/src/pool/types.js';
import { TaskTracker } from '../../packages/engine/src/tracking/task-status.js';
import { makeMockSession } from '../helpers/make-session.js';
import { makeTask } from '../helpers/make-task.js';

// ─── Source-reading helpers (step-hooks.test.ts pattern) ────────────────────

const POOL_SRC = resolve(import.meta.dir, '../../packages/engine/src/pool');
const TYPES_TS = resolve(POOL_SRC, 'types.ts');
const RUNNER_UTILS_TS = resolve(POOL_SRC, 'runner-utils.ts');
const STEP_EXECUTION_TS = resolve(POOL_SRC, 'step-execution.ts');
const LANE_POOL_TS = resolve(POOL_SRC, 'lane-pool.ts');

/** Read a source file defensively (empty string when absent) so the file
 *  compiles now and assertions are RED until the source lands. */
function tryReadSource(absPath: string): string {
  return existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

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

function createProfilesMap(...profiles: AgentProfile[]): Map<string, AgentProfile> {
  const map = new Map<string, AgentProfile>();
  for (const p of profiles) map.set(p.id, p);
  return map;
}

interface RunStepContext {
  stepIndex: number;
  attempt: number;
  execCount: number;
}

const defaultCtx: RunStepContext = { stepIndex: 0, attempt: 0, execCount: 0 };

const baseStep: StepDefinition = { name: 'implement', profileId: 'coder', isReadOnly: false };

/** Overrides type is permissive so hookRegistry/worktreeCwd can be supplied
 *  before the fields are formally declared on StepExecutionContext. */
type ExecCtxOverrides = Partial<StepExecutionContext> & { hookRegistry?: unknown; worktreeCwd?: string };

function createStepExecutionContext(overrides: ExecCtxOverrides = {}): StepExecutionContext {
  const { hookRegistry: _hr, worktreeCwd: _wt, ...rest } = overrides;
  return {
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    apiKeys: undefined,
    onStatus: undefined,
    activeSessions: new Set<{ abort(): Promise<void> }>(),
    phaseId: 'implementing',
    ...rest,
    ...(overrides.hookRegistry !== undefined ? { hookRegistry: overrides.hookRegistry } : {}),
    ...(overrides.worktreeCwd !== undefined ? { worktreeCwd: overrides.worktreeCwd } : {}),
  } as StepExecutionContext;
}

function makeSession(textFn: (promptText: string) => string | undefined = () => 'done') {
  return makeMockSession(textFn).session;
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

/** Minimal fake HookRegistry for seam tests — lets us control
 *  hasSubscribers/invokePipeline without wiring a real registry. */
interface FakeRegistry {
  register: ReturnType<typeof mock>;
  invokeObserve: ReturnType<typeof mock>;
  invokePipeline: ReturnType<typeof mock>;
  invokeFirstWins: ReturnType<typeof mock>;
  invokeAllRun: ReturnType<typeof mock>;
  hasSubscribers: ReturnType<typeof mock>;
  clone: ReturnType<typeof mock>;
}

function makeFakeRegistry(opts: { hasSubscribers: boolean; returnValue?: string }): FakeRegistry {
  return {
    register: mock(() => {}),
    invokeObserve: mock(async () => {}),
    invokePipeline: mock(async () => opts.returnValue ?? 'HOOK-BUILT-PROMPT'),
    invokeFirstWins: mock(async () => undefined),
    invokeAllRun: mock(async () => undefined),
    hasSubscribers: mock(() => opts.hasSubscribers),
    clone: mock(() => ({
      register: mock(() => {}),
      invokeObserve: mock(async () => {}),
      invokePipeline: mock(async () => opts.returnValue ?? 'HOOK-BUILT-PROMPT'),
      invokeFirstWins: mock(async () => undefined),
      invokeAllRun: mock(async () => undefined),
      hasSubscribers: mock(() => opts.hasSubscribers),
      clone: mock(() => ({})),
    })),
  };
}

/** Build a TaskRunnerContext with mock complete/fail. Permissive overrides so
 *  hookRegistry/worktreeCwd can be supplied pre-declaration. */
function makeRunnerContext(overrides: Record<string, unknown> = {}): TaskRunnerContext {
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
    completeTask: mock(() => true) as () => boolean,
    failTask: mock(() => {}) as (result?: unknown) => void,
    ...overrides,
  } as TaskRunnerContext;
}

/** LanePoolOptions literal builder. */
function createPoolOptions(overrides: {
  taskTracker: TaskTracker;
  getRunnerForTask?: (task: import('../../packages/engine/src/core/types.js').Task) => TaskRunner;
  getStepsForTask?: (task: import('../../packages/engine/src/core/types.js').Task) => StepDefinition[];
  hookRegistry?: HookRegistry;
  worktreeManager?: unknown;
}): LanePoolOptions {
  return {
    maxConcurrentLanes: 1,
    profilesDirs: ['/mock/profiles'],
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    phaseId: 'implementing',
    taskTracker: overrides.taskTracker,
    getRunnerForTask: overrides.getRunnerForTask,
    getStepsForTask: overrides.getStepsForTask,
    hookRegistry: overrides.hookRegistry,
    worktreeManager: overrides.worktreeManager as LanePoolOptions['worktreeManager'],
  } as LanePoolOptions;
}

// ─── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  mockCreateHarness.mockClear();
  mockPromptForStructured.mockClear();
  mockBuildPrompt.mockReset();
  mockLoadProfilesFromDirs.mockReset();
  // Sensible defaults so individual tests can opt out.
  mockBuildPrompt.mockResolvedValue('FALLBACK-BUILT-PROMPT');
});

afterAll(() => {
  // Restore real modules so mocks don't leak into other test files.
  mock.module('../../packages/engine/src/core/agent-registry.js', () => realAgentRegistry);
  mock.module('../../packages/engine/src/core/structured-output.js', () => realStructuredOutput);
  mock.module('../../packages/engine/src/pool/prompt-builder.js', () => realPromptBuilder);
  mock.module('../../packages/engine/src/core/profile.js', () => realProfile);
});

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE-READING: type declarations & seam structure
// (RED until the source lands — these are the structural contract.)
// ═══════════════════════════════════════════════════════════════════════════

describe('source: types.ts — hookRegistry declarations', () => {
  const src = tryReadSource(TYPES_TS);

  it("imports HookRegistry (type-only) from '../hooks/types.js'", () => {
    expect(src).toMatch(/import\s+type\s*\{[^}]*\bHookRegistry\b[^}]*\}\s*from\s*['"]\.\.\/hooks\/types\.js['"]/);
  });

  it('declares hookRegistry?: HookRegistry on BOTH LanePoolOptions and TaskRunnerContext', () => {
    // Two distinct interfaces each declare the optional field, so the pattern
    // must appear at least twice in the file.
    const matches = src.match(/hookRegistry\s*\?:\s*HookRegistry\b/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('source: step-execution.ts — StepExecutionContext fields + seam', () => {
  const src = tryReadSource(STEP_EXECUTION_TS);

  it("imports HookRegistry (type-only) from '../hooks/types.js'", () => {
    expect(src).toMatch(/import\s+type\s*\{[^}]*\bHookRegistry\b[^}]*\}\s*from\s*['"]\.\.\/hooks\/types\.js['"]/);
  });

  it('declares hookRegistry?: HookRegistry on StepExecutionContext', () => {
    expect(src).toMatch(/hookRegistry\s*\?:\s*HookRegistry/);
  });

  it('declares worktreeCwd?: string on StepExecutionContext (the per-task worktree path)', () => {
    expect(src).toMatch(/worktreeCwd\s*\?:\s*string/);
  });

  it('gates the seam on execCtx.hookRegistry?.hasSubscribers("beforeStepPrompt")', () => {
    expect(src).toMatch(/execCtx\.hookRegistry\s*\?\.\s*hasSubscribers\(['"]beforeStepPrompt['"]\)/);
  });

  it('invokes the pipeline via invokePipeline("beforeStepPrompt", task.prompt, …)', () => {
    expect(src).toMatch(/invokePipeline\(\s*['"]beforeStepPrompt['"]\s*,\s*task\.prompt\b/);
  });

  it('seeds the pipeline with task.prompt as the initial value', () => {
    // The pipeline's initial value is the task prompt string.
    expect(src).toMatch(/invokePipeline\(\s*['"]beforeStepPrompt['"]\s*,\s*task\.prompt\s*,/);
  });

  it('passes worktreeCwd: execCtx.worktreeCwd into the hook args', () => {
    expect(src).toMatch(/worktreeCwd:\s*execCtx\.worktreeCwd/);
  });

  it('keeps buildPrompt as the fallback branch of the seam', () => {
    expect(src).toMatch(/buildPrompt\(/);
  });
});

describe('source: runner-utils.ts — buildExecCtx forwards hookRegistry', () => {
  const src = tryReadSource(RUNNER_UTILS_TS);

  it('forwards ctx.hookRegistry into the returned StepExecutionContext', () => {
    expect(src).toMatch(/hookRegistry:\s*ctx\.hookRegistry/);
  });

  it('forwards ctx.worktreeCwd so the seam receives the per-task worktree path', () => {
    // The seam reads execCtx.worktreeCwd; buildExecCtx is the only builder of
    // StepExecutionContext used by the runners, so it must forward the field.
    expect(src).toMatch(/worktreeCwd:\s*ctx\.worktreeCwd/);
  });
});

describe('source: lane-pool.ts — forwards hookRegistry + sets worktreeCwd', () => {
  const src = tryReadSource(LANE_POOL_TS);

  it('threads the scoped hookRegistry clone into the TaskRunnerContext built by processTask', () => {
    expect(src).toMatch(/hookRegistry:\s*this\.scopedHookRegistry/);
  });

  it('sets worktreeCwd on the runner context to the created worktree path', () => {
    // Point 4: when a per-task worktree is created, set worktreeCwd on the
    // runner context so beforeStepPrompt can resolve files correctly.
    expect(src).toMatch(/runnerCtx\.worktreeCwd\s*=\s*taskWorktreePath/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL: buildExecCtx threading
// ═══════════════════════════════════════════════════════════════════════════

describe('buildExecCtx forwards hookRegistry + worktreeCwd', () => {
  it('forwards the hookRegistry instance reference from TaskRunnerContext', () => {
    const registry = createHookRegistry();
    const ctx = makeRunnerContext({ hookRegistry: registry });

    const exec = buildExecCtx(ctx);

    expect((exec as unknown as Record<string, unknown>).hookRegistry).toBe(registry);
  });

  it('leaves hookRegistry undefined when the runner context omits it', () => {
    const exec = buildExecCtx(makeRunnerContext());

    expect((exec as unknown as Record<string, unknown>).hookRegistry).toBeUndefined();
  });

  it('forwards worktreeCwd from the runner context to the step execution context', () => {
    const ctx = makeRunnerContext({ worktreeCwd: '/wt/task-9' });

    const exec = buildExecCtx(ctx);

    expect((exec as unknown as Record<string, unknown>).worktreeCwd).toBe('/wt/task-9');
  });

  it('leaves worktreeCwd undefined when the runner context omits it', () => {
    const exec = buildExecCtx(makeRunnerContext());

    expect((exec as unknown as Record<string, unknown>).worktreeCwd).toBeUndefined();
  });

  it('returns a fresh object each call (no shared mutable instance)', () => {
    const ctx = makeRunnerContext({ hookRegistry: createHookRegistry() });
    const a = buildExecCtx(ctx);
    const b = buildExecCtx(ctx);
    expect(a).not.toBe(b);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL: runStep beforeStepPrompt seam
// ═══════════════════════════════════════════════════════════════════════════

describe('runStep beforeStepPrompt seam', () => {
  /**
   * The seam (step-execution.ts):
   *
   *   const promptText = execCtx.hookRegistry?.hasSubscribers('beforeStepPrompt')
   *     ? await execCtx.hookRegistry.invokePipeline('beforeStepPrompt', task.prompt, { task, step, prompt: task.prompt, cwd: execCtx.cwd, worktreeCwd: execCtx.worktreeCwd }, ctx)
   *     : await buildPrompt(task, step, execCtx.cwd, { skipFiles: !!existingSessionPath });
   *
   * Behavior matrix:
   *   registry + subscribers → invokePipeline used, buildPrompt bypassed
   *   registry, no subscribers → buildPrompt used (zero change)
   *   no registry → buildPrompt used (zero change)
   */

  it('uses the hook pipeline return value as the prompt when subscribers exist', async () => {
    const session = makeSession(() => 'done');
    setupHarnessMocks(session);
    const registry = makeFakeRegistry({ hasSubscribers: true, returnValue: 'TRANSFORMED-PROMPT' });
    const execCtx = createStepExecutionContext({ hookRegistry: registry });

    await runStep({
      task: makeTask({ prompt: 'original' }),
      step: baseStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile),
      execCtx,
    });

    expect(registry.invokePipeline).toHaveBeenCalledTimes(1);
    // buildPrompt must be bypassed entirely when the seam fires.
    expect(mockBuildPrompt).not.toHaveBeenCalled();
    // The pipeline return value becomes the prompt text.
    expect(session.prompt).toHaveBeenCalledWith('TRANSFORMED-PROMPT');
  });

  it('does NOT call buildPrompt when the seam fires (hook path wins)', async () => {
    setupHarnessMocks();
    const registry = makeFakeRegistry({ hasSubscribers: true });
    const execCtx = createStepExecutionContext({ hookRegistry: registry });

    await runStep({
      task: makeTask(),
      step: baseStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile),
      execCtx,
    });

    expect(mockBuildPrompt).not.toHaveBeenCalled();
  });

  it('falls back to buildPrompt when the registry has no subscribers', async () => {
    setupHarnessMocks();
    const registry = makeFakeRegistry({ hasSubscribers: false });
    const execCtx = createStepExecutionContext({ hookRegistry: registry });

    await runStep({
      task: makeTask(),
      step: baseStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile),
      execCtx,
    });

    expect(registry.invokePipeline).not.toHaveBeenCalled();
    expect(mockBuildPrompt).toHaveBeenCalledTimes(1);
  });

  it('falls back to buildPrompt when no hookRegistry is provided', async () => {
    setupHarnessMocks();
    const execCtx = createStepExecutionContext(); // no hookRegistry

    await runStep({
      task: makeTask(),
      step: baseStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile),
      execCtx,
    });

    expect(mockBuildPrompt).toHaveBeenCalledTimes(1);
  });

  it('seeds invokePipeline with task.prompt as the initial pipeline value', async () => {
    setupHarnessMocks();
    const registry = makeFakeRegistry({ hasSubscribers: true });
    const task = makeTask({ prompt: 'do the thing' });
    const execCtx = createStepExecutionContext({ hookRegistry: registry });

    await runStep({
      task: task,
      step: baseStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile),
      execCtx,
    });

    expect(registry.invokePipeline).toHaveBeenCalledTimes(1);
    const initialValue = (registry.invokePipeline.mock.calls[0] as unknown[])[1];
    expect(initialValue).toBe('do the thing');
  });

  it('passes the hook name as the first invokePipeline argument', async () => {
    setupHarnessMocks();
    const registry = makeFakeRegistry({ hasSubscribers: true });
    const execCtx = createStepExecutionContext({ hookRegistry: registry });

    await runStep({
      task: makeTask(),
      step: baseStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile),
      execCtx,
    });

    const name = (registry.invokePipeline.mock.calls[0] as unknown[])[0];
    expect(name).toBe('beforeStepPrompt');
  });

  it('passes task, step, prompt, cwd, and worktreeCwd in the hook args', async () => {
    setupHarnessMocks();
    const registry = makeFakeRegistry({ hasSubscribers: true });
    const task = makeTask({ prompt: 'build it' });
    const execCtx = createStepExecutionContext({
      hookRegistry: registry,
      cwd: '/proj/root',
      worktreeCwd: '/wt/task-1',
    });

    await runStep({
      task: task,
      step: baseStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile),
      execCtx,
    });

    const args = (registry.invokePipeline.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(args.task).toBe(task);
    expect(args.step).toBe(baseStep);
    expect(args.prompt).toBe('build it');
    expect(args.cwd).toBe('/proj/root');
    expect(args.worktreeCwd).toBe('/wt/task-1');
  });

  it('passes worktreeCwd as undefined when not set on execCtx', async () => {
    setupHarnessMocks();
    const registry = makeFakeRegistry({ hasSubscribers: true });
    const execCtx = createStepExecutionContext({ hookRegistry: registry });

    await runStep({
      task: makeTask(),
      step: baseStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile),
      execCtx,
    });

    const args = (registry.invokePipeline.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(args.worktreeCwd).toBeUndefined();
  });

  it('uses the seam-built prompt for structured (schema) steps too', async () => {
    // The seam replaces the single buildPrompt call BEFORE the schema branch,
    // so promptForStructured receives the pipeline-built promptText.
    setupHarnessMocks();
    mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });
    const registry = makeFakeRegistry({ hasSubscribers: true, returnValue: 'STRUCT-PROMPT' });
    const execCtx = createStepExecutionContext({ hookRegistry: registry });
    const reviewStep: StepDefinition = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
      schema: z.object({ approved: z.boolean() }),
    };

    await runStep({
      task: makeTask(),
      step: reviewStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile, reviewerProfile),
      execCtx,
    });

    expect(mockBuildPrompt).not.toHaveBeenCalled();
    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    // promptForStructured(session, promptText, schema, opts) — promptText is arg [1].
    const promptArg = (mockPromptForStructured.mock.calls[0] as unknown[])[1];
    expect(promptArg).toBe('STRUCT-PROMPT');
  });

  it('structured step falls back to buildPrompt when the registry has no subscribers', async () => {
    setupHarnessMocks();
    mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });
    const registry = makeFakeRegistry({ hasSubscribers: false });
    const execCtx = createStepExecutionContext({ hookRegistry: registry });
    const reviewStep: StepDefinition = {
      name: 'review',
      profileId: 'reviewer',
      isReadOnly: true,
      schema: z.object({ approved: z.boolean() }),
    };

    await runStep({
      task: makeTask(),
      step: reviewStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile, reviewerProfile),
      execCtx,
    });

    expect(registry.invokePipeline).not.toHaveBeenCalled();
    expect(mockBuildPrompt).toHaveBeenCalledTimes(1);
    // promptForStructured was fed the buildPrompt result.
    const promptArg = (mockPromptForStructured.mock.calls[0] as unknown[])[1];
    expect(promptArg).toBe('FALLBACK-BUILT-PROMPT');
  });

  it('awaits the pipeline result (prompt is not a Promise)', async () => {
    const session = makeSession(() => 'done');
    setupHarnessMocks(session);
    const registry = makeFakeRegistry({ hasSubscribers: true, returnValue: 'AWAITED-PROMPT' });
    const execCtx = createStepExecutionContext({ hookRegistry: registry });

    await runStep({
      task: makeTask(),
      step: baseStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile),
      execCtx,
    });

    // session.prompt must receive the resolved string, not a Promise object.
    expect(session.prompt).toHaveBeenCalledWith('AWAITED-PROMPT');
    expect(typeof (session.prompt.mock.calls[0][0] as unknown)).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL: LanePool → TaskRunnerContext threading
// ═══════════════════════════════════════════════════════════════════════════

describe('LanePoolOptions.hookRegistry -> TaskRunnerContext', () => {
  beforeEach(() => {
    mockLoadProfilesFromDirs.mockResolvedValue(new Map<string, AgentProfile>());
  });

  it('threads the hookRegistry instance into the TaskRunnerContext built by runLane', async () => {
    const registry = createHookRegistry();
    let capturedCtx: TaskRunnerContext | undefined;

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        hookRegistry: registry,
        getRunnerForTask: () => async (ctx) => {
          capturedCtx = ctx;
          ctx.completeTask();
          return { status: 'completed' };
        },
      }),
    );

    await pool.run();

    expect(capturedCtx).toBeDefined();
    // LanePool clones the registry per run() (scopedHookRegistry) so pool-internal
    // subscriber registrations (e.g. the default auditor) never mutate the original.
    // The TaskRunnerContext receives the clone — verify it is defined and is a
    // independent HookRegistry instance (not the original).
    const threadedRegistry = (capturedCtx as unknown as Record<string, unknown>).hookRegistry as HookRegistry;
    expect(threadedRegistry).toBeDefined();
    expect(threadedRegistry).not.toBe(registry);
    expect(typeof threadedRegistry.hasSubscribers).toBe('function');
  });

  it('sets TaskRunnerContext.hookRegistry to undefined when the option is omitted', async () => {
    let capturedCtx: TaskRunnerContext | undefined;

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        // hookRegistry intentionally NOT provided
        getRunnerForTask: () => async (ctx) => {
          capturedCtx = ctx;
          ctx.completeTask();
          return { status: 'completed' };
        },
      }),
    );

    await pool.run();

    expect(capturedCtx).toBeDefined();
    expect((capturedCtx as unknown as Record<string, unknown>).hookRegistry).toBeUndefined();
  });

  it('sets worktreeCwd on the TaskRunnerContext when a per-task worktree is created', async () => {
    const worktreePath = '/wt/task-1';
    const worktreeManager = {
      createTaskWorktree: mock(async () => worktreePath),
      mergeTaskBranch: mock(async () => ({ success: true })),
      cullTaskWorktree: mock(async () => {}),
    };
    let capturedCtx: TaskRunnerContext | undefined;

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        worktreeManager,
        getRunnerForTask: () => async (ctx) => {
          capturedCtx = ctx;
          ctx.completeTask();
          return { status: 'completed' };
        },
      }),
    );

    await pool.run();

    expect(capturedCtx).toBeDefined();
    expect(worktreeManager.createTaskWorktree).toHaveBeenCalledTimes(1);
    // Point 4: worktreeCwd is set to the returned worktree path, distinct from
    // the pool cwd (which is also overridden to the worktree path).
    expect((capturedCtx as unknown as Record<string, unknown>).worktreeCwd).toBe(worktreePath);
  });

  it('leaves worktreeCwd undefined when no worktreeManager is configured', async () => {
    let capturedCtx: TaskRunnerContext | undefined;

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        getRunnerForTask: () => async (ctx) => {
          capturedCtx = ctx;
          ctx.completeTask();
          return { status: 'completed' };
        },
      }),
    );

    await pool.run();

    expect(capturedCtx).toBeDefined();
    expect((capturedCtx as unknown as Record<string, unknown>).worktreeCwd).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL: end-to-end — LanePool → linearStepsRunner → runStep seam fires
// ═══════════════════════════════════════════════════════════════════════════

describe('end-to-end: hookRegistry prompt transformation reaches session.prompt', () => {
  /**
   * Full chain: LanePoolOptions.hookRegistry (with a real beforeStepPrompt
   * subscriber) → TaskRunnerContext → linearStepsRunner → buildExecCtx →
   * StepExecutionContext → runStep seam → session.prompt receives the
   * transformed prompt.
   *
   * This is RED until EVERY hop is wired. It is the integration proof that the
   * seam activates only when a hookRegistry is forwarded into LanePool.
   */

  beforeEach(() => {
    // linearStepsRunner needs a profile map containing the step's profileId.
    mockLoadProfilesFromDirs.mockResolvedValue(createProfilesMap(defaultProfile));
  });

  it('delivers a beforeStepPrompt-subscriber-transformed prompt to the agent', async () => {
    const registry = createHookRegistry();
    registry.defineHook('beforeStepPrompt', 'pipeline');
    registry.register({
      beforeStepPrompt: (value: string) => `${value} [HOOKED]`,
    });

    const session = makeSession(() => 'done');
    setupHarnessMocks(session);

    const tracker = new TaskTracker();
    tracker.addTask(makeTask({ prompt: 'Implement feature X' }));

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        hookRegistry: registry,
        getStepsForTask: () => [baseStep],
      }),
    );

    const result = await pool.run();

    expect(result.completedTasks).toBe(1);
    // buildPrompt must have been bypassed by the seam.
    expect(mockBuildPrompt).not.toHaveBeenCalled();
    // The agent received the pipeline-transformed prompt.
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt.mock.calls[0][0]).toContain('[HOOKED]');
    expect(session.prompt.mock.calls[0][0]).toContain('Implement feature X');
  });

  it('uses buildPrompt (no transformation) when hookRegistry is not forwarded', async () => {
    // No hookRegistry on LanePoolOptions → the seam takes the buildPrompt
    // branch. Behavior is identical to today (zero change).
    const session = makeSession(() => 'done');
    setupHarnessMocks(session);

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        // hookRegistry intentionally NOT provided
        getStepsForTask: () => [baseStep],
      }),
    );

    await pool.run();

    expect(mockBuildPrompt).toHaveBeenCalledTimes(1);
    // The agent received the (mocked) buildPrompt output, NOT a hooked value.
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt.mock.calls[0][0]).toBe('FALLBACK-BUILT-PROMPT');
  });

  it('a registry with NO beforeStepPrompt subscribers falls back to buildPrompt', async () => {
    // A hookRegistry is threaded, but no one subscribes to beforeStepPrompt →
    // hasSubscribers('beforeStepPrompt') is false → buildPrompt path.
    const registry = createHookRegistry();
    registry.defineHook('beforeStepPrompt', 'pipeline');
    // No register() call → zero subscribers.

    const session = makeSession(() => 'done');
    setupHarnessMocks(session);

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());

    const pool = new LanePool(
      createPoolOptions({
        taskTracker: tracker,
        hookRegistry: registry,
        getStepsForTask: () => [baseStep],
      }),
    );

    await pool.run();

    expect(mockBuildPrompt).toHaveBeenCalledTimes(1);
    expect(session.prompt.mock.calls[0][0]).toBe('FALLBACK-BUILT-PROMPT');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression guard: omitting hookRegistry leaves existing behavior intact
// ═══════════════════════════════════════════════════════════════════════════

describe('regression: optional hookRegistry preserves existing behavior', () => {
  // Ensure the `afterEach`/`afterAll` restoration doesn't trip on missing
  // modules. This block simply documents the zero-change invariant that every
  // other suite above also asserts: undefined hookRegistry ⇒ buildPrompt path.
  it('runStep with a hookRegistry-less execCtx still calls buildPrompt exactly once', async () => {
    const session = makeSession(() => 'done');
    setupHarnessMocks(session);

    await runStep({
      task: makeTask(),
      step: baseStep,
      agentId: 'lane-0',
      ctx: defaultCtx,
      profiles: createProfilesMap(defaultProfile),
      execCtx: createStepExecutionContext(),
    });

    expect(mockBuildPrompt).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });
});
