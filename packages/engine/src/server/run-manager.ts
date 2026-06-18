import type { ServerWebSocket } from 'bun';
import { basename } from 'node:path';

import type { ClientMessage, RunSummary, ServerMessage } from '@engin/shared/protocol-types';
import { getDefaultWorkDir, loadEnvFiles, resolveProfilesDirs } from '../core/config.js';
import type { WorkflowModule, WorktreeInfo } from '../core/types.js';
import { loadWorkflow } from '../core/workflow-loader.js';
import { setupWorktree } from '../core/worktree-lifecycle.js';
import { cleanupWorktree, mergeWorktreeToMain, pushWorktreeAndCreatePR } from '../core/worktree-operations.js';
import { EventStore } from '../tracking/event-store.js';
import { createStoreCallbacks } from '../tracking/store-callbacks.js';
import { installConsoleCapture } from './console-capture.js';
import { RunExecutor } from './run-executor.js';
import { RunRegistry } from './run-registry.js';
import { StatusBridge } from './status-bridge.js';
import { SubscriptionManager } from './subscription-manager.js';

// Install the global console capture ONCE at module load. The wrappers route
// per-run console.warn/error/info output to the active run's store via
// AsyncLocalStorage (see console-capture.ts). Idempotent and inert outside any
// run context, so it is safe to call at import time. Replacing the per-run
// save/restore of the process-global `console` with async-context routing
// fixes the concurrent-run capture corruption (deferred item CQ-H3).
installConsoleCapture();

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
  /** T33: Worktree info when the run uses a git worktree. */
  worktree?: WorktreeInfo;
  /** T33: API keys for agent-based git operations (merge/PR). */
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
 * ~60 s after the run reaches a terminal state. The public API is unchanged
 * from the pre-decomposition RunManager.
 */
export class RunManager {
  private readonly registry = new RunRegistry();
  private readonly subscriptions = new SubscriptionManager();
  private readonly executor: RunExecutor;

  /**
   * @param onRunsChanged Called whenever the active-run set changes (start,
   * complete, fail, cancel, reap) so the control server can broadcast a
   * `runs` message to all clients.
   */
  constructor(private readonly onRunsChanged: () => void) {
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

    // T33: When worktree is requested, create the worktree BEFORE launching
    // the workflow. Store WorktreeInfo on the handle and include it in the
    // RunSummary so the client receives it via the run_started reply.
    let worktree: WorktreeInfo | undefined;
    if (msg.worktree) {
      const profilesDirs = resolveProfilesDirs(msg.cwd, msg.workflowName);
      // setupWorktree disposes its harness on failure; any partially-created
      // worktree directory is a known limitation (setupWorktree does not expose
      // partial cleanup on throw).
      const setupResult = await setupWorktree(msg.cwd, profilesDirs, msg.taskPrompt, msg.apiKeys);
      worktree = setupResult.worktreeInfo;
    }

    const summary: RunSummary = {
      runId,
      cwd: msg.cwd,
      workflowName: msg.workflowName,
      taskPrompt: msg.taskPrompt,
      status: 'running',
      startedAt,
      ...(worktree ? { worktree } : {}),
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
      ...(worktree ? { worktree } : {}),
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
   * T33: Perform a post-run worktree action on the server. Called when the
   * client sends a `worktree_action` ClientMessage via routeMessage.
   *
   * - **keep**    — leave the worktree on disk (no-op).
   * - **discard** — remove the worktree directory (best-effort, silent on failure).
   * - **merge**   — commit changes in the worktree and merge the branch into
   *   the main branch (with agent-based conflict resolution). On unresolved
   *   conflicts the merge is aborted and the worktree is preserved for manual
   *   intervention.
   * - **pr**      — commit, push the branch, and create a pull request. The
   *   worktree is removed after the PR is created.
   *
   * Delegates to the shared `worktree-operations` module so the git + agent
   * orchestration is identical between the server and the CLI. No-ops silently
   * if the runId is unknown or has no worktree.
   */
  async handleWorktreeAction(runId: string, action: 'keep' | 'discard' | 'merge' | 'pr'): Promise<void> {
    const handle = this.registry.get(runId);
    if (!handle || !handle.worktree) return;

    const wt = handle.worktree;
    const repoRoot = wt.originalCwd || handle.cwd;
    const profilesDirs = resolveProfilesDirs(handle.cwd, handle.workflowName);

    switch (action) {
      case 'keep':
        return;

      case 'discard': {
        // Best-effort, silent cleanup (errors are swallowed by cleanupWorktree).
        await cleanupWorktree(repoRoot, wt.worktreePath);
        handle.worktree = undefined;
        return;
      }

      case 'merge': {
        try {
          await mergeWorktreeToMain({
            profilesDirs,
            repoRoot,
            worktreePath: wt.worktreePath,
            branchName: wt.branchName,
            taskPrompt: handle.taskPrompt,
            apiKeys: handle.apiKeys,
          });
        } catch (err) {
          console.error(
            `⚠️ worktree action '${action}' failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      case 'pr': {
        try {
          // Title truncation is the caller's responsibility (the shared
          // module forwards the title verbatim).
          let title = handle.taskPrompt;
          if (title.length > 60) {
            title = title.slice(0, 57) + '...';
          }

          await pushWorktreeAndCreatePR({
            profilesDirs,
            repoRoot,
            worktreePath: wt.worktreePath,
            branchName: wt.branchName,
            taskPrompt: handle.taskPrompt,
            title,
            apiKeys: handle.apiKeys,
          });
        } catch (err) {
          console.error(
            `⚠️ worktree action '${action}' failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
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
    // Snapshot the handles so abort/flush/dispose iterate a stable set even if
    // a reaper fires concurrently during shutdown.
    const handles = Array.from(this.registry.values());

    // Cancel all runs (cooperative abort).
    for (const handle of handles) {
      handle.controller.abort();
    }
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
