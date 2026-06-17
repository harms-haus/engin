import type { ServerWebSocket } from 'bun';
import { basename } from 'node:path';

import type { ClientMessage, RunSummary, ServerMessage } from '@engin/shared/protocol-types';
import { getDefaultWorkDir, loadEnvFiles, resolveProfilesDirs } from '../core/config.js';
import {
  abortMerge,
  checkoutBranch,
  commitChanges,
  getCurrentBranch,
  getDiff,
  getMainBranch,
  mergeBranch,
  removeWorktree,
  stageAll,
} from '../core/git.js';
import { RendererRegistry } from '../core/renderer-registry.js';
import type { StatusCallbacks, WorkflowModule, WorkflowRunOptions, WorktreeInfo } from '../core/types.js';
import { loadWorkflow } from '../core/workflow-loader.js';
import {
  generateCommitMessage,
  pushAndCreatePR,
  resolveConflictsWithAgent,
  setupWorktree,
} from '../core/worktree-lifecycle.js';
import { EventStore } from '../tracking/event-store.js';
import { createStoreCallbacks } from '../tracking/store-callbacks.js';
import { installConsoleCapture, runWithConsoleCapture } from './console-capture.js';
import { StatusBridge } from './status-bridge.js';

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
 * Internal handle for a single workflow run. Stored in the RunManager's
 * in-memory registry for the lifetime of the run (plus a short reaper window
 * after completion so late clients can view the final state).
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

// ─── RunManager ──────────────────────────────────────────────────────────────

/**
 * Owns the lifecycle of concurrent workflow runs in the control server.
 *
 * Each run is identified by its `runId` (the work-directory basename). The
 * manager registers a {@link RunHandle} in an in-memory map, launches the
 * workflow as a **fire-and-forget** async IIFE, and reaps the handle ~60 s
 * after the run reaches a terminal state.
 */
export class RunManager {
  private readonly runs = new Map<string, RunHandle>();

  /**
   * @param onRunsChanged Called whenever the active-run set changes (start,
   * complete, fail, cancel, reap) so the control server can broadcast a
   * `runs` message to all clients.
   */
  constructor(private readonly onRunsChanged: () => void) {}

  // ─── startRun ─────────────────────────────────────────────────────────────

  /**
   * Register and launch a new workflow run.
   *
   * This method is **fire-and-forget**: it performs all synchronous setup,
   * registers the handle, calls `onRunsChanged`, launches the workflow inside
   * an async IIFE, and returns `{ runId, summary }` immediately — WITHOUT
   * awaiting the workflow.
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
    const existing = this.runs.get(runId);
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
    //     message with runId and routes only to this run's subscribers.
    const subscribers = new Set<ServerWebSocket>();
    const broadcast = (msg: ServerMessage): void => {
      const payload = JSON.stringify(msg);
      for (const ws of subscribers) {
        if (ws.readyState === 1) {
          try {
            ws.send(payload);
          } catch {
            // Ignore send errors on stale sockets.
          }
        }
      }
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

    // (11) Register the handle in the map.
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
    this.runs.set(runId, handle);

    // (12) Notify the control server that the active-run set changed.
    this.onRunsChanged();

    // (13) Launch the workflow as a FIRE-AND-FORGET async IIFE. Do NOT await.
    void this.executeWorkflow(handle, workflow, storeCallbacks, msg);

    // (14) Return immediately.
    return { runId, summary };
  }

  // ─── Workflow execution (async IIFE body) ─────────────────────────────────

  /**
   * The async IIFE body that runs the workflow to completion. On success it
   * flushes the store (durability BEFORE the status flip), marks the run
   * complete, and broadcasts `run_complete`. On failure it flushes first
   * (partial events stay durable), distinguishes AbortError from genuine
   * errors, marks the run failed, and broadcasts `run_failed`. The finally
   * block notifies the control server and schedules a 60 s reaper.
   */
  private async executeWorkflow(
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

    // Build the workflow run options.
    const options: WorkflowRunOptions = {
      cwd: handle.cwd,
      workDir: handle.workDir,
      onStatus: storeCallbacks,
      signal: controller.signal,
      rendererRegistry,
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
        bridge.broadcastTerminal({ type: 'run_complete', runId });
      } catch (err: unknown) {
        // Flush even on error so partial events are durable.
        await store.flush();

        // Distinguish AbortError (from controller.abort()) from genuine errors.
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const message = isAbort ? 'Run cancelled' : err instanceof Error ? err.message : String(err);

        handle.status = 'failed';
        handle.summary.status = 'failed';

        const phaseId = store.getProjection().currentPhaseId;
        bridge.broadcastTerminal({ type: 'run_failed', runId, error: message, phase: phaseId });
      } finally {
        this.onRunsChanged();

        // Schedule a reaper: once the run is no longer 'running', dispose the
        // bridge and remove the handle from the registry after 60 s.
        setTimeout(() => {
          if (handle.status !== 'running') {
            bridge.dispose();
            this.runs.delete(runId);
            this.onRunsChanged();
          }
        }, 60_000);
      }
    });
  }

  // ─── cancelRun ────────────────────────────────────────────────────────────

  /**
   * Cooperatively cancel a run by aborting its AbortController. Does NOT
   * throw if the runId is unknown (idempotent no-op). Does not remove the
   * handle from the registry — the IIFE's catch / finally blocks handle that.
   */
  cancelRun(runId: string): void {
    const handle = this.runs.get(runId);
    if (!handle) return;
    handle.controller.abort();
  }

  // ─── handleWorktreeAction ────────────────────────────────────────────────

  /**
   * T33: Perform a post-run worktree action on the server. Called when the
   * client sends a `worktree_action` ClientMessage via routeMessage.
   *
   * - **keep**    — leave the worktree on disk (no-op).
   * - **discard** — remove the worktree directory.
   * - **merge**   — commit changes in the worktree and merge the branch into
   *   the main branch (with agent-based conflict resolution).
   * - **pr**      — commit, push the branch, and create a pull request.
   *
   * No-ops silently if the runId is unknown or has no worktree.
   */
  async handleWorktreeAction(runId: string, action: 'keep' | 'discard' | 'merge' | 'pr'): Promise<void> {
    const handle = this.runs.get(runId);
    if (!handle || !handle.worktree) return;

    const wt = handle.worktree;
    const repoRoot = wt.originalCwd || handle.cwd;
    const profilesDirs = resolveProfilesDirs(handle.cwd, handle.workflowName);

    switch (action) {
      case 'keep':
        return;

      case 'discard': {
        try {
          removeWorktree(repoRoot, wt.worktreePath);
          handle.worktree = undefined;
        } catch {
          console.error(`⚠️ Could not remove worktree at ${wt.worktreePath}`);
        }
        return;
      }

      case 'merge': {
        let savedBranch: string | undefined;
        try {
          // Commit changes in the worktree.
          const diff = getDiff(wt.worktreePath);
          if (diff) {
            stageAll(wt.worktreePath);
            const message = await generateCommitMessage(
              profilesDirs,
              wt.worktreePath,
              handle.taskPrompt,
              diff,
              handle.apiKeys,
            );
            commitChanges(wt.worktreePath, message);
          }

          const mainBranch = getMainBranch(repoRoot);
          savedBranch = getCurrentBranch(repoRoot);
          checkoutBranch(repoRoot, mainBranch);
          const result = mergeBranch(repoRoot, wt.branchName);

          if (!result.success) {
            const resolved = await resolveConflictsWithAgent(
              profilesDirs,
              repoRoot,
              result.conflicts,
              handle.taskPrompt,
              handle.apiKeys,
            );
            if (resolved) {
              commitChanges(repoRoot, `Merge resolution: ${wt.branchName} into ${mainBranch}`);
            } else {
              abortMerge(repoRoot);
            }
          }
        } catch (err) {
          console.error(
            `⚠️ worktree action '${action}' failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (savedBranch) {
          try {
            checkoutBranch(repoRoot, savedBranch);
          } catch {
            // Ignore - may be detached HEAD.
          }
        }
        try {
          removeWorktree(repoRoot, wt.worktreePath);
        } catch {
          // Best-effort cleanup.
        }
        return;
      }

      case 'pr': {
        try {
          // Commit changes in the worktree.
          const diff = getDiff(wt.worktreePath);
          if (diff) {
            stageAll(wt.worktreePath);
            const message = await generateCommitMessage(
              profilesDirs,
              wt.worktreePath,
              handle.taskPrompt,
              diff,
              handle.apiKeys,
            );
            commitChanges(wt.worktreePath, message);
          }

          let title = handle.taskPrompt;
          if (title.length > 60) {
            title = title.slice(0, 57) + '...';
          }

          await pushAndCreatePR(profilesDirs, repoRoot, wt.branchName, handle.taskPrompt, title, handle.apiKeys);
        } catch (err) {
          console.error(
            `⚠️ worktree action '${action}' failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        try {
          removeWorktree(repoRoot, wt.worktreePath);
        } catch {
          // Best-effort cleanup.
        }
        return;
      }
    }
  }

  // ─── listRuns / getRun ────────────────────────────────────────────────────

  /** Return a {@link RunSummary} for every registered run. */
  listRuns(): RunSummary[] {
    return Array.from(this.runs.values(), (h) => h.summary);
  }

  /** Return the {@link RunSummary} for a single run, or `undefined`. */
  getRun(runId: string): RunSummary | undefined {
    return this.runs.get(runId)?.summary;
  }

  // ─── Subscription management ──────────────────────────────────────────────

  /** Subscribe a WebSocket to a run's broadcasts. */
  subscribe(ws: ServerWebSocket, runId: string): void {
    const handle = this.runs.get(runId);
    if (!handle) return;
    handle.subscribers.add(ws);
  }

  /** Unsubscribe a WebSocket from a specific run's broadcasts. */
  unsubscribe(ws: ServerWebSocket, runId: string): void {
    const handle = this.runs.get(runId);
    if (!handle) return;
    handle.subscribers.delete(ws);
  }

  /** Unsubscribe a WebSocket from ALL runs. */
  unsubscribeAll(ws: ServerWebSocket): void {
    for (const handle of this.runs.values()) {
      handle.subscribers.delete(ws);
    }
  }

  // ─── Resync ───────────────────────────────────────────────────────────────

  /**
   * Handle a resync request from a client for a specific run. Sends either an
   * events catch-up (when `lastSeq` is within the ring buffer) or a full
   * snapshot, tagged with `runId`, directly to the requesting WebSocket.
   */
  handleResync(ws: ServerWebSocket, runId: string, lastSeq?: number): void {
    const handle = this.runs.get(runId);
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
   * Used during graceful server shutdown. Idempotent.
   */
  async shutdownAll(): Promise<void> {
    // Cancel all runs (cooperative abort).
    for (const handle of this.runs.values()) {
      handle.controller.abort();
    }
    // Flush all stores so partial events are durable.
    for (const handle of this.runs.values()) {
      try {
        await handle.store.flush();
      } catch {
        // Best-effort flush.
      }
    }
    // Dispose all bridges.
    for (const handle of this.runs.values()) {
      handle.bridge.dispose();
    }
  }
}
