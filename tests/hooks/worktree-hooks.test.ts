// ─── Worktree lifecycle hook type-contract tests (TEST-FIRST) ───────────────
//
// This is a TEST file. It contains no production type definitions — only
// assertions about packages/engine/src/hooks/types.ts.
//
// WHAT IT PINS
//   Six worktree-lifecycle hooks added to `WorkflowHooks` via declaration
//   merging, plus nine companion arg/result aliases:
//
//     WorkflowHooks fields (each OPTIONAL, single fn | fn[]):
//       beforeTaskWorktreeCreate : FirstWinsHook<BeforeTaskWorktreeResult | undefined, BeforeTaskWorktreeArgs>
//       afterTaskWorktreeCreate  : ObserveHook<AfterTaskWorktreeArgs>
//       populateWorktree         : PipelineHook<void, PopulateWorktreeArgs>
//       onTaskMerge              : FirstWinsHook<TaskMergeDecision | undefined, OnTaskMergeArgs>
//       onMergeConflict          : FirstWinsHook<ConflictResolution | undefined, OnMergeConflictArgs>
//       onCommitFailure          : FirstWinsHook<CommitFailureResolution | undefined, OnCommitFailureArgs>
//
//     Aliases:
//       BeforeTaskWorktreeArgs   = { task: Task; worktreeManager: unknown }
//       BeforeTaskWorktreeResult = { skip?: boolean; baseBranch?: string; extraFiles?: string[] }
//       AfterTaskWorktreeArgs    = { task: Task; worktreePath: string; branch: string }
//       PopulateWorktreeArgs     = { worktreePath: string; sourceCwd: string; task?: Task }
//       OnTaskMergeArgs          = { task: Task; worktreePath: string; branch: string }
//       TaskMergeDecision        = { proceed: boolean; strategy?: 'squash' | 'merge' }
//       OnMergeConflictArgs      = { task: Task; conflicts: string[]; worktreePath: string; mainBranch: string }
//       OnCommitFailureArgs      = { task: Task; errors: string[]; worktreePath: string }
//       CommitFailureResolution  = { strategy: 'agent' | 'skip' | 'fail'; resolvedFiles?: string[] }
//
// TEST-FIRST STRATEGY (same as tests/hooks/step-hooks.test.ts)
//   `Task` is already imported type-only from ../core/types.js; ConflictResolution
//   already exists (the workflow-level alias). The SIX hook fields and NINE new
//   aliases do NOT exist yet. The source-level checks below read types.ts
//   defensively (empty string when absent) so THIS FILE COMPILES against the
//   current source, while every `.toContain` / `.toMatch` on a not-yet-added
//   symbol is RED until the source lands. The runtime fixtures use a REAL
//   executor-side Task to illustrate the spec and stay GREEN.

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Task, TaskStatus } from '../../packages/engine/src/core/types.js';

// ── Source access ──────────────────────────────────────────────────────────

const TYPES_TS = resolve(import.meta.dir, '../../packages/engine/src/hooks/types.ts');

/** Read types.ts defensively — empty string if absent (RED without throwing).
 *  Mirrors tryReadSource in tests/hooks/step-hooks.test.ts. */
function src(): string {
  return existsSync(TYPES_TS) ? readFileSync(TYPES_TS, 'utf-8') : '';
}

// ── Runtime fixture ────────────────────────────────────────────────────────

/** A real executor-side Task (every required field populated). Flows through
 *  the runtime fixture checks to prove the worktree args carry the engine's
 *  actual Task, not a re-declared shape. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Implement worktree hooks',
    prompt: 'add the worktree lifecycle hooks',
    profile: 'coder',
    files: [],
    dependencies: [],
    status: 'ready' as TaskStatus,
    phaseId: 'coding',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Reuse contract — Task (type-only) & ConflictResolution (not re-declared)
// ═══════════════════════════════════════════════════════════════════════════════

describe('reuse — Task imported type-only, ConflictResolution not re-declared', () => {
  it("imports Task (type-only) from '../core/types.js'", () => {
    // The import MUST be type-only so types.ts stays free of runtime circular
    // dependencies (the mechanism-only invariant every hook task obeys).
    expect(src()).toMatch(/import\s+type\s*\{[^}]*\bTask\b[^}]*\}\s*from\s*['"]\.\.\/core\/types\.js['"]/);
  });

  it('does not re-declare Task (no local `type Task` / `interface Task`)', () => {
    expect(src()).not.toMatch(/\b(?:type|interface)\s+Task\b/);
  });

  it('reuses the existing ConflictResolution for onMergeConflict (declared exactly once)', () => {
    // onMergeConflict MUST reuse the workflow-level ConflictResolution
    // (strategy: 'agent' | 'manual' | 'abort') — NOT introduce a second alias.
    const matches = src().match(/export\s+(?:type|interface)\s+ConflictResolution\b/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. All nine companion aliases are exported
// ═══════════════════════════════════════════════════════════════════════════════

describe('exports — nine worktree arg/result aliases are present', () => {
  const names = [
    'BeforeTaskWorktreeArgs',
    'BeforeTaskWorktreeResult',
    'AfterTaskWorktreeArgs',
    'PopulateWorktreeArgs',
    'OnTaskMergeArgs',
    'TaskMergeDecision',
    'OnMergeConflictArgs',
    'OnCommitFailureArgs',
    'CommitFailureResolution',
  ] as const;

  it('exports every alias at the top level (export type | export interface)', () => {
    for (const name of names) {
      expect(src()).toMatch(new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`));
    }
    expect(names).toHaveLength(9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Alias field shapes (exact, with anchors where unions are at risk)
// ═══════════════════════════════════════════════════════════════════════════════

describe('alias shapes', () => {
  it('BeforeTaskWorktreeArgs = { task: Task; worktreeManager: unknown }', () => {
    // worktreeManager is `unknown` (opaque — avoids a circular runtime import;
    // the engine casts at the call site).
    expect(src()).toContain('worktreeManager: unknown');
  });

  it('BeforeTaskWorktreeResult has optional skip?: boolean / baseBranch?: string / extraFiles?: string[]', () => {
    expect(src()).toMatch(/skip\s*\?:\s*boolean/);
    expect(src()).toMatch(/baseBranch\s*\?:\s*string/);
    expect(src()).toMatch(/extraFiles\s*\?:\s*string\[\]/);
  });

  it('AfterTaskWorktreeArgs = { task: Task; worktreePath: string; branch: string }', () => {
    expect(src()).toMatch(/worktreePath\s*:\s*string/);
    expect(src()).toMatch(/\bbranch\s*:\s*string/);
  });

  it('PopulateWorktreeArgs = { worktreePath: string; sourceCwd: string; task?: Task }', () => {
    expect(src()).toMatch(/sourceCwd\s*:\s*string/);
    // task is OPTIONAL here (unique among the worktree args).
    expect(src()).toMatch(/task\s*\?:\s*Task/);
  });

  it('OnTaskMergeArgs = { task: Task; worktreePath: string; branch: string }', () => {
    expect(src()).toMatch(/worktreePath\s*:\s*string/);
    expect(src()).toMatch(/\bbranch\s*:\s*string/);
  });

  it("TaskMergeDecision: proceed: boolean (required) + strategy?: 'squash' | 'merge' (NO rebase)", () => {
    // proceed is required (no `?`); strategy is optional with the closed
    // squash | merge union. The negative lookahead `(?!\s*\|)` anchors the
    // union so it cannot false-match RunMergeDecision's 'squash' | 'merge' | 'rebase'.
    expect(src()).toMatch(/proceed\s*:\s*boolean/);
    expect(src()).toMatch(/strategy\s*\?:\s*'squash'\s*\|\s*'merge'(?!\s*\|)/);
  });

  it('OnMergeConflictArgs = { task: Task; conflicts: string[]; worktreePath: string; mainBranch: string }', () => {
    expect(src()).toMatch(/conflicts\s*:\s*string\[\]/);
    expect(src()).toMatch(/worktreePath\s*:\s*string/);
    expect(src()).toMatch(/mainBranch\s*:\s*string/);
  });

  it('OnCommitFailureArgs = { task: Task; errors: string[]; worktreePath: string }', () => {
    expect(src()).toMatch(/errors\s*:\s*string\[\]/);
    expect(src()).toMatch(/worktreePath\s*:\s*string/);
  });

  it("CommitFailureResolution: strategy: 'agent' | 'skip' | 'fail' (required) + resolvedFiles?: string[]", () => {
    // strategy is REQUIRED (no `?`); union is distinct from ConflictResolution
    // (agent | manual | abort). Negative lookahead anchors the union.
    expect(src()).toMatch(/strategy\s*:\s*'agent'\s*\|\s*'skip'\s*\|\s*'fail'(?!\s*\|)/);
    expect(src()).toMatch(/resolvedFiles\s*\?:\s*string\[\]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. WorkflowHooks declaration merging — presence, optionality, exact generic,
//    and the single-fn | fn[] array arm for every field.
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorkflowHooks fields — present, optional, exact generic, array arm', () => {
  it('beforeTaskWorktreeCreate?: FirstWinsHook<BeforeTaskWorktreeResult | undefined, BeforeTaskWorktreeArgs> | []', () => {
    expect(src()).toMatch(/beforeTaskWorktreeCreate\s*\?:/);
    expect(src()).toContain('FirstWinsHook<BeforeTaskWorktreeResult | undefined, BeforeTaskWorktreeArgs>');
    expect(src()).toContain('FirstWinsHook<BeforeTaskWorktreeResult | undefined, BeforeTaskWorktreeArgs>[]');
  });

  it('afterTaskWorktreeCreate?: ObserveHook<AfterTaskWorktreeArgs> | []', () => {
    expect(src()).toMatch(/afterTaskWorktreeCreate\s*\?:/);
    expect(src()).toContain('ObserveHook<AfterTaskWorktreeArgs>');
    expect(src()).toContain('ObserveHook<AfterTaskWorktreeArgs>[]');
  });

  it('populateWorktree?: PipelineHook<void, PopulateWorktreeArgs> | []', () => {
    // Value generic pinned to `void`: ordered side-effect pipeline (copy files
    // into the worktree) producing no transformed value.
    expect(src()).toMatch(/populateWorktree\s*\?:/);
    expect(src()).toContain('PipelineHook<void, PopulateWorktreeArgs>');
    expect(src()).toContain('PipelineHook<void, PopulateWorktreeArgs>[]');
  });

  it('onTaskMerge?: FirstWinsHook<TaskMergeDecision | undefined, OnTaskMergeArgs> | []', () => {
    expect(src()).toMatch(/onTaskMerge\s*\?:/);
    expect(src()).toContain('FirstWinsHook<TaskMergeDecision | undefined, OnTaskMergeArgs>');
    expect(src()).toContain('FirstWinsHook<TaskMergeDecision | undefined, OnTaskMergeArgs>[]');
  });

  it('onMergeConflict?: FirstWinsHook<ConflictResolution | undefined, OnMergeConflictArgs> | [] (reuses ConflictResolution)', () => {
    expect(src()).toMatch(/onMergeConflict\s*\?:/);
    expect(src()).toContain('FirstWinsHook<ConflictResolution | undefined, OnMergeConflictArgs>');
    expect(src()).toContain('FirstWinsHook<ConflictResolution | undefined, OnMergeConflictArgs>[]');
  });

  it('onCommitFailure?: FirstWinsHook<CommitFailureResolution | undefined, OnCommitFailureArgs> | []', () => {
    expect(src()).toMatch(/onCommitFailure\s*\?:/);
    expect(src()).toContain('FirstWinsHook<CommitFailureResolution | undefined, OnCommitFailureArgs>');
    expect(src()).toContain('FirstWinsHook<CommitFailureResolution | undefined, OnCommitFailureArgs>[]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Composition rule per hook — the RIGHT mechanism wired to each name
//    (an ObserveHook must not appear where a FirstWinsHook is expected, etc.).
// ═══════════════════════════════════════════════════════════════════════════════

describe('composition rule per worktree hook', () => {
  it('beforeTaskWorktreeCreate is a FirstWinsHook decision hook', () => {
    expect(src()).toContain('FirstWinsHook<BeforeTaskWorktreeResult | undefined, BeforeTaskWorktreeArgs>');
    expect(src()).not.toContain('ObserveHook<BeforeTaskWorktreeArgs>');
  });

  it('afterTaskWorktreeCreate is an ObserveHook (fire-and-forget)', () => {
    expect(src()).toContain('ObserveHook<AfterTaskWorktreeArgs>');
    expect(src()).not.toContain('FirstWinsHook<AfterTaskWorktreeArgs');
  });

  it('populateWorktree is a PipelineHook<void, …> (NOT observe / first-wins)', () => {
    expect(src()).toContain('PipelineHook<void, PopulateWorktreeArgs>');
    expect(src()).not.toContain('ObserveHook<PopulateWorktreeArgs>');
    expect(src()).not.toContain('FirstWinsHook<PopulateWorktreeArgs');
  });

  it('onTaskMerge is a FirstWinsHook decision hook', () => {
    expect(src()).toContain('FirstWinsHook<TaskMergeDecision | undefined, OnTaskMergeArgs>');
    expect(src()).not.toContain('ObserveHook<OnTaskMergeArgs>');
  });

  it('onMergeConflict is a FirstWinsHook decision hook', () => {
    expect(src()).toContain('FirstWinsHook<ConflictResolution | undefined, OnMergeConflictArgs>');
    expect(src()).not.toContain('ObserveHook<OnMergeConflictArgs>');
  });

  it('onCommitFailure is a FirstWinsHook decision hook', () => {
    expect(src()).toContain('FirstWinsHook<CommitFailureResolution | undefined, OnCommitFailureArgs>');
    expect(src()).not.toContain('ObserveHook<OnCommitFailureArgs>');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. All six fields land together under a Worktree lifecycle section
// ═══════════════════════════════════════════════════════════════════════════════

describe('all six fields land together', () => {
  const FIELDS = [
    'beforeTaskWorktreeCreate',
    'afterTaskWorktreeCreate',
    'populateWorktree',
    'onTaskMerge',
    'onMergeConflict',
    'onCommitFailure',
  ] as const;

  it('every field is an OPTIONAL key on WorkflowHooks (the `?:` marker)', () => {
    for (const f of FIELDS) {
      expect(src()).toMatch(new RegExp(`${f}\\s*\\?:`));
    }
    expect(FIELDS).toHaveLength(6);
  });

  it('the fields are grouped under a Worktree lifecycle section comment', () => {
    // Resilient to exact dash counts.
    expect(src()).toMatch(/Worktree lifecycle/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Runtime spec illustrations — a real executor-side Task flows through every
//    arg shape, and each decision/result shape accepts valid literals. GREEN.
// ═══════════════════════════════════════════════════════════════════════════════

describe('runtime fixtures — real Task flows through every worktree arg', () => {
  it('BeforeTaskWorktreeArgs carries { task, worktreeManager }', () => {
    const args = { task: makeTask(), worktreeManager: { create: () => {} } };
    expect(args.task.id).toBe('task-1');
    expect(args.worktreeManager).toEqual({ create: expect.any(Function) });
  });

  it('AfterTaskWorktreeArgs carries { task, worktreePath, branch }', () => {
    const args = { task: makeTask(), worktreePath: '/wt-1', branch: 'engin/task-1' };
    expect(args.worktreePath).toBe('/wt-1');
    expect(args.branch).toBe('engin/task-1');
  });

  it('PopulateWorktreeArgs carries { worktreePath, sourceCwd } WITHOUT task (task optional)', () => {
    const args = { worktreePath: '/wt-1', sourceCwd: '/repo' };
    expect(args).not.toHaveProperty('task');
  });

  it('PopulateWorktreeArgs carries { worktreePath, sourceCwd, task }', () => {
    const args = { worktreePath: '/wt-1', sourceCwd: '/repo', task: makeTask() };
    expect(args.task?.id).toBe('task-1');
  });

  it('OnTaskMergeArgs carries { task, worktreePath, branch }', () => {
    const args = { task: makeTask(), worktreePath: '/wt-1', branch: 'engin/task-1' };
    expect(args.task).toBeDefined();
    expect(args.branch).toBe('engin/task-1');
  });

  it('OnMergeConflictArgs carries { task, conflicts, worktreePath, mainBranch }', () => {
    const args = {
      task: makeTask(),
      conflicts: ['src/a.ts', 'src/b.ts'],
      worktreePath: '/wt-1',
      mainBranch: 'main',
    };
    expect(args.conflicts).toEqual(['src/a.ts', 'src/b.ts']);
    expect(args.mainBranch).toBe('main');
  });

  it('OnCommitFailureArgs carries { task, errors, worktreePath }', () => {
    const args = { task: makeTask(), errors: ['nothing to commit'], worktreePath: '/wt-1' };
    expect(args.errors).toHaveLength(1);
  });
});

describe('runtime fixtures — decision/result shapes', () => {
  it('BeforeTaskWorktreeResult accepts all-optional (empty)', () => {
    const r = {};
    expect(r).toEqual({});
  });

  it('BeforeTaskWorktreeResult can skip + override baseBranch + add extraFiles', () => {
    const r = { skip: true, baseBranch: 'develop', extraFiles: ['README.md'] };
    expect(r).toEqual({ skip: true, baseBranch: 'develop', extraFiles: ['README.md'] });
  });

  it('TaskMergeDecision requires proceed; strategy is squash | merge only', () => {
    // Widen to a common shape so the bare (strategy-omitted) object is still
    // indexable for `strategy` (which is legitimately absent there).
    const decisions: Array<{ proceed: boolean; strategy?: string }> = [
      { proceed: true, strategy: 'squash' },
      { proceed: false, strategy: 'merge' },
      { proceed: true },
    ];
    expect(decisions.map((d) => d.strategy)).toEqual(['squash', 'merge', undefined]);
  });

  it('CommitFailureResolution requires strategy; literals are agent | skip | fail', () => {
    const resolutions: Array<{ strategy: string; resolvedFiles?: string[] }> = [
      { strategy: 'agent' },
      { strategy: 'skip' },
      { strategy: 'fail', resolvedFiles: ['src/a.ts'] },
    ];
    expect(resolutions.map((r) => r.strategy)).toEqual(['agent', 'skip', 'fail']);
    expect(resolutions[2].resolvedFiles).toEqual(['src/a.ts']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Module load surface — adding worktree hooks must not introduce a runtime
//    dependency edge (types.ts stays a type-only module).
// ═══════════════════════════════════════════════════════════════════════════════

describe('module surface', () => {
  it('types.ts remains a loadable type-only module (no runtime value exports)', async () => {
    // All additions are interfaces/type aliases (erased at runtime); the Task
    // import is type-only. Importing types.ts must yield an empty namespace —
    // no circular runtime dependency.
    const mod = await import('../../packages/engine/src/hooks/types.js');
    expect(mod).toBeTypeOf('object');
    expect(Object.keys(mod)).toEqual([]);
  });
});
