import { type Component, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { TaskStatus } from '../../core/types.js';
import type { WorkflowProjection } from '../../tracking/event-types.js';
import { borderLine } from '../theme.js';
import { AgentLogWidget } from './agent-log-widget.js';
import { LanePoolWidget } from './lane-pool-widget.js';
import { PhaseBar } from './phase-bar.js';

// ─── Dashboard Component ────────────────────────────────────────────────────

export class Dashboard implements Component {
  private readonly _phaseBar: PhaseBar;
  private readonly _lanePool: LanePoolWidget;
  private readonly _agentLog: AgentLogWidget;
  private _lastSyncedPhase: string | null = null;

  constructor(agentLogLines = 20) {
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
    const contentLines = phaseBarLines + this._lanePool.getVisibleLaneCount() + this._agentLog.getExpandedLineCount();
    // +4 border lines: top + 2 separators + bottom
    return contentLines + 4;
  }

  /**
   * Push projection state into all child widgets. Called on every store
   * notification so the TUI reflects the latest workflow state.
   */
  syncFromProjection(projection: WorkflowProjection): void {
    // ── Phase bar ──
    this._phaseBar.setCurrentPhase(projection.currentPhase);
    this._phaseBar.setCompletedPhases(projection.completedPhases);
    if (projection.sidebar.phases) {
      this._phaseBar.setPhases(projection.sidebar.phases);
    }
    if (projection.sidebar.indicator) {
      this._phaseBar.setIndicator(projection.sidebar.indicator);
    }

    // ── Lane pool — derive TaskLane[] from projection.tasks ──
    const lanes = Object.values(projection.tasks).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status as TaskStatus,
      agentId: t.agentId,
      phase: t.phase,
      startedAt: t.startedAt,
      stepInfo: t.stepInfo,
      completedAt: t.completedAt ? new Date(t.completedAt).getTime() : undefined,
    }));
    this._lanePool.updateLanes(lanes);

    // ── Agent log — push all agents, widget filters by current phase ──
    const agentEntities = Object.values(projection.agents);
    this._agentLog.setAgents(agentEntities);
    if (projection.sidebar.phases) {
      this._agentLog.setPhases(projection.sidebar.phases.map((p) => p.id));
    }
    this._agentLog.setCurrentPhase(projection.currentPhase);
    this._agentLog.invalidate();

    // ── Phase bar underline sync from agent log navigation ──
    // If agent log has been user-navigated to a different phase, sync that back.
    const cycled = this._agentLog.getCurrentPhase();
    if (cycled !== null && cycled !== this._lastSyncedPhase) {
      this._phaseBar.setSelectedPhase(cycled);
      this._lastSyncedPhase = cycled;
    }
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
      const cycled = this._agentLog.getCurrentPhase();
      if (cycled !== null && cycled !== this._lastSyncedPhase) {
        this._phaseBar.setSelectedPhase(cycled);
        this._lastSyncedPhase = cycled;
      }
    }
    // All other input is ignored (lane pool is display-only)
  }
}
