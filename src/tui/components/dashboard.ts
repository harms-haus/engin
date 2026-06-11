import { type Component } from '@earendil-works/pi-tui';
import { AgentLogWidget } from './agent-log-widget.js';
import { LanePoolWidget } from './lane-pool-widget.js';
import { PhaseBar } from './phase-bar.js';

// ─── Dashboard Component ────────────────────────────────────────────────────

export class Dashboard implements Component {
  private readonly _phaseBar: PhaseBar;
  private readonly _lanePool: LanePoolWidget;
  private readonly _agentLog: AgentLogWidget;
  private readonly _maxConcurrentLanes: number;
  private readonly _agentLogLines: number;

  constructor(maxConcurrentLanes: number, agentLogLines = 4) {
    this._maxConcurrentLanes = maxConcurrentLanes;
    this._agentLogLines = agentLogLines;
    this._phaseBar = new PhaseBar();
    this._lanePool = new LanePoolWidget(maxConcurrentLanes);
    this._agentLog = new AgentLogWidget(agentLogLines);
  }

  get phaseBar(): PhaseBar {
    return this._phaseBar;
  }

  get lanePool(): LanePoolWidget {
    return this._lanePool;
  }

  get agentLog(): AgentLogWidget {
    return this._agentLog;
  }

  getComputedHeight(): number {
    return 1 + this._maxConcurrentLanes + this._agentLogLines;
  }

  invalidate(): void {
    this._phaseBar.invalidate();
    this._lanePool.invalidate();
    this._agentLog.invalidate();
  }

  render(width: number): string[] {
    return [...this._phaseBar.render(width), ...this._lanePool.render(width), ...this._agentLog.render(width)];
  }

  handleInput(data: string): void {
    this._lanePool.handleInput(data);
  }
}
