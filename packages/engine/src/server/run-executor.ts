// ─── RunExecutor ────────────────────────────────────────────────────────────
//
// Runs a single workflow to completion and drives its terminal lifecycle:
// the workflow.run() lifecycle, store flush, status transitions
// (running → complete / failed), terminal broadcasts, renderer-registry
// wiring, the post-terminal reaper scheduling, AND the worktree lifecycle.
//
// The public `execute()` method is a slim orchestrator that delegates each
// cohesive sub-step to a dedicated private helper (see the helper docstrings
// below for their individual contracts). `execute()` composes the hooks,
// threads the registry across helpers, and drives the try/catch/finally that
// routes success vs. failure into the terminal handlers.

import { join } from 'node:path';

import { resolveProfilesDirs } from '../core/config.js';
import { getRepoRoot, isGitRepo, sanitizeBranchSlug } from '../core/git.js';
import { redactSecrets } from '../core/redact.js';
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
import type { HookRegistry } from '../hooks/registry.js';
import type { HookContext, HookProvider } from '../hooks/types.js';
import type { EventStore } from '../tracking/event-store.js';
import { runWithConsoleCapture } from './console-capture.js';
import type { RunHandle, StartRunMessage } from './run-manager.js';
import type { RunRegistry } from './run-registry.js';
import type { StatusBridge } from './status-bridge.js';

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
   * Run the workflow to completion. This is a slim orchestrator that delegates
   * each cohesive sub-step to a dedicated private helper. The helpers, in call
   * order: {@link setupRenderer}, {@link setupWorktree},
   * {@link registerDefaultHooks}, {@link detectAndFireResume},
   * {@link buildWorkflowOptions}, {@link runWithTimeoutGuard},
   * {@link handleTerminalSuccess} / {@link handleTerminalError}, and
   * {@link scheduleReaper}.
   *
   * The workflow execution body runs inside a {@link runWithConsoleCapture}
   * scope so console output made during execution (including teardown) is
   * routed to THIS run's store as a `log` event (concurrency-safe via
   * AsyncLocalStorage).
   */
  async execute(
    handle: RunHandle,
    workflow: WorkflowModule,
    storeCallbacks: StatusCallbacks,
    msg: StartRunMessage,
  ): Promise<void> {
    const { runId, store, controller, bridge } = handle;

    const rendererRegistry = this.setupRenderer(workflow);

    const hookProviders: HookProvider = workflow.hooks ?? [];
    const { onStatus: composedStatus, registry: hookRegistry } = composeHooks(storeCallbacks, hookProviders);

    const { worktreeManager, profilesDirs } = await this.setupWorktree(handle, msg, hookRegistry);

    this.registerDefaultHooks(hookRegistry, profilesDirs, msg, handle);

    const hookCtx: HookContext = {
      registry: hookRegistry,
      cwd: handle.cwd,
      workDir: handle.workDir,
      signal: controller.signal,
    };

    await this.detectAndFireResume(store, hookRegistry, hookCtx, handle.workDir);

    const options = this.buildWorkflowOptions(
      handle,
      composedStatus,
      hookRegistry,
      rendererRegistry,
      worktreeManager,
      msg,
    );

    await runWithConsoleCapture(store, async () => {
      try {
        await this.runWithTimeoutGuard(store, controller, msg, async (isTimedOut) => {
          try {
            await workflow.run(handle.taskPrompt, options);
            await this.handleTerminalSuccess(handle, store, bridge);
          } catch (err: unknown) {
            await this.handleTerminalError(handle, store, bridge, hookRegistry, hookCtx, isTimedOut(), err);
          }
        });
      } finally {
        this.scheduleReaper(runId, handle);
        this.onRunsChanged();
      }
    });
  }

  /**
   * Create a fresh renderer registry for this run and give the workflow module
   * an opportunity to register output renderers for its agent profiles. When
   * no renderers are registered (or the workflow does not export
   * registerRenderers), the registry is empty and all render calls return
   * undefined — the correct default behavior.
   */
  private setupRenderer(workflow: WorkflowModule): RendererRegistry {
    const rendererRegistry = new RendererRegistry();
    if (typeof workflow.registerRenderers === 'function') {
      workflow.registerRenderers(rendererRegistry);
    }
    return rendererRegistry;
  }

  /**
   * Set up the worktree isolation for the run.
   *
   * When the cwd is a git repo: derive a main-wt branch via
   * `generateTitleAndBranch` + `sanitizeBranchSlug` (prefixed `engin/`),
   * register the worktree-lifecycle DEFAULT hooks BEFORE constructing the
   * {@link WorktreeManager} (so `setupMainWorktree()` — which invokes the
   * `populateWorktree` pipeline hook — observes them), construct the manager,
   * call `setupMainWorktree()`, and wire it onto the handle
   * (`handle.worktreeManager`, `handle.worktree`, `handle.summary.worktree`).
   *
   * When the cwd is NOT a git repo: warn via `console.warn` and run in-place
   * (no worktree, no manager). Returns `profilesDirs` only on the git path.
   */
  private async setupWorktree(
    handle: RunHandle,
    msg: StartRunMessage,
    hookRegistry: HookRegistry,
  ): Promise<{ worktreeManager?: WorktreeManager; profilesDirs?: string[] }> {
    const isGit = isGitRepo(handle.cwd);
    if (!isGit) {
      console.warn(`[run-executor] cwd is not a git repository. Running without worktrees.`);
      return {};
    }

    const repoRoot = getRepoRoot(handle.cwd);
    const profilesDirs = resolveProfilesDirs(handle.cwd, handle.workflowName);

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

    const worktreeManager = new WorktreeManager({
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

    handle.worktreeManager = worktreeManager;
    handle.worktree = worktreeManager.getWorktreeInfo();
    handle.summary.worktree = {
      worktreePath: mainWorktreePath,
      branchName: mainBranch,
      originalCwd: handle.cwd,
    };

    return { worktreeManager, profilesDirs };
  }

  /**
   * Register the DEFAULT implementations of the engine-owned workflow-level
   * hooks into the registry built by `composeHooks`:
   *
   *   - `onWorkflowResume` / `onWorkflowAbort` — always registered (engine
   *     lifecycle).
   *   - `beforeRunMerge` / `onRunMergeConflict` — registered only on the git
   *     path (the run-end final-merge pair).
   *
   * The defaults are appended AFTER `composeHooks` registers the workflow's
   * own providers, so a workflow-provided subscriber composes WITH the default
   * under the same name.
   */
  private registerDefaultHooks(
    hookRegistry: HookRegistry,
    profilesDirs: string[] | undefined,
    msg: StartRunMessage,
    _handle: RunHandle,
  ): void {
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
  }

  /**
   * Resume detection: before launching `workflow.run()`, probe the store for
   * prior events. When the store already has events (this is a RESUME of a
   * previously-started run), fire the `onWorkflowResume` observe hook so the
   * workflow can restore sidebar state, clear stale sessions, warm caches,
   * etc. On a fresh run (empty store) the hook is NOT fired.
   */
  private async detectAndFireResume(
    store: EventStore,
    hookRegistry: HookRegistry,
    hookCtx: HookContext,
    workDir: string,
  ): Promise<void> {
    const isResume = store.getEventsSince(0).length > 0;
    if (isResume) {
      await hookRegistry.invokeObserve('onWorkflowResume', { workDir, tracker: undefined }, hookCtx);
    }
  }

  /**
   * Build the {@link WorkflowRunOptions} handed to `workflow.run()`. When git
   * is available, `cwd` becomes the MAIN WORKTREE PATH (the transparency
   * mechanism). `onStatus` is the COMPOSED surface and `hookRegistry` is
   * forwarded so engine primitives can invoke hooks at proper lifecycle seams.
   */
  private buildWorkflowOptions(
    handle: RunHandle,
    composedStatus: StatusCallbacks,
    hookRegistry: HookRegistry,
    rendererRegistry: RendererRegistry,
    worktreeManager: WorktreeManager | undefined,
    msg: StartRunMessage,
  ): WorkflowRunOptions {
    const options: WorkflowRunOptions = {
      cwd: worktreeManager ? worktreeManager.mainWorktreePath : handle.cwd,
      workDir: handle.workDir,
      onStatus: composedStatus,
      hookRegistry,
      signal: handle.controller.signal,
      rendererRegistry,
      ...(worktreeManager ? { worktreeManager } : {}),
      ...(worktreeManager ? { worktree: worktreeManager.getWorktreeInfo() } : {}),
    };
    if (msg.apiKeys !== undefined) {
      options.apiKeys = msg.apiKeys;
    }
    return options;
  }

  /**
   * Wrap the workflow execution (including terminal success/error handling)
   * with the per-run timeout guard. When `runTimeoutMs` is a positive finite
   * number, a timer is armed that sets the `runTimedOut` flag AND aborts the
   * controller so the terminal error path can distinguish "Run timed out"
   * from "Run cancelled". The timer remains active until `fn` settles (covering
   * store flush + terminal broadcast), then is always cleared in the finally.
   *
   * The `isTimedOut` callback lets the error handler inside `fn` read the
   * live flag at the point the error is handled.
   */
  private async runWithTimeoutGuard(
    _store: EventStore,
    controller: AbortController,
    msg: StartRunMessage,
    fn: (isTimedOut: () => boolean) => Promise<void>,
  ): Promise<void> {
    let runTimedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (msg.runTimeoutMs != null && Number.isFinite(msg.runTimeoutMs) && msg.runTimeoutMs > 0) {
      timer = setTimeout(() => {
        runTimedOut = true;
        controller.abort();
      }, msg.runTimeoutMs);
    }

    try {
      await fn(() => runTimedOut);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The success terminal path: flush the store (durability BEFORE the status
   * flip), run nothing-succeeded detection, then mark the run complete and
   * broadcast `run_complete` via {@link StatusBridge.broadcastTerminal}.
   *
   * Nothing-succeeded detection: when the workflow resolved but NO tasks
   * completed, treat the run as a failure by throwing an Error with counts.
   * A workflow that legitimately produces zero tasks is NOT a failure.
   */
  private async handleTerminalSuccess(handle: RunHandle, store: EventStore, bridge: StatusBridge): Promise<void> {
    await store.flush();

    const projection = store.getProjection();
    const taskEntries = Object.values(projection.tasks);
    const registeredTasks = taskEntries.length;
    if (registeredTasks > 0) {
      const completedTasks = taskEntries.filter((t) => t.status === 'complete').length;
      if (completedTasks === 0) {
        const failedTasks = taskEntries.filter((t) => t.status === 'failed').length;
        const nonTerminalStatuses = ['ready', 'blocked', 'active', 'cancelled'] as const;
        const nonTerminalParts: string[] = [];
        for (const s of nonTerminalStatuses) {
          const count = taskEntries.filter((t) => t.status === s).length;
          if (count > 0) nonTerminalParts.push(`${count} ${s}`);
        }
        const nonTerminalSummary = nonTerminalParts.length > 0 ? '; non-terminal: ' + nonTerminalParts.join(', ') : '';
        throw new Error(`Run completed with 0 successful tasks (${failedTasks} failed${nonTerminalSummary})`);
      }
    }

    handle.status = 'complete';
    handle.summary.status = 'complete';
    bridge.broadcastTerminal({
      type: 'run_complete',
      runId: handle.runId,
      ...(handle.summary.worktree ? { worktree: handle.summary.worktree } : {}),
    });
  }

  /**
   * The error terminal path: flush the store (partial events stay durable),
   * fire `onWorkflowAbort` for a cooperative abort BEFORE flipping the status,
   * then mark the run failed and broadcast `run_failed`.
   *
   * Distinguish timeout → cancel → genuine errors. `onWorkflowAbort` is fired
   * before the status flip so the workflow can perform synchronous abort
   * cleanup.
   */
  private async handleTerminalError(
    handle: RunHandle,
    store: EventStore,
    bridge: StatusBridge,
    hookRegistry: HookRegistry,
    hookCtx: HookContext,
    runTimedOut: boolean,
    err: unknown,
  ): Promise<void> {
    await store.flush();

    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort) {
      await hookRegistry.invokeObserve('onWorkflowAbort', { reason: 'Aborted', workDir: handle.workDir }, hookCtx);
    }

    const message = runTimedOut
      ? 'Run timed out'
      : isAbort
        ? 'Run cancelled'
        : redactSecrets(err instanceof Error ? err.message : String(err));

    handle.status = 'failed';
    handle.summary.status = 'failed';

    const phaseId = store.getProjection().currentPhaseId;
    bridge.broadcastTerminal({
      type: 'run_failed',
      runId: handle.runId,
      error: message,
      phase: phaseId,
      ...(handle.summary.worktree ? { worktree: handle.summary.worktree } : {}),
    });
  }

  /**
   * Schedule the post-terminal reaper: dispose the bridge and the run's store,
   * then remove the handle from the registry after the reap delay.
   */
  private scheduleReaper(runId: string, handle: RunHandle): void {
    const { store, bridge } = handle;
    this.registry.scheduleReap(runId, this.reapDelayMs, () => {
      bridge.dispose();
      store.dispose();
      this.registry.remove(runId);
      this.onRunsChanged();
    });
  }
}
