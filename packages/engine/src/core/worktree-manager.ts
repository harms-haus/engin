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
//   • merge serialization — concurrent task merges are chained onto a single
//     `mergeChain` promise so the squash-merges into the main-wt branch never
//     interleave (which would corrupt the merge state).
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
  commitChanges,
  createWorktree,
  deleteBranchForce,
  getCurrentBranch,
  getMainBranch,
  populateWorktree,
  removeWorktree,
  squashMergeBranch,
  stageFiles,
  worktreePrune,
} from './git.js';
import type { Task, WorktreeInfo } from './types.js';
import { resolveConflictsWithAgent } from './worktree-lifecycle.js';
import { commitWorktreeChanges } from './worktree-operations.js';

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
   * Serialisation chain for task-branch merges. Each `mergeTaskBranch` call
   * chains its squash-merge onto this promise so concurrent merges into the
   * main-wt branch never interleave. Reassigned BEFORE the await so the next
   * caller observes the in-flight merge.
   */
  private mergeChain: Promise<unknown> = Promise.resolve();

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
    // 1. Sweep orphans from crashed runs before adding new worktree metadata.
    worktreePrune(this.repoRoot);

    // 2. Create the main worktree on the engin/{mainSlug} branch, checked out
    //    from the real repo's current HEAD/main.
    createWorktree(this.repoRoot, this.mainBranch, this.mainWorktreePath);

    // 3. Populate via the hook pipeline (default delegates to the
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
    // work.
    createWorktree(this.mainWorktreePath, taskBranch, taskWorktreePath);

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
   * via {@link mergeChain} so concurrent merges never interleave.
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

    // Chain the merge onto mergeChain. Reassign mergeChain BEFORE awaiting so
    // a concurrent caller observes this in-flight merge and waits for it
    // rather than racing ahead.
    const serialized = this.mergeChain.then(async () => {
      const result = squashMergeBranch(this.mainWorktreePath, info.branch);

      if (result.success) {
        commitChanges(this.mainWorktreePath, `Merge task: ${taskId}`);
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
            conflicts: result.conflicts,
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
        result.conflicts,
        taskPrompt,
        this.apiKeys,
      );

      if (!resolvedResult.resolved) {
        // Preserve the task worktree so the user can intervene manually.
        return { success: false, conflictsResolved: false };
      }

      stageFiles(this.mainWorktreePath, result.conflicts);
      commitChanges(this.mainWorktreePath, `Merge task: ${taskId}`);
      return { success: true, conflictsResolved: true };
    });
    this.mergeChain = serialized.catch((err) => {
      // Swallow rejections so a failed merge does not break the chain for
      // subsequent queued merges — but log so the swallowed failure remains
      // debuggable (the {success:false} result is still surfaced to callers).
      console.warn('[WorktreeManager] mergeChain rejection swallowed:', err instanceof Error ? err.message : err);
    });

    const result = await serialized;

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

    try {
      // Force removal — agents leave worktrees dirty (uncommitted changes,
      // untracked files) that would block a non-forced removal.
      removeWorktree(this.repoRoot, info.path);
    } catch (err) {
      console.warn(
        `cullTaskWorktree: failed to remove worktree at ${info.path}:`,
        err instanceof Error ? err.message : err,
      );
    }

    try {
      // Force-delete the branch even when it contains unmerged commits.
      deleteBranchForce(this.repoRoot, info.branch);
    } catch (err) {
      console.warn(
        `cullTaskWorktree: failed to delete branch ${info.branch}:`,
        err instanceof Error ? err.message : err,
      );
    }

    info.status = 'culled';
    this.taskPrompts.delete(taskId);
    this.taskTasks.delete(taskId);
  }

  /**
   * Sweeps orphaned worktree metadata via `git worktree prune`. Exposed so
   * callers can prune without going through {@link setupMainWorktree}.
   */
  async prune(): Promise<void> {
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
      commitChanges(this.repoRoot, `Merge engin run: ${this.mainBranch}`);
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
    commitChanges(this.repoRoot, `Merge resolution: ${this.mainBranch}`);
    return { resolved: true };
  }

  /**
   * Aborts an in-progress final merge on the repo root. Used when the caller
   * decides not to resolve conflicts from {@link finalMergeToMain}.
   */
  async abortFinalMerge(): Promise<void> {
    abortMerge(this.repoRoot);
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

    // 3. Remove the main worktree (best-effort).
    try {
      removeWorktree(this.repoRoot, this.mainWorktreePath);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    // 4. Force-delete the main-wt branch (best-effort).
    try {
      deleteBranchForce(this.repoRoot, this.mainBranch);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

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

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Restores the previously-checked-out branch. Errors are swallowed because
 * the repo may be in a detached-HEAD state where the symbolic ref is gone.
 * Mirrors the private helper of the same name in worktree-operations.ts.
 */
function restoreSavedBranch(repoRoot: string, savedBranch: string): void {
  try {
    checkoutBranch(repoRoot, savedBranch);
  } catch {
    // Ignore — may be detached HEAD.
  }
}
