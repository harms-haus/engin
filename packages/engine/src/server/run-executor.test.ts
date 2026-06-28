// ─── Tests for run-executor.ts — the composeHooks composition seam ──────────
//
// These tests pin the wiring introduced by "Wire composeHooks into
// run-executor.ts": before building `WorkflowRunOptions`, `execute` now calls
//
//   const hookProviders: HookProvider = workflow.hooks ?? [];
//   const { onStatus: composedStatus, registry: hookRegistry } =
//     composeHooks(storeCallbacks, hookProviders);
//
//   const options: WorkflowRunOptions = {
//     ...
//     onStatus: composedStatus,   // ← was storeCallbacks
//     hookRegistry,               // ← NEW: forwarded to workflow primitives
//     ...
//   };
//
// The contract under test (the firmest constraint is "zero behavior change"):
//
//  (1) options.onStatus is the COMPOSED surface produced by composeHooks — a
//      distinct object from the raw `storeCallbacks` carrying exactly the
//      STATUS_CALLBACK_METHODS — that still delegates every status event to
//      the store (so existing workflows are unaffected).
//  (2) options.hookRegistry is forwarded: a HookRegistry instance, empty when
//      `workflow.hooks` is undefined, populated from `workflow.hooks` (single
//      provider or array) when provided.
//  (3) store callbacks ALWAYS fire even when influence hooks are registered
//      (the zero-behavior-change guarantee WITH hooks present).
//  (4) the terminal lifecycle (run_complete / run_failed broadcast + reaper
//      scheduling) is NOT disrupted by the composition seam — the CRITICAL
//      INVARIANT that broadcastTerminal stays the only path for terminal msgs.
//
// Approach: drive the real `RunExecutor.execute` end-to-end on a NON-GIT temp
// `cwd` (so `isGitRepo` returns false and the executor takes the in-place path
// — no worktree setup, no LLM branch-slug generation). A real `EventStore` +
// `StatusBridge` + `createStoreCallbacks` are used so that "status events still
// flow to the store" is verified against durable state, not a stub. The
// `WorkflowModule` is a tiny mock whose `run` captures the `WorkflowRunOptions`
// it is handed and optionally fires status callbacks through them. The
// `RunRegistry` is a stub that records the scheduled reaper (so teardown is
// deterministic and free of real timers).
//
// `run-manager.ts` is imported as TYPE-ONLY (for `RunHandle` / `StartRunMessage`),
// so its module-load `installConsoleCapture()` side effect does NOT run — the
// store therefore receives ONLY events fired explicitly through `storeCallbacks`,
// keeping the assertions clean.

import type { EventRecord } from '@engin/shared/event-types';
import type { RunSummary, ServerMessage } from '@engin/shared/protocol-types';
import type { ServerWebSocket } from 'bun';
import type { Mock } from 'bun:test';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StatusCallbacks, WorkflowModule, WorkflowRunOptions } from '../core/types.js';
import { STATUS_CALLBACK_METHODS } from '../core/types.js';
import { HookRegistry } from '../hooks/registry.js';
import type {
  HookContext,
  HookProvider,
  OnWorkflowAbortArgs,
  OnWorkflowResumeArgs,
  PopulateWorktreeArgs,
  WorkflowHooks,
} from '../hooks/types.js';
import { EventStore } from '../tracking/event-store.js';
import { createStoreCallbacks } from '../tracking/store-callbacks.js';
import { RunExecutor } from './run-executor.js';
import type { RunHandle, StartRunMessage } from './run-manager.js';
import type { RunRegistry } from './run-registry.js';
import { StatusBridge } from './status-bridge.js';

// ── Constants ───────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';
const WORKFLOW_NAME = 'test-workflow';
const TASK_PROMPT = 'do the thing';

// ── Console.warn silencing ──────────────────────────────────────────────────
//
// The non-git path of `execute` calls `console.warn(...)` once per run. Silence
// it for the duration of each test so the output stays clean (mirrors the
// manual warn-spy pattern in registry.test.ts, but we just suppress here).

let realWarn: typeof console.warn;

beforeEach(() => {
  realWarn = console.warn;
  console.warn = (() => undefined) as unknown as typeof console.warn;
});

// ── Per-test teardown registry ───────────────────────────────────────────────

const cleanups: Array<() => void> = [];

afterEach(() => {
  console.warn = realWarn;
  while (cleanups.length) {
    const fn = cleanups.pop()!;
    try {
      fn();
    } catch {
      // Best-effort teardown.
    }
  }
});

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** `WorkflowHooks` is empty (mechanism-only) until concrete hooks are added via
 *  declaration merging, so a plain `{ hookName: fn }` record fails excess-
 *  property checking. Cast through `unknown` — same trick as compose.test.ts. */
function asHooks(hooks: Record<string, unknown>): WorkflowHooks {
  return hooks as unknown as WorkflowHooks;
}

/**
 * Ergonomic accessor for the status callbacks on `options`. Both
 * `composeHooks(...).onStatus` and `createStoreCallbacks(store)` define EVERY
 * one of the STATUS_CALLBACK_METHODS, so the optional markers on the
 * `StatusCallbacks` interface can be cast away for test firing.
 */
function status(options: WorkflowRunOptions): Required<StatusCallbacks> {
  return options.onStatus as Required<StatusCallbacks>;
}

/**
 * Build a real `RunHandle` backed by a fresh `EventStore` (temp dir) and
 * `StatusBridge`, plus a stub `RunRegistry` that records the scheduled reaper
 * instead of arming a real `setTimeout`. The `cwd` is a fresh non-git temp dir
 * so `execute` takes the in-place path (no worktree / LLM setup).
 *
 * Registers its own teardown (dispose bridge + store, remove temp dirs).
 */
async function makeRun(
  reapDelayMs = 60_000,
  opts: { cwd?: string } = {},
): Promise<{
  handle: RunHandle;
  store: EventStore;
  storeCallbacks: StatusCallbacks;
  bridge: StatusBridge;
  broadcasts: ServerMessage[];
  onRunsChanged: Mock<() => void>;
  reapCalls: Array<{ runId: string; delayMs: number; onReap: () => void }>;
  removeMock: Mock<(runId: string) => void>;
  executor: RunExecutor;
  msg: StartRunMessage;
}> {
  // `opts.cwd` lets a test point the run at a REAL git repository so the
  // executor takes the worktree (git) path. Defaults to a fresh non-git temp
  // dir (the in-place path — no worktree / LLM branch-slug generation).
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'run-exec-cwd-'));
  const workDir = mkdtempSync(join(tmpdir(), 'run-exec-work-'));
  const store = await EventStore.load(workDir);

  const broadcasts: ServerMessage[] = [];
  const bridge = new StatusBridge((m) => broadcasts.push(m), store, RUN_ID);

  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const summary: RunSummary = {
    runId: RUN_ID,
    cwd,
    workflowName: WORKFLOW_NAME,
    taskPrompt: TASK_PROMPT,
    status: 'running',
    startedAt,
  };
  const handle: RunHandle = {
    runId: RUN_ID,
    cwd,
    workflowName: WORKFLOW_NAME,
    taskPrompt: TASK_PROMPT,
    workDir,
    store,
    controller,
    bridge,
    status: 'running',
    summary,
    startedAt,
    subscribers: new Set<ServerWebSocket>(),
  };

  const storeCallbacks = createStoreCallbacks(store);

  // Stub registry: record the reaper (no real timer) so teardown is
  // deterministic. `remove` is provided so an invoked reaper callback can run
  // to completion.
  const reapCalls: Array<{ runId: string; delayMs: number; onReap: () => void }> = [];
  const removeMock = mock((_runId: string) => undefined);
  const registry = {
    scheduleReap: (runId: string, delayMs: number, onReap: () => void): void => {
      reapCalls.push({ runId, delayMs, onReap });
    },
    remove: removeMock,
  } as unknown as RunRegistry;

  const onRunsChanged = mock(() => undefined);
  const executor = new RunExecutor(registry, onRunsChanged, reapDelayMs);

  const msg: StartRunMessage = {
    workflowName: WORKFLOW_NAME,
    taskPrompt: TASK_PROMPT,
    cwd,
  };

  cleanups.push(() => {
    bridge.dispose();
    store.dispose();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  return { handle, store, storeCallbacks, bridge, broadcasts, onRunsChanged, reapCalls, removeMock, executor, msg };
}

/**
 * Build a mock `WorkflowModule` whose `run` captures the `WorkflowRunOptions`
 * it is handed. `runImpl` (optional) is invoked with those options so a test
 * can fire status callbacks through `options.onStatus` or throw to exercise
 * the failure path. `hooks` (optional) is forwarded as `workflow.hooks`.
 */
function makeWorkflow(
  opts: {
    hooks?: HookProvider;
    runImpl?: (options: WorkflowRunOptions) => void | Promise<void>;
  } = {},
): {
  workflow: WorkflowModule;
  captured: { prompt?: string; options?: WorkflowRunOptions };
} {
  const captured: { prompt?: string; options?: WorkflowRunOptions } = {};
  const workflow: WorkflowModule = {
    run: async (taskPrompt: string, options: WorkflowRunOptions): Promise<void> => {
      captured.prompt = taskPrompt;
      captured.options = options;
      await opts.runImpl?.(options);
    },
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
  };
  return { workflow, captured };
}

/** All event records appended to the store so far (seq-ordered ring buffer). */
function events(store: EventStore): EventRecord[] {
  return store.getEventsSince(0);
}

/**
 * Create a fresh temp git repository with an initial commit on `main`. Used to
 * drive the executor's worktree (git) path: `isGitRepo` returns true,
 * `generateTitleAndBranch` falls back to a deterministic slug (no LLM call),
 * and `WorktreeManager.setupMainWorktree()` succeeds (git worktree add needs a
 * HEAD). Returns the repo path; the caller is responsible for cleanup.
 */
function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-exec-git-'));
  const cmds: string[][] = [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'engin-test@example.com'],
    ['config', 'user.name', 'Engin Test'],
    ['commit', '-q', '--allow-empty', '-m', 'init'],
  ];
  for (const cmd of cmds) {
    Bun.spawnSync({ cmd: ['git', ...cmd], cwd: dir });
  }
  return dir;
}

// ── (1) options.onStatus — composed via composeHooks ────────────────────────

describe('RunExecutor.execute — options.onStatus is the composed surface', () => {
  it('forwards a composed onStatus that is DISTINCT from the raw storeCallbacks', async () => {
    // The composition seam must replace the raw `options.onStatus =
    // storeCallbacks` assignment with `composeHooks(...).onStatus`. That
    // produces a FRESH composed object (pinned by compose.test.ts), so it must
    // NOT be the same reference as `storeCallbacks`.
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow();

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(captured.options).toBeDefined();
    expect(captured.options!.onStatus).toBeDefined();
    // The seam produced a distinct composed wrapper — not the raw store callbacks.
    expect(captured.options!.onStatus).not.toBe(run.storeCallbacks);
  });

  it('the composed onStatus carries EXACTLY the STATUS_CALLBACK_METHODS shape', async () => {
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow();

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    const onStatus = captured.options!.onStatus!;
    expect(Object.keys(onStatus).sort()).toEqual([...STATUS_CALLBACK_METHODS].sort());
    for (const name of STATUS_CALLBACK_METHODS) {
      expect(typeof (onStatus as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('delegates status events fired through options.onStatus to the store (zero behavior change)', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: (options) => {
        // A workflow fires a status event through the composed onStatus it was
        // handed. With zero behavior change it MUST reach the store.
        status(options).onWorkflowStart({
          taskPrompt: TASK_PROMPT,
          resumed: false,
          workDir: options.workDir,
        });
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    const started = events(run.store).find((e) => e.type === 'workflow_started');
    expect(started).toBeDefined();
    expect((started!.data as Record<string, unknown>).taskPrompt).toBe(TASK_PROMPT);
    expect((started!.data as Record<string, unknown>).resumed).toBe(false);
  });

  it('forwards MULTIPLE distinct status methods through onStatus, each landing in the store', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: (options) => {
        const cb = status(options);
        cb.onWorkflowStart({ taskPrompt: TASK_PROMPT, resumed: false, workDir: options.workDir });
        cb.onPhaseStart({ phase: 'scouting', round: 1 });
        cb.onSidebarUpdate({ title: 'Engin', indicator: '●' });
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    const types = events(run.store).map((e) => e.type);
    expect(types).toContain('workflow_started');
    expect(types).toContain('phase_started');
    expect(types).toContain('sidebar_updated');

    const phase = events(run.store).find((e) => e.type === 'phase_started');
    expect((phase!.data as Record<string, unknown>).phase).toBe('scouting');
  });

  it('forwards the status info object to the store untouched end-to-end', async () => {
    // The composed wrapper forwards `...args` verbatim (store is the source of
    // truth). The info object's fields must survive the composed hop intact.
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: (options) => {
        status(options).onPhaseStart({ phase: 'build', round: 3 });
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    const phase = events(run.store).find((e) => e.type === 'phase_started');
    expect(phase).toBeDefined();
    expect(phase!.data as Record<string, unknown>).toEqual({ phase: 'build', round: 3 });
  });

  it('forwards onTaskParked / onTaskUnparked / onWorkflowData through the composed onStatus to the store', async () => {
    // The newer status callbacks (parking + workflow data) must flow through
    // the composed onStatus surface identically to the legacy callbacks.
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: (options) => {
        const cb = status(options);
        cb.onWorkflowStart({ taskPrompt: TASK_PROMPT, resumed: false, workDir: options.workDir });
        cb.onTaskRegister({
          taskId: 't1',
          phaseId: 'p1',
          title: 'Task t1',
          dependencies: [],
        });
        cb.onTaskParked({ taskId: 't1', title: 'Task t1', agentId: 'a1', phaseId: 'p1' });
        cb.onTaskUnparked({ taskId: 't1', title: 'Task t1', agentId: 'a1', phaseId: 'p1' });
        cb.onWorkflowData({ data: { summary: 'done' } });
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    const types = events(run.store).map((e) => e.type);
    expect(types).toContain('task_parked');
    expect(types).toContain('task_unparked');
    expect(types).toContain('workflow_data_set');

    // Verify the projection evolved correctly: task went parked → active.
    const proj = run.store.getProjection();
    expect(proj.tasks['t1'].status).toBe('active');
    // workflowData was merged.
    expect(proj.workflowData).toEqual({ summary: 'done' });
  });
});

// ── (2) options.hookRegistry — forwarded to workflow primitives ─────────────

describe('RunExecutor.execute — options.hookRegistry is forwarded', () => {
  it('forwards a HookRegistry instance as options.hookRegistry', async () => {
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow();

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(captured.options!.hookRegistry).toBeInstanceOf(HookRegistry);
  });

  it('defaults to an EMPTY registry when workflow.hooks is undefined (existing workflows)', async () => {
    // CRITICAL zero-behavior-change path: `workflow.hooks ?? []` feeds an empty
    // provider list into composeHooks, yielding a registry with no subscribers.
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow();

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    const registry = captured.options!.hookRegistry!;
    expect(registry.hasSubscribers('beforeSessionPrompt')).toBe(false);
    expect(registry.hasSubscribers('shouldRetryPhase')).toBe(false);
    expect(registry.hasSubscribers('anyName')).toBe(false);
  });

  it('populates the registry from a SINGLE provider object (workflow.hooks)', async () => {
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow({
      hooks: asHooks({ beforeSessionPrompt: mock(() => undefined) }),
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    const registry = captured.options!.hookRegistry!;
    expect(registry.hasSubscribers('beforeSessionPrompt')).toBe(true);
  });

  it('populates the registry from an ARRAY of providers (HookProvider = WorkflowHooks[])', async () => {
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow({
      hooks: [
        asHooks({ beforeSessionPrompt: mock(() => undefined) }),
        asHooks({ shouldRetryPhase: mock(() => undefined), onPhaseSettled: mock(() => undefined) }),
      ],
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    const registry = captured.options!.hookRegistry!;
    expect(registry.hasSubscribers('beforeSessionPrompt')).toBe(true);
    expect(registry.hasSubscribers('shouldRetryPhase')).toBe(true);
    expect(registry.hasSubscribers('onPhaseSettled')).toBe(true);
  });

  it('each execute() call gets a fresh, independent registry (no shared state across runs)', async () => {
    const run = await makeRun();
    const { workflow: wfWithHooks, captured: capA } = makeWorkflow({
      hooks: asHooks({ beforeSessionPrompt: mock(() => undefined) }),
    });
    const { workflow: wfNoHooks, captured: capB } = makeWorkflow();

    await run.executor.execute(run.handle, wfWithHooks, run.storeCallbacks, run.msg);
    await run.executor.execute(run.handle, wfNoHooks, run.storeCallbacks, run.msg);

    expect(capA.options!.hookRegistry).not.toBe(capB.options!.hookRegistry);
    expect(capA.options!.hookRegistry!.hasSubscribers('beforeSessionPrompt')).toBe(true);
    expect(capB.options!.hookRegistry!.hasSubscribers('beforeSessionPrompt')).toBe(false);
  });
});

// ── (3) store callbacks ALWAYS fire even with influence hooks registered ────

describe('RunExecutor.execute — store callbacks always fire (zero behavior change with hooks)', () => {
  it('status events still flow to the store when workflow.hooks are provided', async () => {
    // The composed onStatus wraps ONLY the store callbacks (observe/influence
    // firing is deferred to engine primitives). So registering influence hooks
    // must NOT suppress or replace the store callbacks.
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      hooks: asHooks({
        shouldRetryPhase: mock(() => undefined),
      }),
      runImpl: (options) => {
        const cb = status(options);
        cb.onWorkflowStart({ taskPrompt: TASK_PROMPT, resumed: false, workDir: options.workDir });
        cb.onPhaseStart({ phase: 'plan', round: 1 });
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    const types = events(run.store).map((e) => e.type);
    expect(types).toContain('workflow_started');
    expect(types).toContain('phase_started');
  });

  it('the composed onStatus does NOT fan into the registry (influence firing is deferred)', async () => {
    // Pin the documented design: a status callback firing does NOT invoke
    // registry subscribers (even one registered under the SAME name). They live
    // only in the registry for engine primitives to invoke at proper seams.
    const run = await makeRun();
    const subscriber = mock(() => undefined);
    const { workflow, captured } = makeWorkflow({
      hooks: asHooks({ onWorkflowStart: subscriber }),
      runImpl: (options) => {
        status(options).onWorkflowStart({
          taskPrompt: TASK_PROMPT,
          resumed: false,
          workDir: options.workDir,
        });
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    // The subscriber was registered into the forwarded registry …
    expect(captured.options!.hookRegistry!.hasSubscribers('onWorkflowStart')).toBe(true);
    // … but was NOT invoked when the store-bound onWorkflowStart fired.
    expect(subscriber).not.toHaveBeenCalled();
    // The store DID receive the event (source of truth always fires).
    expect(events(run.store).some((e) => e.type === 'workflow_started')).toBe(true);
  });
});

// ── (4) terminal lifecycle still fires through the composition seam ─────────
//
// The CRITICAL INVARIANT in run-executor.ts: `execute` MUST call
// bridge.broadcastTerminal(...) for run_complete / run_failed. The composition
// seam must not disrupt this — status events now flow through the composed
// onStatus, but the terminal broadcast path is unchanged.

describe('RunExecutor.execute — terminal lifecycle is not disrupted by the seam', () => {
  it('broadcasts run_complete and marks the handle terminal on success', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({ runImpl: () => undefined });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('complete');
    expect(run.handle.summary.status).toBe('complete');
    const terminal = run.broadcasts.find((m) => m.type === 'run_complete');
    expect(terminal).toBeDefined();
    expect((terminal as { runId?: string }).runId).toBe(RUN_ID);
  });

  it('broadcasts run_failed and marks the handle failed when the workflow throws', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: () => {
        throw new Error('workflow boom');
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('failed');
    expect(run.handle.summary.status).toBe('failed');
    const terminal = run.broadcasts.find((m) => m.type === 'run_failed');
    expect(terminal).toBeDefined();
    expect((terminal as { runId?: string }).runId).toBe(RUN_ID);
    expect(String((terminal as { error?: string }).error)).toContain('workflow boom');
  });

  it('treats an AbortError as a cancellation (error message "Run cancelled")', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('failed');
    const terminal = run.broadcasts.find((m) => m.type === 'run_failed');
    expect(terminal).toBeDefined();
    expect(String((terminal as { error?: string }).error)).toBe('Run cancelled');
  });

  it('schedules the post-terminal reaper (teardown wiring intact)', async () => {
    // Use a distinctive reap delay so we can assert it is forwarded verbatim.
    const run = await makeRun(12_345);
    const { workflow } = makeWorkflow({ runImpl: () => undefined });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    // The finally block notified the control server …
    expect(run.onRunsChanged).toHaveBeenCalledTimes(1);
    // … and armed exactly one reaper for this runId with the configured delay.
    expect(run.reapCalls).toHaveLength(1);
    expect(run.reapCalls[0].runId).toBe(RUN_ID);
    expect(run.reapCalls[0].delayMs).toBe(12_345);

    // Invoking the reaper disposes the bridge + store, removes the handle, and
    // re-notifies the control server (the second onRunsChanged call).
    run.reapCalls[0].onReap();
    expect(run.removeMock).toHaveBeenCalledWith(RUN_ID);
    expect(run.onRunsChanged).toHaveBeenCalledTimes(2);
  });
});

// ── (5) onWorkflowResume — resume detection ────────────────────────────────
//
// The resume seam: after composing hooks (+ registering the workflow-level
// defaults), `execute` probes the store for prior events / a snapshot. When
// one exists (this is a RESUME of a previously-started run) it fires
// `registry.invokeObserve('onWorkflowResume', { workDir, tracker: undefined },
// ctx)` BEFORE launching workflow.run(). The workflow's onWorkflowResume can
// then restore sidebar state, clear stale sessions, warm caches, etc. On a
// fresh run (empty store) the hook is NOT fired.
//
// Approach: drive the real `execute` end-to-end on a NON-GIT temp cwd. A run
// is turned into a RESUME by seeding the store with an event (and flushing it
// to disk) BEFORE calling execute — mirroring an EventStore.load() that
// replays a pre-existing events.jsonl.

describe('RunExecutor.execute — onWorkflowResume fired on resume', () => {
  /** Seed the store so `execute` detects a resume (prior events present). */
  async function seedResume(run: { store: EventStore; handle: RunHandle }): Promise<void> {
    run.store.append('workflow_started', {
      taskPrompt: TASK_PROMPT,
      resumed: false,
      workDir: run.handle.workDir,
    });
    await run.store.flush();
  }

  it('fires onWorkflowResume when the store already has events (resume)', async () => {
    const resumeSpy = mock(() => undefined);
    const run = await makeRun();
    const { workflow } = makeWorkflow({ hooks: asHooks({ onWorkflowResume: resumeSpy }) });

    await seedResume(run);
    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onWorkflowResume on a fresh run (empty store)', async () => {
    // The CRITICAL zero-behavior-change path for the resume seam: a brand-new
    // run has an empty store, so execute must NOT fire onWorkflowResume. The
    // default is registered (see suite 7) but never invoked.
    const resumeSpy = mock(() => undefined);
    const run = await makeRun();
    const { workflow } = makeWorkflow({ hooks: asHooks({ onWorkflowResume: resumeSpy }) });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('passes { workDir, tracker: undefined } and a HookContext carrying the run paths', async () => {
    let capturedArgs: OnWorkflowResumeArgs | undefined;
    let capturedCtx: HookContext | undefined;
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      hooks: asHooks({
        onWorkflowResume: async (args: OnWorkflowResumeArgs, ctx: HookContext) => {
          capturedArgs = args;
          capturedCtx = ctx;
        },
      }),
    });

    await seedResume(run);
    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(capturedArgs).toEqual({ workDir: run.handle.workDir, tracker: undefined });
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.workDir).toBe(run.handle.workDir);
    expect(capturedCtx!.cwd).toBe(run.handle.cwd);
    expect(capturedCtx!.registry).toBeInstanceOf(HookRegistry);
  });

  it('fires onWorkflowResume BEFORE invoking workflow.run()', async () => {
    // Ordering matters: the resume hook must run before the workflow so it can
    // restore state the workflow depends on. Capture the call order via a
    // shared array.
    const order: string[] = [];
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      hooks: asHooks({
        onWorkflowResume: async () => {
          order.push('resume');
        },
      }),
      runImpl: () => {
        order.push('run');
      },
    });

    await seedResume(run);
    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(order).toEqual(['resume', 'run']);
  });

  it('invokes a user-provided onWorkflowResume composed WITH the default on a resume', async () => {
    // The engine registers the default onWorkflowResume (no-op) AND the user
    // hook lands in the same registry via composeHooks. Observe fan-out fires
    // both — the user hook must be invoked on a resume.
    const resumeSpy = mock(() => undefined);
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow({ hooks: asHooks({ onWorkflowResume: resumeSpy }) });

    await seedResume(run);
    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(captured.options!.hookRegistry!.hasSubscribers('onWorkflowResume')).toBe(true);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });
});

// ── (6) onWorkflowAbort — abort handling ────────────────────────────────────
//
// The abort seam: in the catch block that handles an AbortError (from
// controller.abort()), `execute` fires
// `registry.invokeObserve('onWorkflowAbort', { reason: 'Aborted', workDir },
// ctx)` BEFORE marking the run failed. This distinguishes a cooperative abort
// from a genuine failure (onWorkflowAbort is distinct from any onWorkflowFailed
// semantics). A genuine (non-abort) error must NOT fire it.

describe('RunExecutor.execute — onWorkflowAbort fired on abort', () => {
  /** A workflow runImpl that throws an AbortError (mirrors controller.abort()). */
  function throwAbort(): () => void {
    return () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
  }

  it('fires onWorkflowAbort when the workflow throws an AbortError', async () => {
    const abortSpy = mock(() => undefined);
    const run = await makeRun();
    const { workflow } = makeWorkflow({ hooks: asHooks({ onWorkflowAbort: abortSpy }), runImpl: throwAbort() });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('passes { reason: "Aborted", workDir }', async () => {
    let capturedArgs: OnWorkflowAbortArgs | undefined;
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      hooks: asHooks({
        onWorkflowAbort: async (args: OnWorkflowAbortArgs) => {
          capturedArgs = args;
        },
      }),
      runImpl: throwAbort(),
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(capturedArgs).toEqual({ reason: 'Aborted', workDir: run.handle.workDir });
  });

  it('fires onWorkflowAbort BEFORE flipping the handle status to failed', async () => {
    // The abort hook is awaited in the catch block BEFORE `handle.status =
    // 'failed'`. Capture the live status from inside the hook to pin the
    // ordering: it must still be 'running' when the hook runs, then flip to
    // 'failed' afterwards.
    let statusAtAbort: string | undefined;
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      hooks: asHooks({
        onWorkflowAbort: async () => {
          statusAtAbort = run.handle.status;
        },
      }),
      runImpl: throwAbort(),
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(statusAtAbort).toBe('running');
    // …and the status DID flip afterwards (the hook did not swallow the flip).
    expect(run.handle.status).toBe('failed');
  });

  it('does NOT fire onWorkflowAbort on a genuine (non-abort) error', async () => {
    // Only an AbortError triggers onWorkflowAbort; a genuine error is a
    // failure, not an abort. §7: onWorkflowAbort is distinct from failure.
    const abortSpy = mock(() => undefined);
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      hooks: asHooks({ onWorkflowAbort: abortSpy }),
      runImpl: () => {
        throw new Error('genuine boom');
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(abortSpy).not.toHaveBeenCalled();
    expect(run.handle.status).toBe('failed');
  });

  it('still broadcasts run_failed ("Run cancelled") and schedules the reaper on abort', async () => {
    // The abort hook firing must NOT disrupt the terminal lifecycle: the run
    // is still marked failed, the run_failed terminal broadcast still emits
    // "Run cancelled", and the reaper is still armed.
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      hooks: asHooks({ onWorkflowAbort: mock(() => undefined) }),
      runImpl: throwAbort(),
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('failed');
    const terminal = run.broadcasts.find((m) => m.type === 'run_failed');
    expect(terminal).toBeDefined();
    expect(String((terminal as { error?: string }).error)).toBe('Run cancelled');
    expect(run.reapCalls).toHaveLength(1);
  });
});

// ── (7) default workflow hooks registered into the forwarded registry ──────
//
// `execute` registers the DEFAULT implementations of the workflow-level hooks
// it owns into the registry built by composeHooks, so that:
//  - the engine-fired observe hooks (onWorkflowResume, onWorkflowAbort) have a
//    well-defined (identity / log) behavior even when the workflow registers
//    no subscriber; AND
//  - the git-path merge hooks (beforeRunMerge, onRunMergeConflict) reproduce
//    the legacy squash-merge / agent-resolution UX when the workflow opts out.
//
// DESIGN SPLIT (documented for the implementer): the engine fires
// onWorkflowResume / onWorkflowAbort (engine lifecycle) and registers the merge
// defaults (git-driven; profilesDirs is computed in the git branch). The
// onPersist / onRestore defaults are NOT registered by the engine — the
// WorkflowStatusTracker they capture is created by the WORKFLOW (spir.ts), so
// the workflow registers those defaults itself. The engine only fires hooks it
// owns; it does not fabricate a tracker.

describe('RunExecutor.execute — default workflow hooks registered', () => {
  it('registers the default onWorkflowResume even when workflow.hooks is undefined', async () => {
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow();

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(captured.options!.hookRegistry!.hasSubscribers('onWorkflowResume')).toBe(true);
  });

  it('registers the default onWorkflowAbort even when workflow.hooks is undefined', async () => {
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow();

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(captured.options!.hookRegistry!.hasSubscribers('onWorkflowAbort')).toBe(true);
  });

  it('a user-provided onWorkflowResume composes WITH the default (both land in the registry)', async () => {
    // composeHooks registers the workflow's hooks first; the engine appends the
    // default afterwards. Both are present under the same name (observe fan-out).
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow({
      hooks: asHooks({ onWorkflowResume: mock(() => undefined) }),
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(captured.options!.hookRegistry!.hasSubscribers('onWorkflowResume')).toBe(true);
  });

  it('registers the default beforeRunMerge + onRunMergeConflict when the cwd is a git repo', async () => {
    // The merge defaults are git-only: profilesDirs (needed by
    // createDefaultOnRunMergeConflict) is computed inside the worktree (git)
    // branch. A real temp git repo drives the executor down that path; the
    // worktree is created and the run completes, then we assert the forwarded
    // registry carries both merge defaults and that they reproduce the legacy
    // decisions when invoked.
    const repoDir = createTempGitRepo();
    cleanups.push(() => rmSync(repoDir, { recursive: true, force: true }));
    const run = await makeRun(60_000, { cwd: repoDir });
    const { workflow, captured } = makeWorkflow({ runImpl: () => undefined });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    // The git path wired the worktree onto the handle (sanity: we really took
    // the worktree branch, not the in-place fallback).
    expect(run.handle.worktreeManager).toBeDefined();
    expect(run.handle.worktree).toBeDefined();

    const registry = captured.options!.hookRegistry!;
    expect(registry.hasSubscribers('beforeRunMerge')).toBe(true);
    expect(registry.hasSubscribers('onRunMergeConflict')).toBe(true);

    const ctx: HookContext = { registry, cwd: repoDir, workDir: run.handle.workDir };

    // Default beforeRunMerge → proceed with a squash merge (legacy behavior).
    const decision = await registry.invokeFirstWins(
      'beforeRunMerge',
      { repoRoot: repoDir, mainBranch: run.handle.worktree!.branchName },
      ctx,
    );
    expect(decision).toEqual({ proceed: true, strategy: 'squash' });

    // Default onRunMergeConflict → pure agent-resolution marker (legacy UX).
    const resolution = await registry.invokeFirstWins(
      'onRunMergeConflict',
      { conflicts: ['src/a.ts'], worktreePath: run.handle.worktree!.worktreePath, repoRoot: repoDir },
      ctx,
    );
    expect(resolution).toEqual({ strategy: 'agent' });
  });

  it('on a resumed run the default onWorkflowResume fires without disrupting completion', async () => {
    // Zero-behavior-change for the resume seam WITH the default registered: a
    // resumed run still completes, broadcasts run_complete, and arms the
    // reaper. The awaited invokeObserve must not break the success path.
    const run = await makeRun();
    const { workflow } = makeWorkflow({ runImpl: () => undefined });
    run.store.append('workflow_started', {
      taskPrompt: TASK_PROMPT,
      resumed: true,
      workDir: run.handle.workDir,
    });
    await run.store.flush();

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('complete');
    expect(run.handle.summary.status).toBe('complete');
    expect(run.broadcasts.some((m) => m.type === 'run_complete')).toBe(true);
    expect(run.reapCalls).toHaveLength(1);
  });
});

// ── (8) worktree-lifecycle hook threading to WorktreeManager ────────────────
//
// On the git path, RunExecutor constructs a WorktreeManager and calls
// setupMainWorktree(). The worktree-lifecycle hooks (populateWorktree,
// beforeTaskWorktreeCreate, onTaskMerge, …) must be ACTIVE during that setup
// so a workflow-provided subscriber fires AND the engine-registered defaults
// reproduce the legacy .worktreecopy / squash-merge / agent-resolution UX.
//
// This suite pins the threading: the hookRegistry built by composeHooks (from
// workflow.hooks) must reach the WorktreeManager BEFORE setupMainWorktree runs.
// The implementer may solve the ordering however they choose (reorder
// composeHooks ahead of the WorktreeManager construction, a setter, or passing
// the registry to setupMainWorktree) — these tests pin the OUTCOME: a
// workflow-provided populateWorktree subscriber fires during execute on the
// git path, and the engine-owned worktree defaults are registered.

describe('RunExecutor.execute — worktree-lifecycle hooks threaded to WorktreeManager', () => {
  it('a workflow-provided populateWorktree subscriber fires during execute on the git path', async () => {
    // THE threading acceptance test: a workflow that registers a
    // populateWorktree subscriber MUST see it fire when execute calls
    // setupMainWorktree(). This only works if the registry reaches the
    // WorktreeManager before setupMainWorktree runs.
    const repoDir = createTempGitRepo();
    cleanups.push(() => rmSync(repoDir, { recursive: true, force: true }));
    const run = await makeRun(60_000, { cwd: repoDir });

    const seen: PopulateWorktreeArgs[] = [];
    const { workflow } = makeWorkflow({
      hooks: asHooks({
        populateWorktree: async (_v: undefined, args: PopulateWorktreeArgs) => {
          seen.push(args);
        },
      }),
      runImpl: () => undefined,
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    // The hook fired at least once (setupMainWorktree populates the main worktree).
    expect(seen.length).toBeGreaterThanOrEqual(1);
    // The first invocation is the MAIN worktree population.
    const mainArgs = seen[0];
    expect(mainArgs.worktreePath).toBe(join(run.handle.workDir, 'worktree'));
    expect(mainArgs.sourceCwd).toBe(repoDir);
    // setupMainWorktree has no task context — task is undefined for the main worktree.
    expect(mainArgs.task).toBeUndefined();
  });

  it('passes a HookContext carrying the registry + repo cwd + workDir to the populate subscriber', async () => {
    const repoDir = createTempGitRepo();
    cleanups.push(() => rmSync(repoDir, { recursive: true, force: true }));
    const run = await makeRun(60_000, { cwd: repoDir });

    let capturedCtx: HookContext | undefined;
    const { workflow } = makeWorkflow({
      hooks: asHooks({
        populateWorktree: async (_v: undefined, _args: PopulateWorktreeArgs, ctx: HookContext) => {
          capturedCtx = ctx;
        },
      }),
      runImpl: () => undefined,
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.registry).toBeInstanceOf(HookRegistry);
    expect(capturedCtx!.workDir).toBe(run.handle.workDir);
  });

  it('registers the worktree-lifecycle DEFAULTS on the git path so hasSubscribers is true', async () => {
    // The engine registers the default implementations of the six
    // worktree-lifecycle hooks into the forwarded registry (alongside
    // beforeRunMerge / onRunMergeConflict from suite 7) so a workflow that
    // opts out still gets the legacy .worktreecopy / squash-merge UX.
    const repoDir = createTempGitRepo();
    cleanups.push(() => rmSync(repoDir, { recursive: true, force: true }));
    const run = await makeRun(60_000, { cwd: repoDir });
    const { workflow, captured } = makeWorkflow({ runImpl: () => undefined });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.worktreeManager).toBeDefined();
    const registry = captured.options!.hookRegistry!;
    expect(registry.hasSubscribers('populateWorktree')).toBe(true);
    expect(registry.hasSubscribers('beforeTaskWorktreeCreate')).toBe(true);
    expect(registry.hasSubscribers('afterTaskWorktreeCreate')).toBe(true);
    expect(registry.hasSubscribers('onTaskMerge')).toBe(true);
    expect(registry.hasSubscribers('onMergeConflict')).toBe(true);
    expect(registry.hasSubscribers('onCommitFailure')).toBe(true);
  });

  it('does NOT register the worktree defaults on the non-git path (no worktree to manage)', async () => {
    // The worktree-lifecycle defaults are git-only (like beforeRunMerge /
    // onRunMergeConflict): there is no worktree to populate / merge on the
    // in-place path, so the defaults must NOT be registered.
    const run = await makeRun();
    const { workflow, captured } = makeWorkflow({ runImpl: () => undefined });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    const registry = captured.options!.hookRegistry!;
    expect(registry.hasSubscribers('populateWorktree')).toBe(false);
    expect(registry.hasSubscribers('beforeTaskWorktreeCreate')).toBe(false);
    expect(registry.hasSubscribers('onTaskMerge')).toBe(false);
  });

  it('a workflow-provided populateWorktree composes WITH the default (pipeline fan-out)', async () => {
    // Both the workflow subscriber AND the engine default land under the same
    // 'populateWorktree' name. Pipeline composition runs them in order.
    const repoDir = createTempGitRepo();
    cleanups.push(() => rmSync(repoDir, { recursive: true, force: true }));
    const run = await makeRun(60_000, { cwd: repoDir });

    let workflowFired = false;
    const { workflow, captured } = makeWorkflow({
      hooks: asHooks({
        populateWorktree: async () => {
          workflowFired = true;
        },
      }),
      runImpl: () => undefined,
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    // The workflow subscriber fired.
    expect(workflowFired).toBe(true);
    // AND the default is registered alongside it.
    expect(captured.options!.hookRegistry!.hasSubscribers('populateWorktree')).toBe(true);
  });

  it('the git-path run still completes and broadcasts run_complete when hooks are threaded', async () => {
    // Threading hooks must NOT disrupt the terminal lifecycle: the run still
    // completes, broadcasts run_complete, and arms the reaper.
    const repoDir = createTempGitRepo();
    cleanups.push(() => rmSync(repoDir, { recursive: true, force: true }));
    const run = await makeRun(60_000, { cwd: repoDir });
    const { workflow } = makeWorkflow({
      hooks: asHooks({ populateWorktree: async () => undefined }),
      runImpl: () => undefined,
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('complete');
    expect(run.handle.summary.status).toBe('complete');
    expect(run.broadcasts.some((m) => m.type === 'run_complete')).toBe(true);
    expect(run.reapCalls).toHaveLength(1);
  });
});

// ── (9) Nothing-succeeded detection ────────────────────────────────────────
//
// When `workflow.run()` resolves but NO tasks completed (all failed, all
// cancelled, or all deadlocked-now-failed via kb-7), the executor must NOT
// broadcast `run_complete`. Instead it throws an Error with counts so control
// falls into the existing catch block → `run_failed`.
//
// Rules:
//  - 0 tasks registered → `run_complete` (legitimate workflow with no tasks).
//  - ≥1 task registered, ≥1 completed → `run_complete` (partial tolerated).
//  - ≥1 task registered, 0 completed → throw → `run_failed` with counts.
//  - AbortError → still `run_failed` with 'Run cancelled' (unchanged).
//  - The thrown error is a normal Error (NOT AbortError), so the catch block
//    takes the generic error branch → message in the terminal broadcast.

/**
 * Helper: fire status callbacks through the composed `onStatus` surface so
 * the store evolves task entities. Returns the IDs of the created tasks so
 * the caller can inspect the projection afterward.
 *
 * `outcomes` is an array of { id, status } — each entry gets registered,
 * started, and then the given final status applied (complete or failed).
 */
async function emitTaskOutcomes(
  options: WorkflowRunOptions,
  outcomes: Array<{ id: string; status: 'complete' | 'failed' }>,
  store: EventStore,
): Promise<void> {
  const cb = status(options);
  for (const { id, status: taskStatus } of outcomes) {
    cb.onTaskRegister({
      taskId: id,
      phaseId: 'p1',
      title: `Task ${id}`,
      dependencies: [],
    });
    cb.onTaskStart({ taskId: id, title: `Task ${id}`, agentId: `agent-${id}`, phaseId: 'p1' });
    if (taskStatus === 'complete') {
      cb.onTaskComplete({ taskId: id, title: `Task ${id}` });
    } else {
      cb.onTaskRejected({ taskId: id, title: `Task ${id}`, reason: 'failed' });
    }
  }
  // Flush so the projection is durable (the executor checks getProjection()).
  await store.flush();
}

describe('RunExecutor.execute — nothing-succeeded detection', () => {
  it('broadcasts run_failed when workflow resolves but 0 tasks completed and >0 failed', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: async (options) => {
        await emitTaskOutcomes(
          options,
          [
            { id: 't1', status: 'failed' },
            { id: 't2', status: 'failed' },
          ],
          run.store,
        );
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    // Must be FAILED, not complete.
    expect(run.handle.status).toBe('failed');
    expect(run.handle.summary.status).toBe('failed');

    const terminal = run.broadcasts.find((m) => m.type === 'run_failed');
    expect(terminal).toBeDefined();
    expect(String((terminal as { error?: string }).error)).toContain('0 successful tasks');
    expect(String((terminal as { error?: string }).error)).toContain('2 failed');

    // Must NOT have broadcast run_complete.
    expect(run.broadcasts.find((m) => m.type === 'run_complete')).toBeUndefined();
  });

  it('broadcasts run_complete when at least 1 task completed (partial success tolerated)', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: async (options) => {
        await emitTaskOutcomes(
          options,
          [
            { id: 't1', status: 'complete' },
            { id: 't2', status: 'failed' },
          ],
          run.store,
        );
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('complete');
    expect(run.handle.summary.status).toBe('complete');
    expect(run.broadcasts.some((m) => m.type === 'run_complete')).toBe(true);
  });

  it('broadcasts run_complete when 0 tasks were registered (legitimate no-task workflow)', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({ runImpl: () => undefined });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('complete');
    expect(run.handle.summary.status).toBe('complete');
    expect(run.broadcasts.some((m) => m.type === 'run_complete')).toBe(true);
  });

  it('aborted run still broadcasts run_failed with "Run cancelled" (no regression)', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: async (options) => {
        // Emit a task first, then abort — abort path must still win.
        await emitTaskOutcomes(options, [{ id: 't1', status: 'failed' }], run.store);
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('failed');
    const terminal = run.broadcasts.find((m) => m.type === 'run_failed');
    expect(terminal).toBeDefined();
    expect(String((terminal as { error?: string }).error)).toBe('Run cancelled');
  });

  it('regression: a normal all-complete run still broadcasts run_complete', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: async (options) => {
        await emitTaskOutcomes(
          options,
          [
            { id: 't1', status: 'complete' },
            { id: 't2', status: 'complete' },
          ],
          run.store,
        );
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('complete');
    expect(run.handle.summary.status).toBe('complete');
    expect(run.broadcasts.some((m) => m.type === 'run_complete')).toBe(true);
    expect(run.reapCalls).toHaveLength(1);
  });

  it('broadcasts run_failed when 0 complete and some tasks are in non-terminal states', async () => {
    // Non-terminal statuses (ready/blocked/active/cancelled) in the projection
    // produce an accurate per-status breakdown in the error message instead of
    // the former misleading 'cancelled' catch-all label.
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: async (options) => {
        const cb = status(options);
        // Task t1: registered only → stays 'ready' in projection.
        cb.onTaskRegister({
          taskId: 't1',
          phaseId: 'p1',
          title: 'Task t1',
          dependencies: [],
        });
        // Task t2: registered + started → 'active' in projection.
        cb.onTaskRegister({
          taskId: 't2',
          phaseId: 'p1',
          title: 'Task t2',
          dependencies: [],
        });
        cb.onTaskStart({ taskId: 't2', title: 'Task t2', agentId: 'agent-t2', phaseId: 'p1' });
        // Task t3: rejected → 'failed' in projection.
        cb.onTaskRegister({
          taskId: 't3',
          phaseId: 'p1',
          title: 'Task t3',
          dependencies: [],
        });
        cb.onTaskStart({ taskId: 't3', title: 'Task t3', agentId: 'agent-t3', phaseId: 'p1' });
        cb.onTaskRejected({ taskId: 't3', title: 'Task t3', reason: 'failed' });
        await run.store.flush();
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('failed');
    expect(run.handle.summary.status).toBe('failed');

    const terminal = run.broadcasts.find((m) => m.type === 'run_failed');
    expect(terminal).toBeDefined();
    const msg = String((terminal as { error?: string }).error);
    expect(msg).toContain('0 successful tasks');
    expect(msg).toContain('1 failed');
    // Non-terminal breakdown: 1 ready (t1) + 1 active (t2) — stable order matches TaskStatus.
    expect(msg).toContain('non-terminal: 1 ready, 1 active');
  });

  it('broadcasts run_failed when all tasks are rejected (0 complete, all mapped to failed)', async () => {
    const run = await makeRun();
    const { workflow } = makeWorkflow({
      runImpl: async (options) => {
        const cb = status(options);
        cb.onTaskRegister({
          taskId: 't1',
          phaseId: 'p1',
          title: 'Task t1',
          dependencies: [],
        });
        cb.onTaskStart({ taskId: 't1', title: 'Task t1', agentId: 'a1', phaseId: 'p1' });
        // onTaskRejected maps to 'failed' in the projection regardless of reason.
        cb.onTaskRejected({ taskId: 't1', title: 'Task t1', reason: 'cancelled' });
        await run.store.flush();
      },
    });

    await run.executor.execute(run.handle, workflow, run.storeCallbacks, run.msg);

    expect(run.handle.status).toBe('failed');
    const terminal = run.broadcasts.find((m) => m.type === 'run_failed');
    expect(terminal).toBeDefined();
    expect(String((terminal as { error?: string }).error)).toContain('0 successful tasks');
    expect(String((terminal as { error?: string }).error)).toContain('1 failed');
    // No non-terminal tasks — the breakdown suffix should be absent.
    expect(String((terminal as { error?: string }).error)).not.toContain('non-terminal');
    expect(run.broadcasts.find((m) => m.type === 'run_complete')).toBeUndefined();
  });
});
