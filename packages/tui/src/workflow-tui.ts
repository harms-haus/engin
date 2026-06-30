import type { ClientStore } from '@engin/shared/client-store';
import { render, type Instance, type RenderOptions } from 'ink';
import { createElement, type ReactNode } from 'react';
import { App } from './app.js';
import { TuiStore } from './tui-store.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Ink's `render()` signature. Exposed so tests can inject a stub render
 * function via {@link WorkflowTUIOptions.renderFn} instead of globally
 * mocking the `ink` module (which breaks other test files under Bun's
 * concurrent test runner).
 */
export type RenderFn = (node: ReactNode, options?: NodeJS.WriteStream | RenderOptions) => Instance;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface WorkflowTUIOptions {
  agentLogLines?: number;
  clientStore?: ClientStore;
  /** Server run identifier, shown in the detach/kill prompt. */
  runId?: string;
  /** Called when the user chooses to detach (leave run on server, exit client). */
  onDetach?: () => void;
  /** Called when the user chooses to kill (cancel the run, then exit). */
  onKill?: () => void;
  /**
   * Custom render function (defaults to Ink's `render`). Intended for tests
   * that want to avoid spinning up a real terminal.
   */
  renderFn?: RenderFn;
}

// ─── WorkflowTUI ─────────────────────────────────────────────────────────────

/**
 * Imperative shell for the engin TUI.
 *
 * Manages the lifecycle of an Ink-based terminal UI that renders workflow
 * progress (event log, phase bar, task list, agent log, QR overlay, and
 * detach/kill prompt). All rendering is handled by Ink and React components.
 *
 * The TUI is started/stopped imperatively. All user-visible state is held in
 * a {@link TuiStore} (wrapping a {@link ClientStore}) so the Ink/React tree
 * can reactively update.
 */
export class WorkflowTUI {
  private tuiStore: TuiStore | null = null;
  private instance: Instance | null = null;
  private clientStore: ClientStore | undefined;
  private runId: string | undefined;
  private readonly onDetachFn: (() => void) | undefined;
  private readonly onKillFn: (() => void) | undefined;
  private readonly renderFn: RenderFn;
  private running = false;
  private preparedQrString: string | null = null;

  constructor(options: WorkflowTUIOptions = {}) {
    this.clientStore = options.clientStore;
    this.runId = options.runId;
    this.onDetachFn = options.onDetach;
    this.onKillFn = options.onKill;
    this.renderFn = options.renderFn ?? render;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Start the TUI.
   *
   * Creates a {@link TuiStore} (which subscribes to the ClientStore),
   * renders the Ink {@link App} tree, and enters the render loop.
   *
   * If no `clientStore` was provided in the constructor this is a no-op.
   * If already running this is a no-op.
   */
  start(): void {
    if (this.running || !this.clientStore) return;

    this.tuiStore = new TuiStore(this.clientStore, {
      onDetach: () => this.invokeDetach(),
      onKill: () => this.invokeKill(),
    });

    if (this.runId) {
      this.tuiStore.setRunId(this.runId);
    }

    // Propagate a QR string prepared before start().
    if (this.preparedQrString !== null) {
      this.tuiStore.setQrString(this.preparedQrString);
    }

    this.instance = this.renderFn(createElement(App, { store: this.tuiStore }), {
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: true,
    });

    this.running = true;
  }

  /**
   * Stop the TUI.
   *
   * Unmounts the Ink tree, disposes the TuiStore (unsubscribes from the
   * ClientStore), and resets internal references. Safe to call multiple
   * times — subsequent calls after the first are no-ops.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    // Independent try/catch blocks so an unmount failure does not
    // prevent dispose or null-assignment (subscription leak safety).
    try {
      this.instance?.unmount();
    } catch (err) {
      console.error('Error during TUI unmount:', err);
    }
    this.instance = null;

    try {
      this.tuiStore?.dispose();
    } catch (err) {
      console.error('Error during TuiStore dispose:', err);
    }
    this.tuiStore = null;
  }

  // ─── QR Code Overlay ────────────────────────────────────────────

  /**
   * Pre-generate the QR string so the user can reveal it on demand via
   * Ctrl+Q. The QR is NOT rendered by default; it becomes visible only
   * after the user presses Ctrl+Q (which calls `toggleQr()` on the store).
   *
   * This is a no-op if the TUI has not been started (no tuiStore).
   */
  async prepareQrCode(url: string): Promise<void> {
    try {
      // Dynamic import inside the try block so module-load failures
      // are caught and logged (not an unhandled promise rejection).
      const { generateQrString } = await import('./components/qr-overlay.js');
      const str = await generateQrString(url);
      // Cache on the instance so a call BEFORE start() survives into
      // the TuiStore once it is created.
      this.preparedQrString = str;
      // If the TUI is already started, propagate immediately.
      this.tuiStore?.setQrString(str);
    } catch (err) {
      console.error('Failed to generate QR code overlay:', err);
    }
  }

  /**
   * Show the QR code overlay immediately by preparing the QR string and
   * toggling visibility on the store.
   */
  async showQrCode(url: string): Promise<void> {
    await this.prepareQrCode(url);
    this.tuiStore?.setQrVisible(true);
  }

  // ─── Pause for Inspection ───────────────────────────────────────

  /**
   * Keep the TUI open and fully navigable after the run completes, until
   * the user explicitly exits.
   *
   * Sets an `inspecting` flag on the store and awaits a promise that is
   * resolved ONLY by:
   *   • Ctrl+C delivered through the Ink input handler (graceful exit), or
   *   • the optional `signal` aborting.
   * Ctrl+D continues to detach immediately (unchanged).
   *
   * A single hint line is added to the event log so the user knows how
   * to exit.
   */
  async pauseForInspection(signal?: AbortSignal): Promise<void> {
    if (!this.tuiStore || !this.running) return;

    // An already-aborted signal resolves immediately without entering
    // inspecting mode (no hint line, no state mutation).
    if (signal?.aborted) return;

    const store = this.tuiStore;
    if (!store) return;

    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (this.tuiStore) {
          this.tuiStore.inspecting = false;
          this.tuiStore.resolvePause = null;
        }
        signal?.removeEventListener('abort', done);
        resolve();
      };

      store.inspecting = true;
      store.resolvePause = done;

      // Single hint line so the user knows how to exit.
      store.addEventLogLine('Workflow complete — Ctrl+C to exit · Ctrl+D to detach');

      // Allow the optional AbortSignal to resolve the pause (e.g. web terminate).
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  // ─── Accessors ───────────────────────────────────────────────────────

  /**
   * Returns the current event-log lines. Previously returned an `EventLog`
   * component instance; now returns the string array directly since the
   * CLI consumer never reads it (verified against run-session-client.ts).
   */
  getEventLog(): string[] {
    return this.tuiStore?.eventLogLines ?? [];
  }

  /**
   * Returns the current {@link TuiStore}. Previously returned a `Dashboard`
   * component instance; the CLI consumer never reads it.
   */
  getDashboard(): TuiStore | null {
    return this.tuiStore;
  }

  // ─── Run ID ───────────────────────────────────────────────────────

  /**
   * Update the runId (e.g. once `run_started` is received from the server).
   * The runId is displayed in the detach/kill prompt so the user knows which
   * run they are detaching from / killing.
   */
  setRunId(runId: string): void {
    this.runId = runId;
    this.tuiStore?.setRunId(runId);
  }

  // ─── Callback invokers ───────────────────────────────────────────────

  /**
   * Invoke the onDetach callback if configured, otherwise warn. Centralizes
   * the check-callback→invoke→warn pattern used by both the Ctrl+D shortcut
   * and the detach/kill prompt's detach action.
   */
  private invokeDetach(): void {
    if (this.onDetachFn) {
      this.onDetachFn();
    } else {
      console.warn('onDetach callback not configured — detach ignored');
    }
  }

  /**
   * Invoke the onKill callback if configured, otherwise warn. Centralizes
   * the check-callback→invoke→warn pattern used by the detach/kill prompt's
   * kill action.
   */
  private invokeKill(): void {
    if (this.onKillFn) {
      this.onKillFn();
    } else {
      console.warn('onKill callback not configured — kill ignored');
    }
  }
}
