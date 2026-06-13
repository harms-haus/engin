import { type Component, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { AgentRegistry } from '../../tracking/agent-registry.js';
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
  private readonly _registry: AgentRegistry;

  constructor(maxConcurrentLanes: number, agentLogLines = 20) {
    this._agentLogLines = agentLogLines;
    this._phaseBar = new PhaseBar();
    this._lanePool = new LanePoolWidget();
    this._agentLog = new AgentLogWidget(agentLogLines);
    this._registry = new AgentRegistry();
    this._agentLog.setRegistry(this._registry);
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

  get registry(): AgentRegistry {
    return this._registry;
  }

  getComputedHeight(): number {
    // PhaseBar always renders exactly 1 line; no need to call render()
    const phaseBarLines = 1;
    const contentLines = phaseBarLines + this._lanePool.getVisibleLaneCount() + this._agentLog.getExpandedLineCount();
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
      lines.push('│' + truncateToWidth(line, innerWidth, undefined, true) + '│');
    }

    // Separator
    lines.push(borderLine('├', '─', '┤', innerWidth));

    // Lane pool content
    for (const line of this._lanePool.render(innerWidth)) {
      lines.push('│' + truncateToWidth(line, innerWidth, undefined, true) + '│');
    }

    // Separator
    lines.push(borderLine('├', '─', '┤', innerWidth));

    // Agent log content
    for (const line of this._agentLog.render(innerWidth)) {
      lines.push('│' + truncateToWidth(line, innerWidth, undefined, true) + '│');
    }

    // Bottom border
    lines.push(borderLine('└', '─', '┘', innerWidth));

    return lines;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, 'up') ||
      matchesKey(data, 'down') ||
      matchesKey(data, 'left') ||
      matchesKey(data, 'right') ||
      matchesKey(data, Key.shift('up')) ||
      matchesKey(data, Key.shift('down'))
    ) {
      this._agentLog.handleInput(data);
    }
    // All other input is ignored (lane pool is display-only)
  }
}
