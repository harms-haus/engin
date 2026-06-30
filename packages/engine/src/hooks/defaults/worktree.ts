// ─── Default implementations of the worktree-lifecycle hooks ────────────────
//
// Each ships a "zero-config" behavior so a workflow that registers NO hooks
// still gets sensible worktree-isolation, population, merge, conflict-resolution,
// commit-failure, and post-create semantics.

import { populateWorktree } from '../../core/worktree-populate.js';
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
import { createAgentStrategyHook } from './shared.js';

/**
 * The default set of "read-only" profiles — tasks running under one of these
 * profiles do NOT get an isolated worktree. They run against the run cwd
 * directly because they perform no writes (so isolation buys nothing and the
 * worktree creation cost is pure overhead).
 *
 * `'scout'` is included by default so scout tasks (which perform no writes)
 * run against the run cwd directly, avoiding unnecessary worktree creation.
 */
const DEFAULT_READ_ONLY_PROFILES: readonly string[] = ['scout'];

/**
 * DEFAULT `beforeTaskWorktreeCreate` (first-wins) hook factory.
 *
 * Returns a first-wins hook that skips worktree creation for tasks whose
 * `profile` is in `readOnlyProfiles` (default `['scout']`). For every other
 * task it abstains (returns `undefined`), so isolation proceeds normally.
 *
 * Read-only profiles perform no writes, so an isolated worktree buys nothing.
 * The skip is driven SOLELY by `task.profile ∈ readOnlyProfiles` — the opaque
 * `worktreeManager` arg is not consulted.
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
 * Captures a `sourceCwd` and returns a pipeline hook that delegates to the
 * `populateWorktree` primitive — the `.worktreecopy` copy + symlink primitive
 * — passing `args.sourceCwd` and `args.worktreePath`.
 *
 * The hook honors `args.sourceCwd` (NOT the factory-captured one) so an engine
 * that swaps source directories at invoke time is respected. The factory-
 * captured `sourceCwd` exists for API symmetry with the other defaults.
 *
 * The pipeline value is `void`; the hook performs the copy as a side effect and
 * returns `undefined` (propagating `populateWorktree`'s no-result contract).
 * When `sourceCwd` has no `.worktreecopy` the primitive returns early (empty
 * entries → nothing copied) and the default propagates that — it does NOT
 * throw.
 */
export function createDefaultPopulateWorktree(_sourceCwd: string): PipelineHook<void, PopulateWorktreeArgs> {
  return async (_value, args, _ctx) => {
    await populateWorktree(args.sourceCwd, args.worktreePath);
  };
}

/**
 * DEFAULT `onTaskMerge` (first-wins) hook.
 *
 * Returns a constant task-merge decision: PROCEED with a SQUASH merge. The
 * decision is independent of the task, worktree, and branch args. Returns a
 * non-`undefined` value so it WINS in a first-wins composition when no earlier
 * subscriber has decided.
 */
export const defaultOnTaskMerge: FirstWinsHook<TaskMergeDecision | undefined, OnTaskMergeArgs> = async (
  _args,
  _ctx,
) => ({ proceed: true, strategy: 'squash' });

/**
 * DEFAULT `onMergeConflict` (first-wins) hook factory.
 *
 * Captures the `profilesDirs` / `apiKeys` used downstream by the agent-based
 * conflict-resolution primitive (`resolveConflictsWithAgent`, the tooled
 * fix-up primitive) and returns a first-wins hook that returns the PURE
 * DELEGATION MARKER `{ strategy: 'agent' }`. The default signals the strategy
 * only — it does NOT read the conflict files, spawn a fix-up session, or
 * populate `resolvedFiles`. The actual resolution is composed downstream by
 * `WorktreeManager`, which consumes the marker and invokes the tooled agent
 * against the captured profiles / API keys via `resolveConflictsWithAgent`.
 *
 * The captured `profilesDirs` and `apiKeys` are accepted for signature
 * alignment with the downstream resolution primitive; the pure-marker default
 * does not use them directly. Pointing them at non-existent paths must NOT
 * throw — the default never touches the filesystem.
 */
export function createDefaultOnMergeConflict(
  _profilesDirs: string[],
  _apiKeys?: Record<string, string>,
): FirstWinsHook<ConflictResolution | undefined, OnMergeConflictArgs> {
  return createAgentStrategyHook();
}

/**
 * DEFAULT `onCommitFailure` (first-wins) hook factory.
 *
 * Captures the `profilesDirs` / `apiKeys` used downstream by the tooled fix-up
 * primitive (`resolveConflictsWithAgent`, reused for lint/commit failure
 * repair) and returns a first-wins hook that returns the PURE DELEGATION
 * MARKER `{ strategy: 'agent' }`. The default signals the strategy only — it
 * does NOT read the failed files, spawn a fix-up session, or populate
 * `resolvedFiles`. The actual repair is composed downstream by
 * `WorktreeManager`, which consumes the marker and invokes the tooled agent
 * against the captured profiles / API keys.
 *
 * The captured `profilesDirs` and `apiKeys` are accepted for signature
 * alignment with the downstream resolution primitive; the pure-marker default
 * does not use them directly. Pointing them at non-existent paths must NOT
 * throw — the default never touches the filesystem.
 */
export function createDefaultOnCommitFailure(
  _profilesDirs: string[],
  _apiKeys?: Record<string, string>,
): FirstWinsHook<CommitFailureResolution | undefined, OnCommitFailureArgs> {
  return createAgentStrategyHook();
}

/**
 * DEFAULT `afterTaskWorktreeCreate` (observe) hook.
 *
 * No-op. Resolves `undefined` and performs no disk I/O, no args mutation.
 * Exists so a workflow that registers no `afterTaskWorktreeCreate` subscriber
 * still has a well-defined default.
 */
export const defaultAfterTaskWorktreeCreate: ObserveHook<AfterTaskWorktreeArgs> = async (_args, _ctx) => {
  // Intentionally a no-op.
};
