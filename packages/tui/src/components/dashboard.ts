import { type Component, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { WorkflowProjection } from '@engin/shared';
import { borderLine } from '../theme.js';
import { AgentLogWidget, computeNextAgentStepIndex } from './agent-log-widget.js';
import { PhaseBar } from './phase-bar.js';
import { TaskListWidget } from './task-list-widget.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DashboardSelection {
  selectedPhaseId: string | null;
  selectedTaskId: string | null;
  selectedStepIndex: number | null;
  userPinnedPhase: boolean;
  userPinnedStep: boolean;
}

// ─── Dashboard Component ────────────────────────────────────────────────────

export class Dashboard implements Component {
  private readonly _phaseBar: PhaseBar;
  private readonly _taskList: TaskListWidget;
  private readonly _agentLog: AgentLogWidget;

  private _selection: DashboardSelection = {
    selectedPhaseId: null,
    selectedTaskId: null,
    selectedStepIndex: null,
    userPinnedPhase: false,
    userPinnedStep: false,
  };

  /** Cached ordered phase IDs used for keyboard navigation. */
  private _phaseIds: string[] = [];

  /** Cached step entities for the currently selected task (needed for tab navigation). */
  private _steps: { index: number; agentKey?: string }[] = [];

  /**
   * Last projection pushed via syncFromProjection. Retained so handleInput
   * can re-apply the current selection to the child widgets (filter tasks by
   * phase, push the selected task's steps/agents) and invalidate them for an
   * immediate re-render — without waiting for the next store event.
   */
  private _lastProjection: WorkflowProjection | null = null;

  constructor(agentLogLines = 20) {
    this._phaseBar = new PhaseBar();
    this._taskList = new TaskListWidget();
    this._agentLog = new AgentLogWidget(agentLogLines);
  }

  get phaseBar(): PhaseBar {
    return this._phaseBar;
  }

  get taskList(): TaskListWidget {
    return this._taskList;
  }

  get agentLog(): AgentLogWidget {
    return this._agentLog;
  }

  getSelection(): Readonly<DashboardSelection> {
    return { ...this._selection };
  }

  /**
   * Force-reset task/step selection so the next sync picks fresh defaults.
   * Phase selection is preserved.
   */
  forceReselect(): void {
    this._selection.selectedTaskId = null;
    this._selection.selectedStepIndex = null;
    this._selection.userPinnedStep = false;
  }

  getComputedHeight(): number {
    // PhaseBar always renders exactly 1 line; no need to call render()
    const phaseBarLines = 1;
    const contentLines = phaseBarLines + this._taskList.getVisibleTaskCount() + this._agentLog.getExpandedLineCount();
    // +4 border lines: top + 2 separators + bottom
    return contentLines + 4;
  }

  /**
   * Push projection state into all child widgets. Called on every store
   * notification so the TUI reflects the latest workflow state.
   *
   * Implements the "follow" rules from PART 4e:
   *   - PHASE FOLLOW: auto-advance to currentPhaseId unless user pinned to a
   *     completed phase.
   *   - TASK FOLLOW: auto-select the first active task in the current phase.
   *   - STEP FOLLOW: auto-advance to activeStepIndex unless user pinned.
   */
  syncFromProjection(projection: WorkflowProjection): void {
    // ── Phase bar ──
    this._phaseBar.setPhases(projection.phases);
    this._phaseBar.setCurrentPhaseId(projection.currentPhaseId);
    this._phaseBar.setCompletedPhaseIds(projection.completedPhaseIds);
    if (projection.sidebar.indicator) {
      this._phaseBar.setIndicator(projection.sidebar.indicator);
    }

    // Cache phase IDs for keyboard navigation
    this._phaseIds = projection.phases.map((p) => p.id);

    // ── PHASE FOLLOW ──
    const completedSet = new Set(projection.completedPhaseIds);
    if (
      this._selection.selectedPhaseId !== null &&
      !completedSet.has(this._selection.selectedPhaseId) &&
      this._selection.selectedPhaseId !== projection.currentPhaseId
    ) {
      // User was on a non-completed phase that is no longer current → follow current
      this._selection.selectedPhaseId = projection.currentPhaseId;
      this._selection.selectedTaskId = null;
      this._selection.selectedStepIndex = null;
      this._selection.userPinnedStep = false;
    } else if (this._selection.selectedPhaseId === null) {
      this._selection.selectedPhaseId = projection.currentPhaseId;
    }
    // If selectedPhaseId is in completedPhaseIds → leave it (reviewing history)

    // Apply the (possibly phase-followed) selection to child widgets + invalidate.
    this._lastProjection = projection;
    this._applySelectionToWidgets();
  }

  /**
   * Push the current selection state into the child widgets (task filter,
   * task-follow, step-follow, agent-log steps/agents) and invalidate them so
   * the next render reflects the selection. Does NOT run the phase-follow rule
   * (that mutates selection and only runs on store events).
   *
   * Called from syncFromProjection (after ingesting a new projection) AND from
   * handleInput (after keyboard navigation mutates the selection), so that
   * navigation re-renders immediately instead of waiting for the next store
   * event to bust the widget render caches.
   */
  private _applySelectionToWidgets(): void {
    const projection = this._lastProjection;
    if (!projection) return;

    // ── Filter tasks by selected phase ──
    const effectivePhaseId = this._selection.selectedPhaseId ?? projection.currentPhaseId;
    const phaseTasks = Object.values(projection.tasks).filter((t) => t.phaseId === effectivePhaseId);
    this._taskList.updateTasks(phaseTasks);

    // ── TASK FOLLOW ──
    const currentSelectedTaskId = this._selection.selectedTaskId;
    if (currentSelectedTaskId === null || !phaseTasks.some((t) => t.id === currentSelectedTaskId)) {
      // Auto-select first active task; if none, first task; if none, null
      const activeTask = phaseTasks.find((t) => t.status === 'active');
      this._selection.selectedTaskId = activeTask?.id ?? phaseTasks[0]?.id ?? null;
    }
    // else keep selected task

    // ── STEP FOLLOW ──
    const selectedTask = phaseTasks.find((t) => t.id === this._selection.selectedTaskId);
    if (selectedTask) {
      const activeStepIndex = selectedTask.activeStepIndex ?? 0;
      const steps = selectedTask.steps ?? [];

      // Cache steps for tab navigation
      this._steps = steps;

      if (this._selection.selectedStepIndex === null) {
        this._selection.selectedStepIndex = activeStepIndex;
      } else if (!this._selection.userPinnedStep) {
        // Not pinned → follow the (possibly changed) activeStepIndex
        this._selection.selectedStepIndex = activeStepIndex;
      }
      // If userPinnedStep → leave as-is

      // Push steps to agentLog
      this._agentLog.setSteps(steps);
      this._agentLog.setActiveStepIndex(activeStepIndex);
      if (this._selection.selectedStepIndex !== null) {
        this._agentLog.setSelectedStepIndex(this._selection.selectedStepIndex);
      }

      // Filter agents by selected task and phase
      const stepAgents = Object.values(projection.agents).filter(
        (a) => a.taskId === selectedTask.id && a.phaseId === effectivePhaseId,
      );
      this._agentLog.setAgents(stepAgents);
    } else {
      this._steps = [];
      this._agentLog.setSteps([]);
      this._agentLog.setAgents([]);
    }

    // ── Sync selection state to widgets ──
    this._phaseBar.setSelectedPhase(this._selection.selectedPhaseId ?? projection.currentPhaseId);
    this._taskList.setSelectedTaskId(this._selection.selectedTaskId);

    // ── Invalidate all ──
    this._phaseBar.invalidate();
    this._taskList.invalidate();
    this._agentLog.invalidate();
  }

  invalidate(): void {
    this._phaseBar.invalidate();
    this._taskList.invalidate();
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

    // Task list content
    for (const line of this._taskList.render(innerWidth)) {
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
    // ── Left / Right → PhaseBar (phase navigation) ──
    if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
      // Let PhaseBar update its internal selectedPhaseId
      this._phaseBar.handleInput(data);

      // Compute new selectedPhaseId from direction + cached phase IDs
      if (this._phaseIds.length > 0) {
        const currentId = this._selection.selectedPhaseId ?? this._phaseIds[0];
        const currentIdx = this._phaseIds.indexOf(currentId);
        let newIdx: number;
        if (matchesKey(data, 'left')) {
          newIdx = currentIdx <= 0 ? this._phaseIds.length - 1 : currentIdx - 1;
        } else {
          newIdx = currentIdx < 0 || currentIdx >= this._phaseIds.length - 1 ? 0 : currentIdx + 1;
        }
        this._selection.selectedPhaseId = this._phaseIds[newIdx];
        // Sync PhaseBar selection
        this._phaseBar.setSelectedPhase(this._selection.selectedPhaseId);
      }

      // Mark as user-pinned so syncFromProjection won't override if this is a
      // completed phase (reviewing history). The follow rule in syncFromProjection
      // will override if the selected phase is NOT completed.
      this._selection.userPinnedPhase = true;

      // On phase change reset task/step selection
      this._selection.selectedTaskId = null;
      this._selection.selectedStepIndex = null;
      this._selection.userPinnedStep = false;

      // Re-filter tasks for the new phase, push the auto-selected task's steps /
      // agents to the agent log, and invalidate all widgets so the navigation
      // re-renders immediately.
      this._applySelectionToWidgets();
      return;
    }

    // ── Up / Down → TaskList (collapsed) or AgentLog (expanded) ──
    if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      if (this._agentLog.isExpanded()) {
        // Route to agent log for scrolling
        this._agentLog.handleInput(data);
        // Only invalidate the agent log — do NOT call _applySelectionToWidgets()
        // which would reset the scroll offset via setSelectedStepIndex().
        this._agentLog.invalidate();
      } else {
        // Route to task list for navigation
        this._taskList.handleInput(data);
        const newTaskId = this._taskList.getSelectedTaskId();
        if (newTaskId !== this._selection.selectedTaskId) {
          this._selection.selectedTaskId = newTaskId;
          // On task change reset step selection
          this._selection.selectedStepIndex = null;
          this._selection.userPinnedStep = false;
        }
        // Re-push the selected task's steps / agents to the agent log and
        // invalidate all widgets so task navigation re-renders immediately.
        this._applySelectionToWidgets();
      }
      return;
    }

    // ── Shift+Up / Shift+Down (expanded) → AgentLog ──
    if (matchesKey(data, Key.shift('up')) || matchesKey(data, Key.shift('down'))) {
      if (this._agentLog.isExpanded()) {
        this._agentLog.handleInput(data);
        this._agentLog.invalidate();
      }
      return;
    }

    // ── Tab / Shift+Tab → AgentLog (step cycling) ──
    if (matchesKey(data, 'tab') || matchesKey(data, Key.shift('tab'))) {
      this._selection.userPinnedStep = true;
      const dir = matchesKey(data, 'tab') ? 'forward' : 'backward';
      const currentIdx = this._selection.selectedStepIndex ?? -1;
      const nextIndex = computeNextAgentStepIndex(this._steps, currentIdx, dir);
      if (nextIndex !== currentIdx) {
        this._selection.selectedStepIndex = nextIndex;
      }
      // Push the updated selection to child widgets and invalidate for re-render
      this._applySelectionToWidgets();
      return;
    }

    // All other input is ignored
  }
}
