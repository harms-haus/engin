// ─── Default implementations of the workflow-level hooks ────────────────────
//
// `createDefaultOnPersist`, `createDefaultOnRestore`, `defaultBeforeRunMerge`,
// `createDefaultOnRunMergeConflict`, `defaultOnWorkflowAbort`, and
// `defaultOnWorkflowResume` are the DEFAULT implementations of the six
// workflow-level hooks declared in hooks/types.ts (task-23). Each ships a
// "zero-config" behavior so a workflow that registers NO hooks still gets
// sensible persistence, restore, merge, abort, and resume semantics.
//
// They are also the building blocks `spir.ts`'s `runSpir` is being refactored
// to call through — `createDefaultOnPersist` replaces the inline
// `await tracker.save()`, `createDefaultOnRestore` replaces the inline
// `WorkflowStatusTracker.load(workDir)`, and `defaultOnWorkflowAbort` replaces
// the bespoke `'Workflow cancelled'` string-matching.

import type { WorkflowState } from '../../core/types.js';
import { WorkflowStatusTracker } from '../../tracking/workflow-status.js';
import type {
  BeforeRunMergeArgs,
  ConflictResolution,
  FirstWinsHook,
  ObserveHook,
  OnPersistArgs,
  OnRestoreArgs,
  OnRunMergeConflictArgs,
  OnWorkflowAbortArgs,
  OnWorkflowResumeArgs,
  PipelineHook,
  RunMergeDecision,
} from '../types.js';

/**
 * DEFAULT `onPersist` (pipeline) hook factory.
 *
 * Captures a {@link WorkflowStatusTracker} and returns a pipeline hook that
 * `await`s `tracker.save()` (flushing state to disk) and then returns
 * `tracker.toJSON()` as the pipeline output. The INCOMING pipeline value is
 * IGNORED — the tracker is the single source of truth for persisted state, so
 * the serialized output always reflects the latest tracker contents at call
 * time (never a stale snapshot).
 *
 * Unlike the tracker's fire-and-forget auto-persist, this default `await`s
 * `save()` — so a write failure rejects the hook rather than being swallowed.
 *
 * Replaces the inline `await tracker.save()` call in `spir.ts::runSpir`.
 */
export function createDefaultOnPersist(tracker: WorkflowStatusTracker): PipelineHook<WorkflowState, OnPersistArgs> {
  return async (_value, _args, _ctx) => {
    await tracker.save();
    return tracker.toJSON();
  };
}

/**
 * DEFAULT `onRestore` (pipeline) hook factory.
 *
 * Returns a pipeline hook that loads the tracker from `args.workDir` (NOT the
 * factory-captured path) and returns the restored {@link WorkflowState}. The
 * INCOMING pipeline value is IGNORED — the state loaded from disk wins.
 *
 * The factory-captured `workDir` is accepted for API symmetry with
 * {@link createDefaultOnPersist} and to mirror `runSpir`'s existing
 * `WorkflowStatusTracker.load(workDir)` call site, but the hook honors the
 * invocation `args.workDir` so an engine that swaps work directories at
 * invoke time is respected. `load()` failures (e.g. a missing state file)
 * propagate — they are NOT swallowed.
 *
 * Replaces the inline `WorkflowStatusTracker.load(workDir)` call in
 * `spir.ts::runSpir`.
 */
export function createDefaultOnRestore(_workDir: string): PipelineHook<WorkflowState, OnRestoreArgs> {
  return async (_value, args, _ctx) => {
    const tracker = await WorkflowStatusTracker.load(args.workDir);
    return tracker.toJSON();
  };
}

/**
 * DEFAULT `beforeRunMerge` (first-wins) hook.
 *
 * Returns the current default merge decision: PROCEED with a SQUASH merge. The
 * decision is constant — it ignores the worktree / branch args — so a workflow
 * that registers no `beforeRunMerge` subscriber gets the legacy squash-merge
 * behavior unchanged. Returns a non-`undefined` value so it WINS in a
 * first-wins composition when no earlier subscriber has decided.
 */
export const defaultBeforeRunMerge: FirstWinsHook<RunMergeDecision | undefined, BeforeRunMergeArgs> = async (
  _args,
  _ctx,
) => ({ proceed: true, strategy: 'squash' });

/**
 * DEFAULT `onRunMergeConflict` (first-wins) hook factory.
 *
 * Captures the `profilesDirs` / `apiKeys` used downstream by the agent-based
 * conflict-resolution primitive (`worktree-lifecycle.ts::resolveConflictsWithAgent`)
 * and returns a first-wins hook that returns the PURE DELEGATION MARKER
 * `{ strategy: 'agent' }`. The default signals the strategy only — it does NOT
 * read the conflict files, spawn a fix-up session, or populate
 * `resolvedFiles`. The actual resolution is composed downstream by
 * `WorktreeManager.resolveFinalMergeConflicts`, which consumes the marker and
 * invokes the tooled agent against the captured profiles / API keys.
 *
 * The captured `profilesDirs` and `apiKeys` are accepted for signature
 * alignment with the downstream resolution primitive and for future expansion
 * (e.g. a default that resolves inline); the pure-marker default does not use
 * them directly. Pointing them at non-existent paths must NOT throw — the
 * default never touches the filesystem.
 */
export function createDefaultOnRunMergeConflict(
  _profilesDirs: string[],
  _apiKeys?: Record<string, string>,
): FirstWinsHook<ConflictResolution | undefined, OnRunMergeConflictArgs> {
  return async (_args, _ctx) => ({ strategy: 'agent' });
}

/**
 * DEFAULT `onWorkflowAbort` (observe) hook.
 *
 * Surfaces the abort reason via `console.warn`. Replaces the bespoke
 * `'Workflow cancelled'` string-matching previously inlined in `spir.ts` —
 * the reason is now logged as data, whatever string the caller supplies.
 */
export const defaultOnWorkflowAbort: ObserveHook<OnWorkflowAbortArgs> = async (args, _ctx) => {
  console.warn(args.reason);
};

/**
 * DEFAULT `onWorkflowResume` (observe) hook.
 *
 * No-op by default: the resume logic stays in the workflow for now. Resolves
 * `undefined` and performs no disk I/O. A future expansion could clear stale
 * sessions or warm caches; for now it exists so a workflow that registers no
 * `onWorkflowResume` subscriber still has a well-defined (identity) default.
 */
export const defaultOnWorkflowResume: ObserveHook<OnWorkflowResumeArgs> = async (_args, _ctx) => {
  // Intentionally a no-op.
};
