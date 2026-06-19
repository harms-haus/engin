// ─── Default implementations of the worktree-lifecycle hooks ────────────────
//
// `createDefaultBeforeTaskWorktreeCreate`, `createDefaultPopulateWorktree`,
// `defaultOnTaskMerge`, `createDefaultOnMergeConflict`,
// `createDefaultOnCommitFailure`, and `defaultAfterTaskWorktreeCreate` are the
// DEFAULT implementations of the six worktree-lifecycle hooks declared in
// hooks/types.ts (the "Worktree lifecycle hooks" block). Each ships a
// "zero-config" behavior so a workflow that registers NO hooks still gets
// sensible worktree-isolation, population, merge, conflict-resolution,
// commit-failure, and post-create semantics.
//
// The high-value default is `createDefaultPopulateWorktree`, which delegates to
// the EXISTING `core/git.ts::populateWorktree` primitive — the `.worktreecopy`
// copy + symlink primitive — so a workflow that registers no
// `populateWorktree` subscriber still gets the legacy worktree population
// behavior unchanged.

import { populateWorktree } from '../../core/git.js';
import type {
  AfterTaskWorktreeArgs,
  BeforeTaskWorktreeArgs,
  BeforeTaskWorktreeResult,
  CommitFailureResolution,
  ConflictResolution,
  FirstWinsHook,
  ObserveHook,
  OnCommitFailureArgs,
  OnMergeConflictArgs,
  OnTaskMergeArgs,
  PipelineHook,
  PopulateWorktreeArgs,
  TaskMergeDecision,
} from '../types.js';

/**
 * The default set of "read-only" profiles — tasks running under one of these
 * profiles do NOT get an isolated worktree. They run against the run cwd
 * directly because they perform no writes (so isolation buys nothing and the
 * worktree creation cost is pure overhead).
 *
 * `'scout'` is included by default to reproduce the legacy "scouts run against
 * the run cwd directly" behavior with zero configuration.
 */
const DEFAULT_READ_ONLY_PROFILES: readonly string[] = ['scout'];

/**
 * DEFAULT `beforeTaskWorktreeCreate` (first-wins) hook factory.
 *
 * Returns a first-wins hook that skips worktree creation for tasks whose
 * `profile` is in `readOnlyProfiles` (default `['scout']`). For every other
 * task it abstains (returns `undefined`), so isolation proceeds normally.
 *
 * Reproduces the legacy "scouts run against the run cwd directly" behavior:
 * read-only scout tasks perform no writes, so an isolated worktree buys
 * nothing. The skip is driven SOLELY by `task.profile ∈ readOnlyProfiles` —
 * the opaque `worktreeManager` arg is not consulted.
 *
 * An explicit empty list (`createDefaultBeforeTaskWorktreeCreate([])`) means
 * "no profile is read-only" — even `'scout'` is NOT skipped. Profile-name
 * matching is case-sensitive: `'Scout'` is not the same profile as `'scout'`.
 *
 * Returns `{ skip: true }` (only `skip` set — no `baseBranch` / `extraFiles`)
 * for read-only tasks, so it WINS in a first-wins composition when no earlier
 * subscriber has decided.
 */
export function createDefaultBeforeTaskWorktreeCreate(
  readOnlyProfiles: readonly string[] = DEFAULT_READ_ONLY_PROFILES,
): FirstWinsHook<BeforeTaskWorktreeResult | undefined, BeforeTaskWorktreeArgs> {
  return async (args, _ctx) => {
    if (readOnlyProfiles.includes(args.task.profile)) {
      return { skip: true };
    }
    return undefined;
  };
}

/**
 * DEFAULT `populateWorktree` (pipeline) hook factory.
 *
 * Captures a `sourceCwd` (for API symmetry with the other defaults and to
 * mirror the existing `populateWorktree(sourceCwd, worktreePath)` call site)
 * and returns a pipeline hook that delegates to the EXISTING
 * `core/git.ts::populateWorktree` primitive — the `.worktreecopy` copy +
 * symlink primitive — passing `args.sourceCwd` and `args.worktreePath`.
 *
 * The hook honors `args.sourceCwd` (NOT the factory-captured one) so an engine
 * that swaps source directories at invoke time is respected — mirroring
 * `createDefaultOnRestore`'s `args.workDir` precedence over the captured path.
 * The factory-captured `sourceCwd` exists for API symmetry and future
 * expansion.
 *
 * The pipeline value is `void`; the hook performs the copy as a side effect and
 * returns `undefined` (propagating `populateWorktree`'s no-result contract).
 * When `sourceCwd` has no `.worktreecopy` the primitive returns early (empty
 * entries → nothing copied) and the default propagates that — it does NOT
 * throw.
 *
 * This is the high-value default: workflows override `populateWorktree` to
 * `bun install`, copy secrets, etc., but a workflow that registers no
 * subscriber still gets the legacy `.worktreecopy`-driven population.
 */
export function createDefaultPopulateWorktree(_sourceCwd: string): PipelineHook<void, PopulateWorktreeArgs> {
  return async (_value, args, _ctx) => {
    populateWorktree(args.sourceCwd, args.worktreePath);
  };
}

/**
 * DEFAULT `onTaskMerge` (first-wins) hook.
 *
 * Returns the current default task-merge decision: PROCEED with a SQUASH merge.
 * The decision is constant — it ignores the task / worktree / branch args — so
 * a workflow that registers no `onTaskMerge` subscriber gets the legacy
 * squash-merge behavior unchanged. Returns a non-`undefined` value so it WINS
 * in a first-wins composition when no earlier subscriber has decided.
 */
export const defaultOnTaskMerge: FirstWinsHook<TaskMergeDecision | undefined, OnTaskMergeArgs> = async (
  _args,
  _ctx,
) => ({ proceed: true, strategy: 'squash' });

/**
 * DEFAULT `onMergeConflict` (first-wins) hook factory.
 *
 * Captures the `profilesDirs` / `apiKeys` used downstream by the agent-based
 * conflict-resolution primitive (`worktree-lifecycle.ts::resolveConflictsWithAgent`,
 * the tooled fix-up primitive) and returns a first-wins hook that returns the
 * PURE DELEGATION MARKER `{ strategy: 'agent' }`. The default signals the
 * strategy only — it does NOT read the conflict files, spawn a fix-up session,
 * or populate `resolvedFiles`. The actual resolution is composed downstream by
 * `WorktreeManager`, which consumes the marker and invokes the tooled agent
 * against the captured profiles / API keys via `resolveConflictsWithAgent`.
 *
 * The captured `profilesDirs` and `apiKeys` are accepted for signature
 * alignment with the downstream resolution primitive and for future expansion
 * (e.g. a default that resolves inline); the pure-marker default does not use
 * them directly. Pointing them at non-existent paths must NOT throw — the
 * default never touches the filesystem.
 */
export function createDefaultOnMergeConflict(
  _profilesDirs: string[],
  _apiKeys?: Record<string, string>,
): FirstWinsHook<ConflictResolution | undefined, OnMergeConflictArgs> {
  return async (_args, _ctx) => ({ strategy: 'agent' });
}

/**
 * DEFAULT `onCommitFailure` (first-wins) hook factory.
 *
 * Captures the `profilesDirs` / `apiKeys` used downstream by the tooled fix-up
 * primitive (`worktree-lifecycle.ts::resolveConflictsWithAgent`, reused for
 * lint/commit failure repair) and returns a first-wins hook that returns the
 * PURE DELEGATION MARKER `{ strategy: 'agent' }`. The default signals the
 * strategy only — it does NOT read the failed files, spawn a fix-up session,
 * or populate `resolvedFiles`. The actual repair is composed downstream by
 * `WorktreeManager`, which consumes the marker and invokes the tooled agent
 * against the captured profiles / API keys.
 *
 * The captured `profilesDirs` and `apiKeys` are accepted for signature
 * alignment with the downstream resolution primitive and for future expansion
 * (e.g. a default that resolves inline); the pure-marker default does not use
 * them directly. Pointing them at non-existent paths must NOT throw — the
 * default never touches the filesystem.
 */
export function createDefaultOnCommitFailure(
  _profilesDirs: string[],
  _apiKeys?: Record<string, string>,
): FirstWinsHook<CommitFailureResolution | undefined, OnCommitFailureArgs> {
  return async (_args, _ctx) => ({ strategy: 'agent' });
}

/**
 * DEFAULT `afterTaskWorktreeCreate` (observe) hook.
 *
 * No-op by default: the post-create worktree state stays internal to
 * `WorktreeManager` for now. Resolves `undefined` and performs no disk I/O,
 * no args mutation. A future expansion could fire a status event for TUI/web
 * per-task branch display; for now it exists so a workflow that registers no
 * `afterTaskWorktreeCreate` subscriber still has a well-defined (identity)
 * default.
 */
export const defaultAfterTaskWorktreeCreate: ObserveHook<AfterTaskWorktreeArgs> = async (_args, _ctx) => {
  // Intentionally a no-op.
};
