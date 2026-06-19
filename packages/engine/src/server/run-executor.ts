// ─── RunExecutor ────────────────────────────────────────────────────────────
//
// Workflow execution body extracted from RunManager (decomposition step). It
// contains the former private `executeWorkflow` async IIFE: the workflow.run()
// lifecycle, store flush, status transitions (running → complete / failed),
// terminal broadcasts, renderer-registry wiring, the post-terminal reaper
// scheduling, AND the worktree lifecycle:
//
//   - When git is available, RunExecutor creates a {@link WorktreeManager},
//     calls `setupMainWorktree()`, wires it onto the handle + WorkflowRunOptions
//     (options.cwd becomes the MAIN WORKTREE PATH — the transparency
//     mechanism by which the workflow sees the worktree as its cwd), and
//     derives the main-wt branch via `generateTitleAndBranch` +
//     `sanitizeBranchSlug`.
//   - When the cwd is NOT a git repo, it warns and runs in-place (no
//     worktree), leaving options.cwd = handle.cwd.
//   - On failure, the worktree is PRESERVED (no cleanup) so the user can
//     inspect or retry. The run-end final merge is NOT automatic — it is
//     driven by the user via `RunManager.handleWorktreeAction` once the run
//     reaches a terminal state.
//
// WORKFLOW-LEVEL HOOK WIRING (this task): `execute` owns a SUBSET of the
// workflow-level hooks declared in hooks/types.ts. After `composeHooks`
// builds the registry, `execute` registers the DEFAULT implementations of
// the engine-owned hooks (see run-executor.test.ts suite 7):
//
//   - `onWorkflowResume` / `onWorkflowAbort` — always registered (engine
//     lifecycle). The engine FIRES them: `onWorkflowResume` on resume
//     detection (the store already has events), `onWorkflowAbort` in the
//     AbortError branch of the catch block BEFORE the handle is marked failed.
//   - `beforeRunMerge` / `onRunMergeConflict` — registered only on the git
//     path (the run-end final-merge pair). The engine does NOT fire them
//     here — `RunManager.handleWorktreeAction` invokes them once the run is
//     terminal and the user requests the merge. The defaults reproduce the
//     legacy squash-merge / agent-resolution UX.
//
// DESIGN SPLIT: the `onPersist` / `onRestore` defaults are NOT registered by
// the engine — the WorkflowStatusTracker they capture is created by the
// WORKFLOW (spir.ts), so the workflow registers those defaults itself. The
// engine only fires / registers hooks it owns; it does not fabricate a
// tracker.
//
// All wiring is ADDITIVE: when no workflow-provided hooks are present, the
// defaults reproduce the prior behavior EXACTLY (existing workflows are
// unaffected).
//
// CRITICAL INVARIANT (called out by the decomposition task):
//   `execute` MUST call `bridge.broadcastTerminal(...)` to emit the terminal
//   `run_complete` / `run_failed` messages. After task-29 removes the
//   projection-change-based terminal detection from StatusBridge,
//   `broadcastTerminal` is the ONLY path for terminal messages — so if the
//   call is dropped, clients never learn a run finished.
//
// RunExecutor does NOT load workflows (the facade does) — it only consumes the
// {@link WorkflowModule} it is handed. It assumes the handle is already
// registered in the {@link RunRegistry} (the facade registers before calling
// execute).

import { join } from 'node:path';

import { resolveProfilesDirs } from '../core/config.js';
import { getRepoRoot, isGitRepo, sanitizeBranchSlug } from '../core/git.js';
import { RendererRegistry } from '../core/renderer-registry.js';
import { generateTitleAndBranch } from '../core/title-generator.js';
import type { StatusCallbacks, WorkflowModule, WorkflowRunOptions } from '../core/types.js';
import { WorktreeManager } from '../core/worktree-manager.js';
import { composeHooks } from '../hooks/compose.js';
import {
  createDefaultBeforeTaskWorktreeCreate,
  createDefaultOnCommitFailure,
  createDefaultOnMergeConflict,
  createDefaultOnRunMergeConflict,
  createDefaultPopulateWorktree,
  defaultAfterTaskWorktreeCreate,
  defaultBeforeRunMerge,
  defaultOnTaskMerge,
  defaultOnWorkflowAbort,
  defaultOnWorkflowResume,
} from '../hooks/defaults/index.js';
import type { HookContext, HookProvider } from '../hooks/types.js';
import { runWithConsoleCapture } from './console-capture.js';
import type { RunHandle, StartRunMessage } from './run-manager.js';
import type { RunRegistry } from './run-registry.js';

/**
 * Default delay (ms) before a terminal run's handle is reaped from the
 * registry. The window lets late-joining clients view the final state.
 */
const DEFAULT_REAP_DELAY_MS = 60_000;

/**
 * Runs a single workflow to completion and drives its terminal lifecycle.
 *
 * Constructed once by the {@link RunManager} facade and reused across runs:
 * `execute` is invoked fire-and-forget for each newly registered handle.
 */
export class RunExecutor {
  private readonly reapDelayMs: number;

  /**
   * @param registry      The run registry (used to schedule the reaper and
   *                      remove the handle once it has been reaped).
   * @param onRunsChanged Called whenever the active-run set changes (run
   *                      settles, handle reaped) so the control server can
   *                      broadcast a `runs` message to all clients.
   * @param reapDelayMs   Delay before a terminal run's handle is reaped.
   *                      Defaults to 60 s.
   */
  constructor(
    private readonly registry: RunRegistry,
    private readonly onRunsChanged: () => void,
    reapDelayMs: number = DEFAULT_REAP_DELAY_MS,
  ) {
    this.reapDelayMs = reapDelayMs;
  }

  /**
   * Run the workflow to completion.
   *
   * Before launching the workflow, the executor probes `isGitRepo(handle.cwd)`:
   *
   *   - **git available** — it derives a main-wt branch via
   *     `generateTitleAndBranch` + `sanitizeBranchSlug` (prefixed `engin/`),
   *     constructs a {@link WorktreeManager}, calls `setupMainWorktree()`, and
   *     wires it onto the handle (`handle.worktreeManager`, `handle.worktree`,
   *     `handle.summary.worktree`) and the `WorkflowRunOptions`. The workflow's
   *     `options.cwd` becomes the MAIN WORKTREE PATH (not the original cwd) —
   *     the transparency mechanism by which the workflow sees the worktree as
   *     its cwd.
   *   - **non-git cwd** — it warns via `console.warn` and runs in-place
   *     (`options.cwd = handle.cwd`, no worktree, no manager).
   *
   * After composing the workflow-provided hooks with the store callbacks via
   * `composeHooks`, the executor registers the DEFAULT implementations of
   * the engine-owned workflow-level hooks into the same registry:
   * `onWorkflowResume` and `onWorkflowAbort` always; `beforeRunMerge` and
   * `onRunMergeConflict` on the git path only. (The `onPersist` / `onRestore`
   * defaults are NOT registered here — the tracker they capture is owned by
   * the workflow.)
   *
   * RESUME: before launching `workflow.run()`, the executor probes the store
   * for prior events. If any exist (this is a RESUME of a previously-started
   * run), it fires `registry.invokeObserve('onWorkflowResume', { workDir,
   * tracker: undefined }, ctx)` so the workflow can restore sidebar state,
   * clear stale sessions, etc. On a fresh run (empty store) the hook is NOT
   * fired.
   *
   * On success it flushes the store (durability BEFORE the status flip), marks
   * the run complete, and broadcasts `run_complete` via
   * {@link StatusBridge.broadcastTerminal}. On failure it flushes first
   * (partial events stay durable), distinguishes `AbortError` (from
   * `controller.abort()`) from genuine errors. In the AbortError branch it
   * fires `registry.invokeObserve('onWorkflowAbort', { reason: 'Aborted',
   * workDir }, ctx)` BEFORE marking the run failed — `onWorkflowAbort` is a
   * distinct seam from any future `onWorkflowFailed` semantics. Then it marks
   * the run failed and broadcasts `run_failed`. The worktree is PRESERVED on
   * failure (no cleanup) so the user can inspect or retry — the run-end final
   * merge is driven by the user via `RunManager.handleWorktreeAction` once the
   * run is terminal, using the `handle.summary.worktree` info carried in the
   * `run_complete` broadcast. The finally block notifies the control server
   * that the active-run set changed and schedules a reaper that disposes the
   * bridge and removes the handle after the reap delay.
   *
   * The workflow execution body runs inside a {@link runWithConsoleCapture}
   * scope so any `console.warn`/`error`/`info` output made during execution
   * (including the flush/terminal/finally teardown) is routed to THIS run's
   * store as a `log` event. This is concurrency-safe: concurrent runs each
   * capture their own output via AsyncLocalStorage with no per-run mutation
   * of the global `console` object.
   */
  async execute(
    handle: RunHandle,
    workflow: WorkflowModule,
    storeCallbacks: StatusCallbacks,
    msg: StartRunMessage,
  ): Promise<void> {
    const { runId, store, controller, bridge } = handle;

    // Create a fresh renderer registry for this run and give the workflow
    // module an opportunity to register output renderers for its agent
    // profiles. When no renderers are registered (or the workflow does not
    // export registerRenderers), the registry is empty and all render calls
    // return undefined — the correct default behavior.
    const rendererRegistry = new RendererRegistry();
    if (typeof workflow.registerRenderers === 'function') {
      workflow.registerRenderers(rendererRegistry);
    }

    // ─── Hook composition seam ───────────────────────────────────────────
    //
    // Compose the engine's status-callback surface with workflow-provided
    // hooks BEFORE the worktree setup so the registry can be threaded into
    // the {@link WorktreeManager} (which invokes the worktree-lifecycle hooks
    // during `setupMainWorktree()` and `createTaskWorktree()`). `composeHooks`
    // returns:
    //  - `onStatus`     — a {@link StatusCallbacks} wrapper that delegates
    //                     every STATUS_CALLBACK_METHOD to `storeCallbacks`
    //                     verbatim (zero behavior change). Observe/influence
    //                     firing is NOT done here — it is deferred to the
    //                     engine primitives that own a proper HookContext.
    //  - `registry`     — a fresh {@link HookRegistry} carrying the workflow's
    //                     influence hooks (empty when `workflow.hooks` is
    //                     undefined — the existing-workflows path).
    //
    // When `workflow.hooks` is undefined, `workflow.hooks ?? []` feeds an
    // empty provider list into `composeHooks`, yielding an empty registry AND
    // a composed `onStatus` that is behaviorally identical to
    // `storeCallbacks` — the firmest guarantee in the hook system (existing
    // workflows are unaffected).
    const hookProviders: HookProvider = workflow.hooks ?? [];
    const { onStatus: composedStatus, registry: hookRegistry } = composeHooks(storeCallbacks, hookProviders);

    // ─── Worktree setup ──────────────────────────────────────────────────
    //
    // When the cwd is a git repo, isolate the run inside a main worktree on a
    // dedicated `engin/<slug>` branch. The branch slug is derived from the
    // task prompt via `generateTitleAndBranch` (LLM) + `sanitizeBranchSlug`.
    // The workflow sees the worktree as its cwd via `options.cwd` (the
    // transparency mechanism). When git is NOT available, warn and run
    // in-place against the original cwd.
    //
    // On the git path the worktree-lifecycle DEFAULT implementations
    // (`populateWorktree`, `beforeTaskWorktreeCreate`, `onTaskMerge`, …) are
    // registered into the SAME registry BEFORE the WorktreeManager is
    // constructed, so `setupMainWorktree()` — which invokes the
    // `populateWorktree` pipeline hook — observes the default subscriber
    // (and any workflow-provided override registered earlier by
    // `composeHooks`). The registry is then threaded to the WorktreeManager
    // via the `hookRegistry` option.
    const isGit = isGitRepo(handle.cwd);
    let worktreeManager: WorktreeManager | undefined;
    // Lifted out of the `if (isGit)` block so the merge-default registration
    // below can build `createDefaultOnRunMergeConflict` from the same
    // `profilesDirs` computed here. It stays `undefined` on the non-git
    // path — the merge + worktree defaults are NOT registered in that case
    // (there is no worktree to merge).
    let profilesDirs: string[] | undefined;

    if (isGit) {
      const repoRoot = getRepoRoot(handle.cwd);
      profilesDirs = resolveProfilesDirs(handle.cwd, handle.workflowName);

      // Register the worktree-lifecycle DEFAULTS (git path only) BEFORE
      // constructing the WorktreeManager so `setupMainWorktree()` sees them.
      // They compose WITH any workflow-provided subscriber registered earlier
      // by `composeHooks` (observe fan-out fires both; pipeline runs both in
      // order; first-wins lets the workflow's earlier-registered hook
      // decide). The defaults reproduce the legacy `.worktreecopy` /
      // squash-merge / agent-resolution UX when the workflow opts out.
      hookRegistry.register({
        beforeTaskWorktreeCreate: createDefaultBeforeTaskWorktreeCreate(),
        populateWorktree: createDefaultPopulateWorktree(handle.cwd),
        afterTaskWorktreeCreate: defaultAfterTaskWorktreeCreate,
        onTaskMerge: defaultOnTaskMerge,
        onMergeConflict: createDefaultOnMergeConflict(profilesDirs, msg.apiKeys),
        onCommitFailure: createDefaultOnCommitFailure(profilesDirs, msg.apiKeys),
      });

      const { branchName: rawBranch } = await generateTitleAndBranch({
        profilesDirs,
        taskPrompt: handle.taskPrompt,
        cwd: handle.cwd,
        apiKeys: msg.apiKeys,
      });
      const slug = sanitizeBranchSlug(rawBranch);
      const mainBranch = `engin/${slug}`;
      const mainWorktreePath = join(handle.workDir, 'worktree');

      worktreeManager = new WorktreeManager({
        repoRoot,
        sourceCwd: handle.cwd,
        workDir: handle.workDir,
        mainBranch,
        mainWorktreePath,
        profilesDirs,
        apiKeys: msg.apiKeys,
        hookRegistry,
      });
      await worktreeManager.setupMainWorktree();

      // Wire the manager + worktree info onto the handle so
      // `RunManager.handleWorktreeAction` can drive the final merge UX once
      // the run reaches a terminal state. `summary.worktree` carries the
      // same info to clients via the `run_complete` broadcast so they can
      // prompt for the merge.
      handle.worktreeManager = worktreeManager;
      handle.worktree = worktreeManager.getWorktreeInfo();
      handle.summary.worktree = {
        worktreePath: mainWorktreePath,
        branchName: mainBranch,
        originalCwd: handle.cwd,
      };
    } else {
      // Non-git: warn but continue in-place (no worktrees).
      console.warn(`[run-executor] cwd is not a git repository. Running without worktrees.`);
    }

    // ─── Default workflow-hook registration ─────────────────────────────
    //
    // The engine owns a SUBSET of the workflow-level hooks: the ones driven
    // by the engine's own lifecycle (resume, abort) and the git-driven
    // run-end final-merge pair (beforeRunMerge / onRunMergeConflict). It
    // registers their DEFAULT implementations into the SAME registry
    // `composeHooks` built, so:
    //
    //  - the engine-fired observe hooks (onWorkflowResume, onWorkflowAbort)
    //    have a well-defined (identity / log) behavior even when the
    //    workflow registers no subscriber; AND
    //  - the git-path merge hooks reproduce the legacy squash-merge /
    //    agent-resolution UX when the workflow opts out.
    //
    // DESIGN SPLIT (called out by the task and pinned by suite 7 of
    // run-executor.test.ts): the engine fires onWorkflowResume /
    // onWorkflowAbort (engine lifecycle) and registers the merge defaults
    // (git-driven; `profilesDirs` is computed in the git branch above). The
    // `onPersist` / `onRestore` defaults are NOT registered by the engine —
    // the WorkflowStatusTracker they capture is created by the WORKFLOW
    // (spir.ts), so the workflow registers those defaults itself. The engine
    // only fires hooks it owns; it does not fabricate a tracker.
    //
    // The defaults are appended AFTER `composeHooks` registers the
    // workflow's own providers, so a workflow-provided subscriber composes
    // WITH the default under the same name (observe fan-out fires both;
    // first-wins lets the workflow's earlier-registered hook decide).
    hookRegistry.register({
      onWorkflowResume: defaultOnWorkflowResume,
      onWorkflowAbort: defaultOnWorkflowAbort,
      ...(profilesDirs
        ? {
            beforeRunMerge: defaultBeforeRunMerge,
            onRunMergeConflict: createDefaultOnRunMergeConflict(profilesDirs, msg.apiKeys),
          }
        : {}),
    });

    // The per-run {@link HookContext} shared by every hook the engine fires
    // from this `execute` invocation. `cwd` is the ORIGINAL cwd (handle.cwd),
    // NOT the worktree path — hooks that need the worktree path receive it
    // via their args (e.g. BeforeRunMergeArgs.worktree). `signal` is the
    // run's AbortController signal so hooks can cooperate with cancellation.
    const hookCtx: HookContext = {
      registry: hookRegistry,
      cwd: handle.cwd,
      workDir: handle.workDir,
      signal: controller.signal,
    };

    // ─── Resume detection ─────────────────────────────────────────────────
    //
    // Before launching the workflow, probe the store for prior events. When
    // the store already has events (this is a RESUME of a previously-started
    // run, e.g. an EventStore.load() that replayed a pre-existing
    // events.jsonl), fire the `onWorkflowResume` observe hook so the
    // workflow can restore sidebar state, clear stale sessions, warm caches,
    // etc. BEFORE workflow.run() executes. On a fresh run (empty store) the
    // hook is NOT fired — the default is registered but never invoked.
    //
    // `getEventsSince(0)` returns every record with seq > 0, i.e. every
    // event in the ring buffer (loaded from disk on EventStore.load OR
    // appended in this session). A non-empty result means prior state exists.
    const isResume = store.getEventsSince(0).length > 0;
    if (isResume) {
      await hookRegistry.invokeObserve('onWorkflowResume', { workDir: handle.workDir, tracker: undefined }, hookCtx);
    }

    // Build the workflow run options. When git is available, `cwd` becomes
    // the MAIN WORKTREE PATH (the transparency mechanism). The worktree
    // manager + info are forwarded so the workflow can spawn per-task
    // worktrees off the main one. `onStatus` is the COMPOSED surface (not the
    // raw storeCallbacks) and `hookRegistry` is forwarded so workflow code
    // that constructs LanePool / calls runStepTask can pass `hookRegistry:
    // options.hookRegistry` and the engine primitives can invoke hooks at the
    // proper lifecycle seams.
    const options: WorkflowRunOptions = {
      cwd: isGit && worktreeManager ? worktreeManager.mainWorktreePath : handle.cwd,
      workDir: handle.workDir,
      onStatus: composedStatus,
      hookRegistry,
      signal: controller.signal,
      rendererRegistry,
      ...(worktreeManager ? { worktreeManager } : {}),
      ...(worktreeManager ? { worktree: worktreeManager.getWorktreeInfo() } : {}),
    };
    if (msg.maxConcurrent !== undefined) {
      options.maxConcurrentTasks = msg.maxConcurrent;
    }
    if (msg.apiKeys !== undefined) {
      options.apiKeys = msg.apiKeys;
    }

    // Run the workflow inside an async-local console capture context. Any
    // console.warn/error/info call made during execution — including the
    // flush/terminal/finally teardown below — is routed to THIS run's store as
    // a `log` event by the globally-installed console wrappers (see
    // console-capture.ts). This is concurrency-safe: concurrent runs each
    // capture their own output with no per-run mutation of the process-global
    // `console` object. console.log is intentionally not captured and the
    // originals are always forwarded to (so the server log file still gets
    // them). The context exits automatically when this scope settles, so no
    // save/restore is needed.
    await runWithConsoleCapture(store, async () => {
      try {
        await workflow.run(handle.taskPrompt, options);

        // Durability: flush BEFORE flipping status so the terminal event
        // records are on disk by the time clients see "complete".
        await store.flush();

        handle.status = 'complete';
        handle.summary.status = 'complete';
        // CRITICAL: broadcastTerminal is the ONLY path for terminal messages
        // once task-29 removes projection-change detection from StatusBridge.
        bridge.broadcastTerminal({ type: 'run_complete', runId });
      } catch (err: unknown) {
        // Flush even on error so partial events are durable.
        await store.flush();

        // Distinguish AbortError (from controller.abort()) from genuine errors.
        const isAbort = err instanceof Error && err.name === 'AbortError';

        // Abort hook: fire `onWorkflowAbort` BEFORE flipping the handle
        // status to 'failed'. This distinguishes a cooperative abort (from
        // controller.abort()) from a genuine failure — `onWorkflowAbort` is
        // a distinct seam from any future `onWorkflowFailed` semantics
        // (§7). The hook is observe fan-out: a workflow that registered no
        // subscriber still gets the default (which logs the reason via
        // console.warn, captured to this run's store as a `log` event by
        // the surrounding runWithConsoleCapture scope). Awaited so the
        // workflow can perform synchronous abort cleanup (e.g. tearing down
        // child processes) before the terminal broadcast fires.
        if (isAbort) {
          await hookRegistry.invokeObserve('onWorkflowAbort', { reason: 'Aborted', workDir: handle.workDir }, hookCtx);
        }

        const message = isAbort ? 'Run cancelled' : err instanceof Error ? err.message : String(err);

        handle.status = 'failed';
        handle.summary.status = 'failed';

        const phaseId = store.getProjection().currentPhaseId;
        // CRITICAL: broadcastTerminal is the ONLY path for terminal messages.
        bridge.broadcastTerminal({ type: 'run_failed', runId, error: message, phase: phaseId });
      } finally {
        this.onRunsChanged();

        // Schedule a reaper: once the run is no longer 'running', dispose the
        // bridge AND the run's store, then remove the handle from the registry
        // after the reap delay. Disposing the store tears down its subscribers
        // and ensures any pending coalesced writes become no-ops so they never
        // fire into a dead store. The registry gates the firing on the run
        // still being registered and terminal (see RunRegistry.scheduleReap).
        this.registry.scheduleReap(runId, this.reapDelayMs, () => {
          bridge.dispose();
          store.dispose();
          this.registry.remove(runId);
          this.onRunsChanged();
        });
      }
    });
  }
}
