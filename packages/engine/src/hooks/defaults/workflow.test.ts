// ─── Tests for hooks/defaults/workflow.ts — workflow-level default hooks ─────
//
// These tests pin the SIX default implementations for the workflow-level hooks
// declared in hooks/types.ts (task-23). Each default ships a "zero-config"
// behavior so a workflow that registers NO hooks still gets sensible
// persistence, restore, merge, abort, and resume semantics. They are also the
// building blocks `spir.ts`'s `runSpir` is being refactored to call through.
//
// Module under test: ./workflow.js
//
// Defaults covered:
//   1. createDefaultOnPersist(tracker)                — PipelineHook: tracker.save() → tracker.toJSON()
//   2. createDefaultOnRestore(workDir)                — PipelineHook: WorkflowStatusTracker.load(args.workDir) → toJSON()
//   3. defaultBeforeRunMerge                          — FirstWinsHook: { proceed: true, strategy: 'squash' }
//   4. createDefaultOnRunMergeConflict(profilesDirs, apiKeys?) — FirstWinsHook: { strategy: 'agent' }
//   5. defaultOnWorkflowAbort                         — ObserveHook: console.warn(reason)
//   6. defaultOnWorkflowResume                        — ObserveHook: no-op
//
// Where practical these exercise a REAL WorkflowStatusTracker against temp
// directories (mirrors tests/tracking/workflow-status.test.ts). The test file
// is co-located with the source, so imports are relative to
// packages/engine/src/hooks/defaults/.
//
// NOTE: `./workflow.js` does not exist yet — this is the write-tests step. The
// tests are RED until the implementation lands; they serve as the executable
// spec for workflow.ts.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StatusCallbacks, WorkflowState } from '../../core/types.js';
import { EventStore } from '../../tracking/event-store.js';
import { WorkflowStatusTracker } from '../../tracking/workflow-status.js';
import { composeHooks } from '../compose.js';
import { createHookRegistry } from '../registry.js';
import type {
  BeforeRunMergeArgs,
  HookContext,
  ObserveHook,
  OnRunMergeConflictArgs,
  OnWorkflowAbortArgs,
  OnWorkflowResumeArgs,
  RunMergeDecision,
  WorkflowHooks,
} from '../types.js';
import * as defaultsBarrel from './index.js';
import {
  createDefaultOnPersist,
  createDefaultOnRestore,
  createDefaultOnRunMergeConflict,
  defaultBeforeRunMerge,
  defaultOnWorkflowAbort,
  defaultOnWorkflowResume,
} from './workflow.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

/**
 * Minimal HookContext. `registry` defaults to a fresh, independent registry
 * (forwarded as a real value here even though direct-invocation tests don't
 * route through it). Mirrors makeCtx in registry.test.ts / compose.test.ts.
 */
function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: createHookRegistry(),
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

/** A minimal, valid WorkflowState used as the incoming pipeline value. */
function emptyWorkflowState(): WorkflowState {
  return {
    taskPrompt: '',
    currentPhaseId: '',
    completedPhaseIds: [],
    tasks: [],
    workflowData: {},
    stats: { totalTokens: 0, totalCost: 0, agentCount: 0 },
  };
}

// Temp-directory tracking: each test that needs disk gets a fresh dir, cleaned
// up after every test. Mirrors tests/helpers/use-temp-dir.ts but inlined so
// this co-located test stays self-contained (no deep relative import).
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `wf-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

// ── console.warn spy (manual, version-safe — mirrors registry.test.ts) ──────
//
// defaultOnWorkflowAbort surfaces the abort reason via console.warn. We capture
// warn calls without touching the real stream so assertions are deterministic.

let warnCalls: unknown[][] = [];
let realWarn: typeof console.warn;

beforeEach(() => {
  realWarn = console.warn;
  warnCalls = [];
  console.warn = ((...args: unknown[]) => {
    warnCalls.push(args);
  }) as unknown as typeof console.warn;
});

afterEach(async () => {
  console.warn = realWarn;
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

// ── createDefaultOnPersist ──────────────────────────────────────────────────

describe('createDefaultOnPersist', () => {
  it('returns a function (a PipelineHook)', () => {
    const tracker = new WorkflowStatusTracker('/tmp/never-written-persist');
    const hook = createDefaultOnPersist(tracker);
    expect(typeof hook).toBe('function');
    tracker.dispose();
  });

  it('is assignable to WorkflowHooks.onPersist (type-level + identity)', () => {
    const tracker = new WorkflowStatusTracker('/tmp/never-written-persist');
    const hook = createDefaultOnPersist(tracker);
    const hooks: WorkflowHooks = { onPersist: hook };
    expect(hooks.onPersist).toBe(hook);
    tracker.dispose();
  });

  it('calls tracker.save() so the state lands on disk', async () => {
    const dir = await makeTempDir();
    const tracker = new WorkflowStatusTracker(dir);
    tracker.setTaskPrompt('persist-me');

    let saveCalls = 0;
    const realSave = tracker.save.bind(tracker);
    tracker.save = async () => {
      saveCalls++;
      await realSave();
    };

    const hook = createDefaultOnPersist(tracker);
    await hook(emptyWorkflowState(), { workDir: dir }, makeCtx());

    expect(saveCalls).toBe(1);

    tracker.save = realSave;
    tracker.dispose();
  });

  it('returns tracker.toJSON() as the pipeline output', async () => {
    const dir = await makeTempDir();
    const tracker = new WorkflowStatusTracker(dir);
    tracker.setTaskPrompt('roundtrip');
    tracker.setWorkflowData({ plan: { steps: [1, 2] } });

    const hook = createDefaultOnPersist(tracker);
    const result = await hook(emptyWorkflowState(), { workDir: dir }, makeCtx());

    expect(result).toEqual(tracker.toJSON());
    expect(result.taskPrompt).toBe('roundtrip');
    expect((result.workflowData as Record<string, unknown>).plan).toEqual({ steps: [1, 2] });
    tracker.dispose();
  });

  it('ignores the incoming pipeline value (tracker state wins)', async () => {
    const dir = await makeTempDir();
    const tracker = new WorkflowStatusTracker(dir);
    tracker.setTaskPrompt('from-tracker');

    const incoming: WorkflowState = { ...emptyWorkflowState(), taskPrompt: 'from-pipeline' };
    const hook = createDefaultOnPersist(tracker);
    const result = await hook(incoming, { workDir: dir }, makeCtx());

    expect(result.taskPrompt).toBe('from-tracker');
    tracker.dispose();
  });

  it('reflects the latest tracker state at each call (not a stale snapshot)', async () => {
    const dir = await makeTempDir();
    const tracker = new WorkflowStatusTracker(dir);
    const hook = createDefaultOnPersist(tracker);

    tracker.setTaskPrompt('first');
    const r1 = await hook(emptyWorkflowState(), { workDir: dir }, makeCtx());
    expect(r1.taskPrompt).toBe('first');

    tracker.setTaskPrompt('second');
    const r2 = await hook(emptyWorkflowState(), { workDir: dir }, makeCtx());
    expect(r2.taskPrompt).toBe('second');
    tracker.dispose();
  });

  it('awaits save() before resolving (save errors propagate, not swallowed)', async () => {
    // Unlike the tracker's fire-and-forget auto-persist, the explicit onPersist
    // default does `await tracker.save()` — a failure must reject the hook.
    const dir = await makeTempDir();
    const tracker = new WorkflowStatusTracker(dir);
    const realSave = tracker.save.bind(tracker);
    tracker.save = async () => {
      throw new Error('disk full');
    };

    const hook = createDefaultOnPersist(tracker);
    await expect(hook(emptyWorkflowState(), { workDir: dir }, makeCtx())).rejects.toThrow('disk full');

    tracker.save = realSave;
    tracker.dispose();
  });
});

// ── createDefaultOnRestore ──────────────────────────────────────────────────

describe('createDefaultOnRestore', () => {
  it('returns a function (a PipelineHook)', () => {
    const hook = createDefaultOnRestore('/tmp/never-read-restore');
    expect(typeof hook).toBe('function');
  });

  it('is assignable to WorkflowHooks.onRestore (type-level + identity)', () => {
    const hook = createDefaultOnRestore('/some/dir');
    const hooks: WorkflowHooks = { onRestore: hook };
    expect(hooks.onRestore).toBe(hook);
  });

  it('loads the tracker from args.workDir and returns its serialized state', async () => {
    const dir = await makeTempDir();
    const seed = new WorkflowStatusTracker(dir);
    seed.setTaskPrompt('restore-me');
    seed.setWorkflowData({ plan: { x: 1 } });
    await seed.save();
    seed.dispose();

    const hook = createDefaultOnRestore(dir);
    const result = await hook(emptyWorkflowState(), { workDir: dir }, makeCtx());

    expect(result.taskPrompt).toBe('restore-me');
    expect((result.workflowData as Record<string, unknown>).plan).toEqual({ x: 1 });
  });

  it('reads the workDir from the invocation args (args.workDir), not the factory-captured one', async () => {
    // The spec is explicit: the hook calls `WorkflowStatusTracker.load(args.workDir)`.
    // State lives in dirA; the factory is handed dirB (no state). Invoking with
    // args.workDir = dirA must load dirA's state — proving the hook honors the
    // invocation args over the factory-captured path.
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    const seed = new WorkflowStatusTracker(dirA);
    seed.setTaskPrompt('lives-in-dirA');
    await seed.save();
    seed.dispose();

    const hook = createDefaultOnRestore(dirB);
    const result = await hook(emptyWorkflowState(), { workDir: dirA }, makeCtx());

    expect(result.taskPrompt).toBe('lives-in-dirA');
  });

  it('round-trips phase history, workflow data, and tasks through a real tracker', async () => {
    const dir = await makeTempDir();
    const seed = new WorkflowStatusTracker(dir);
    seed.setTaskPrompt('roundtrip');
    seed.setCurrentPhase('scouting');
    seed.setPhase('planning');
    seed.setWorkflowData({ scoutingReports: [{ s: 1 }] });
    seed.taskTracker.addTask({
      id: 't1',
      title: 'Scout',
      prompt: 'p',
      profile: 'coder',
      files: [],
      dependencies: [],
      status: 'ready',
      phaseId: 'planning',
    });
    await seed.save();
    seed.dispose();

    const hook = createDefaultOnRestore(dir);
    const result = await hook(emptyWorkflowState(), { workDir: dir }, makeCtx());

    expect(result.currentPhaseId).toBe('planning');
    expect(result.completedPhaseIds).toEqual(['scouting']);
    expect(result.workflowData.scoutingReports).toEqual([{ s: 1 }]);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe('t1');
  });

  it('ignores the incoming pipeline value (loaded state wins)', async () => {
    const dir = await makeTempDir();
    const seed = new WorkflowStatusTracker(dir);
    seed.setTaskPrompt('from-disk');
    await seed.save();
    seed.dispose();

    const incoming: WorkflowState = { ...emptyWorkflowState(), taskPrompt: 'from-pipeline' };
    const hook = createDefaultOnRestore(dir);
    const result = await hook(incoming, { workDir: dir }, makeCtx());

    expect(result.taskPrompt).toBe('from-disk');
  });

  it('propagates load() failures (missing state file)', async () => {
    const dir = await makeTempDir(); // empty — no .engin-state.json
    const hook = createDefaultOnRestore(dir);
    await expect(hook(emptyWorkflowState(), { workDir: dir }, makeCtx())).rejects.toThrow(
      'Workflow state file not found',
    );
  });
});

// ── defaultBeforeRunMerge ───────────────────────────────────────────────────

describe('defaultBeforeRunMerge', () => {
  it('is a function (a FirstWinsHook)', () => {
    expect(typeof defaultBeforeRunMerge).toBe('function');
  });

  it('is assignable to WorkflowHooks.beforeRunMerge (type-level + identity)', () => {
    const hooks: WorkflowHooks = { beforeRunMerge: defaultBeforeRunMerge };
    expect(hooks.beforeRunMerge).toBe(defaultBeforeRunMerge);
  });

  it('returns the squash-merge decision { proceed: true, strategy: "squash" }', async () => {
    const args: BeforeRunMergeArgs = { repoRoot: '/repo', mainBranch: 'main' };
    const result = await defaultBeforeRunMerge(args, makeCtx());
    expect(result).toEqual({ proceed: true, strategy: 'squash' });
  });

  it('returns a non-undefined value (wins in a first-wins composition)', async () => {
    const result = await defaultBeforeRunMerge({ repoRoot: '/r', mainBranch: 'main' }, makeCtx());
    expect(result).toBeDefined();
  });

  it('returns the same decision regardless of the worktree / branch args', async () => {
    const a = await defaultBeforeRunMerge({ repoRoot: '/a', mainBranch: 'main' }, makeCtx());
    const b = await defaultBeforeRunMerge(
      {
        repoRoot: '/b',
        mainBranch: 'develop',
        worktree: { worktreePath: '/wt', branchName: 'feature', originalCwd: '/repo' },
      },
      makeCtx(),
    );
    expect(a).toEqual(b);
  });
});

// ── createDefaultOnRunMergeConflict ─────────────────────────────────────────

describe('createDefaultOnRunMergeConflict', () => {
  it('returns a function (a FirstWinsHook)', () => {
    const hook = createDefaultOnRunMergeConflict(['/profiles']);
    expect(typeof hook).toBe('function');
  });

  it('is assignable to WorkflowHooks.onRunMergeConflict (type-level + identity)', () => {
    const hook = createDefaultOnRunMergeConflict(['/profiles']);
    const hooks: WorkflowHooks = { onRunMergeConflict: hook };
    expect(hooks.onRunMergeConflict).toBe(hook);
  });

  it('returns the agent-resolution marker { strategy: "agent" }', async () => {
    const hook = createDefaultOnRunMergeConflict(['/profiles']);
    const args: OnRunMergeConflictArgs = {
      conflicts: ['src/a.ts', 'src/b.ts'],
      worktreePath: '/wt',
      repoRoot: '/repo',
    };
    const result = await hook(args, makeCtx());
    expect(result).toEqual({ strategy: 'agent' });
  });

  it('accepts an optional apiKeys map as the second factory argument', () => {
    // Type-level + runtime: the factory signature is (profilesDirs, apiKeys?).
    const hook = createDefaultOnRunMergeConflict(['/profiles'], { OPENAI_API_KEY: 'sk-test' });
    expect(typeof hook).toBe('function');
  });

  it('returns the agent marker regardless of conflict count / paths', async () => {
    const hook = createDefaultOnRunMergeConflict(['/profiles']);
    const withConflicts = await hook({ conflicts: ['a.ts'], worktreePath: '/w', repoRoot: '/r' }, makeCtx());
    const empty = await hook({ conflicts: [], worktreePath: '/w', repoRoot: '/r' }, makeCtx());
    expect(withConflicts).toEqual({ strategy: 'agent' });
    expect(empty).toEqual({ strategy: 'agent' });
  });

  it('does not read conflict files or spawn an agent (pure delegation marker)', async () => {
    // The default returns ONLY the strategy marker; the actual agent-based
    // resolution is composed downstream by WorktreeManager.resolveFinalMergeConflicts
    // (which calls worktree-lifecycle.ts:resolveConflictsWithAgent). Pointing
    // repoRoot / profiles at non-existent paths must NOT throw — if the default
    // tried to resolve conflicts itself it would attempt to read the (missing)
    // conflict files and spawn a session.
    const hook = createDefaultOnRunMergeConflict(['/nonexistent-profiles']);
    const result = await hook(
      { conflicts: ['missing.ts'], worktreePath: '/nonexistent-wt', repoRoot: '/nonexistent-repo' },
      makeCtx(),
    );
    expect(result).toEqual({ strategy: 'agent' });
    // The default returns ONLY the marker — no resolvedFiles (resolution happens
    // downstream in WorktreeManager.resolveFinalMergeConflicts).
    expect(result?.resolvedFiles).toBeUndefined();
  });
});

// ── defaultOnWorkflowAbort ──────────────────────────────────────────────────

describe('defaultOnWorkflowAbort', () => {
  it('is a function (an ObserveHook)', () => {
    expect(typeof defaultOnWorkflowAbort).toBe('function');
  });

  it('is assignable to WorkflowHooks.onWorkflowAbort (type-level + identity)', () => {
    const hooks: WorkflowHooks = { onWorkflowAbort: defaultOnWorkflowAbort };
    expect(hooks.onWorkflowAbort).toBe(defaultOnWorkflowAbort);
  });

  it('logs the abort reason via console.warn', async () => {
    const args: OnWorkflowAbortArgs = { reason: 'Workflow cancelled', workDir: '/w' };
    await defaultOnWorkflowAbort(args, makeCtx());
    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0])).toContain('Workflow cancelled');
  });

  it('logs whatever reason string is supplied', async () => {
    await defaultOnWorkflowAbort({ reason: 'SIGTERM received', workDir: '/w' }, makeCtx());
    expect(String(warnCalls.at(-1))).toContain('SIGTERM received');
  });

  it('resolves undefined (observe hooks have no return value)', async () => {
    const result = await defaultOnWorkflowAbort({ reason: 'x', workDir: '/w' }, makeCtx());
    expect(result).toBeUndefined();
  });
});

// ── defaultOnWorkflowResume ─────────────────────────────────────────────────

describe('defaultOnWorkflowResume', () => {
  it('is a function (an ObserveHook)', () => {
    expect(typeof defaultOnWorkflowResume).toBe('function');
  });

  it('is assignable to WorkflowHooks.onWorkflowResume (type-level + identity)', () => {
    const hooks: WorkflowHooks = { onWorkflowResume: defaultOnWorkflowResume };
    expect(hooks.onWorkflowResume).toBe(defaultOnWorkflowResume);
  });

  it('is a no-op: resolves undefined and does not throw', async () => {
    const args: OnWorkflowResumeArgs = { workDir: '/w', tracker: undefined };
    await expect(defaultOnWorkflowResume(args, makeCtx())).resolves.toBeUndefined();
  });

  it('does not mutate the args or perform disk I/O', async () => {
    const args: OnWorkflowResumeArgs = { workDir: '/resume/dir', tracker: { arbitrary: 'shape' } };
    await defaultOnWorkflowResume(args, makeCtx());
    expect(args.workDir).toBe('/resume/dir');
    expect((args.tracker as { arbitrary: string }).arbitrary).toBe('shape');
  });

  it('tolerates a tracker of any shape (typed unknown)', async () => {
    await expect(
      defaultOnWorkflowResume({ workDir: '/w', tracker: { anything: true } }, makeCtx()),
    ).resolves.toBeUndefined();
    await expect(defaultOnWorkflowResume({ workDir: '/w', tracker: null }, makeCtx())).resolves.toBeUndefined();
  });
});

// ── Defaults compose through the HookRegistry ───────────────────────────────
//
// These verify the defaults satisfy their declared composition rule when wired
// into a real HookRegistry (the engine's invocation path). `WorkflowHooks`
// already declares these fields, so the hook-name literals typecheck without
// the `as never` cast the mechanism-only registry tests needed.

describe('defaults compose through the HookRegistry', () => {
  it('onPersist: default persists and returns tracker.toJSON() via invokePipeline', async () => {
    const dir = await makeTempDir();
    const tracker = new WorkflowStatusTracker(dir);
    tracker.setTaskPrompt('via-registry');

    const reg = createHookRegistry();
    reg.defineHook('onPersist', 'pipeline');
    reg.register({ onPersist: createDefaultOnPersist(tracker) });

    const result = await reg.invokePipeline(
      'onPersist',
      tracker.toJSON(),
      { workDir: dir },
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual(tracker.toJSON());
    tracker.dispose();
  });

  it('onRestore: default restores via invokePipeline', async () => {
    const dir = await makeTempDir();
    const seed = new WorkflowStatusTracker(dir);
    seed.setTaskPrompt('via-registry-restore');
    await seed.save();
    seed.dispose();

    const reg = createHookRegistry();
    reg.defineHook('onRestore', 'pipeline');
    reg.register({ onRestore: createDefaultOnRestore(dir) });

    const result = await reg.invokePipeline(
      'onRestore',
      emptyWorkflowState(),
      { workDir: dir },
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual(expect.objectContaining({ taskPrompt: 'via-registry-restore' }));
  });

  it('beforeRunMerge: default decision wins via invokeFirstWins', async () => {
    const reg = createHookRegistry();
    reg.defineHook('beforeRunMerge', 'first-wins');
    reg.register({ beforeRunMerge: defaultBeforeRunMerge });

    const result = await reg.invokeFirstWins(
      'beforeRunMerge',
      { repoRoot: '/repo', mainBranch: 'main' },
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual({ proceed: true, strategy: 'squash' });
  });

  it('onRunMergeConflict: default marker wins via invokeFirstWins', async () => {
    const reg = createHookRegistry();
    reg.defineHook('onRunMergeConflict', 'first-wins');
    reg.register({ onRunMergeConflict: createDefaultOnRunMergeConflict(['/profiles']) });

    const result = await reg.invokeFirstWins(
      'onRunMergeConflict',
      { conflicts: ['a.ts'], worktreePath: '/wt', repoRoot: '/repo' },
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual({ strategy: 'agent' });
  });

  it('onWorkflowAbort: default fans out via invokeObserve and logs via warn', async () => {
    const reg = createHookRegistry();
    reg.defineHook('onWorkflowAbort', 'observe');
    reg.register({ onWorkflowAbort: defaultOnWorkflowAbort });

    await reg.invokeObserve('onWorkflowAbort', { reason: 'hard-stop', workDir: '/w' }, makeCtx({ registry: reg }));

    expect(String(warnCalls.at(-1))).toContain('hard-stop');
  });

  it('onWorkflowResume: default is a no-op via invokeObserve', async () => {
    const reg = createHookRegistry();
    reg.defineHook('onWorkflowResume', 'observe');
    reg.register({ onWorkflowResume: defaultOnWorkflowResume });

    await expect(
      reg.invokeObserve('onWorkflowResume', { workDir: '/w', tracker: undefined }, makeCtx({ registry: reg })),
    ).resolves.toBeUndefined();
  });

  it('first-wins: a workflow override registered before the default short-circuits it', async () => {
    // Proves the default composes correctly: when a user hook is registered
    // BEFORE the default, first-wins honors the earlier subscriber.
    const reg = createHookRegistry();
    reg.defineHook('beforeRunMerge', 'first-wins');
    reg.register({
      beforeRunMerge: [async () => ({ proceed: false, strategy: 'merge' as const }), defaultBeforeRunMerge],
    });

    const result = await reg.invokeFirstWins(
      'beforeRunMerge',
      { repoRoot: '/r', mainBranch: 'main' },
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual({ proceed: false, strategy: 'merge' });
  });
});

// ── Defaults barrel (./index.js) ────────────────────────────────────────────
//
// The task requires "Export all factories/functions. Add to
// packages/engine/src/hooks/defaults/index.ts." These pin that re-export so a
// consumer importing from the defaults barrel gets every default. Accessed via
// a Record cast so the test is a pure runtime check (no hard type error while
// index.ts still only does `export {}`).

describe('defaults barrel (./index.js)', () => {
  it('re-exports all six workflow defaults', () => {
    const barrel = defaultsBarrel as unknown as Record<string, unknown>;
    expect(typeof barrel.createDefaultOnPersist).toBe('function');
    expect(typeof barrel.createDefaultOnRestore).toBe('function');
    expect(typeof barrel.defaultBeforeRunMerge).toBe('function');
    expect(typeof barrel.createDefaultOnRunMergeConflict).toBe('function');
    expect(typeof barrel.defaultOnWorkflowAbort).toBe('function');
    expect(typeof barrel.defaultOnWorkflowResume).toBe('function');
  });
});

// ── Engine firing: abort routes to onWorkflowAbort ─────────────────────────
//
// These mirror the engine's catch-block decision in run-executor.ts::execute:
// only an AbortError (produced when controller.abort() cancels the run) fires
// `invokeObserve('onWorkflowAbort', { reason: 'Aborted', workDir }, ctx)`, and
// it fires BEFORE the handle flips to 'failed'. A genuine (non-abort) error is
// a FAILURE — it does NOT fire onWorkflowAbort. (onWorkflowFailed is not yet a
// declared hook; abort and failure are distinct seams, and these tests pin the
// seam selection.) They exercise the DEFAULT onWorkflowAbort composed WITH a
// user subscriber so the fan-out path is covered.

describe('engine firing: abort routes to onWorkflowAbort (not a failure path)', () => {
  type Registry = ReturnType<typeof createHookRegistry>;

  /** Faithful copy of run-executor.ts's terminal-hook decision. */
  async function fireOnAbort(reg: Registry, err: unknown, workDir: string, ctx: HookContext): Promise<void> {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort) {
      await reg.invokeObserve('onWorkflowAbort', { reason: 'Aborted', workDir }, ctx);
    }
  }

  function makeAbortError(): Error {
    const err = new Error('The user aborted a request');
    err.name = 'AbortError';
    return err;
  }

  it('fires onWorkflowAbort (default + user subscriber) when the signal aborts the run', async () => {
    const dir = await makeTempDir();
    const controller = new AbortController();
    const ctx = makeCtx({ workDir: dir, signal: controller.signal });

    const seen: OnWorkflowAbortArgs[] = [];
    const userHook: ObserveHook<OnWorkflowAbortArgs> = async (args) => {
      seen.push(args);
    };

    const reg = createHookRegistry();
    reg.defineHook('onWorkflowAbort', 'observe');
    // Workflow provider registered first; the engine appends the default AFTER
    // composeHooks — exactly the order run-executor uses.
    reg.register({ onWorkflowAbort: userHook });
    reg.register({ onWorkflowAbort: defaultOnWorkflowAbort });

    controller.abort();
    await fireOnAbort(reg, makeAbortError(), dir, ctx);

    // Observe fan-out: the user subscriber fires exactly once with the engine's
    // { reason: 'Aborted', workDir } payload.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ reason: 'Aborted', workDir: dir });
    // The default subscriber surfaced the same reason via console.warn.
    expect(String(warnCalls.at(-1))).toContain('Aborted');
  });

  it('does NOT fire onWorkflowAbort on a genuine (non-abort) error', async () => {
    const dir = await makeTempDir();
    const ctx = makeCtx({ workDir: dir });

    const seen: OnWorkflowAbortArgs[] = [];
    const reg = createHookRegistry();
    reg.defineHook('onWorkflowAbort', 'observe');
    reg.register({ onWorkflowAbort: defaultOnWorkflowAbort });
    reg.register({
      onWorkflowAbort: async (args) => {
        seen.push(args);
      },
    });

    await fireOnAbort(reg, new Error('phase runner crashed'), dir, ctx);

    expect(seen).toHaveLength(0);
  });

  it('keys off err.name === "AbortError", not the message text', async () => {
    // An error that merely SAYS "aborted" in its message is a FAILURE, not an
    // abort — the engine must not mis-route it to onWorkflowAbort.
    const dir = await makeTempDir();
    const ctx = makeCtx({ workDir: dir });

    const seen: OnWorkflowAbortArgs[] = [];
    const reg = createHookRegistry();
    reg.defineHook('onWorkflowAbort', 'observe');
    reg.register({
      onWorkflowAbort: async (args) => {
        seen.push(args);
      },
    });

    await fireOnAbort(reg, new Error('Run aborted by user'), dir, ctx);
    expect(seen).toHaveLength(0);
  });

  it('routes to onWorkflowAbort specifically — not to the other observe hook (onWorkflowResume)', async () => {
    // The seam-selection guarantee: an abort fans out to onWorkflowAbort only.
    // A sibling observe hook (onWorkflowResume) must stay silent on the abort
    // path. (onWorkflowFailed is not a declared hook yet; this stands in for
    // "the abort does not get mis-routed to a different lifecycle seam".)
    const dir = await makeTempDir();
    const controller = new AbortController();
    const ctx = makeCtx({ workDir: dir, signal: controller.signal });

    const abortSeen: OnWorkflowAbortArgs[] = [];
    const resumeSeen: OnWorkflowResumeArgs[] = [];
    const reg = createHookRegistry();
    reg.defineHook('onWorkflowAbort', 'observe');
    reg.defineHook('onWorkflowResume', 'observe');
    reg.register({
      onWorkflowAbort: async (a) => {
        abortSeen.push(a);
      },
    });
    reg.register({
      onWorkflowResume: async (a) => {
        resumeSeen.push(a);
      },
    });

    controller.abort();
    await fireOnAbort(reg, makeAbortError(), dir, ctx);

    expect(abortSeen).toHaveLength(1);
    expect(resumeSeen).toHaveLength(0);
  });

  it('forwards the run AbortSignal through the HookContext to subscribers', async () => {
    const controller = new AbortController();
    const dir = await makeTempDir();
    let capturedSignal: AbortSignal | undefined;
    const ctx = makeCtx({ workDir: dir, signal: controller.signal });

    const reg = createHookRegistry();
    reg.defineHook('onWorkflowAbort', 'observe');
    reg.register({
      onWorkflowAbort: async (_args, c) => {
        capturedSignal = c.signal;
      },
    });

    controller.abort();
    await fireOnAbort(reg, makeAbortError(), dir, ctx);

    expect(capturedSignal).toBe(controller.signal);
    expect(capturedSignal?.aborted).toBe(true);
  });
});

// ── Engine firing: onWorkflowResume fires on existing events ───────────────
//
// These mirror the engine's resume detection in run-executor.ts::execute:
// BEFORE workflow.run(), `const isResume = store.getEventsSince(0).length > 0;`
// and, when true, `invokeObserve('onWorkflowResume', { workDir, tracker:
// undefined }, ctx)`. A fresh run (empty store) does NOT fire the hook. They
// drive a REAL EventStore against temp dirs so the gate is exercised end to
// end.

describe('engine firing: onWorkflowResume fires when the store has existing events', () => {
  type Registry = ReturnType<typeof createHookRegistry>;

  /** Faithful copy of run-executor.ts's resume gate. */
  async function maybeFireResume(reg: Registry, store: EventStore, workDir: string, ctx: HookContext): Promise<void> {
    if (store.getEventsSince(0).length > 0) {
      await reg.invokeObserve('onWorkflowResume', { workDir, tracker: undefined }, ctx);
    }
  }

  it('does NOT fire onWorkflowResume on a fresh run (empty store)', async () => {
    const dir = await makeTempDir();
    const store = new EventStore(dir);
    const ctx = makeCtx({ workDir: dir });

    const seen: OnWorkflowResumeArgs[] = [];
    const reg = createHookRegistry();
    reg.defineHook('onWorkflowResume', 'observe');
    reg.register({
      onWorkflowResume: async (a) => {
        seen.push(a);
      },
    });

    await maybeFireResume(reg, store, dir, ctx);

    expect(store.getEventsSince(0)).toHaveLength(0);
    expect(seen).toHaveLength(0);
    store.dispose();
  });

  it('fires onWorkflowResume when the store already has events (resume)', async () => {
    const dir = await makeTempDir();
    const store = new EventStore(dir);
    // Seed a prior event + flush so it is durable — mirrors an
    // EventStore.load() that replayed a pre-existing events.jsonl.
    store.append('workflow_started', { taskPrompt: 'prior-run', workDir: dir });
    await store.flush();
    const ctx = makeCtx({ workDir: dir });

    const seen: OnWorkflowResumeArgs[] = [];
    const reg = createHookRegistry();
    reg.defineHook('onWorkflowResume', 'observe');
    reg.register({
      onWorkflowResume: async (a) => {
        seen.push(a);
      },
    });

    await maybeFireResume(reg, store, dir, ctx);

    expect(store.getEventsSince(0).length).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ workDir: dir, tracker: undefined });
    store.dispose();
  });

  it('composes the user onWorkflowResume WITH the default (both fire) on resume', async () => {
    const dir = await makeTempDir();
    const store = new EventStore(dir);
    store.append('workflow_started', { taskPrompt: 'prior-run' });
    await store.flush();
    const ctx = makeCtx({ workDir: dir });

    const seen: OnWorkflowResumeArgs[] = [];
    const reg = createHookRegistry();
    reg.defineHook('onWorkflowResume', 'observe');
    reg.register({
      onWorkflowResume: async (a) => {
        seen.push(a);
      },
    });
    // Engine appends the default after the workflow's providers.
    reg.register({ onWorkflowResume: defaultOnWorkflowResume });

    await maybeFireResume(reg, store, dir, ctx);

    // Fan-out: the user subscriber fires once; the default is a no-op but
    // still ran without throwing.
    expect(seen).toHaveLength(1);
    store.dispose();
  });

  it('survives a store carrying a larger prior history (pre-run, observe, non-throwing)', async () => {
    const dir = await makeTempDir();
    const store = new EventStore(dir);
    for (let i = 0; i < 5; i++) {
      store.append('log', { message: `prior line ${i}` });
    }
    await store.flush();
    const ctx = makeCtx({ workDir: dir });

    const reg = createHookRegistry();
    reg.defineHook('onWorkflowResume', 'observe');
    reg.register({ onWorkflowResume: defaultOnWorkflowResume });

    await expect(maybeFireResume(reg, store, dir, ctx)).resolves.toBeUndefined();
    store.dispose();
  });
});

// ── Merge gate: beforeRunMerge { proceed: false } prevents the final merge ──
//
// These mirror how the run-end final merge consumes the first-wins
// beforeRunMerge decision (run-executor.ts registers the default;
// RunManager.handleWorktreeAction invokes it once the run is terminal):
//
//   const d = await reg.invokeFirstWins('beforeRunMerge', args, ctx);
//   if (d?.proceed) await doFinalMerge(d.strategy);
//
// A workflow that returns { proceed: false } short-circuits the default and
// the final merge is skipped entirely. They pin both the skip and the proceed
// paths, plus the first-wins short-circuit guarantee.

describe('merge gate: beforeRunMerge { proceed: false } prevents the final merge', () => {
  type Registry = ReturnType<typeof createHookRegistry>;

  const mergeArgs: BeforeRunMergeArgs = {
    repoRoot: '/repo',
    mainBranch: 'main',
    worktree: { worktreePath: '/wt', branchName: 'engin/feat', originalCwd: '/repo' },
  };

  let mergeCalls: Array<{ strategy?: RunMergeDecision['strategy'] }> = [];

  beforeEach(() => {
    mergeCalls = [];
  });

  /** Faithful copy of the run-end merge gate consumer. */
  async function runMergeGate(
    reg: Registry,
    args: BeforeRunMergeArgs,
    ctx: HookContext,
  ): Promise<RunMergeDecision | undefined> {
    const decision = (await reg.invokeFirstWins('beforeRunMerge', args, ctx)) as RunMergeDecision | undefined;
    if (decision?.proceed) {
      mergeCalls.push({ strategy: decision.strategy });
    }
    return decision;
  }

  it('skips the final merge when beforeRunMerge returns { proceed: false }', async () => {
    const reg = createHookRegistry();
    reg.defineHook('beforeRunMerge', 'first-wins');
    // Workflow hook registered BEFORE the default decides first (first-wins).
    reg.register({
      beforeRunMerge: [async () => ({ proceed: false, strategy: 'merge' }), defaultBeforeRunMerge],
    });

    const decision = await runMergeGate(reg, mergeArgs, makeCtx());

    expect(decision).toEqual({ proceed: false, strategy: 'merge' });
    expect(mergeCalls).toHaveLength(0);
  });

  it('performs the final merge when beforeRunMerge returns { proceed: true }', async () => {
    const reg = createHookRegistry();
    reg.defineHook('beforeRunMerge', 'first-wins');
    reg.register({
      beforeRunMerge: [async () => ({ proceed: true, strategy: 'merge' }), defaultBeforeRunMerge],
    });

    const decision = await runMergeGate(reg, mergeArgs, makeCtx());

    expect(decision).toEqual({ proceed: true, strategy: 'merge' });
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0].strategy).toBe('merge');
  });

  it('with only the default registered, proceeds with the legacy squash merge', async () => {
    const reg = createHookRegistry();
    reg.defineHook('beforeRunMerge', 'first-wins');
    reg.register({ beforeRunMerge: defaultBeforeRunMerge });

    const decision = await runMergeGate(reg, mergeArgs, makeCtx());

    expect(decision).toEqual({ proceed: true, strategy: 'squash' });
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0].strategy).toBe('squash');
  });

  it('first-wins short-circuits: a later subscriber is never consulted once the user decides', async () => {
    let laterCalls = 0;
    const reg = createHookRegistry();
    reg.defineHook('beforeRunMerge', 'first-wins');
    reg.register({
      beforeRunMerge: [
        async () => ({ proceed: false }),
        async () => {
          laterCalls++;
          return { proceed: true, strategy: 'squash' };
        },
      ],
    });

    const decision = await runMergeGate(reg, mergeArgs, makeCtx());

    expect(decision).toEqual({ proceed: false });
    expect(laterCalls).toBe(0);
    expect(mergeCalls).toHaveLength(0);
  });

  it('honors args.worktree / branch without changing the default decision', async () => {
    // The default is constant; the gate must not be influenced by the
    // worktree/branch payload when no user hook is registered.
    const reg = createHookRegistry();
    reg.defineHook('beforeRunMerge', 'first-wins');
    reg.register({ beforeRunMerge: defaultBeforeRunMerge });

    const withoutWorktree = await runMergeGate(reg, { repoRoot: '/r', mainBranch: 'main' }, makeCtx());
    const withWorktree = await runMergeGate(reg, mergeArgs, makeCtx());

    expect(withoutWorktree).toEqual(withWorktree);
    expect(mergeCalls).toHaveLength(2);
  });
});

// ── Backward compat: zero-config defaults reproduce legacy behavior ────────
//
// The synthesis suite: when workflow.hooks is undefined/empty, the engine
// registers ONLY the defaults (after composeHits registers the empty provider
// list). Every workflow-level seam must reproduce its legacy inline behavior
// EXACTLY — existing workflows are unaffected. This ties all six defaults
// together as the "no hooks registered" baseline.

describe('backward compat: zero-config (no hooks registered) reproduces legacy behavior', () => {
  it('onPersist → legacy inline tracker.save() + tracker.toJSON() (and lands on disk)', async () => {
    const dir = await makeTempDir();
    const tracker = new WorkflowStatusTracker(dir);
    tracker.setTaskPrompt('legacy-persist');

    const reg = createHookRegistry();
    reg.defineHook('onPersist', 'pipeline');
    reg.register({ onPersist: createDefaultOnPersist(tracker) });

    const result = await reg.invokePipeline(
      'onPersist',
      tracker.toJSON(),
      { workDir: dir },
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual(tracker.toJSON());
    // Legacy durability guarantee: the state is actually on disk.
    const reloaded = await WorkflowStatusTracker.load(dir);
    expect(reloaded.taskPrompt).toBe('legacy-persist');
    reloaded.dispose();
    tracker.dispose();
  });

  it('onRestore → legacy inline WorkflowStatusTracker.load(workDir) round-trip', async () => {
    const dir = await makeTempDir();
    const seed = new WorkflowStatusTracker(dir);
    seed.setTaskPrompt('legacy-restore');
    seed.setWorkflowData({ plan: { ok: true } });
    await seed.save();
    seed.dispose();

    const reg = createHookRegistry();
    reg.defineHook('onRestore', 'pipeline');
    reg.register({ onRestore: createDefaultOnRestore(dir) });

    const result = (await reg.invokePipeline(
      'onRestore',
      emptyWorkflowState(),
      { workDir: dir },
      makeCtx({ registry: reg }),
    )) as WorkflowState;

    expect(result.taskPrompt).toBe('legacy-restore');
    expect((result.workflowData as Record<string, unknown>).plan).toEqual({ ok: true });
  });

  it('beforeRunMerge + onRunMergeConflict defaults reproduce the legacy git merge UX', async () => {
    // Legacy: proceed with a squash merge; resolve any conflict with the
    // tooled agent. Both defaults are first-wins and win when no user hook is
    // registered.
    const reg = createHookRegistry();
    reg.defineHook('beforeRunMerge', 'first-wins');
    reg.defineHook('onRunMergeConflict', 'first-wins');
    reg.register({ beforeRunMerge: defaultBeforeRunMerge });
    reg.register({ onRunMergeConflict: createDefaultOnRunMergeConflict(['/profiles']) });

    const mergeDecision = await reg.invokeFirstWins(
      'beforeRunMerge',
      { repoRoot: '/repo', mainBranch: 'main' },
      makeCtx({ registry: reg }),
    );
    const conflictDecision = await reg.invokeFirstWins(
      'onRunMergeConflict',
      { conflicts: ['src/a.ts'], worktreePath: '/wt', repoRoot: '/repo' },
      makeCtx({ registry: reg }),
    );

    expect(mergeDecision).toEqual({ proceed: true, strategy: 'squash' });
    expect(conflictDecision).toEqual({ strategy: 'agent' });
  });

  it('onWorkflowAbort + onWorkflowResume defaults reproduce the legacy observe UX', async () => {
    // Legacy: the abort reason is logged (the prior 'Workflow cancelled'
    // string-match is now a data payload); resume is a no-op.
    const reg = createHookRegistry();
    reg.defineHook('onWorkflowAbort', 'observe');
    reg.defineHook('onWorkflowResume', 'observe');
    reg.register({ onWorkflowAbort: defaultOnWorkflowAbort });
    reg.register({ onWorkflowResume: defaultOnWorkflowResume });

    await reg.invokeObserve(
      'onWorkflowAbort',
      { reason: 'Workflow cancelled', workDir: '/w' },
      makeCtx({ registry: reg }),
    );
    await expect(
      reg.invokeObserve('onWorkflowResume', { workDir: '/w', tracker: undefined }, makeCtx({ registry: reg })),
    ).resolves.toBeUndefined();

    expect(String(warnCalls.at(-1))).toContain('Workflow cancelled');
  });

  it('with undefined workflow.hooks, composeHooks yields an empty registry before defaults are added', () => {
    // The engine's zero-config path: `workflow.hooks ?? []` feeds an empty
    // provider list, so NO workflow-provided subscriber exists for any seam
    // until the engine registers the defaults. The composed onStatus is a
    // behaviorally-identical wrapper over the (here empty) store callbacks.
    const { onStatus, registry } = composeHooks({} as StatusCallbacks, []);

    expect(registry.hasSubscribers('onPersist')).toBe(false);
    expect(registry.hasSubscribers('onRestore')).toBe(false);
    expect(registry.hasSubscribers('beforeRunMerge')).toBe(false);
    expect(registry.hasSubscribers('onRunMergeConflict')).toBe(false);
    expect(registry.hasSubscribers('onWorkflowAbort')).toBe(false);
    expect(registry.hasSubscribers('onWorkflowResume')).toBe(false);
    // STATUS_CALLBACK_METHODS are still present (delegating, no-op on an empty
    // store) — the composed surface shape is unchanged.
    expect(typeof onStatus).toBe('object');
  });
});
