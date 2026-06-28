/**
 * Shared projection-store helpers.
 *
 * Extracted from the helper functions that were duplicated between
 * `packages/shared/src/client-store.ts` (plain-TS ClientStore) and
 * `packages/web/src/store/workflow-store.ts` (Zustand + Immer workflow-store):
 *
 *   • {@link capSessionLogs}           — defensive cap on session log length.
 *   • {@link toProjection}           — reconstruct a `WorkflowProjection` from
 *                                      projection-named fields (runLog reset).
 *   • {@link writeProjectionToState} — write projection fields into a state
 *                                      object (defensive copies; no seq/runLog).
 *   • {@link reconcileSelection}     — phase / task / session follow rules.
 *
 * All four helpers use the CANONICAL projection field names (`tasks`, `sessions`,
 * …) — NOT the web store's `tasksById` / `sessionsById`. The web workflow-store
 * maps its fields onto the canonical names before calling these helpers.
 *
 * `WritableProjectionState` and `SelectionState` are deliberately structural
 * (loose) interfaces so that both the ClientStore's typed state and ad-hoc
 * state objects satisfy them.
 */

import type { SessionEntity, TaskEntity, TaskStatus, WorkflowProjection } from './event-types.js';
import { MAX_SESSION_LOG } from './evolve-utils.js';

// ─── Structural state shapes ─────────────────────────────────────────────────

/** Projection fields (canonical names) WITHOUT `runLog`. */
export type ProjectionFields = Omit<WorkflowProjection, 'runLog'>;

/**
 * A mutable state object that carries the projection fields. Carried loosely
 * (index-signature compatible) so both the ClientStore's typed state and plain
 * record objects satisfy it. {@link writeProjectionToState} writes every
 * projection field EXCEPT `seq` and `runLog` (those are managed separately by
 * each store).
 */
export type WritableProjectionState = Record<string, unknown>;

/** Selection-bearing state accessed by {@link reconcileSelection}. */
export interface SelectionState {
  currentPhaseId: string;
  completedPhaseIds: string[];
  tasks: Record<string, TaskEntity>;
  sessions?: Record<string, SessionEntity>;
  selectedPhaseId: string | null;
  selectedTaskId: string | null;
  selectedSessionId?: string | null;
  userPinnedPhase: boolean;
  userPinnedSession?: boolean;
  /**
   * Previous-state fields the transition-aware rules consult on the NEXT call
   * (populated by the {@link reconcileSelection} write-back at the end of each
   * invocation). Declared OPTIONAL so ad-hoc state objects — and stores built
   * before the fields existed — still satisfy the interface; the rules
   * gracefully no-op when they're absent.
   */
  prevCurrentPhaseId?: string | null;
  prevSelectedTaskStatus?: TaskStatus | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Defensive cap on session log length. */
export function capSessionLogs(sessions: Record<string, SessionEntity>): Record<string, SessionEntity> {
  const out: Record<string, SessionEntity> = {};
  for (const [k, v] of Object.entries(sessions)) {
    if (v.log.length > MAX_SESSION_LOG) {
      out[k] = { ...v, log: v.log.slice(v.log.length - MAX_SESSION_LOG) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Reconstruct a `WorkflowProjection` from an object carrying the projection
 * fields (canonical names). The returned projection's `runLog` is reset to a
 * fresh empty array — the seed for an `evolve` fold (the stores manage the run
 * log via `appendRunLog`, never through `evolve`).
 *
 * Does not mutate the input.
 */
export function toProjection(fields: ProjectionFields): WorkflowProjection {
  return {
    seq: fields.seq,
    taskPrompt: fields.taskPrompt,
    phases: fields.phases,
    currentPhaseId: fields.currentPhaseId,
    completedPhaseIds: fields.completedPhaseIds,
    tasks: fields.tasks,
    sessions: fields.sessions,
    sidebar: fields.sidebar,
    status: fields.status,
    error: fields.error,
    failedPhase: fields.failedPhase,
    stats: fields.stats,
    // The stores' runLog is managed via appendRunLog (the server
    // `{ type: 'log' }` message), distinct from the projection's LogEntry[]
    // runLog. `log` events are routed to appendRunLog by the transport — never
    // through applyEvents — so a fresh empty array is the correct seed for the
    // evolve fold.
    runLog: [],
  };
}

/**
 * Write every normalized projection field into `state`. Uses defensive
 * (shallow) copies for externally-sourced collections. Does NOT write `seq`
 * (set separately after evolve) or `runLog` (managed via appendRunLog).
 *
 * @param fromSnapshot When true, defensively cap session logs (untrusted external
 *   source). When false (the default; the event-folding path), pass sessions
 *   through uncapped by reference — `evolve` already enforces the cap.
 */
export function writeProjectionToState(
  state: WritableProjectionState,
  p: WorkflowProjection,
  fromSnapshot = false,
): void {
  state['sessions'] = fromSnapshot ? capSessionLogs(p.sessions) : p.sessions;
  state['tasks'] = { ...p.tasks };
  state['phases'] = [...p.phases];
  state['currentPhaseId'] = p.currentPhaseId;
  state['completedPhaseIds'] = [...p.completedPhaseIds];
  state['sidebar'] = { ...p.sidebar };
  state['status'] = p.status;
  state['taskPrompt'] = p.taskPrompt;
  state['error'] = p.error;
  state['failedPhase'] = p.failedPhase;
  state['stats'] = { ...p.stats };
}

/**
 * Whether a {@link TaskStatus} is terminal (no further progress): `complete`,
 * `failed`, or `cancelled`. Shared by the store-facing
 * {@link reconcileSelection} and the TUI `Dashboard._applySelectionToWidgets`
 * task-completion-reselection rule so the terminal-status set cannot diverge
 * between the two call sites.
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}

/**
 * Pick the most-recently-started (greatest `startedAt`) `active` task from the
 * supplied list. Tasks missing `startedAt` are treated as `-Infinity` (oldest).
 * Returns `undefined` when the list contains no active task. Shared by the
 * store-facing {@link reconcileSelection} and the TUI
 * `Dashboard._applySelectionToWidgets` task-completion-reselection rule so the
 * tie-break and `-Infinity` default cannot diverge between them.
 */
export function pickMostRecentlyStartedActive(tasks: TaskEntity[]): TaskEntity | undefined {
  const active = tasks.filter((t) => t.status === 'active');
  if (active.length === 0) return undefined;
  return active.reduce((best, t) => ((t.startedAt ?? -Infinity) > (best.startedAt ?? -Infinity) ? t : best));
}

/**
 * Pick the most-recently-started (greatest `startedAt`) `parked` task from the
 * supplied list. Tasks missing `startedAt` are treated as `-Infinity` (oldest).
 * Returns `undefined` when the list contains no parked task. Used as a
 * completion-reselection fallback (after {@link pickMostRecentlyStartedActive})
 * so that when no `active` task remains but a parked (paused-but-in-progress)
 * task does, it is re-selected instead of leaving the now-terminal task. Shared
 * by the store-facing {@link reconcileSelection} and the TUI dashboard so the
 * fallback cannot diverge between the two call sites.
 */
export function pickMostRecentlyStartedParked(tasks: TaskEntity[]): TaskEntity | undefined {
  const parked = tasks.filter((t) => t.status === 'parked');
  if (parked.length === 0) return undefined;
  return parked.reduce((best, t) => ((t.startedAt ?? -Infinity) > (best.startedAt ?? -Infinity) ? t : best));
}

/**
 * Reconcile selection state after projection updates (snapshot or events).
 * Implements the Dashboard's follow rules:
 *
 * - PHASE FOLLOW: only advances the selected phase when the user WAS
 *   synced with the active phase (selectedPhaseId === prevCurrentPhaseId) AND
 *   the active phase advanced (currentPhaseId moved on). Navigating to a
 *   different phase that is neither completed nor carried forward from the
 *   (previous) current phase is treated as an intentional detour and is left
 *   alone. When the selected phase advances, task / session selection is reset so
 *   the new phase starts clean. The very first call (selectedPhaseId === null)
 *   auto-selects currentPhaseId.
 * - TASK FOLLOW: if selectedTaskId is null or no longer belongs to the selected
 *   phase → auto-select the first active or parked task (or first task).
 *   ADDITIONALLY, when the selected task transitioned out of 'active' or
 *   'parked' (→ complete / failed / cancelled) and other in-progress tasks
 *   remain, re-select the most-recently-started (greatest startedAt; missing
 *   startedAt → -Infinity) in-progress task — preferring an active task,
 *   falling back to a parked one. If no in-progress task remains, keep the
 *   completed task selected (intended).
 * - SESSION FOLLOW (B11): when the user has not pinned a session AND the log
 *   pane is not expanded (`isLogExpanded`), auto-select the most-recently-
 *   started (greatest `startedAt`) session whose `taskId` matches the selected
 *   task. Sessions of other tasks are ignored. When no matching session exists,
 *   `selectedSessionId` is set to null.
 *
 * At the END of the function, the prev-tracking fields are written back from
 * the post-follow current values so the NEXT call can detect a transition.
 *
 * @param isLogExpanded When true, suppresses session follow (the user is
 *   actively browsing the log pane). Omitted or false: session follow runs.
 *
 * Mutates selection fields on `state`.
 */
export function reconcileSelection(state: SelectionState, isLogExpanded?: boolean): void {
  // Phase follow
  if (state.selectedPhaseId === null && state.currentPhaseId) {
    // Fresh connect / first call: latch onto the active phase.
    state.selectedPhaseId = state.currentPhaseId;
  } else if (
    state.selectedPhaseId !== null &&
    state.selectedPhaseId === state.prevCurrentPhaseId &&
    state.currentPhaseId &&
    state.currentPhaseId !== state.prevCurrentPhaseId
  ) {
    // User was synced with the active phase AND the active phase advanced →
    // pull them along, resetting task/session selection for the new phase so it
    // starts clean.
    state.selectedPhaseId = state.currentPhaseId;
    state.userPinnedPhase = false;
    state.selectedTaskId = null;
    state.userPinnedSession = false;
  }
  // Else: the user is reviewing a completed phase or has navigated to a
  // different phase (an intentional detour). Leave selectedPhaseId as-is.

  // Task follow
  if (state.selectedPhaseId) {
    const tasksInPhase = Object.values(state.tasks).filter((t) => t.phaseId === state.selectedPhaseId);

    // Existing: auto-select when the current selection is null or stale.
    // A 'parked' task is in-progress (paused but active), so it is eligible
    // for auto-selection — mirroring the TUI dashboard's follow logic.
    if (state.selectedTaskId === null || !tasksInPhase.some((t) => t.id === state.selectedTaskId)) {
      const firstActive = tasksInPhase.find((t) => t.status === 'active' || t.status === 'parked');
      const nextTaskId = firstActive?.id ?? tasksInPhase[0]?.id ?? null;
      // Only clobber selection when the task ACTUALLY changes — e.g. when the
      // selected task is gone or a fresh task is auto-selected. When there is
      // nothing to select (selectedTaskId already null, no tasks in phase),
      // leave session selection untouched.
      if (nextTaskId !== state.selectedTaskId) {
        state.selectedTaskId = nextTaskId;
        // Reset session selection when task changes.
        state.userPinnedSession = false;
      }
    }

    // Task completion reselection: if the SELECTED task transitioned
    // OUT of 'active' or 'parked' (→ complete / failed / cancelled) since the
    // last call (prevSelectedTaskStatus was 'active' or 'parked') and other
    // in-progress tasks remain, re-select the most-recently-started (greatest
    // startedAt; missing startedAt treated as -Infinity) in-progress task —
    // preferring an active task, falling back to a parked one. If no
    // in-progress task remains, keep the completed task selected (intended).
    if (
      state.selectedTaskId !== null &&
      (state.prevSelectedTaskStatus === 'active' || state.prevSelectedTaskStatus === 'parked')
    ) {
      const selectedTask = state.tasks[state.selectedTaskId];
      if (selectedTask && isTerminalTaskStatus(selectedTask.status)) {
        const next = pickMostRecentlyStartedActive(tasksInPhase) ?? pickMostRecentlyStartedParked(tasksInPhase);
        if (next) {
          state.selectedTaskId = next.id;
          state.userPinnedSession = false;
        }
      }
    }
  }

  // Session follow (B11): when the user has not pinned a session AND the log
  // pane is not expanded, auto-select the most-recently-started (greatest
  // startedAt; missing startedAt → -Infinity so it loses) session whose taskId
  // matches the selected task. Sessions of other tasks are ignored. When no
  // matching session exists, selectedSessionId is set to null (which also covers
  // the task-change reset: a new task with no sessions clears the selection).
  if (state.selectedTaskId !== null && !state.userPinnedSession && !isLogExpanded) {
    const taskSessions = state.sessions
      ? Object.values(state.sessions).filter((a) => a.taskId === state.selectedTaskId)
      : [];
    if (taskSessions.length === 0) {
      state.selectedSessionId = null;
    } else {
      // ISO-8601-Z timestamps are lexicographically sortable, so `>` on the
      // string value gives the most-recently-started (greatest) `startedAt`.
      const mostRecent = taskSessions.reduce((best, a) => ((a.startedAt ?? '') > (best.startedAt ?? '') ? a : best));
      state.selectedSessionId = mostRecent.uid;
    }
  }

  // Prev-tracking write-back (transition detection for the NEXT call).
  // prevCurrentPhaseId captures the current (post-update) currentPhaseId so the
  // next call can detect a phase advancement. prevSelectedTaskStatus captures
  // the POST-follow selected task's status so the next call can detect a
  // completion transition. Coerce empty currentPhaseId → null so a fresh store
  // never holds a '' previous phase.
  state.prevCurrentPhaseId = state.currentPhaseId || null;
  const selTask = state.selectedTaskId ? state.tasks[state.selectedTaskId] : undefined;
  state.prevSelectedTaskStatus = selTask ? selTask.status : null;
}

/**
 * Cycle forward or backward through a session list (by array order). The
 * `sessions` list is pre-sorted by the caller. Wraps at both ends. Returns the
 * uid of the target session, or:
 *   • the first session when `currentSessionId` is null (or not found in the
 *     list — treated as null), regardless of direction;
 *   • null when the list is empty.
 */
export function selectNextSession(
  sessions: SessionEntity[],
  currentSessionId: string | null,
  direction: 1 | -1,
): string | null {
  if (sessions.length === 0) return null;
  const idx = currentSessionId ? sessions.findIndex((s) => s.uid === currentSessionId) : -1;
  if (idx === -1) return sessions[0].uid;
  const next = (idx + direction + sessions.length) % sessions.length;
  return sessions[next].uid;
}
