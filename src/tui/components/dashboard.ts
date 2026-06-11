import { type Component, matchesKey } from '@earendil-works/pi-tui';
import { borderLine } from '../theme.js';
import { AgentLogWidget } from './agent-log-widget.js';
import { LanePoolWidget } from './lane-pool-widget.js';
import { PhaseBar } from './phase-bar.js';

// ─── Dashboard Component ────────────────────────────────────────────────────

export class Dashboard implements Component {
  private readonly _phaseBar: PhaseBar;
  private readonly _lanePool: LanePoolWidget;
  private readonly _agentLog: AgentLogWidget;
  private readonly _agentLogLines: number;

  constructor(maxConcurrentLanes: number, agentLogLines = 10) {
    this._agentLogLines = agentLogLines;
    this._phaseBar = new PhaseBar();
    this._lanePool = new LanePoolWidget();
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
    // PhaseBar always renders exactly 1 line; no need to call render()
    const phaseBarLines = 1;
    const contentLines = phaseBarLines + this._lanePool.getVisibleLaneCount() + this._agentLogLines;
    // +4 border lines: top + 2 separators + bottom
    return contentLines + 4;
  }

  invalidate(): void {
    this._phaseBar.invalidate();
    this._lanePool.invalidate();
    this._agentLog.invalidate();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(0, width - 2);
    const lines: string[] = [];

    // Top border
    lines.push(borderLine('┌', '─', '┐', innerWidth));

    // Phase bar content
    for (const line of this._phaseBar.render(innerWidth)) {
      lines.push('│' + line.padEnd(innerWidth).slice(0, innerWidth) + '│');
    }

    // Separator
    lines.push(borderLine('├', '─', '┤', innerWidth));

    // Lane pool content
    for (const line of this._lanePool.render(innerWidth)) {
      lines.push('│' + line.padEnd(innerWidth).slice(0, innerWidth) + '│');
    }

    // Separator
    lines.push(borderLine('├', '─', '┤', innerWidth));

    // Agent log content
    for (const line of this._agentLog.render(innerWidth)) {
      lines.push('│' + line.padEnd(innerWidth).slice(0, innerWidth) + '│');
    }

    // Bottom border
    lines.push(borderLine('└', '─', '┘', innerWidth));

    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
      this._agentLog.handleInput(data);
    } else {
      this._lanePool.handleInput(data);
    }
  }
}
