// ─── Tests for hooks/defaults/worktree.ts — worktree-lifecycle default hooks ──
//
// These tests pin the SIX default implementations for the worktree-lifecycle
// hooks declared in hooks/types.ts (the "Worktree lifecycle hooks" block):
//
//   1. createDefaultBeforeTaskWorktreeCreate(readOnlyProfiles?) — FirstWinsHook
//        → undefined for most tasks; { skip: true } for read-only scout tasks
//          (task.profile ∈ readOnlyProfiles). Reproduces "scouts run against the
//          run cwd directly" — they don't need a worktree.
//   2. createDefaultPopulateWorktree(sourceCwd)                  — PipelineHook<void>
//        → calls populateWorktree(args.sourceCwd, args.worktreePath) from
//          core/git.ts (the .worktreecopy copy + symlink primitive).
//   3. defaultOnTaskMerge                                         — FirstWinsHook
//        → { proceed: true, strategy: 'squash' } (current squash-merge behavior).
//   4. createDefaultOnMergeConflict(profilesDirs, apiKeys?)      — FirstWinsHook
//        → { strategy: 'agent' } (delegates to resolveConflictsWithAgent, the
//          tooled fix-up primitive — pure delegation marker, no inline work).
//   5. createDefaultOnCommitFailure(profilesDirs, apiKeys?)      — FirstWinsHook
//        → { strategy: 'agent' } (delegates to the tooled fix-up primitive for
//          lint/commit failures).
//   6. defaultAfterTaskWorktreeCreate                             — ObserveHook
//        → no-op (future: fire a status event for TUI/web per-task branch
//          display; for now worktree state stays internal to WorktreeManager).
//
// Module under test: ./worktree.js
//
// Where practical these exercise REAL temp directories (and `.worktreecopy`
// files) against the real `populateWorktree` primitive — mirroring
// tests/core/git.test.ts. The test file is co-located with the source, so
// imports are relative to packages/engine/src/hooks/defaults/.
//
// NOTE: `./worktree.js` does not exist yet — this is the write-tests step. The
// tests are RED until the implementation lands; they serve as the executable
// spec for worktree.ts.

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Task } from '../../core/types.js';
import { createHookRegistry } from '../registry.js';
import type {
  AfterTaskWorktreeArgs,
  BeforeTaskWorktreeArgs,
  BeforeTaskWorktreeResult,
  CommitFailureResolution,
  ConflictResolution,
  HookContext,
  OnCommitFailureArgs,
  OnMergeConflictArgs,
  OnTaskMergeArgs,
  PopulateWorktreeArgs,
  WorkflowHooks,
} from '../types.js';
import * as defaultsBarrel from './index.js';
import {
  createDefaultBeforeTaskWorktreeCreate,
  createDefaultOnCommitFailure,
  createDefaultOnMergeConflict,
  createDefaultPopulateWorktree,
  defaultAfterTaskWorktreeCreate,
  defaultOnTaskMerge,
} from './worktree.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

/**
 * Minimal HookContext. `registry` defaults to a fresh, independent registry
 * (forwarded as a real value here even though direct-invocation tests don't
 * route through it). Mirrors makeCtx in registry.test.ts / compose.test.ts /
 * workflow.test.ts.
 */
function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: createHookRegistry(),
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

/** A minimal Task fixture. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Do thing',
    prompt: 'implement feature X',
    profile: 'coder',
    files: [],
    dependencies: [],
    worktree: 'none',
    status: 'active',
    phaseId: 'code',
    ...overrides,
  };
}

/** A minimal BeforeTaskWorktreeArgs fixture. */
function makeBeforeArgs(taskOverrides: Partial<Task> = {}): BeforeTaskWorktreeArgs {
  return {
    task: makeTask(taskOverrides),
    // worktreeManager is typed `unknown` in the args — a stub is enough.
    worktreeManager: undefined,
  };
}

// Temp-directory tracking: each test that needs disk gets a fresh dir, cleaned
// up after every test. Mirrors the inlined helper in workflow.test.ts /
// prompt-context.test.ts so this co-located test stays self-contained.
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `wt-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

// ── createDefaultBeforeTaskWorktreeCreate ───────────────────────────────────

describe('createDefaultBeforeTaskWorktreeCreate', () => {
  it('returns a function (a FirstWinsHook)', () => {
    const hook = createDefaultBeforeTaskWorktreeCreate();
    expect(typeof hook).toBe('function');
  });

  it('is assignable to WorkflowHooks.beforeTaskWorktreeCreate (type-level + identity)', () => {
    const hook = createDefaultBeforeTaskWorktreeCreate();
    const hooks: WorkflowHooks = { beforeTaskWorktreeCreate: hook };
    expect(hooks.beforeTaskWorktreeCreate).toBe(hook);
  });

  it('returns undefined for a normal (non-read-only) task — does not skip isolation', async () => {
    const hook = createDefaultBeforeTaskWorktreeCreate();
    const result = await hook(makeBeforeArgs({ profile: 'coder' }), makeCtx());
    expect(result).toBeUndefined();
  });

  it("returns { skip: true } for a read-only 'scout' task by default (reproduces scouts-run-against-run-cwd)", async () => {
    // The default read-only profile set must include 'scout' so the legacy
    // behavior — scouts run against the run cwd directly, no worktree — is
    // preserved with zero configuration.
    const hook = createDefaultBeforeTaskWorktreeCreate();
    const result = await hook(makeBeforeArgs({ profile: 'scout' }), makeCtx());
    expect(result).toEqual({ skip: true });
  });

  it('returns { skip: true } (only skip set — no baseBranch / extraFiles)', async () => {
    const hook = createDefaultBeforeTaskWorktreeCreate(['scout']);
    const result = await hook(makeBeforeArgs({ profile: 'scout' }), makeCtx());
    expect(result).toEqual({ skip: true });
    // baseBranch / extraFiles are not populated by the default.
    expect(result?.baseBranch).toBeUndefined();
    expect(result?.extraFiles).toBeUndefined();
  });

  it('returns a non-undefined value for read-only tasks (wins in first-wins composition)', async () => {
    const hook = createDefaultBeforeTaskWorktreeCreate(['scout']);
    const result = await hook(makeBeforeArgs({ profile: 'scout' }), makeCtx());
    expect(result).toBeDefined();
  });

  it('honours an explicit read-only profile list (skips only listed profiles)', async () => {
    const hook = createDefaultBeforeTaskWorktreeCreate(['reviewer', 'reader']);
    // Listed profiles skip isolation.
    expect(await hook(makeBeforeArgs({ profile: 'reviewer' }), makeCtx())).toEqual({ skip: true });
    expect(await hook(makeBeforeArgs({ profile: 'reader' }), makeCtx())).toEqual({ skip: true });
    // Unlisted profiles do NOT skip isolation.
    expect(await hook(makeBeforeArgs({ profile: 'scout' }), makeCtx())).toBeUndefined();
    expect(await hook(makeBeforeArgs({ profile: 'coder' }), makeCtx())).toBeUndefined();
  });

  it('skips NOTHING when the read-only profile list is empty', async () => {
    // An explicit empty list means "no profile is read-only" — even 'scout'
    // must NOT be skipped. This proves the skip is driven by the list, not by
    // a hard-coded profile name check.
    const hook = createDefaultBeforeTaskWorktreeCreate([]);
    expect(await hook(makeBeforeArgs({ profile: 'scout' }), makeCtx())).toBeUndefined();
    expect(await hook(makeBeforeArgs({ profile: 'coder' }), makeCtx())).toBeUndefined();
  });

  it('case-sensitively matches the profile name', async () => {
    // Profile names are exact identifiers — 'Scout' (capital) is not the same
    // profile as 'scout'. The default must not fold case.
    const hook = createDefaultBeforeTaskWorktreeCreate(['scout']);
    expect(await hook(makeBeforeArgs({ profile: 'Scout' }), makeCtx())).toBeUndefined();
    expect(await hook(makeBeforeArgs({ profile: 'scout' }), makeCtx())).toEqual({ skip: true });
  });

  it('the decision is independent of the worktreeManager arg', async () => {
    // worktreeManager is opaque (unknown) to the default — the skip decision
    // is driven solely by task.profile.
    const hook = createDefaultBeforeTaskWorktreeCreate(['scout']);
    const a = await hook({ task: makeTask({ profile: 'scout' }), worktreeManager: undefined }, makeCtx());
    const b = await hook({ task: makeTask({ profile: 'scout' }), worktreeManager: { anything: true } }, makeCtx());
    expect(a).toEqual(b);
    expect(a).toEqual({ skip: true });
  });

  it('satisfies the BeforeTaskWorktreeResult type for the skip case', async () => {
    const hook = createDefaultBeforeTaskWorktreeCreate(['scout']);
    const result: BeforeTaskWorktreeResult | undefined = await hook(makeBeforeArgs({ profile: 'scout' }), makeCtx());
    // Type-level check compiles only when result is assignable; assert runtime too.
    expect(result?.skip).toBe(true);
  });
});

// ── createDefaultPopulateWorktree ───────────────────────────────────────────

describe('createDefaultPopulateWorktree', () => {
  it('returns a function (a PipelineHook<void, PopulateWorktreeArgs>)', () => {
    const hook = createDefaultPopulateWorktree('/some/source');
    expect(typeof hook).toBe('function');
  });

  it('is assignable to WorkflowHooks.populateWorktree (type-level + identity)', () => {
    const hook = createDefaultPopulateWorktree('/some/source');
    const hooks: WorkflowHooks = { populateWorktree: hook };
    expect(hooks.populateWorktree).toBe(hook);
  });

  it('calls populateWorktree(args.sourceCwd, args.worktreePath) — copies per .worktreecopy', async () => {
    // The high-value default: it delegates to the EXISTING core/git.ts
    // populateWorktree that reads `.worktreecopy` (copy + symlink). We verify
    // the delegation end-to-end against a real source dir + .worktreecopy.
    const source = makeTempDir();
    const target = makeTempDir();

    // Source layout: two .txt files + one .md file.
    writeFileSync(join(source, '.worktreecopy'), '*.txt\n');
    writeFileSync(join(source, 'a.txt'), 'aaa');
    writeFileSync(join(source, 'b.txt'), 'bbb');
    writeFileSync(join(source, 'c.md'), 'ccc');

    const hook = createDefaultPopulateWorktree(source);
    await hook(undefined, { worktreePath: target, sourceCwd: source }, makeCtx());

    expect(readFileSync(join(target, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(readFileSync(join(target, 'b.txt'), 'utf-8')).toBe('bbb');
    // c.md does not match *.txt — not copied.
    expect(existsSync(join(target, 'c.md'))).toBe(false);
  });

  it('reads sourceCwd from the invocation args (args.sourceCwd), not the factory-captured one', async () => {
    // Mirrors createDefaultOnRestore: the factory-captured sourceCwd is for
    // API symmetry, but the hook honors args.sourceCwd so an engine that
    // swaps source dirs at invoke time is respected. State lives in dirA;
    // the factory is handed dirB (no .worktreecopy). Invoking with
    // args.sourceCwd = dirA must populate from dirA.
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    const target = makeTempDir();

    writeFileSync(join(dirA, '.worktreecopy'), '*.txt\n');
    writeFileSync(join(dirA, 'only-in-a.txt'), 'from-dirA');
    // dirB has NO .worktreecopy and NO matching files.

    const hook = createDefaultPopulateWorktree(dirB);
    await hook(undefined, { worktreePath: target, sourceCwd: dirA }, makeCtx());

    expect(readFileSync(join(target, 'only-in-a.txt'), 'utf-8')).toBe('from-dirA');
  });

  it('is a no-op when sourceCwd has no .worktreecopy (empty entries → nothing copied)', async () => {
    // populateWorktree returns early when .worktreecopy is absent (empty
    // entries). The default must propagate that — not throw.
    const source = makeTempDir();
    const target = makeTempDir();
    writeFileSync(join(source, 'untracked.txt'), 'x'); // no .worktreecopy present

    const hook = createDefaultPopulateWorktree(source);
    const result = await hook(undefined, { worktreePath: target, sourceCwd: source }, makeCtx());
    expect(result).toBeUndefined();
    expect(existsSync(join(target, 'untracked.txt'))).toBe(false);
  });

  it('resolves to undefined (pipeline value is void)', async () => {
    const source = makeTempDir();
    const target = makeTempDir();
    writeFileSync(join(source, '.worktreecopy'), '*.txt\n');
    writeFileSync(join(source, 'a.txt'), 'a');

    const hook = createDefaultPopulateWorktree(source);
    const result = await hook(undefined, { worktreePath: target, sourceCwd: source }, makeCtx());
    expect(result).toBeUndefined();
  });

  it('passes the worktreePath through as the copy target', async () => {
    // Verify the second arg to populateWorktree is args.worktreePath by
    // checking the files land in exactly that directory.
    const source = makeTempDir();
    const target = makeTempDir();
    writeFileSync(join(source, '.worktreecopy'), 'payload.txt\n');
    writeFileSync(join(source, 'payload.txt'), 'P');

    const hook = createDefaultPopulateWorktree(source);
    await hook(undefined, { worktreePath: target, sourceCwd: source }, makeCtx());

    expect(readFileSync(join(target, 'payload.txt'), 'utf-8')).toBe('P');
  });
});

// ── defaultOnTaskMerge ──────────────────────────────────────────────────────

describe('defaultOnTaskMerge', () => {
  it('is a function (a FirstWinsHook)', () => {
    expect(typeof defaultOnTaskMerge).toBe('function');
  });

  it('is assignable to WorkflowHooks.onTaskMerge (type-level + identity)', () => {
    const hooks: WorkflowHooks = { onTaskMerge: defaultOnTaskMerge };
    expect(hooks.onTaskMerge).toBe(defaultOnTaskMerge);
  });

  it("returns the squash-merge decision { proceed: true, strategy: 'squash' }", async () => {
    const args: OnTaskMergeArgs = {
      task: makeTask(),
      worktreePath: '/wt',
      branch: 'engin/main--task-1',
    };
    const result = await defaultOnTaskMerge(args, makeCtx());
    expect(result).toEqual({ proceed: true, strategy: 'squash' });
  });

  it('returns a non-undefined value (wins in a first-wins composition)', async () => {
    const result = await defaultOnTaskMerge({ task: makeTask(), worktreePath: '/wt', branch: 'b' }, makeCtx());
    expect(result).toBeDefined();
  });

  it('returns the same decision regardless of the task / worktree / branch args', async () => {
    const a = await defaultOnTaskMerge(
      { task: makeTask({ id: 't1', profile: 'coder' }), worktreePath: '/wt-1', branch: 'engin/main--t1' },
      makeCtx(),
    );
    const b = await defaultOnTaskMerge(
      { task: makeTask({ id: 't2', profile: 'scout' }), worktreePath: '/wt-2', branch: 'engin/main--t2' },
      makeCtx(),
    );
    expect(a).toEqual(b);
    expect(a).toEqual({ proceed: true, strategy: 'squash' });
  });
});

// ── createDefaultOnMergeConflict ────────────────────────────────────────────

describe('createDefaultOnMergeConflict', () => {
  it('returns a function (a FirstWinsHook)', () => {
    const hook = createDefaultOnMergeConflict(['/profiles']);
    expect(typeof hook).toBe('function');
  });

  it('is assignable to WorkflowHooks.onMergeConflict (type-level + identity)', () => {
    const hook = createDefaultOnMergeConflict(['/profiles']);
    const hooks: WorkflowHooks = { onMergeConflict: hook };
    expect(hooks.onMergeConflict).toBe(hook);
  });

  it("returns the agent-resolution marker { strategy: 'agent' }", async () => {
    const hook = createDefaultOnMergeConflict(['/profiles']);
    const args: OnMergeConflictArgs = {
      task: makeTask(),
      conflicts: ['src/a.ts', 'src/b.ts'],
      worktreePath: '/wt',
      mainBranch: 'main',
    };
    const result = await hook(args, makeCtx());
    expect(result).toEqual({ strategy: 'agent' });
  });

  it('accepts an optional apiKeys map as the second factory argument', () => {
    // Type-level + runtime: the factory signature is (profilesDirs, apiKeys?).
    const hook = createDefaultOnMergeConflict(['/profiles'], { OPENAI_API_KEY: 'sk-test' });
    expect(typeof hook).toBe('function');
  });

  it('returns the agent marker regardless of conflict count / paths', async () => {
    const hook = createDefaultOnMergeConflict(['/profiles']);
    const withConflicts = await hook(
      { task: makeTask(), conflicts: ['a.ts'], worktreePath: '/w', mainBranch: 'main' },
      makeCtx(),
    );
    const empty = await hook({ task: makeTask(), conflicts: [], worktreePath: '/w', mainBranch: 'main' }, makeCtx());
    expect(withConflicts).toEqual({ strategy: 'agent' });
    expect(empty).toEqual({ strategy: 'agent' });
  });

  it('does not read conflict files or spawn an agent (pure delegation marker)', async () => {
    // The default returns ONLY the strategy marker; the actual agent-based
    // resolution is composed downstream (WorktreeManager calls
    // worktree-lifecycle.ts:resolveConflictsWithAgent, the tooled fix-up
    // primitive). Pointing worktreePath / profiles at non-existent paths must
    // NOT throw — if the default tried to resolve conflicts itself it would
    // attempt to read the (missing) conflict files and spawn a session.
    const hook = createDefaultOnMergeConflict(['/nonexistent-profiles']);
    const result = await hook(
      {
        task: makeTask(),
        conflicts: ['missing.ts'],
        worktreePath: '/nonexistent-wt',
        mainBranch: 'main',
      },
      makeCtx(),
    );
    expect(result).toEqual({ strategy: 'agent' });
    // The default returns ONLY the marker — no resolvedFiles (resolution happens
    // downstream via resolveConflictsWithAgent).
    expect(result?.resolvedFiles).toBeUndefined();
  });

  it('satisfies the ConflictResolution type for the agent marker', async () => {
    const hook = createDefaultOnMergeConflict(['/profiles']);
    const result: ConflictResolution | undefined = await hook(
      { task: makeTask(), conflicts: ['a.ts'], worktreePath: '/w', mainBranch: 'main' },
      makeCtx(),
    );
    expect(result?.strategy).toBe('agent');
  });
});

// ── createDefaultOnCommitFailure ────────────────────────────────────────────

describe('createDefaultOnCommitFailure', () => {
  it('returns a function (a FirstWinsHook)', () => {
    const hook = createDefaultOnCommitFailure(['/profiles']);
    expect(typeof hook).toBe('function');
  });

  it('is assignable to WorkflowHooks.onCommitFailure (type-level + identity)', () => {
    const hook = createDefaultOnCommitFailure(['/profiles']);
    const hooks: WorkflowHooks = { onCommitFailure: hook };
    expect(hooks.onCommitFailure).toBe(hook);
  });

  it("returns the agent-resolution marker { strategy: 'agent' }", async () => {
    const hook = createDefaultOnCommitFailure(['/profiles']);
    const args: OnCommitFailureArgs = {
      task: makeTask(),
      errors: ['error: lint failed (no-unused-vars)', 'error: pre-commit hook rejected'],
      worktreePath: '/wt',
    };
    const result = await hook(args, makeCtx());
    expect(result).toEqual({ strategy: 'agent' });
  });

  it('accepts an optional apiKeys map as the second factory argument', () => {
    const hook = createDefaultOnCommitFailure(['/profiles'], { ANTHROPIC_API_KEY: 'sk-test' });
    expect(typeof hook).toBe('function');
  });

  it('returns the agent marker regardless of error count / content', async () => {
    const hook = createDefaultOnCommitFailure(['/profiles']);
    const withErrors = await hook({ task: makeTask(), errors: ['lint fail'], worktreePath: '/w' }, makeCtx());
    const empty = await hook({ task: makeTask(), errors: [], worktreePath: '/w' }, makeCtx());
    expect(withErrors).toEqual({ strategy: 'agent' });
    expect(empty).toEqual({ strategy: 'agent' });
  });

  it('does not read files or spawn an agent (pure delegation marker)', async () => {
    // Like the merge-conflict default, the commit-failure default returns ONLY
    // the strategy marker — the actual tooled fix-up (lint repair / commit
    // retry) runs downstream. Pointing profiles / worktree at non-existent
    // paths must NOT throw.
    const hook = createDefaultOnCommitFailure(['/nonexistent-profiles']);
    const result = await hook({ task: makeTask(), errors: ['boom'], worktreePath: '/nonexistent-wt' }, makeCtx());
    expect(result).toEqual({ strategy: 'agent' });
    expect(result?.resolvedFiles).toBeUndefined();
  });

  it('satisfies the CommitFailureResolution type for the agent marker', async () => {
    const hook = createDefaultOnCommitFailure(['/profiles']);
    const result: CommitFailureResolution | undefined = await hook(
      { task: makeTask(), errors: ['lint'], worktreePath: '/w' },
      makeCtx(),
    );
    expect(result?.strategy).toBe('agent');
  });
});

// ── defaultAfterTaskWorktreeCreate ──────────────────────────────────────────

describe('defaultAfterTaskWorktreeCreate', () => {
  it('is a function (an ObserveHook)', () => {
    expect(typeof defaultAfterTaskWorktreeCreate).toBe('function');
  });

  it('is assignable to WorkflowHooks.afterTaskWorktreeCreate (type-level + identity)', () => {
    const hooks: WorkflowHooks = { afterTaskWorktreeCreate: defaultAfterTaskWorktreeCreate };
    expect(hooks.afterTaskWorktreeCreate).toBe(defaultAfterTaskWorktreeCreate);
  });

  it('is a no-op: resolves undefined and does not throw', async () => {
    const args: AfterTaskWorktreeArgs = {
      task: makeTask(),
      worktreePath: '/wt/task-1',
      branch: 'engin/main--task-1',
    };
    const result = await defaultAfterTaskWorktreeCreate(args, makeCtx());
    expect(result).toBeUndefined();
  });

  it('does not mutate the args or perform disk I/O', async () => {
    const args: AfterTaskWorktreeArgs = {
      task: makeTask({ id: 't-9' }),
      worktreePath: '/wt/t-9',
      branch: 'engin/main--t-9',
    };
    await defaultAfterTaskWorktreeCreate(args, makeCtx());
    expect(args.worktreePath).toBe('/wt/t-9');
    expect(args.branch).toBe('engin/main--t-9');
    expect(args.task.id).toBe('t-9');
  });

  it('performs no filesystem writes (worktree state stays internal to WorktreeManager)', async () => {
    // Per the preamble decision, the default after-create hook does NOT fire a
    // status event or write any state file yet — worktree state stays internal
    // to WorktreeManager. Assert no file is created in a temp worktree path.
    const wt = makeTempDir();
    const snapshot = (d: string, acc: string[] = []): string[] => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        acc.push(join(d, e.name));
        if (e.isDirectory()) snapshot(join(d, e.name), acc);
      }
      return acc;
    };
    const before = snapshot(wt);
    await defaultAfterTaskWorktreeCreate({ task: makeTask(), worktreePath: wt, branch: 'b' }, makeCtx());
    const after = snapshot(wt);
    expect(after).toEqual(before);
  });
});

// ── Defaults compose through the HookRegistry ───────────────────────────────
//
// These verify the defaults satisfy their declared composition rule when wired
// into a real HookRegistry (the engine's invocation path). `WorkflowHooks`
// already declares these fields, so the hook-name literals typecheck.

describe('defaults compose through the HookRegistry', () => {
  it('beforeTaskWorktreeCreate: scout task is skipped via invokeFirstWins', async () => {
    const reg = createHookRegistry();
    reg.defineHook('beforeTaskWorktreeCreate', 'first-wins');
    reg.register({ beforeTaskWorktreeCreate: createDefaultBeforeTaskWorktreeCreate() });

    const result = await reg.invokeFirstWins(
      'beforeTaskWorktreeCreate',
      makeBeforeArgs({ profile: 'scout' }),
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual({ skip: true });
  });

  it('beforeTaskWorktreeCreate: non-read-only task abstains (returns undefined)', async () => {
    const reg = createHookRegistry();
    reg.defineHook('beforeTaskWorktreeCreate', 'first-wins');
    reg.register({ beforeTaskWorktreeCreate: createDefaultBeforeTaskWorktreeCreate() });

    const result = await reg.invokeFirstWins(
      'beforeTaskWorktreeCreate',
      makeBeforeArgs({ profile: 'coder' }),
      makeCtx({ registry: reg }),
    );

    expect(result).toBeUndefined();
  });

  it('populateWorktree: default populates the worktree via invokePipeline', async () => {
    const source = makeTempDir();
    const target = makeTempDir();
    writeFileSync(join(source, '.worktreecopy'), '*.txt\n');
    writeFileSync(join(source, 'via-registry.txt'), 'rrr');

    const reg = createHookRegistry();
    reg.defineHook('populateWorktree', 'pipeline');
    reg.register({ populateWorktree: createDefaultPopulateWorktree(source) });

    const result = await reg.invokePipeline(
      'populateWorktree',
      undefined,
      { worktreePath: target, sourceCwd: source } satisfies PopulateWorktreeArgs,
      makeCtx({ registry: reg }),
    );

    expect(result).toBeUndefined();
    expect(readFileSync(join(target, 'via-registry.txt'), 'utf-8')).toBe('rrr');
  });

  it('onTaskMerge: default decision wins via invokeFirstWins', async () => {
    const reg = createHookRegistry();
    reg.defineHook('onTaskMerge', 'first-wins');
    reg.register({ onTaskMerge: defaultOnTaskMerge });

    const result = await reg.invokeFirstWins(
      'onTaskMerge',
      { task: makeTask(), worktreePath: '/wt', branch: 'b' },
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual({ proceed: true, strategy: 'squash' });
  });

  it('onMergeConflict: default marker wins via invokeFirstWins', async () => {
    const reg = createHookRegistry();
    reg.defineHook('onMergeConflict', 'first-wins');
    reg.register({ onMergeConflict: createDefaultOnMergeConflict(['/profiles']) });

    const result = await reg.invokeFirstWins(
      'onMergeConflict',
      { task: makeTask(), conflicts: ['a.ts'], worktreePath: '/wt', mainBranch: 'main' },
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual({ strategy: 'agent' });
  });

  it('onCommitFailure: default marker wins via invokeFirstWins', async () => {
    const reg = createHookRegistry();
    reg.defineHook('onCommitFailure', 'first-wins');
    reg.register({ onCommitFailure: createDefaultOnCommitFailure(['/profiles']) });

    const result = await reg.invokeFirstWins(
      'onCommitFailure',
      { task: makeTask(), errors: ['lint'], worktreePath: '/wt' },
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual({ strategy: 'agent' });
  });

  it('afterTaskWorktreeCreate: default is a no-op via invokeObserve', async () => {
    const reg = createHookRegistry();
    reg.defineHook('afterTaskWorktreeCreate', 'observe');
    reg.register({ afterTaskWorktreeCreate: defaultAfterTaskWorktreeCreate });

    await expect(
      reg.invokeObserve(
        'afterTaskWorktreeCreate',
        { task: makeTask(), worktreePath: '/wt', branch: 'b' },
        makeCtx({ registry: reg }),
      ),
    ).resolves.toBeUndefined();
  });

  it('first-wins: a workflow override registered before the default short-circuits it', async () => {
    // Proves the onTaskMerge default composes correctly: when a user hook is
    // registered BEFORE the default, first-wins honors the earlier subscriber.
    const reg = createHookRegistry();
    reg.defineHook('onTaskMerge', 'first-wins');
    reg.register({
      onTaskMerge: [async () => ({ proceed: false, strategy: 'merge' as const }), defaultOnTaskMerge],
    });

    const result = await reg.invokeFirstWins(
      'onTaskMerge',
      { task: makeTask(), worktreePath: '/wt', branch: 'b' },
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual({ proceed: false, strategy: 'merge' });
  });

  it('first-wins: an override can force-skip worktree creation ahead of the default', async () => {
    // A workflow override that forces a base branch / extra files wins over
    // the default's skip-scout behavior — proving the default abstains
    // correctly for tasks it doesn't recognize and yields to earlier hooks.
    const reg = createHookRegistry();
    reg.defineHook('beforeTaskWorktreeCreate', 'first-wins');
    reg.register({
      beforeTaskWorktreeCreate: [
        async () => ({ skip: false, baseBranch: 'engin/custom' }),
        createDefaultBeforeTaskWorktreeCreate(['scout']),
      ],
    });

    const result = await reg.invokeFirstWins(
      'beforeTaskWorktreeCreate',
      makeBeforeArgs({ profile: 'scout' }),
      makeCtx({ registry: reg }),
    );

    expect(result).toEqual({ skip: false, baseBranch: 'engin/custom' });
  });
});

// ── Defaults barrel (./index.js) ────────────────────────────────────────────
//
// The task requires "Export all. Add to packages/engine/src/hooks/defaults/
// index.ts." These pin that re-export so a consumer importing from the
// defaults barrel gets every worktree default. Accessed via a Record cast so
// the test is a pure runtime check.

describe('defaults barrel (./index.js)', () => {
  it('re-exports all six worktree defaults', () => {
    const barrel = defaultsBarrel as unknown as Record<string, unknown>;
    expect(typeof barrel.createDefaultBeforeTaskWorktreeCreate).toBe('function');
    expect(typeof barrel.createDefaultPopulateWorktree).toBe('function');
    expect(typeof barrel.defaultOnTaskMerge).toBe('function');
    expect(typeof barrel.createDefaultOnMergeConflict).toBe('function');
    expect(typeof barrel.createDefaultOnCommitFailure).toBe('function');
    expect(typeof barrel.defaultAfterTaskWorktreeCreate).toBe('function');
  });
});
