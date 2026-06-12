import { Key, matchesKey, ProcessTerminal, TUI, type Component, type Terminal } from '@earendil-works/pi-tui';
import type { StatusCallbacks } from '../core/types.js';
import { Dashboard } from './components/dashboard.js';
import { EventLog } from './components/event-log.js';
import { createTuiStatusCallbacks } from './status-callbacks.js';
import { dim } from './theme.js';

// ─── Options ─────────────────────────────────────────────────────────────────

export interface WorkflowTUIOptions {
  maxConcurrentLanes?: number;
  agentLogLines?: number;
  abort?: () => void;
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
  private readonly originalConsoleLog: typeof console.log;
  private readonly originalConsoleWarn: typeof console.warn;
  private readonly originalConsoleError: typeof console.error;

  constructor(options: WorkflowTUIOptions = {}) {
    this.maxConcurrentLanes = options.maxConcurrentLanes ?? 5;
    this.agentLogLines = options.agentLogLines ?? 20;
    this.abortFn = options.abort;

    this.eventLog = new EventLog();
    this.dashboard = new Dashboard(this.maxConcurrentLanes, this.agentLogLines);

    this.statusCallbacks = createTuiStatusCallbacks({
      eventLog: this.eventLog,
      dashboard: this.dashboard,
      requestRender: () => {
        this.tui?.requestRender();
      },
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

      // Tab: cycle focused lane
      if (matchesKey(data, 'tab')) {
        const pool = this.dashboard.lanePool;
        const sorted = pool.getSortedLanes();
        if (sorted.length > 0) {
          const current = pool.getFocusedLaneIndex();
          const next = current < sorted.length - 1 ? current + 1 : 0;
          pool.setFocusedLaneById(sorted[next].id);
          const lane = sorted[next];
          if (lane) {
            this.dashboard.agentLog.selectAgent(lane.agentId ?? lane.id, lane.profile ?? '');
          }
        }
        this.tui?.requestRender();
        return { consume: true };
      }

      // Left/Right: navigate agents in agent log
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        this.dashboard.handleInput(data);
        // Sync lane pool focus with agent log selection
        const currentAgentId = this.dashboard.agentLog.getCurrentAgentId();
        if (currentAgentId) {
          const sorted = this.dashboard.lanePool.getSortedLanes();
          const lane = sorted.find((l) => l.agentId === currentAgentId);
          if (lane) {
            this.dashboard.lanePool.setFocusedLaneById(lane.id);
          }
        }
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
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    try {
      this.inputUnsubscribe?.();
      this.inputUnsubscribe = null;
      console.log = this.originalConsoleLog;
      console.warn = this.originalConsoleWarn;
      console.error = this.originalConsoleError;
      this.interruptCount = 0;
      this.tui?.stop();
    } catch (err) {
      this.originalConsoleError('Error during TUI cleanup:', err);
    }
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
