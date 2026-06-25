// ─── WorktreeManager ─────────────────────────────────────────────────────────
//
// WorktreeManager is the SOLE owner of main worktree creation and the central
// orchestrator for the per-task worktree feature. It owns:
//
//   • the MAIN worktree (the `engin/{mainSlug}` branch checked out at
//     `{workDir}/worktree`, populated from `.worktreecopy`), AND
//   • the per-task worktree lifecycle (one worktree per concurrent task,
//     branched off the main-wt branch so each task inherits already-merged
//     sibling work), AND
//   • git-lock serialization — every shared-state git operation (main-worktree
//     index/HEAD, repo refs, the worktree list) is routed through a single
//     `gitLock` mutex (`withGitLock`) so concurrent tasks never interleave git
//     commands that touch the same refs / worktree. Per-task-worktree-local
//     commits are NOT routed through here: they operate on isolated git
//     worktrees (separate index/HEAD files) and don't contend.
//
// No other code should call `createWorktree` for the main worktree — they
// must go through `worktreeManager.setupMainWorktree()`.
//
// The final run-end merge into real `main` (and its conflict resolution /
// abort UX) is also owned here via `finalMergeToMain` /
// `resolveFinalMergeConflicts` / `abortFinalMerge`.

import { join } from 'node:path';

import type {
  BeforeTaskWorktreeResult,
  CommitFailureResolution,
  ConflictResolution,
  HookContext,
  HookRegistry,
  TaskMergeDecision,
} from '../hooks/types.js';
import { assertSafeName } from '../pool/validation.js';
import {
  abortMerge,
  checkoutBranch,
  cleanUntracked,
  commitChanges,
  createWorktree,
  deleteBranchForce,
  getCurrentBranch,
  getMainBranch,
  removeWorktree,
  resetHard,
  restoreSavedBranch,
  squashMergeBranch,
  stageAll,
  stageFiles,
  worktreePrune,
} from './git.js';
import type { Task, WorktreeInfo } from './types.js';
import { runTooledFixup } from './worktree-fixup.js';
import { resolveConflictsWithAgent } from './worktree-lifecycle.js';
import { commitWorktreeChanges } from './worktree-operations.js';
import { populateWorktree } from './worktree-populate.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorktreeManagerOptions {
  /** Absolute path to the real git repository root. */
  repoRoot: string;
  /** Original cwd (where `.worktreecopy` lives). */
  sourceCwd: string;
  /** Run dir (`.engin/work/{run-id}/`) — parent of the main + task worktrees. */
  workDir: string;
  /** The main-wt branch name (`engin/{mainSlug}`). Provided by the caller. */
  mainBranch: string;
  /** Absolute path to the main worktree (`{workDir}/worktree`). */
  mainWorktreePath: string;
  /** Profile directories for agent-based commit/conflict operations. */
  profilesDirs: string[];
  /** API keys for agent operations. */
  apiKeys?: Record<string, string>;
  /**
   * Optional hook registry for the worktree-lifecycle hooks
   * (`populateWorktree`, `beforeTaskWorktreeCreate`, `onTaskMerge`, …). When
   * ABSENT, every method behaves EXACTLY as today — direct calls to
   * `populateWorktree`, `resolveConflictsWithAgent`, etc. (backward compat).
   * When PRESENT, the methods invoke the corresponding hooks, falling back
   * to the direct calls only when a hook abstains. The engine (run-executor)
   * registers the DEFAULT implementations into this registry alongside any
   * workflow-provided subscribers.
   */
  hookRegistry?: HookRegistry;
}

export interface TaskWorktreeInfo {
  /** Absolute path to the per-task worktree directory. */
  path: string;
  /** The per-task branch name (`engin/{mainSlug}--{taskId}`). */
  branch: string;
  /** Lifecycle status of the task worktree. */
  status: 'active' | 'merged' | 'culled';
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * The `engin/` ref namespace prefix used for both the main-wt branch and the
 * per-task branches.
 */
const ENGIN_PREFIX = 'engin/';

/**
 * The flat separator between the main slug and the task id in a per-task
 * branch name. MUST be `--` (never `/`) so the per-task branch
 * `engin/{mainSlug}--{taskId}` does not collide with the main-wt branch's
 * `engin/{mainSlug}` ref/file duality (git represents `engin/foo` both as a
 * ref and as the file `.git/refs/heads/engin/foo`; a deeper path would
 * conflict with the directory vs. file invariant).
 */
const TASK_SEPARATOR = '--';

// ─── WorktreeManager ────────────────────────────────────────────────────────

export class WorktreeManager {
  readonly mainBranch: string;
  readonly mainWorktreePath: string;
  readonly repoRoot: string;
  readonly sourceCwd: string;

  private readonly workDir: string;
  private readonly profilesDirs: string[];
  private readonly apiKeys?: Record<string, string>;
  /** Threaded hook registry; `undefined` on the backward-compat path. */
  private readonly hookRegistry?: HookRegistry;

  /** taskId → TaskWorktreeInfo, for all per-task worktrees ever created. */
  private readonly taskWorktrees = new Map<string, TaskWorktreeInfo>();
  /** taskId → taskPrompt, stored at creation time for use during merge. */
  private readonly taskPrompts = new Map<string, string>();
  /** taskId → Task, stored at creation time so the merge / conflict hooks
   *  receive the full task object. When `createTaskWorktree` was called
   *  without a Task (backward compat), a minimal Task is synthesized. */
  private readonly taskTasks = new Map<string, Task>();
  /** taskId set for tasks whose `beforeTaskWorktreeCreate` hook returned
   *  `{ skip: true }` (they run against the main worktree directly — no
   *  isolated branch). `mergeTaskBranch` / `cullTaskWorktree` short-circuit
   *  for these (there is no branch to merge or remove). */
  private readonly skippedTasks = new Set<string>();

  /**
   * Single shared-state git mutex. Every operation that touches the main
   * worktree's index/HEAD, the repo's refs, or the worktree list is chained
   * onto this promise via {@link withGitLock} so concurrent task lanes never
   * interleave those git commands. The chain ALWAYS resolves (a failed op is
   * swallowed when advancing the chain) so one failure never poisons the next;
   * the ORIGINAL promise is returned to the caller so it can observe the error.
   *
   * Per-task-worktree-local commits (`commitWorktreeChanges` on the task's own
   * `info.path`) are intentionally NOT routed through this lock — they run on
   * isolated git worktrees and stay parallel.
   */
  private gitLock: Promise<unknown> = Promise.resolve();

  /**
   * The branch that was checked out in `repoRoot` when {@link finalMergeToMain}
   * began. Captured as an instance field (rather than a local) so it survives
   * across the conflict → resolve flow (where `resolveFinalMergeConflicts` runs
   * in a separate call and the local would be out of scope) and can be restored
   * by {@link cleanup}.
   */
  private savedBranch?: string;

  constructor(opts: WorktreeManagerOptions) {
    this.repoRoot = opts.repoRoot;
    this.sourceCwd = opts.sourceCwd;
    this.workDir = opts.workDir;
    this.mainBranch = opts.mainBranch;
    this.mainWorktreePath = opts.mainWorktreePath;
    this.profilesDirs = opts.profilesDirs;
    this.apiKeys = opts.apiKeys;
    this.hookRegistry = opts.hookRegistry;
  }

  // ─── Git Lock ─────────────────────────────────────────────────────────────

  /**
   * Serialize a shared-state git operation so concurrent task lanes never
   * interleave git commands that touch the same refs / main-worktree index /
   * worktree list.
   *
   * `fn` is chained onto {@link gitLock}: it runs only after every previously
   * chained op has settled. The chain is advanced with a swallowing `.then` so
   * a failed op NEVER poisons the next (the chain always resolves); the
   * ORIGINAL `fn` promise is returned so the caller can observe the failure.
   *
   * Callers MUST NOT invoke another `withGitLock`-protected method from inside
   * `fn` — the lock is NOT re-entrant and doing so deadlocks. The shared-state
   * methods below are written so their critical sections are self-contained
   * (they call git primitives directly, not other locked methods).
   */
  private withGitLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gitLock.then(fn);
    this.gitLock = run.then(
      () => undefined,
      (err) => {
        console.warn(
          '[WorktreeManager] git op failed (lock chain continues):',
          err instanceof Error ? err.message : err,
        );
        return undefined;
      },
    );
    return run;
  }

  /**
   * Roll the SHARED main worktree back to a clean `HEAD` after a failed merge
   * commit. A successful `git merge --squash` stages the merged changes; a
   * subsequent commit failure (e.g. a pre-commit/lint hook rejection) would
   * otherwise leave those changes staged in the shared worktree, corrupting
   * the NEXT task's merge. This aborts any in-progress merge (a no-op when the
   * squash left none) and hard-resets the index + working tree to `HEAD`.
   *
   * Best-effort: every step is independently swallowed + warned so a rollback
   * failure never masks the original commit error. Call from inside a
   * `withGitLock` critical section so the reset cannot race another op.
   */
  private safeResetMainWorktree(): void {
    try {
      abortMerge(this.mainWorktreePath);
    } catch {
      // No merge in progress — git merge --abort then errors. Expected; not warned.
    }
    try {
      resetHard(this.mainWorktreePath);
    } catch (err) {
      console.warn(
        '[WorktreeManager] resetHard failed after merge-commit failure (main worktree may be dirty):',
        err instanceof Error ? err.message : err,
      );
    }
    try {
      cleanUntracked(this.mainWorktreePath);
    } catch (err) {
      console.warn(
        '[WorktreeManager] clean -fd failed after merge-commit failure:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Commit a squash-merge in the SHARED main worktree, retrying ONCE through a
   * tooled fix-up agent when the pre-commit / lint hook rejects the commit.
   *
   * `git merge --squash` stages the merged changes but does NOT commit; the
   * subsequent `git commit` runs the repo's real pre-commit hook
   * (lint-staged → oxlint/eslint), which can reject a just-merged file for a
   * lint error. Rather than fail the whole task — whose own work is already
   * approved — repair the error IN PLACE at the merge: spawn the tooled fix-up
   * agent against the main worktree, re-stage, and retry the commit through
   * the REAL hook (never `--no-verify`). Mirrors the safety net in
   * {@link commitWorktreeChanges}.
   *
   * Runs INSIDE the caller's `withGitLock` critical section — the lock is held
   * across the fix-up so no other task can merge into the main worktree while
   * the agent edits it. The fix-up agent does not call back into WorktreeManager
   * (it operates via its own tools), so there is no re-entrant lock.
   *
   * On exhaustion (fix-up fails OR the retry commit also throws): roll the
   * shared worktree back to a clean HEAD ({@link safeResetMainWorktree}) and
   * re-throw the ORIGINAL commit error. The caller (lane-pool) treats a merge
   * failure as non-retriable and PRESERVES the task worktree, so the approved
   * work is never thrown away or re-run from step 1.
   */
  private async commitMergeWithRetry(message: string, taskPrompt: string): Promise<void> {
    try {
      commitChanges(this.mainWorktreePath, message);
      return;
    } catch (commitError) {
      const errorContext = commitError instanceof Error ? commitError.message : String(commitError);
      const fixupResult = await runTooledFixup({
        profilesDirs: this.profilesDirs,
        worktreePath: this.mainWorktreePath,
        taskPrompt,
        errorContext,
        apiKeys: this.apiKeys,
      });
      if (!fixupResult.success) {
        this.safeResetMainWorktree();
        throw commitError;
      }
      // Re-stage the squash + the fix-up's edits, then retry through the real hook.
      stageAll(this.mainWorktreePath);
      try {
        commitChanges(this.mainWorktreePath, message);
      } catch {
        this.safeResetMainWorktree();
        throw commitError;
      }
    }
  }

  // ─── Main Worktree (SOLE CREATOR) ─────────────────────────────────────────

  /**
   * THE SOLE CREATOR of the main worktree. No other code should call
   * `createWorktree` for the main worktree.
   *
   * 1. Prunes orphaned worktree metadata left by crashed runs.
   * 2. Creates the main worktree at `mainWorktreePath` on `mainBranch`.
   * 3. Populates it via the `populateWorktree` pipeline hook (when a
   *    `hookRegistry` is configured) or the direct `.worktreecopy` primitive
   *    (backward compat).
   *
   * The branch name is NOT generated here — the caller provides `mainBranch`
   * in the constructor (from `generateTitleAndBranch`).
   */
  async setupMainWorktree(): Promise<void> {
    // 1. Sweep orphans from crashed runs before adding new worktree metadata,
    //    and create the main worktree — both touch the repo's worktree list /
    //    refs, so they run inside the git lock. Populate (fs/copy, possibly a
    //    `bun install` hook) stays OUTSIDE the lock so a slow install never
    //    blocks concurrent task lanes (at startup there are none yet, but the
    //    lock invariant is honored regardless).
    await this.withGitLock(async () => {
      worktreePrune(this.repoRoot);
      // Create the main worktree on the engin/{mainSlug} branch, checked out
      // from the real repo's current HEAD/main.
      createWorktree(this.repoRoot, this.mainBranch, this.mainWorktreePath);
    });

    // 2. Populate via the hook pipeline (default delegates to the
    //    `.worktreecopy` primitive) or the direct primitive (backward compat).
    //    No task context for the MAIN worktree — `task` is undefined.
    await this.invokePopulate(this.mainWorktreePath);
  }

  /**
   * Populates a worktree either via the `populateWorktree` pipeline hook
   * (when a `hookRegistry` is configured) or via the direct
   * `core/git.ts::populateWorktree` primitive (backward compat). The default
   * (registered by run-executor) delegates to the same primitive, so the
   * behavior is identical when no workflow override is present; a workflow
   * override can chain additional work (e.g. `bun install`) via pipeline
   * fan-out.
   *
   * `task` is forwarded to the hook args so a workflow's `populateWorktree`
   * subscriber can branch on the task (e.g. install different dependencies
   * per task profile). It is `undefined` for the MAIN worktree
   * (setupMainWorktree has no task context) — the property is OMITTED from
   * the args object so `args.task` reads as `undefined`.
   */
  private async invokePopulate(worktreePath: string, task?: Task): Promise<void> {
    if (this.hookRegistry) {
      await this.hookRegistry.invokePipeline(
        'populateWorktree',
        undefined,
        { worktreePath, sourceCwd: this.sourceCwd, ...(task ? { task } : {}) },
        this.makeHookCtx(),
      );
    } else {
      populateWorktree(this.sourceCwd, worktreePath);
    }
  }

  /**
   * Builds the {@link HookContext} for worktree-lifecycle hook invocations.
   * `cwd` is the original source cwd (the user's repo), `workDir` is the run
   * dir, and `registry` is the threaded hook registry. `signal` is left
   * undefined — the WorktreeManager does not own an abort signal; callers
   * that need cancellation cooperate via the run-level signal elsewhere.
   */
  private makeHookCtx(): HookContext {
    // Every caller is inside an `if (this.hookRegistry)` guard, so the
    // registry is always defined here. The throw makes that precondition
    // explicit and narrows the type without a non-null assertion.
    if (!this.hookRegistry) throw new Error('makeHookCtx called without a hookRegistry');
    return {
      registry: this.hookRegistry,
      cwd: this.sourceCwd,
      workDir: this.workDir,
    };
  }

  // ─── Per-Task Worktrees ───────────────────────────────────────────────────

  /**
   * Creates a per-task worktree branched off the MAIN worktree (not repoRoot)
   * so the task inherits already-merged sibling work.
   *
   * Branch: `engin/{mainSlug}--{taskId}` (flat `--` separator, never `/`).
   * Path:   `{workDir}/task-worktrees/{taskId}/`.
   *
   * HOOKS (when a `hookRegistry` is configured):
   *  - `beforeTaskWorktreeCreate` (first-wins): a workflow can skip isolation
   *    (e.g. read-only scout tasks run against the main worktree directly) or
   *    override the base branch / extra files. When `{ skip: true }`, no
   *    worktree is created — the task runs against the main worktree and
   *    `mergeTaskBranch` short-circuits.
   *  - `populateWorktree` (pipeline): populates the worktree (default delegates
   *    to the `.worktreecopy` primitive; a workflow can chain additional work).
   *  - `afterTaskWorktreeCreate` (observe): fire-and-forget fan-out so a
   *    workflow can react to the new worktree.
   *
   * Returns the absolute worktree path. The taskPrompt (if any) is stored for
   * later use by {@link mergeTaskBranch}. The `task` (if provided) is stored
   * so the merge / conflict hooks receive the full task object.
   */
  async createTaskWorktree(taskId: string, taskPrompt?: string, task?: Task): Promise<string> {
    // Validate taskId BEFORE it is interpolated into a filesystem path
    // ({workDir}/task-worktrees/{taskId}) or a git branch name
    // (engin/{mainSlug}--{taskId}). This centralises the path-traversal /
    // branch-name-safety guard the codebase already requires for task IDs
    // (see assertSafeName), protecting every caller regardless of whether
    // session persistence is configured.
    assertSafeName(taskId, 'task id');

    // Resolve the Task for hook args: use the caller-provided task when
    // available, otherwise synthesize a minimal one from taskId + prompt.
    const effectiveTask: Task = task ?? this.synthesizeTask(taskId, taskPrompt);

    // beforeTaskWorktreeCreate (first-wins): a workflow can skip isolation
    // (e.g. read-only scout tasks run against the main worktree directly).
    // When `{ skip: true }`, no worktree is created — the task's cwd is the
    // main worktree path, and mergeTaskBranch / cullTaskWorktree short-circuit.
    if (this.hookRegistry) {
      const decision = (await this.hookRegistry.invokeFirstWins(
        'beforeTaskWorktreeCreate',
        { task: effectiveTask, worktreeManager: this },
        this.makeHookCtx(),
      )) as BeforeTaskWorktreeResult | undefined;
      if (decision?.skip) {
        // Track as a skipped task so mergeTaskBranch / cullTaskWorktree
        // short-circuit (no on-disk worktree or branch to merge or remove).
        this.skippedTasks.add(taskId);
        this.taskWorktrees.set(taskId, {
          path: this.mainWorktreePath,
          branch: this.mainBranch,
          status: 'active',
        });
        this.taskPrompts.set(taskId, taskPrompt ?? '');
        this.taskTasks.set(taskId, effectiveTask);
        return this.mainWorktreePath;
      }
    }

    const taskBranch = this.taskBranchName(taskId);
    const taskWorktreePath = join(this.workDir, 'task-worktrees', taskId);

    // Created from mainWorktreePath (NOT repoRoot) so the task branch is
    // created off the main-wt branch HEAD, inheriting already-merged sibling
    // work. Branch creation reads main-wt HEAD, so it is routed through the
    // git lock to avoid racing a concurrent task's squash-merge into the main
    // worktree (which would otherwise let the new task branch capture a
    // half-merged state). Populate (fs) stays outside the lock.
    await this.withGitLock(() => Promise.resolve(createWorktree(this.mainWorktreePath, taskBranch, taskWorktreePath)));

    await this.invokePopulate(taskWorktreePath, effectiveTask);

    this.taskWorktrees.set(taskId, { path: taskWorktreePath, branch: taskBranch, status: 'active' });
    this.taskPrompts.set(taskId, taskPrompt ?? '');
    this.taskTasks.set(taskId, effectiveTask);

    // afterTaskWorktreeCreate (observe): fire-and-forget fan-out so a
    // workflow can react to the new worktree (e.g. emit a status event for
    // TUI per-task branch display). Fired ONLY when a worktree was actually
    // created (not on the skip path).
    if (this.hookRegistry) {
      await this.hookRegistry.invokeObserve(
        'afterTaskWorktreeCreate',
        { task: effectiveTask, worktreePath: taskWorktreePath, branch: taskBranch },
        this.makeHookCtx(),
      );
    }

    return taskWorktreePath;
  }

  /**
   * Synthesizes a minimal {@link Task} from a taskId + prompt for hook args
   * when the caller did not provide a full Task object (backward compat with
   * the `createTaskWorktree(taskId, taskPrompt?)` signature used by
   * phase-tasks.ts). The synthesized task carries enough context (id, title,
   * prompt) for a hook subscriber to branch on; fields the caller did not
   * supply default to empty values.
   */
  private synthesizeTask(taskId: string, taskPrompt?: string): Task {
    return {
      id: taskId,
      title: taskPrompt || taskId,
      prompt: taskPrompt ?? '',
      profile: '',
      files: [],
      dependencies: [],
      status: 'active',
      phaseId: '',
    };
  }

  /**
   * Commits and squash-merges a task branch into the main-wt branch, SERIALIZED
   * via the git lock ({@link withGitLock}) so the merge never interleaves with
   * another task's merge, a concurrent createTaskWorktree, or a cull.
   *
   * HOOKS (when a `hookRegistry` is configured):
   *  - `onTaskMerge` (first-wins): a workflow can veto the merge. The default
   *    returns `{ proceed: true, strategy: 'squash' }`. When `{ proceed: false }`,
   *    the merge is skipped (`{ success: false }`).
   *  - `onCommitFailure` (first-wins): when `commitWorktreeChanges` throws, a
   *    workflow can decide how to handle the lint/hook rejection. The default
   *    returns `{ strategy: 'agent' }` (but `commitWorktreeChanges` already
   *    ran its internal agent fix-up, so the hook is an additional seam for
   *    workflow-specific handling; non-`skip` strategies re-throw).
   *  - `onMergeConflict` (first-wins): when the squash-merge conflicts, a
   *    workflow chooses the resolution strategy. The default returns
   *    `{ strategy: 'agent' }` (delegates to `resolveConflictsWithAgent`).
   *    `'manual'` leaves the conflicts for the user; `'abort'` aborts the merge.
   *
   * 1. Validates the task worktree exists and is still active.
   * 2. Short-circuits skipped tasks (read-only — no branch to merge).
   * 3. Commits pending changes in the task worktree (outside the serialized
   *    section — different worktrees don't contend).
   * 4. Inside the serialized section: squash-merges the task branch into the
   *    main worktree. On conflict, an agent attempts resolution; on success
   *    (clean or resolved) the merge is committed.
   * 5. On a successful merge, culls the task worktree.
   *
   * Returns `{ success, conflictsResolved }`. `conflictsResolved` is true only
   * when conflicts arose AND were resolved by the agent.
   */
  async mergeTaskBranch(taskId: string): Promise<{ success: boolean; conflictsResolved: boolean }> {
    const info = this.taskWorktrees.get(taskId);
    if (!info || info.status !== 'active') {
      throw new Error(`mergeTaskBranch: task worktree '${taskId}' is not active`);
    }

    // Skipped tasks (read-only, ran against the main worktree directly) have
    // no separate branch to merge. Short-circuit with success and clear the
    // tracking — there is nothing to commit, merge, or cull.
    if (this.skippedTasks.has(taskId)) {
      this.skippedTasks.delete(taskId);
      this.taskWorktrees.delete(taskId);
      this.taskPrompts.delete(taskId);
      this.taskTasks.delete(taskId);
      return { success: true, conflictsResolved: false };
    }

    const taskPrompt = this.taskPrompts.get(taskId) ?? '';
    const task = this.taskTasks.get(taskId) ?? this.synthesizeTask(taskId, taskPrompt);

    // Commit pending changes in the task worktree BEFORE entering the
    // serialized section — different task worktrees don't contend with each
    // other, only the merge into the shared main-wt branch does. On commit
    // failure, invoke `onCommitFailure` so a workflow can decide how to
    // handle lint / pre-commit-hook rejections. The commit runs BEFORE the
    // `onTaskMerge` decision so the task branch carries the task's final
    // state regardless of whether the merge proceeds.
    try {
      await commitWorktreeChanges({
        profilesDirs: this.profilesDirs,
        worktreePath: info.path,
        taskPrompt,
        apiKeys: this.apiKeys,
      });
    } catch (commitErr) {
      if (!this.hookRegistry) throw commitErr;
      const errors = [commitErr instanceof Error ? commitErr.message : String(commitErr)];
      const resolution = (await this.hookRegistry.invokeFirstWins(
        'onCommitFailure',
        { task, errors, worktreePath: info.path },
        this.makeHookCtx(),
      )) as CommitFailureResolution | undefined;
      // 'skip' → abandon the merge (return failure without re-throwing).
      // 'agent' / 'fail' / undefined → re-throw. `commitWorktreeChanges`
      // already ran its internal agent fix-up; the hook is an additional
      // seam for workflow-specific handling, not a second auto-repair pass.
      if (resolution?.strategy === 'skip') {
        return { success: false, conflictsResolved: false };
      }
      throw commitErr;
    }

    // onTaskMerge (first-wins): a workflow can veto the merge. The default
    // (registered by run-executor) returns `{ proceed: true, strategy: 'squash' }`.
    // When `{ proceed: false }`, skip the merge entirely (do NOT cull — the
    // caller decides the fate of the un-merged branch). Invoked AFTER the
    // commit so the task branch is finalized before the merge decision.
    if (this.hookRegistry) {
      const mergeDecision = (await this.hookRegistry.invokeFirstWins(
        'onTaskMerge',
        { task, worktreePath: info.path, branch: info.branch },
        this.makeHookCtx(),
      )) as TaskMergeDecision | undefined;
      if (mergeDecision && !mergeDecision.proceed) {
        return { success: false, conflictsResolved: false };
      }
    }

    // Run the squash-merge (+ conflict resolution) inside the git lock so it
    // never interleaves with another task's merge, a concurrent
    // createTaskWorktree branch creation, or a cull. The lock chain always
    // resolves (withGitLock swallows + warns on rejection) so a failed merge
    // never blocks subsequent ops; the ORIGINAL result/error is awaited here.
    const result = await this.withGitLock(async () => {
      const mergeResult = squashMergeBranch(this.mainWorktreePath, info.branch);

      if (mergeResult.success) {
        // Commit the staged squash, retrying through a fix-up agent if the
        // pre-commit/lint hook rejects it (see commitMergeWithRetry). On
        // exhaustion the shared worktree is rolled back and the error thrown.
        await this.commitMergeWithRetry(`Merge task: ${taskId}`, taskPrompt);
        return { success: true, conflictsResolved: false };
      }

      // onMergeConflict (first-wins): a workflow chooses the resolution
      // strategy. The default returns `{ strategy: 'agent' }` (delegates to
      // `resolveConflictsWithAgent`). `'manual'` leaves the conflicts for the
      // user; `'abort'` aborts the in-progress merge. When no registry is
      // configured (backward compat), resolve directly with the agent.
      if (this.hookRegistry) {
        const conflictResolution = (await this.hookRegistry.invokeFirstWins(
          'onMergeConflict',
          {
            task,
            conflicts: mergeResult.conflicts,
            worktreePath: this.mainWorktreePath,
            mainBranch: this.mainBranch,
          },
          this.makeHookCtx(),
        )) as ConflictResolution | undefined;
        if (conflictResolution && conflictResolution.strategy !== 'agent') {
          // 'manual' or 'abort' — do not auto-resolve. For 'abort', roll back
          // the in-progress merge so the main worktree is left clean.
          if (conflictResolution.strategy === 'abort') {
            abortMerge(this.mainWorktreePath);
          }
          return { success: false, conflictsResolved: false };
        }
      }

      const resolvedResult = await resolveConflictsWithAgent(
        this.profilesDirs,
        this.mainWorktreePath,
        mergeResult.conflicts,
        taskPrompt,
        this.apiKeys,
      );

      if (!resolvedResult.resolved) {
        // Preserve the task worktree so the user can intervene manually.
        return { success: false, conflictsResolved: false };
      }

      stageFiles(this.mainWorktreePath, mergeResult.conflicts);
      // Same fix-up-retry guarantee as the clean-merge path.
      await this.commitMergeWithRetry(`Merge task: ${taskId}`, taskPrompt);
      return { success: true, conflictsResolved: true };
    });

    if (result.success) {
      await this.cullTaskWorktree(taskId);
    }

    return result;
  }

  /**
   * Force-removes a task worktree and its branch. Idempotent: unknown or
   * already-culled taskIds are a no-op. Best-effort: errors are swallowed
   * (logged via `console.warn`) so cull never breaks the calling flow.
   *
   * Used on success after a merge, and on failure before a retry.
   */
  async cullTaskWorktree(taskId: string): Promise<void> {
    const info = this.taskWorktrees.get(taskId);
    if (!info || info.status !== 'active') {
      // Idempotent: nothing to cull.
      return;
    }

    // Skipped tasks have no on-disk worktree or branch — just clear tracking.
    if (this.skippedTasks.has(taskId)) {
      this.skippedTasks.delete(taskId);
      this.taskWorktrees.delete(taskId);
      this.taskPrompts.delete(taskId);
      this.taskTasks.delete(taskId);
      return;
    }

    const branch = info.branch;
    const path = info.path;

    // removeWorktree + deleteBranchForce both mutate the repo's worktree list
    // / refs (shared state). Run them as ONE locked unit so they cannot race
    // a concurrent merge or createTaskWorktree. Bookkeeping is updated AFTER
    // the locked section completes.
    await this.withGitLock(async () => {
      try {
        // Force removal — agents leave worktrees dirty (uncommitted changes,
        // untracked files) that would block a non-forced removal.
        removeWorktree(this.repoRoot, path);
      } catch (err) {
        console.warn(
          `cullTaskWorktree: failed to remove worktree at ${path}:`,
          err instanceof Error ? err.message : err,
        );
      }

      try {
        // Force-delete the branch even when it contains unmerged commits.
        deleteBranchForce(this.repoRoot, branch);
      } catch (err) {
        console.warn(`cullTaskWorktree: failed to delete branch ${branch}:`, err instanceof Error ? err.message : err);
      }
    });

    info.status = 'culled';
    this.taskPrompts.delete(taskId);
    this.taskTasks.delete(taskId);
  }

  /**
   * Cull a task worktree after a failed fix loop, unless the task should be
   * isolated (preserved for inspection). Best-effort: cull failures are
   * swallowed + warned so cleanup never masks the original failure.
   *
   * `preserve=true` short-circuits before any git work — the worktree is
   * left in place for human inspection (e.g. a security-sensitive failure).
   * `preserve=false` delegates to {@link cullTaskWorktree}.
   */
  async cullOrPreserve(taskId: string, preserve: boolean): Promise<void> {
    if (preserve) return;
    try {
      await this.cullTaskWorktree(taskId);
    } catch (err) {
      console.warn(
        `[WorktreeManager] Failed to cull worktree for task ${taskId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Sweeps orphaned git worktree metadata via `git worktree prune`.
   */
  async gitWorktreePrune(): Promise<void> {
    worktreePrune(this.repoRoot);
  }

  // ─── Final Merge to Real Main ─────────────────────────────────────────────

  /**
   * Squash-merges the main-wt branch into the real `main` branch. Used by the
   * run-end final merge UX.
   *
   * On conflict, does NOT abort — the caller decides whether to resolve (via
   * {@link resolveFinalMergeConflicts}) or abort (via {@link abortFinalMerge}).
   * The repo is left in the conflicted merge state on real `main`.
   *
   * Returns `{ success, conflicts, conflictsResolved }`. On a clean merge,
   * `conflicts` is empty and the previously-checked-out branch is restored.
   */
  async finalMergeToMain(): Promise<{
    success: boolean;
    conflicts: string[];
    conflictsResolved: boolean;
    error?: string;
  }> {
    return this.withGitLock(async () => {
      // 1. Commit any pending changes in the main worktree.
      await commitWorktreeChanges({
        profilesDirs: this.profilesDirs,
        worktreePath: this.mainWorktreePath,
        taskPrompt: 'Final merge',
        apiKeys: this.apiKeys,
      });

      // 2. Save the currently-checked-out branch so it can be restored after.
      //    Stored on the instance (not a local) so it survives across the
      //    conflict → resolve flow, where `resolveFinalMergeConflicts` runs in a
      //    separate call and `cleanup()` performs the actual restore.
      this.savedBranch = getCurrentBranch(this.repoRoot);

      // 3. Check out the real main branch.
      const realMain = getMainBranch(this.repoRoot);
      checkoutBranch(this.repoRoot, realMain);

      // 4. Squash-merge the main-wt branch into real main.
      const result = squashMergeBranch(this.repoRoot, this.mainBranch);

      if (result.success) {
        try {
          commitChanges(this.repoRoot, `Merge engin run: ${this.mainBranch}`);
        } catch (commitErr) {
          // Roll back the staged squash so real main is left clean for a
          // caller retry / manual intervention (mirrors the per-task merge).
          try {
            abortMerge(this.repoRoot);
          } catch {
            /* no merge in progress */
          }
          try {
            resetHard(this.repoRoot);
          } catch {
            /* best-effort */
          }
          restoreSavedBranch(this.repoRoot, this.savedBranch);
          throw commitErr;
        }
        restoreSavedBranch(this.repoRoot, this.savedBranch);
        return { success: true, conflicts: [], conflictsResolved: false };
      }

      // On conflict, leave the repo on real main with the merge in progress so
      // the caller can resolve or abort. Do NOT restore the saved branch — the
      // caller's next action operates on the conflicted merge state.
      return {
        success: false,
        conflicts: result.conflicts,
        conflictsResolved: false,
        ...(result.error ? { error: result.error } : {}),
      };
    });
  }

  /**
   * Resolves conflicts from a failed {@link finalMergeToMain} via the agent.
   * On success, stages the resolved files and commits the merge. Returns
   * `{ resolved: true }` when all conflicts were resolved, or
   * `{ resolved: false, error? }` when the agent could not resolve them
   * (carrying a short diagnostic for the client).
   */
  async resolveFinalMergeConflicts(
    conflicts: string[],
    taskPrompt: string,
  ): Promise<{ resolved: boolean; error?: string }> {
    return this.withGitLock(async () => {
      const resolveResult = await resolveConflictsWithAgent(
        this.profilesDirs,
        this.repoRoot,
        conflicts,
        taskPrompt,
        this.apiKeys,
      );

      if (!resolveResult.resolved) {
        return { resolved: false, ...(resolveResult.error ? { error: resolveResult.error } : {}) };
      }

      stageFiles(this.repoRoot, conflicts);
      try {
        commitChanges(this.repoRoot, `Merge resolution: ${this.mainBranch}`);
      } catch (commitErr) {
        try {
          abortMerge(this.repoRoot);
        } catch {
          /* no merge in progress */
        }
        try {
          resetHard(this.repoRoot);
        } catch {
          /* best-effort */
        }
        throw commitErr;
      }
      return { resolved: true };
    });
  }

  /**
   * Aborts an in-progress final merge on the repo root. Used when the caller
   * decides not to resolve conflicts from {@link finalMergeToMain}.
   */
  async abortFinalMerge(): Promise<void> {
    await this.withGitLock(() => Promise.resolve(abortMerge(this.repoRoot)));
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * Removes the main worktree + main-wt branch + sweeps leftover task
   * worktrees. ONLY called after a successful final merge.
   *
   * Best-effort: a removal failure does NOT throw — it is surfaced via the
   * optional `cleanupError` field so callers can warn without conflating it
   * with an operation failure. Returns `{ cleanupError? }`.
   */
  async cleanup(): Promise<{ cleanupError?: string }> {
    const errors: string[] = [];

    // 1. Restore the branch that was checked out before the final merge began
    //    (best-effort). Uses the branch captured by `finalMergeToMain` rather
    //    than re-reading the current branch — which after a conflict-resolved
    //    merge would be `realMain`, making the restore a no-op.
    try {
      if (this.savedBranch) {
        restoreSavedBranch(this.repoRoot, this.savedBranch);
      }
    } catch {
      // Ignore — may be in detached HEAD or the branch is already gone.
    }

    // 2. Cull any remaining active task worktrees (best-effort;
    //    cullTaskWorktree swallows its own errors).
    for (const taskId of [...this.taskWorktrees.keys()]) {
      const info = this.taskWorktrees.get(taskId);
      if (info && info.status === 'active') {
        await this.cullTaskWorktree(taskId);
      }
    }

    // 3. Remove the main worktree + force-delete the main-wt branch as ONE
    //    locked unit (both touch shared repo refs / the worktree list).
    //    The cull loop above is intentionally OUTSIDE this lock to avoid
    //    re-entrant locking (cullTaskWorktree acquires the lock itself).
    await this.withGitLock(async () => {
      try {
        removeWorktree(this.repoRoot, this.mainWorktreePath);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      try {
        deleteBranchForce(this.repoRoot, this.mainBranch);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    });

    return errors.length > 0 ? { cleanupError: errors.join('; ') } : {};
  }

  // ─── Info ─────────────────────────────────────────────────────────────────

  /**
   * Returns a {@link WorktreeInfo} describing the MAIN worktree, for
   * populating `RunHandle.worktree` and `RunSummary.worktree`.
   */
  getWorktreeInfo(): WorktreeInfo {
    return {
      worktreePath: this.mainWorktreePath,
      branchName: this.mainBranch,
      originalCwd: this.sourceCwd,
    };
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────

  /**
   * Computes the per-task branch name: `engin/{mainSlug}--{taskId}`, where
   * `{mainSlug}` is the main-wt branch with the `engin/` prefix stripped.
   * Uses the flat `--` separator (never `/`) to avoid ref/file duality
   * collision with the `engin/{mainSlug}` ref.
   */
  private taskBranchName(taskId: string): string {
    const mainSlug = this.mainBranch.startsWith(ENGIN_PREFIX)
      ? this.mainBranch.slice(ENGIN_PREFIX.length)
      : this.mainBranch;
    return `${ENGIN_PREFIX}${mainSlug}${TASK_SEPARATOR}${taskId}`;
  }
}
