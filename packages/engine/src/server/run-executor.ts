// ─── RunExecutor ────────────────────────────────────────────────────────────
//
// Workflow execution body extracted from RunManager (decomposition step). It
// contains the former private `executeWorkflow` async IIFE: the workflow.run()
// lifecycle, store flush, status transitions (running → complete / failed),
// terminal broadcasts, renderer-registry wiring, and the post-terminal reaper
// scheduling.
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

import { RendererRegistry } from '../core/renderer-registry.js';
import type { StatusCallbacks, WorkflowModule, WorkflowRunOptions } from '../core/types.js';
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
   * On success it flushes the store (durability BEFORE the status flip), marks
   * the run complete, and broadcasts `run_complete` via
   * {@link StatusBridge.broadcastTerminal}. On failure it flushes first
   * (partial events stay durable), distinguishes `AbortError` (from
   * `controller.abort()`) from genuine errors, marks the run failed, and
   * broadcasts `run_failed`. The finally block notifies the control server
   * that the active-run set changed and schedules a reaper that disposes the
   * bridge and removes the handle after the reap delay.
   *
   * The entire body runs inside a {@link runWithConsoleCapture} scope so any
   * `console.warn`/`error`/`info` output made during execution (including the
   * flush/terminal/finally teardown) is routed to THIS run's store as a `log`
   * event. This is concurrency-safe: concurrent runs each capture their own
   * output via AsyncLocalStorage with no per-run mutation of the global
   * `console` object.
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
        // CRITICAL: broadcastTerminal is the ONLY path for terminal messages
        // once task-29 removes projection-change detection from StatusBridge.
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
