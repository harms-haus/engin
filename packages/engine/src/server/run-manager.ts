import type { ServerWebSocket } from 'bun';
import { basename } from 'node:path';

import type { ClientMessage, RunSummary, ServerMessage } from '@engin/shared/protocol-types';
import { getDefaultWorkDir, loadEnvFiles } from '../core/config.js';
import type { WorkflowModule, WorktreeInfo } from '../core/types.js';
import { loadWorkflow } from '../core/workflow-loader.js';
import type { WorktreeManager } from '../core/worktree-manager.js';
import { EventStore } from '../tracking/event-store.js';
import { createStoreCallbacks } from '../tracking/store-callbacks.js';
import { installConsoleCapture } from './console-capture.js';
import { RunExecutor } from './run-executor.js';
import { RunRegistry } from './run-registry.js';
import { StatusBridge } from './status-bridge.js';
import { SubscriptionManager } from './subscription-manager.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** The payload of a `start_run` client message (without the `type` discriminator). */
export type StartRunMessage = Omit<Extract<ClientMessage, { type: 'start_run' }>, 'type'>;

/** The lifecycle status of a run handle. */
export type RunStatus = 'running' | 'complete' | 'failed';

/**
 * Internal handle for a single workflow run. Stored in the {@link RunRegistry}
 * for the lifetime of the run (plus a short reaper window after completion so
 * late clients can view the final state).
 */
export interface RunHandle {
  /** == basename(workDir), e.g. "1781118746110-develop". */
  runId: string;
  /** Working directory the run was launched from. */
  cwd: string;
  /** Name of the workflow definition that backs this run. */
  workflowName: string;
  /** The task prompt that seeded the run. */
  taskPrompt: string;
  /** Absolute path to the run's work directory (event log lives here). */
  workDir: string;
  /** The canonical event store for this run. */
  store: EventStore;
  /** Abort controller for cooperative cancellation. */
  controller: AbortController;
  /** Per-run status bridge that broadcasts to subscribers. */
  bridge: StatusBridge;
  /** High-level lifecycle status. */
  status: RunStatus;
  /** Lightweight descriptor used in the active-run list. */
  summary: RunSummary;
  /** ISO 8601 timestamp marking when the run started. */
  startedAt: string;
  /** WebSockets currently subscribed to this run's broadcasts. */
  subscribers: Set<ServerWebSocket>;
  /** Worktree info when the run uses a git worktree. */
  worktree?: WorktreeInfo;
  /**
   * Per-run {@link WorktreeManager} owning the main + per-task worktrees.
   * Populated asynchronously by {@link RunExecutor.execute} once the main
   * worktree has been created. `undefined` while the executor is still
   * setting up (or for the non-git fallback path).
   */
  worktreeManager?: WorktreeManager;
  /**
   * Conflicts captured from the most recent `handleWorktreeAction('merge')`
   * that produced conflicts, so a follow-up `handleWorktreeAction('resolve')`
   * can forward them to `WorktreeManager.resolveFinalMergeConflicts`.
   */
  pendingMergeConflicts?: string[];
  /** API keys for agent-based git operations (merge/PR). */
  apiKeys?: Record<string, string>;
}

/** The result of {@link RunManager.startRun}. */
export interface StartRunResult {
  runId: string;
  summary: RunSummary;
}

// ─── RunManager (facade) ────────────────────────────────────────────────────

/**
 * Owns the lifecycle of concurrent workflow runs in the control server.
 *
 * Each run is identified by its `runId` (the work-directory basename). The
 * manager is now a thin facade that wires together three extracted concerns:
 *
 *   - {@link RunRegistry}          — the in-memory handle map, collision
 *                                    detection, and reaper timer.
 *   - {@link SubscriptionManager}  — per-run WebSocket subscriber fan-out.
 *   - {@link RunExecutor}          — the workflow.run() lifecycle, store flush,
 *                                    status transitions, terminal broadcasts,
 *                                    and post-terminal reaper scheduling.
 *
 * It registers a {@link RunHandle}, launches the workflow as a
 * **fire-and-forget** async operation (via the executor), and reaps the handle
 * ~60 s after the run reaches a terminal state. The public API is unchanged.
 */
export class RunManager {
  private static consoleCaptureInstalled = false;

  private readonly registry = new RunRegistry();
  private readonly subscriptions = new SubscriptionManager();
  private readonly executor: RunExecutor;

  /**
   * @param onRunsChanged Called whenever the active-run set changes (start,
   * complete, fail, cancel, reap) so the control server can broadcast a
   * `runs` message to all clients.
   */
  constructor(private readonly onRunsChanged: () => void) {
    if (!RunManager.consoleCaptureInstalled) {
      installConsoleCapture();
      RunManager.consoleCaptureInstalled = true;
    }
    this.executor = new RunExecutor(this.registry, onRunsChanged);
  }

  // ─── startRun ─────────────────────────────────────────────────────────────

  /**
   * Register and launch a new workflow run.
   *
   * This method is **fire-and-forget**: it performs all synchronous setup,
   * registers the handle, calls `onRunsChanged`, launches the workflow (via
   * {@link RunExecutor.execute}), and returns `{ runId, summary }` immediately
   * — WITHOUT awaiting the workflow.
   *
   * @throws if a run with the same `runId` is already `running` (points the
   * caller at `engin resume`).
   */
  async startRun(msg: StartRunMessage): Promise<StartRunResult> {
    // (1) Resolve workDir from msg.workDir or getDefaultWorkDir.
    const workDir = msg.workDir ?? getDefaultWorkDir(msg.cwd, msg.workflowName);

    // (2) Extract runId from workDir basename.
    const runId = basename(workDir);

    // (3) Collision check: refuse if this runId is already running.
    const existing = this.registry.get(runId);
    if (existing && existing.status === 'running') {
      throw new Error(`Run '${runId}' is already running. Use 'engin resume ${runId}' to reconnect.`);
    }

    // (4) Load the workflow module.
    const workflow: WorkflowModule = await loadWorkflow(msg.workflowName, msg.cwd);

    // (5) Load .env files from the run's cwd.
    loadEnvFiles(msg.cwd);

    // (6) Create / reload the event store.
    const store = await EventStore.load(workDir);

    // (7) Create status callbacks that fan into the store.
    const storeCallbacks = createStoreCallbacks(store);

    // (8) Create a fresh abort controller.
    const controller = new AbortController();

    // (9) Create a per-run StatusBridge whose broadcast callback tags every
    //     message with runId and routes only to this run's subscribers. The
    //     fan-out logic lives in SubscriptionManager; the bridge is handed a
    //     closure that delegates to it once the handle exists. `handleRef` is
    //     assigned below before any broadcast can fire (the store is not
    //     mutated between bridge construction and registration, and the
    //     executor is launched only after `handleRef` is set).
    const subscribers = new Set<ServerWebSocket>();
    // Forward-declared: `broadcast` (→ bridge) references `handleRef`, but the
    // handle itself needs the bridge — a circular dependency broken by this
    // mutable binding. It is assigned once below before any broadcast fires.
    // eslint-disable-next-line prefer-const
    let handleRef: RunHandle;
    const broadcast = (msg: ServerMessage): void => {
      this.subscriptions.broadcast(runId, msg, handleRef);
    };
    const bridge = new StatusBridge(broadcast, store, runId);

    // (10) Build the RunSummary.
    const startedAt = new Date().toISOString();

    // The `msg.worktree` gate has been removed — worktree setup now happens
    // asynchronously inside RunExecutor.execute (it involves LLM calls to
    // generate the branch slug and must not block startRun's fire-and-forget
    // contract). The executor creates the WorktreeManager, sets
    // `handle.worktree` and `handle.worktreeManager`, and updates
    // `handle.summary.worktree` once the main worktree exists.
    const summary: RunSummary = {
      runId,
      cwd: msg.cwd,
      workflowName: msg.workflowName,
      taskPrompt: msg.taskPrompt,
      status: 'running',
      startedAt,
    };

    // (11) Build and register the handle in the map.
    const handle: RunHandle = {
      runId,
      cwd: msg.cwd,
      workflowName: msg.workflowName,
      taskPrompt: msg.taskPrompt,
      workDir,
      store,
      controller,
      bridge,
      status: 'running',
      summary,
      startedAt,
      subscribers,
      ...(msg.apiKeys ? { apiKeys: msg.apiKeys } : {}),
    };
    handleRef = handle;
    this.registry.register(handle);

    // (12) Notify the control server that the active-run set changed.
    this.onRunsChanged();

    // (13) Launch the workflow as a FIRE-AND-FORGET async operation. Do NOT await.
    void this.executor.execute(handle, workflow, storeCallbacks, msg);

    // (14) Return immediately.
    return { runId, summary };
  }

  // ─── cancelRun ────────────────────────────────────────────────────────────

  /**
   * Cooperatively cancel a run by aborting its AbortController. Does NOT
   * throw if the runId is unknown (idempotent no-op). Does not remove the
   * handle from the registry — the executor's catch / finally blocks handle that.
   */
  cancelRun(runId: string): void {
    const handle = this.registry.get(runId);
    if (!handle) return;
    handle.controller.abort();
  }

  // ─── handleWorktreeAction ────────────────────────────────────────────────

  /**
   * Drive the two-prompt, human-in-the-loop final merge UX for a run's
   * worktree. Called when the client sends a `worktree_action` ClientMessage
   * via routeMessage.
   *
   * The WorktreeManager (set asynchronously on the handle by RunExecutor)
   * owns the underlying git + agent operations; this method orchestrates the
   * outcome-to-broadcast mapping and the cleanup-on-success-only rule:
   *
   * - **merge**    — squash-merge the main-wt branch into real `main` via
   *   `finalMergeToMain`. Clean merge → `cleanup` + outcome `clean`
   *   (with optional `cleanupError`). Conflicts → outcome `conflicts` with
   *   the worktree/branch paths (the merge is left in-progress for a follow-up
   *   `resolve` / `decline`); the conflict list is stashed on the handle so a
   *   subsequent `resolve` can forward it. Non-conflict failure → outcome
   *   `failed`. Cleanup runs ONLY on a clean merge.
   * - **resolve**  — invoke `resolveFinalMergeConflicts` with the conflicts
   *   stashed by the preceding `merge` (plus the task prompt). Resolved →
   *   `cleanup` + outcome `resolved` (with optional `cleanupError`). Failure
   *   → outcome `failed`. Cleanup runs ONLY on a successful resolve.
   * - **decline**  — abort the in-progress merge via `abortFinalMerge` and
   *   broadcast outcome `declined` with the worktree/branch paths. NEVER cleans
   *   up — the user has chosen to handle the merge manually.
   *
   * The result is broadcast to the run's subscribers via
   * {@link StatusBridge.broadcastWorktreeResult} as a `worktree_merge_result`
   * ServerMessage. No-ops silently if the runId is unknown or the handle has
   * no `worktreeManager` (e.g. the non-git fallback path).
   */
  async handleWorktreeAction(runId: string, action: 'merge' | 'resolve' | 'decline'): Promise<void> {
    const handle = this.registry.get(runId);
    if (!handle || !handle.worktreeManager) return;

    const wtm = handle.worktreeManager;
    // `handle.worktree` is the canonical WorktreeInfo (set by the executor
    // alongside `worktreeManager`). Fall back to the manager's own descriptor
    // for defensive symmetry — in production the two always agree.
    const worktreeInfo = handle.worktree ?? wtm.getWorktreeInfo();
    const worktreePath = worktreeInfo.worktreePath;
    const branchName = worktreeInfo.branchName;

    try {
      switch (action) {
        // ── merge ──────────────────────────────────────────────────────────
        case 'merge': {
          const result = await wtm.finalMergeToMain();
          if (result.success) {
            const cleanupResult = await wtm.cleanup();
            handle.bridge.broadcastWorktreeResult({
              type: 'worktree_merge_result',
              runId,
              outcome: 'clean',
              ...(cleanupResult.cleanupError ? { cleanupError: cleanupResult.cleanupError } : {}),
            });
            return;
          }
          if (result.conflicts.length > 0) {
            // Stash the conflicts so a follow-up `resolve` can forward them to
            // the agent resolver without re-deriving them from the repo state.
            handle.pendingMergeConflicts = result.conflicts;
            handle.bridge.broadcastWorktreeResult({
              type: 'worktree_merge_result',
              runId,
              outcome: 'conflicts',
              worktreePath,
              branchName,
            });
            return;
          }
          // Non-conflict failure (e.g. checkout/commit blew up) — preserve the
          // worktree for manual intervention; do NOT clean up.
          handle.bridge.broadcastWorktreeResult({
            type: 'worktree_merge_result',
            runId,
            outcome: 'failed',
            worktreePath,
            branchName,
            ...(result.error ? { error: result.error } : {}),
          });
          return;
        }

        // ── resolve ────────────────────────────────────────────────────────
        case 'resolve': {
          // Reuse the conflicts captured by the preceding `merge`. Default to an
          // empty list if none are stashed — the resolver will then no-op and
          // report failure, which is the correct surfacing for an out-of-order
          // `resolve`.
          const conflicts = handle.pendingMergeConflicts ?? [];
          const resolveResult = await wtm.resolveFinalMergeConflicts(conflicts, handle.taskPrompt);
          if (resolveResult.resolved) {
            const cleanupResult = await wtm.cleanup();
            handle.bridge.broadcastWorktreeResult({
              type: 'worktree_merge_result',
              runId,
              outcome: 'resolved',
              ...(cleanupResult.cleanupError ? { cleanupError: cleanupResult.cleanupError } : {}),
            });
            return;
          }
          handle.bridge.broadcastWorktreeResult({
            type: 'worktree_merge_result',
            runId,
            outcome: 'failed',
            worktreePath,
            branchName,
            ...(resolveResult.error ? { error: resolveResult.error } : {}),
          });
          return;
        }

        // ── decline ────────────────────────────────────────────────────────
        case 'decline': {
          // Best-effort abort; the merge may or may not be in progress.
          try {
            await wtm.abortFinalMerge();
          } catch {
            // No merge in progress — nothing to abort (e.g. the user declined
            // before any merge was ever attempted).
          }
          handle.bridge.broadcastWorktreeResult({
            type: 'worktree_merge_result',
            runId,
            outcome: 'declined',
            worktreePath,
            branchName,
          });
          return;
        }
      }
    } catch (err) {
      // SURFACE failures instead of letting them propagate to the message
      // router's catch (which only logs). Without this, a thrown git error
      // (e.g. `commitChanges` blowing up on an empty squash, a checkout
      // failure, or an aborted merge) leaves the run-end merge result
      // UNBROADCAST — the client's `waitForResult()` then hangs for its full
      // 60s timeout and the worktree is left unmerged with no diagnostic.
      // Broadcasting `failed` here guarantees the client always receives a
      // terminal outcome (clean | conflicts | resolved | declined | failed)
      // and surfaces a manual-merge hint with the underlying error.
      const error = err instanceof Error ? err.message : String(err);
      handle.bridge.broadcastWorktreeResult({
        type: 'worktree_merge_result',
        runId,
        outcome: 'failed',
        worktreePath,
        branchName,
        error,
      });
    }
  }

  // ─── listRuns / getRun ────────────────────────────────────────────────────

  /** Return a {@link RunSummary} for every registered run. */
  listRuns(): RunSummary[] {
    return this.registry.listRuns();
  }

  /** Return the {@link RunSummary} for a single run, or `undefined`. */
  getRun(runId: string): RunSummary | undefined {
    return this.registry.get(runId)?.summary;
  }

  // ─── Subscription management ──────────────────────────────────────────────

  /** Subscribe a WebSocket to a run's broadcasts. */
  subscribe(ws: ServerWebSocket, runId: string): void {
    const handle = this.registry.get(runId);
    if (!handle) return;
    this.subscriptions.subscribe(ws, runId, handle);
  }

  /** Unsubscribe a WebSocket from a specific run's broadcasts. */
  unsubscribe(ws: ServerWebSocket, runId: string): void {
    const handle = this.registry.get(runId);
    if (!handle) return;
    this.subscriptions.unsubscribe(ws, runId, handle);
  }

  /** Unsubscribe a WebSocket from ALL runs. */
  unsubscribeAll(ws: ServerWebSocket): void {
    for (const handle of this.registry.values()) {
      this.subscriptions.unsubscribeAll(ws, handle);
    }
  }

  // ─── Resync ───────────────────────────────────────────────────────────────

  /**
   * Handle a resync request from a client for a specific run. Sends either an
   * events catch-up (when `lastSeq` is within the ring buffer) or a full
   * snapshot, tagged with `runId`, directly to the requesting WebSocket.
   */
  handleResync(ws: ServerWebSocket, runId: string, lastSeq?: number): void {
    const handle = this.registry.get(runId);
    if (!handle) return;
    const msg = handle.bridge.handleResync(lastSeq);
    const payload = JSON.stringify(msg);
    try {
      ws.send(payload);
    } catch {
      // Ignore send errors on stale sockets.
    }
  }

  // ─── shutdownAll ──────────────────────────────────────────────────────────

  /**
   * Cancel every active run, flush every store, and dispose every bridge.
   * Used during graceful server shutdown. Idempotent. Does not remove handles
   * from the registry — the executor's finally blocks reap them after their
   * runs settle.
   */
  async shutdownAll(): Promise<void> {
    // Arm shutdown mode FIRST so any executor finally-block reap armed AFTER
    // cancelAllReap (below) executes synchronously instead of leaking a
    // deferred timer past teardown.
    this.registry.beginShutdown();
    // Snapshot the handles so abort/flush/dispose iterate a stable set even if
    // a reaper fires concurrently during shutdown.
    const handles = Array.from(this.registry.values());

    // Cancel all runs (cooperative abort).
    for (const handle of handles) {
      handle.controller.abort();
    }
    // Cancel every pending reap timer so no reaper survives shutdown.
    this.registry.cancelAllReap();
    // Flush all stores so partial events are durable.
    for (const handle of handles) {
      try {
        await handle.store.flush();
      } catch {
        // Best-effort flush.
      }
    }
    // Dispose all bridges.
    for (const handle of handles) {
      handle.bridge.dispose();
    }
  }
}
