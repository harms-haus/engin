/**
 * Shared projection-store helpers.
 *
 * Extracted from the four helper functions that were duplicated between
 * `packages/shared/src/client-store.ts` (plain-TS ClientStore) and
 * `packages/web/src/store/workflow-store.ts` (Zustand + Immer workflow-store):
 *
 *   • {@link capAgentLogs}           — defensive cap on agent log length.
 *   • {@link toProjection}           — reconstruct a `WorkflowProjection` from
 *                                      projection-named fields (runLog reset).
 *   • {@link writeProjectionToState} — write projection fields into a state
 *                                      object (defensive copies; no seq/runLog).
 *   • {@link reconcileSelection}     — phase / task / step follow rules.
 *
 * All four helpers use the CANONICAL projection field names (`tasks`, `agents`,
 * …) — NOT the web store's `tasksById` / `agentsById`. The web workflow-store
 * maps its fields onto the canonical names before calling these helpers.
 *
 * `WritableProjectionState` and `SelectionState` are deliberately structural
 * (loose) interfaces so that both the ClientStore's typed state and ad-hoc
 * state objects satisfy them.
 */

import type { AgentEntity, TaskEntity, WorkflowProjection } from './event-types.js';
import { MAX_AGENT_LOG } from './evolve.js';

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
  selectedPhaseId: string | null;
  selectedTaskId: string | null;
  selectedStepIndex: number | null;
  userPinnedPhase: boolean;
  userPinnedStep: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Defensive cap on agent log length. */
export function capAgentLogs(agents: Record<string, AgentEntity>): Record<string, AgentEntity> {
  const out: Record<string, AgentEntity> = {};
  for (const [k, v] of Object.entries(agents)) {
    if (v.log.length > MAX_AGENT_LOG) {
      out[k] = { ...v, log: v.log.slice(v.log.length - MAX_AGENT_LOG) };
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
    agents: fields.agents,
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
 * @param fromSnapshot When true, defensively cap agent logs (untrusted external
 *   source). When false (the default; the event-folding path), pass agents
 *   through uncapped by reference — `evolve` already enforces the cap.
 */
export function writeProjectionToState(
  state: WritableProjectionState,
  p: WorkflowProjection,
  fromSnapshot = false,
): void {
  state['agents'] = fromSnapshot ? capAgentLogs(p.agents) : p.agents;
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
 * Reconcile selection state after projection updates (snapshot or events).
 * Implements follow rules:
 * - Phase follow: if selectedPhaseId is not null, not completed, and differs
 *   from currentPhaseId → snap to currentPhaseId.
 * - Task follow: if selectedTaskId is null or no longer belongs to the selected
 *   phase → auto-select the first active task (or first task).
 * - Step follow: if !userPinnedStep → sync with activeStepIndex of the selected task.
 *
 * Mutates selection fields on `state`.
 */
export function reconcileSelection(state: SelectionState): void {
  // Phase follow
  if (state.selectedPhaseId !== null && state.currentPhaseId) {
    const isCompleted = state.completedPhaseIds.includes(state.selectedPhaseId);
    if (!isCompleted && state.selectedPhaseId !== state.currentPhaseId) {
      state.selectedPhaseId = state.currentPhaseId;
      state.userPinnedPhase = false;
    }
  } else if (state.selectedPhaseId === null && state.currentPhaseId) {
    state.selectedPhaseId = state.currentPhaseId;
  }

  // Task follow
  if (state.selectedPhaseId) {
    const tasksInPhase = Object.values(state.tasks).filter((t) => t.phaseId === state.selectedPhaseId);
    if (state.selectedTaskId === null || !tasksInPhase.some((t) => t.id === state.selectedTaskId)) {
      const firstActive = tasksInPhase.find((t) => t.status === 'active');
      const nextTaskId = firstActive?.id ?? tasksInPhase[0]?.id ?? null;
      // Only clobber selection when the task ACTUALLY changes — e.g. when the
      // selected task is gone or a fresh task is auto-selected. When there is
      // nothing to select (selectedTaskId already null, no tasks in phase),
      // leave selectedStepIndex / userPinnedStep untouched.
      if (nextTaskId !== state.selectedTaskId) {
        state.selectedTaskId = nextTaskId;
        // Reset step selection when task changes.
        state.selectedStepIndex = null;
        state.userPinnedStep = false;
      }
    }
  }

  // Step follow
  if (state.selectedTaskId !== null && !state.userPinnedStep) {
    const task = state.tasks[state.selectedTaskId];
    if (task?.activeStepIndex !== undefined) {
      state.selectedStepIndex = task.activeStepIndex;
    }
  }
}
