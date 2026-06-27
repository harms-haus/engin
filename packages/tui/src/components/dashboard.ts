import { Key, matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import {
  isTerminalTaskStatus,
  pickMostRecentlyStartedActive,
  selectNextSession,
  type SessionEntity,
  type WorkflowProjection,
} from '@engin/shared';
import { borderLine } from '../theme.js';
import { AgentLogWidget } from './agent-log-widget.js';
import { PhaseBar } from './phase-bar.js';
import { TaskListWidget } from './task-list-widget.js';

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Pick the most-recently-started session (greatest `startedAt`).
 * ISO-8601-Z timestamps are lexicographically sortable, so `>` gives the
 * most-recently-started entry.
 */
function pickMostRecentlyStarted(sessions: SessionEntity[]): SessionEntity {
  return sessions.reduce((best, a) => ((a.startedAt ?? '') > (best.startedAt ?? '') ? a : best));
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DashboardSelection {
  selectedPhaseId: string | null;
  selectedTaskId: string | null;
  selectedSessionId: string | null;
  userPinnedPhase: boolean;
  userPinnedSession: boolean;
}

// ─── Dashboard Component ────────────────────────────────────────────────────

export class Dashboard implements Component {
  private readonly _phaseBar: PhaseBar;
  private readonly _taskList: TaskListWidget;
  private readonly _agentLog: AgentLogWidget;

  private _selection: DashboardSelection = {
    selectedPhaseId: null,
    selectedTaskId: null,
    selectedSessionId: null,
    userPinnedPhase: false,
    userPinnedSession: false,
  };

  /** Cached ordered phase IDs used for keyboard navigation. */
  private _phaseIds: string[] = [];

  /** Cached session list (sessions for the selected task) for session tab cycling (B9). */
  private _sessions: SessionEntity[] = [];

  /**
   * Last projection pushed via syncFromProjection. Retained so handleInput
   * can re-apply the current selection to the child widgets (filter tasks by
   * phase, push the selected task's sessions) and invalidate them for an
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
   * Force-reset task/session selection so the next sync picks fresh defaults.
   * Phase selection is preserved.
   */
  forceReselect(): void {
    this._selection.selectedTaskId = null;
    this._selection.selectedSessionId = null;
    this._selection.userPinnedSession = false;
  }

  getComputedHeight(): number {
    // PhaseBar always renders exactly 1 line; no need to call render()
    const phaseBarLines = 1;
    const taskListLines = this._taskList.getRenderedLineCount();
    const contentLines = phaseBarLines + taskListLines + this._agentLog.getExpandedLineCount();
    // +4 border lines: top + 2 separators + bottom
    return contentLines + 4;
  }

  /**
   * Push projection state into all child widgets. Called on every store
   * notification so the TUI reflects the latest workflow state.
   *
   * Implements the "follow" rules from PART 4e:
   *   - PHASE FOLLOW (req 6): auto-advance to currentPhaseId ONLY when the
   *     user was synced to the previous current phase AND it advanced;
   *     otherwise leave the selected phase as-is (navigating to a different
   *     non-completed phase is treated as an intentional detour and is not
   *     pulled back).
   *   - TASK FOLLOW: auto-select the first active task in the current phase.
   *     When the selected task completes (or fails/cancels) and other active
   *     tasks remain, re-select the most-recently-started remaining active
   *     task; if no active task remains, keep the completed task selected.
   *   - SESSION FOLLOW: auto-select the most-recently-started session for the
   *     selected task unless the user pinned a session.
   */
  syncFromProjection(projection: WorkflowProjection): void {
    // Capture the previous projection BEFORE ingesting the new one so the
    // follow rules below can detect transitions (currentPhaseId advance,
    // task status change).
    const oldProjection = this._lastProjection;

    // ── Phase bar ──
    this._phaseBar.setPhases(projection.phases);
    this._phaseBar.setCurrentPhaseId(projection.currentPhaseId);
    this._phaseBar.setCompletedPhaseIds(projection.completedPhaseIds);
    if (projection.sidebar.indicator) {
      this._phaseBar.setIndicator(projection.sidebar.indicator);
    }

    // Cache phase IDs for keyboard navigation
    this._phaseIds = projection.phases.map((p) => p.id);

    // ── PHASE FOLLOW (req 6) ──
    // Tightened rule: only auto-advance the selected phase when the user WAS
    // synced with the active phase AND the active phase advanced. Navigating
    // to a different phase that is neither completed nor the (previous)
    // current phase is treated as an intentional detour and is NOT pulled back.
    if (this._selection.selectedPhaseId === null) {
      this._selection.selectedPhaseId = projection.currentPhaseId;
    } else {
      const prevCurrent = oldProjection?.currentPhaseId ?? projection.currentPhaseId;
      if (this._selection.selectedPhaseId === prevCurrent && projection.currentPhaseId !== prevCurrent) {
        // User was synced with the active phase AND the active phase advanced → follow.
        this._selection.selectedPhaseId = projection.currentPhaseId;
        this._selection.selectedTaskId = null;
        this._selection.selectedSessionId = null;
        this._selection.userPinnedSession = false;
      }
      // Else: user is reviewing a completed phase or has navigated to a
      // different phase — leave selectedPhaseId as-is (do not pull them back).
    }

    // Apply the (possibly phase-followed) selection to child widgets + invalidate.
    this._lastProjection = projection;
    this._applySelectionToWidgets(oldProjection);
  }

  /**
   * Push the current selection state into the child widgets (task filter,
   * task-follow, session-follow, agent-log sessions) and invalidate them so
   * the next render reflects the selection. Does NOT run the phase-follow rule
   * (that mutates selection and only runs on store events).
   *
   * Called from syncFromProjection (after ingesting a new projection) AND from
   * handleInput (after keyboard navigation mutates the selection), so that
   * navigation re-renders immediately instead of waiting for the next store
   * event to bust the widget render caches.
   */
  private _applySelectionToWidgets(oldProjection: WorkflowProjection | null = this._lastProjection): void {
    const projection = this._lastProjection;
    if (!projection) return;

    // ── Filter tasks by selected phase ──
    const effectivePhaseId = this._selection.selectedPhaseId ?? projection.currentPhaseId;
    const phaseTasks = Object.values(projection.tasks).filter((t) => t.phaseId === effectivePhaseId);
    this._taskList.updateTasks(phaseTasks);

    // ── TASK FOLLOW / completion reselection (req 2) ──
    const currentSelectedTaskId = this._selection.selectedTaskId;
    if (currentSelectedTaskId !== null && phaseTasks.some((t) => t.id === currentSelectedTaskId)) {
      // Completion-transition reselection: if the selected task transitioned out
      // of 'active' (→ complete/failed/cancelled) and other active tasks remain,
      // re-select the most-recently-started (least active time) remaining active
      // task. If no active task remains, keep the completed task selected
      // (intended: it is still in phaseTasks).
      const oldStatus = oldProjection?.tasks[currentSelectedTaskId]?.status;
      const selectedTaskInPhase = phaseTasks.find((t) => t.id === currentSelectedTaskId);
      const newStatus = selectedTaskInPhase?.status;
      if (oldStatus === 'active' && newStatus !== undefined && isTerminalTaskStatus(newStatus)) {
        const next = pickMostRecentlyStartedActive(phaseTasks);
        if (next) {
          this._selection.selectedTaskId = next.id;
          this._selection.selectedSessionId = null;
          this._selection.userPinnedSession = false;
        }
      }
    }
    if (this._selection.selectedTaskId === null || !phaseTasks.some((t) => t.id === this._selection.selectedTaskId)) {
      // Auto-select first active task; if none, first task; if none, null
      const activeTask = phaseTasks.find((t) => t.status === 'active');
      const newTaskId = activeTask?.id ?? phaseTasks[0]?.id ?? null;
      if (newTaskId !== this._selection.selectedTaskId) {
        this._selection.selectedSessionId = null;
        this._selection.userPinnedSession = false;
      }
      this._selection.selectedTaskId = newTaskId;
    }
    // else keep selected task

    // ── SESSION FOLLOW (B9) ──
    const selectedTask = phaseTasks.find((t) => t.id === this._selection.selectedTaskId);
    if (selectedTask) {
      // Filter sessions by selected task and phase
      const taskSessions = Object.values(projection.sessions).filter(
        (a) => a.taskId === selectedTask.id && a.phaseId === effectivePhaseId,
      );

      this._agentLog.setAgents(taskSessions);

      // Cache sessions for Tab cycling.
      this._sessions = taskSessions;

      if (taskSessions.length === 0) {
        this._selection.selectedSessionId = null;
      } else if (
        this._selection.selectedSessionId === null ||
        (!this._selection.userPinnedSession && !this._agentLog.isExpanded())
      ) {
        // Initial selection (null → pick most recent, even while expanded) OR
        // follow update (not pinned, not reviewing). ISO-8601-Z timestamps are
        // lexicographically sortable, so `>` gives the most-recently-started.
        const mostRecent = pickMostRecentlyStarted(taskSessions);
        this._selection.selectedSessionId = mostRecent.uid;
      }
      // Else: user pinned the session via Tab (userPinnedSession = true) OR
      // the agent log is expanded with an existing selection (reviewing).

      // Push sessions + selection to the agent log (B9).
      this._agentLog.setSessions(taskSessions);
      this._agentLog.setSelectedSessionId(this._selection.selectedSessionId);
      // activeSessionId = the most-recently-started session (same as follow would pick).
      if (taskSessions.length > 0) {
        const activeSession = pickMostRecentlyStarted(taskSessions);
        this._agentLog.setActiveSessionId(activeSession.uid);
      }
    } else {
      this._sessions = [];
      this._agentLog.setAgents([]);
      this._agentLog.setSessions([]);
    }

    // ── Sync selection state to widgets ──
    this._phaseBar.setSelectedPhase(this._selection.selectedPhaseId ?? projection.currentPhaseId);
    this._taskList.setSelectedTaskId(this._selection.selectedTaskId);

    // ── Compute per-task session counts and push to task list (B9) ──
    const sessionCounts: Record<string, number> = {};
    for (const session of Object.values(projection.sessions)) {
      if (session.phaseId === effectivePhaseId && session.taskId !== undefined) {
        sessionCounts[session.taskId] = (sessionCounts[session.taskId] ?? 0) + 1;
      }
    }
    this._taskList.setSessionCounts(sessionCounts);

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

      // On phase change reset task/session selection
      this._selection.selectedTaskId = null;
      this._selection.selectedSessionId = null;
      this._selection.userPinnedSession = false;

      // Re-filter tasks for the new phase, push the auto-selected task's
      // sessions to the agent log, and invalidate all widgets so the navigation
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
        // which would reset the scroll offset via setSelectedSessionId().
        this._agentLog.invalidate();
      } else {
        // Route to task list for navigation
        this._taskList.handleInput(data);
        const newTaskId = this._taskList.getSelectedTaskId();
        if (newTaskId !== this._selection.selectedTaskId) {
          this._selection.selectedTaskId = newTaskId;
          // On task change reset session selection
          this._selection.selectedSessionId = null;
          this._selection.userPinnedSession = false;
        }
        // Re-push the selected task's sessions to the agent log and
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

    // ── Tab / Shift+Tab → cycle sessions ──
    //
    // Sessions are the model for the tab bar. Tab cycles selectedSessionId.
    if (matchesKey(data, 'tab') || matchesKey(data, Key.shift('tab'))) {
      const isForward = matchesKey(data, 'tab');
      const sessionDir = isForward ? 1 : -1;

      this._selection.userPinnedSession = true;
      const nextSessionId = selectNextSession(this._sessions, this._selection.selectedSessionId, sessionDir);
      if (nextSessionId !== null) {
        this._selection.selectedSessionId = nextSessionId;
      }

      // Push the updated selection to child widgets and invalidate for re-render
      this._applySelectionToWidgets();
      return;
    }

    // All other input is ignored
  }
}
