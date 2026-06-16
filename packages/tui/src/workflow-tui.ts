import {
  Key,
  matchesKey,
  ProcessTerminal,
  TUI,
  type Component,
  type OverlayHandle,
  type Terminal,
} from '@earendil-works/pi-tui';
import type { ClientStore } from '@engin/shared/client-store';
import { Dashboard } from './components/dashboard.js';
import { createDetachKillPrompt, type DetachKillAction } from './components/detach-kill-prompt.js';
import { EventLog } from './components/event-log.js';
import { createQrOverlayComponent } from './components/qr-overlay.js';
import { dim } from './theme.js';
import { createWsBackedTui } from './ws-backed-tui.js';

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
}

// ─── Separator Component ─────────────────────────────────────────────────────

const separatorComponent: Component = {
  render(width: number): string[] {
    return [dim('─'.repeat(width))];
  },
  invalidate(): void {
    // Stateless – nothing to invalidate
  },
  handleInput(_data: string): void {
    // No input handling for separator
  },
};

// ─── QR Overlay Options ────────────────────────────────────────────────────

const QR_OVERLAY_OPTIONS = {
  anchor: 'top-right' as const,
  nonCapturing: true,
  margin: { top: 1, right: 1 },
};

// ─── Detach/Kill Prompt Overlay Options ────────────────────────────────────

const PROMPT_OVERLAY_OPTIONS = {
  anchor: 'center' as const,
};

// ─── WorkflowTUI ─────────────────────────────────────────────────────────────

export class WorkflowTUI {
  private tui: TUI | null = null;
  private terminal: ProcessTerminal | null = null;
  private readonly eventLog: EventLog;
  private readonly dashboard: Dashboard;
  private readonly agentLogLines: number;
  private readonly clientStore: ClientStore | undefined;
  private runId: string | undefined;
  private readonly onDetachFn: (() => void) | undefined;
  private readonly onKillFn: (() => void) | undefined;
  private storeDispose: (() => void) | null = null;
  private running = false;
  private inputUnsubscribe: (() => void) | null = null;
  private qrHandle: OverlayHandle | null = null;
  private pendingQrComponent: Component | null = null;
  private promptHandle: OverlayHandle | null = null;

  constructor(options: WorkflowTUIOptions = {}) {
    this.agentLogLines = options.agentLogLines ?? 20;
    this.clientStore = options.clientStore;
    this.runId = options.runId;
    this.onDetachFn = options.onDetach;
    this.onKillFn = options.onKill;

    this.eventLog = new EventLog();
    this.dashboard = new Dashboard(this.agentLogLines);

    // If a client store is provided, subscribe to it so the TUI stays in sync.
    if (this.clientStore) {
      this.storeDispose = createWsBackedTui({
        clientStore: this.clientStore,
        eventLog: this.eventLog,
        dashboard: this.dashboard,
        requestRender: () => {
          this.tui?.requestRender();
        },
      }).dispose;
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;

    const terminal = new ProcessTerminal();
    this.terminal = terminal;

    const tui = new TUI(terminal as unknown as Terminal);
    this.tui = tui;

    tui.addChild(this.eventLog);
    tui.addChild(separatorComponent);
    tui.addChild(this.dashboard);

    const computedMaxLines = Math.max(3, terminal.rows - this.dashboard.getComputedHeight() - 1);
    this.eventLog.setMaxLines(computedMaxLines);

    tui.setFocus(this.eventLog);

    this.inputUnsubscribe = tui.addInputListener((data: string) => {
      // Ctrl+D: immediate detach (no prompt) — must precede the promptHandle
      // guard so it works even while the detach/kill prompt is visible.
      if (matchesKey(data, Key.ctrl('d'))) {
        this.invokeDetach();
        return { consume: true };
      }

      // When the detach/kill prompt is visible, let all remaining input pass
      // through to the focused overlay component (it handles its own
      // navigation, confirm, and dismiss).
      if (this.promptHandle) {
        return undefined;
      }

      // Ctrl+C: show detach/kill prompt (replaces old abort-counter logic)
      if (matchesKey(data, Key.ctrl('c'))) {
        this.showDetachKillPrompt();
        this.tui?.requestRender();
        return { consume: true };
      }

      // Left/Right: select phase (routes to phaseBar)
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        this.dashboard.handleInput(data);
        this.tui?.requestRender();
        return { consume: true };
      }

      // Up/Down: task nav when collapsed, scroll when expanded
      if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
        this.dashboard.handleInput(data);
        this.tui?.requestRender();
        return { consume: true };
      }

      // Tab / Shift+Tab: cycle steps in agent log (delegate to dashboard)
      if (matchesKey(data, 'tab') || matchesKey(data, Key.shift('tab'))) {
        this.dashboard.handleInput(data);
        this.tui?.requestRender();
        return { consume: true };
      }

      // Spacebar: expand/collapse agent log widget
      if (matchesKey(data, Key.space)) {
        this.dashboard.agentLog.toggleExpand();
        const terminalRows = this.terminal?.rows ?? 24;
        const computedMaxLines = Math.max(3, terminalRows - this.dashboard.getComputedHeight() - 1);
        this.eventLog.setMaxLines(computedMaxLines);
        this.tui?.requestRender();
        return { consume: true };
      }

      // Shift+Up/Shift+Down: scroll by 10 when expanded, fall through when not
      if (matchesKey(data, Key.shift('up')) || matchesKey(data, Key.shift('down'))) {
        if (this.dashboard.agentLog.isExpanded()) {
          this.dashboard.handleInput(data);
          this.tui?.requestRender();
          return { consume: true };
        }
        // Fall through when not expanded
      }

      // PgUp/PgDn/Home/End: scroll the event log
      if (
        matchesKey(data, 'pageUp') ||
        matchesKey(data, 'pageDown') ||
        matchesKey(data, 'home') ||
        matchesKey(data, 'end')
      ) {
        this.eventLog.handleInput(data);
        this.tui?.requestRender();
        return { consume: true };
      }

      return undefined;
    });

    tui.start();
    this.running = true;

    // Attach a QR overlay prepared via prepareQrCode() so it is part of the
    // first render. requestRender() is debounced, so this showOverlay() lands in
    // the same first render that tui.start() scheduled — painting the QR via the
    // initial full repaint rather than a later incremental one that may skip it.
    if (this.pendingQrComponent) {
      this.qrHandle = tui.showOverlay(this.pendingQrComponent, QR_OVERLAY_OPTIONS);
      this.pendingQrComponent = null;
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    try {
      this.storeDispose?.();
      this.storeDispose = null;
      this.inputUnsubscribe?.();
      this.inputUnsubscribe = null;
      this.qrHandle?.hide();
      this.qrHandle = null;
      this.promptHandle?.hide();
      this.promptHandle = null;
      this.tui?.stop();
    } catch (err) {
      console.error('Error during TUI cleanup:', err);
    }
  }

  // ─── QR Code Overlay ────────────────────────────────────────────

  /**
   * Pre-generate the QR overlay component so start() can attach it BEFORE the
   * first render fires. The initial render is the only scrollback-safe full
   * repaint; any later (incremental) render can fail to paint newly-added
   * overlay rows (a pi-tui differential-rendering edge case where the rows land
   * in the diff baseline without being drawn), causing the QR to flash and
   * vanish. Call this before start(); the component is attached in start().
   */
  async prepareQrCode(url: string): Promise<void> {
    try {
      this.pendingQrComponent = (await createQrOverlayComponent(url)).component;
    } catch (err) {
      console.error('Failed to generate QR code overlay:', err);
    }
  }

  async showQrCode(url: string): Promise<void> {
    if (this.qrHandle) {
      this.qrHandle.hide();
      this.qrHandle = null;
    }

    let component: Component;
    try {
      component = (await createQrOverlayComponent(url)).component;
    } catch (err) {
      console.error('Failed to generate QR code overlay:', err);
      return;
    }

    this.qrHandle = this.tui?.showOverlay(component, QR_OVERLAY_OPTIONS) ?? null;
    this.tui?.requestRender();
  }

  // ─── Detach/Kill Prompt ────────────────────────────────────────────

  /**
   * Show the detach/kill prompt overlay. If the prompt is already visible
   * this is a no-op.
   */
  private showDetachKillPrompt(): void {
    if (this.promptHandle) return;

    const component = createDetachKillPrompt({
      runId: this.runId,
      onConfirm: (action: DetachKillAction) => {
        this.dismissDetachKillPrompt();
        if (action === 'detach') {
          this.invokeDetach();
        } else {
          this.invokeKill();
        }
      },
      onDismiss: () => {
        this.dismissDetachKillPrompt();
      },
    });

    this.promptHandle = this.tui?.showOverlay(component, PROMPT_OVERLAY_OPTIONS) ?? null;
  }

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

  /** Hide and clear the detach/kill prompt overlay. */
  private dismissDetachKillPrompt(): void {
    this.promptHandle?.hide();
    this.promptHandle = null;
  }

  // ─── Pause for Inspection ───────────────────────────────────────

  async pauseForInspection(signal?: AbortSignal): Promise<void> {
    if (!this.tui || !this.running) return;

    return new Promise<void>((resolve) => {
      // If already aborted, resolve immediately
      if (signal?.aborted) {
        resolve();
        return;
      }

      // Show message
      this.eventLog.addLine('');
      this.eventLog.addLine('Workflow complete. Press Ctrl+C or Escape to quit.');
      this.tui?.requestRender();

      // Unsubscribe main input handler to prevent its Ctrl+C abort logic
      const mainUnsub = this.inputUnsubscribe;
      mainUnsub?.();

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        pauseUnsub?.();
        storeUnsub?.();
        resolve();
      };

      // Add pause-specific input listener
      const pauseUnsub = this.tui?.addInputListener((data: string) => {
        if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, 'escape')) {
          done();
          return { consume: true };
        }
        return undefined;
      });

      // Subscribe to the client store so the pause also resolves when the run
      // reaches a terminal status (complete/failed) — e.g. the workflow
      // finishes on its own without the user pressing a key.
      let storeUnsub: (() => void) | undefined;
      if (this.clientStore) {
        const status = this.clientStore.getState().status;
        if (status === 'complete' || status === 'failed') {
          done();
          return;
        }
        storeUnsub = this.clientStore.subscribe((state) => {
          if (state.status === 'complete' || state.status === 'failed') {
            done();
          }
        });
      }

      // Listen for AbortSignal so web terminate button can resolve the pause
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  // ─── Accessors ───────────────────────────────────────────────────────

  getEventLog(): EventLog {
    return this.eventLog;
  }

  getDashboard(): Dashboard {
    return this.dashboard;
  }

  // ─── Run ID ───────────────────────────────────────────────────────

  /**
   * Update the runId (e.g. once `run_started` is received from the server).
   * The runId is displayed in the detach/kill prompt so the user knows which
   * run they are detaching from / killing.
   */
  setRunId(runId: string): void {
    this.runId = runId;
  }
}
