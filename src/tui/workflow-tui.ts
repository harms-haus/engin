import {
  Key,
  matchesKey,
  ProcessTerminal,
  TUI,
  type Component,
  type OverlayHandle,
  type Terminal,
} from '@earendil-works/pi-tui';
import type { StatusCallbacks } from '../core/types.js';
import { Dashboard } from './components/dashboard.js';
import { EventLog } from './components/event-log.js';
import { createQrOverlayComponent } from './components/qr-overlay.js';
import { createTuiStatusCallbacks } from './status-callbacks.js';
import { dim } from './theme.js';

// ─── Options ─────────────────────────────────────────────────────────────────

export interface WorkflowTUIOptions {
  maxConcurrentLanes?: number;
  agentLogLines?: number;
  abort?: () => void;
  initialAgents?: {
    agentId: string;
    profile: string;
    phase: string;
    taskId?: string;
    completedAt?: string;
  }[];
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

// ─── WorkflowTUI ─────────────────────────────────────────────────────────────

export class WorkflowTUI {
  private tui: TUI | null = null;
  private terminal: ProcessTerminal | null = null;
  private readonly eventLog: EventLog;
  private readonly dashboard: Dashboard;
  private readonly statusCallbacks: StatusCallbacks;
  private readonly maxConcurrentLanes: number;
  private readonly agentLogLines: number;
  private readonly abortFn: (() => void) | undefined;
  private running = false;
  private interruptCount = 0;
  private inputUnsubscribe: (() => void) | null = null;
  private qrHandle: OverlayHandle | null = null;
  private pendingQrComponent: Component | null = null;
  private readonly originalConsoleLog: typeof console.log;
  private readonly originalConsoleWarn: typeof console.warn;
  private readonly originalConsoleError: typeof console.error;
  private readonly initialAgents: WorkflowTUIOptions['initialAgents'];

  constructor(options: WorkflowTUIOptions = {}) {
    this.maxConcurrentLanes = options.maxConcurrentLanes ?? 5;
    this.agentLogLines = options.agentLogLines ?? 20;
    this.abortFn = options.abort;
    this.initialAgents = options.initialAgents;

    this.eventLog = new EventLog();
    this.dashboard = new Dashboard(this.agentLogLines);

    this.statusCallbacks = createTuiStatusCallbacks({
      eventLog: this.eventLog,
      dashboard: this.dashboard,
      requestRender: () => {
        this.tui?.requestRender();
      },
      initialAgents: this.initialAgents,
    });

    this.originalConsoleLog = console.log;
    this.originalConsoleWarn = console.warn;
    this.originalConsoleError = console.error;
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
      // Ctrl+C interrupt handling
      if (matchesKey(data, Key.ctrl('c'))) {
        this.interruptCount++;
        if (this.interruptCount === 1) {
          this.eventLog.addLine('⏹ Stopping workflow...');
          this.tui?.requestRender();
          this.abortFn?.();
        } else {
          process.exit(1);
        }
        return { consume: true };
      }

      // Tab: cycle focused lane (no agent log sync)
      if (matchesKey(data, 'tab')) {
        const pool = this.dashboard.lanePool;
        const sorted = pool.getSortedLanes();
        if (sorted.length > 0) {
          const current = pool.getFocusedLaneIndex();
          const next = current < sorted.length - 1 ? current + 1 : 0;
          pool.setFocusedLaneById(sorted[next].id);
        }
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

      // Up/Down: always consumed — phase nav when collapsed, scroll when expanded
      if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
        this.dashboard.handleInput(data);
        this.tui?.requestRender();
        return { consume: true };
      }

      // Left/Right: navigate agents in agent log (no lane pool sync)
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        this.dashboard.handleInput(data);
        this.tui?.requestRender();
        return { consume: true };
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

    // Override console methods to route through eventLog
    console.log = (...args: unknown[]) => {
      this.eventLog.addLine(args.join(' '));
      this.tui?.requestRender();
    };
    console.warn = (...args: unknown[]) => {
      this.eventLog.addLine('⚠️ ' + args.join(' '));
      this.tui?.requestRender();
    };
    console.error = (...args: unknown[]) => {
      this.eventLog.addLine('❌ ' + args.join(' '));
      this.tui?.requestRender();
    };

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
      this.inputUnsubscribe?.();
      this.inputUnsubscribe = null;
      this.qrHandle?.hide();
      this.qrHandle = null;
      console.log = this.originalConsoleLog;
      console.warn = this.originalConsoleWarn;
      console.error = this.originalConsoleError;
      this.interruptCount = 0;
      this.tui?.stop();
    } catch (err) {
      this.originalConsoleError('Error during TUI cleanup:', err);
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
      this.originalConsoleError('Failed to generate QR code overlay:', err);
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
      this.originalConsoleError('Failed to generate QR code overlay:', err);
      return;
    }

    this.qrHandle = this.tui?.showOverlay(component, QR_OVERLAY_OPTIONS) ?? null;
    this.tui?.requestRender();
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

      // Listen for AbortSignal so web terminate button can resolve the pause
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  // ─── Accessors ───────────────────────────────────────────────────────

  getStatusCallbacks(): StatusCallbacks {
    return this.statusCallbacks;
  }

  getEventLog(): EventLog {
    return this.eventLog;
  }

  getDashboard(): Dashboard {
    return this.dashboard;
  }
}
