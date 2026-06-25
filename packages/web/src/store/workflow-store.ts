/**
 * Vanilla Zustand store (created outside React) for the workflow projection.
 * Uses Immer middleware for safe structural updates.
 */

import { MAX_RUN_LOG, MAX_WORKFLOW_EVENT_LOG, type TaskStatus } from '@engin/shared/event-types';
import { evolve as evolveClient } from '@engin/shared/evolve';
import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';
import {
  reconcileSelection,
  toProjection,
  writeProjectionToState,
  type ProjectionFields,
  type SelectionState,
  type WritableProjectionState,
} from '@engin/shared/projection-helpers';
import type { Draft } from 'immer';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from 'zustand/react/shallow';
import type {
  AgentEntity,
  ClientMessage,
  EventRecord,
  PhaseEntity,
  RunSummary,
  TaskEntity,
  WorkflowProjection,
} from '../protocol-types';

// ─── Send bridge ─────────────────────────────────────────────────────────────
// Module-level send reference set by useWebSocket on acquire, cleared on release.
// Allows store actions (e.g. cancelRun) to send WS messages without depending
// on the React hook layer.
let _sendFn: ((msg: ClientMessage) => void) | null = null;
let _subscribeRunFn: ((runId: string) => void) | null = null;
let _unsubscribeRunFn: ((runId: string) => void) | null = null;

/** Called by useWebSocket when the singleton EngineClient is acquired / released. */
export function setStoreSendFn(fn: ((msg: ClientMessage) => void) | null): void {
  _sendFn = fn;
}

/** Called by useWebSocket to wire (or unwire) the run-subscription bridge.
 *  Delegates to `EngineClient.subscribe`/`unsubscribe` so subscriptions are
 *  tracked and replayed on reconnect. `selectRun` uses this to tell the server
 *  to stream a run's snapshot/events — without it the server never sends a
 *  projection for the clicked run, so its details never appear. */
export function setStoreSubscribeRunFn(fn: ((runId: string) => void) | null): void {
  _subscribeRunFn = fn;
}

export function setStoreUnsubscribeRunFn(fn: ((runId: string) => void) | null): void {
  _unsubscribeRunFn = fn;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
// capAgentLogs / toProjection / writeProjectionToState / reconcileSelection
// live in @engin/shared/projection-helpers (shared with the TUI ClientStore).
// The web store's projection fields carry the suffixed names `agentsById` /
// `tasksById` (Immer-typed `Draft<WorkflowStoreState>`), whereas the shared
// helpers speak the CANONICAL projection names (`agents` / `tasks`).
// {@link canonicalView} bridges that gap so the helpers can read/write the
// Immer draft directly — Immer records the underlying mutations — without
// duplicating any projection/selection logic in this module.

/**
 * Expose the store's `agentsById` / `tasksById` Immer-draft fields under the
 * canonical projection names (`agents` / `tasks`) the shared helpers expect.
 *
 * Reads and writes pass straight through to the underlying Immer draft, so
 * mutations performed by the shared {@link writeProjectionToState} and
 * {@link reconcileSelection} are tracked by Immer exactly as if the store used
 * the canonical field names directly (the ClientStore does — its state already
 * carries `agents` / `tasks`). Every other field shares its name between the
 * two stores and is forwarded untouched.
 */
function canonicalView(state: Draft<WorkflowStoreState>): WritableProjectionState & SelectionState & ProjectionFields {
  return new Proxy(state as object, {
    get(t, p) {
      const s = t as WorkflowStoreState;
      if (p === 'agents') return s.agentsById;
      if (p === 'tasks') return s.tasksById;
      return Reflect.get(s, p);
    },
    set(t, p, value) {
      const s = t as WorkflowStoreState;
      if (p === 'agents') {
        s.agentsById = value as Record<string, AgentEntity>;
        return true;
      }
      if (p === 'tasks') {
        s.tasksById = value as Record<string, TaskEntity>;
        return true;
      }
      return Reflect.set(s, p, value);
    },
  }) as WritableProjectionState & SelectionState & ProjectionFields;
}

// ─── Store state interface ──────────────────────────────────────────────────

export interface WorkflowEventLogEntry {
  seq: number;
  line: string;
}

/** Server-captured runtime console line for a run (the `{ type: 'log' }`
 *  server message). Distinct from WorkflowEventLogEntry (workflow events). */
export interface RunLogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

export interface WorkflowStoreState {
  // Normalized projection fields
  agentsById: Record<string, AgentEntity>;
  tasksById: Record<string, TaskEntity>;
  phases: PhaseEntity[];
  currentPhaseId: string;
  completedPhaseIds: string[];
  sidebar: {
    title: string;
    indicator: string;
  };
  status: 'running' | 'complete' | 'failed';
  taskPrompt: string;
  error?: string;
  failedPhase?: string;
  seq: number;
  stats: { totalTokens: number; agentCount: number };
  workflowEventLog: WorkflowEventLogEntry[];

  // Selection state
  selectedPhaseId: string | null;
  selectedTaskId: string | null;
  selectedStepIndex: number | null;
  userPinnedPhase: boolean;
  userPinnedStep: boolean;
  /**
   * Previous-state fields the shared `reconcileSelection` write-back populates
   * on every call (through the `canonicalView` proxy → Immer draft) so the
   * NEXT call can detect a phase / task-status transition:
   *
   *   prevCurrentPhaseId      — drives the tightened phase-follow
   *                             (synced + advanced → follow).
   *   prevSelectedTaskStatus  — drives task-completion-reselection
   *                             (active → complete|failed|cancelled).
   *
   * NOTE: there is intentionally NO prevActiveStepIndex — the shared
   * step-follow stays the broad userPinnedStep-gated rule (the TUI's
   * expanded-state exception is not mirrored here).
   */
  prevCurrentPhaseId: string | null;
  prevSelectedTaskStatus: TaskStatus | null;

  // Multi-run state
  runs: RunSummary[];
  selectedRunId: string | null;
  runLogs: Record<string, RunLogEntry[]>;

  // Actions
  setRuns: (runs: RunSummary[]) => void;
  addRun: (summary: RunSummary) => void;
  selectRun: (runId: string) => void;
  cancelRun: (runId: string) => void;
  appendRunLog: (runId: string, entry: RunLogEntry) => void;
  applySnapshot: (runId: string, snapshot: WorkflowProjection, seq: number) => void;
  applyEvents: (runId: string, events: EventRecord[]) => void;
  setStatus: (runId: string, status: 'running' | 'complete' | 'failed') => void;
  setFailed: (runId: string, error: string, failedPhase: string) => void;
  selectPhase: (id: string | null) => void;
  selectTask: (id: string | null) => void;
  selectStep: (index: number | null) => void;
  resetSelection: () => void;
}

// ─── Store creation ─────────────────────────────────────────────────────────

/** The projection fields reset to empty/initial values. Spread into a draft
 *  in {@link selectRun} so switching runs doesn't bleed the previous run's
 *  entities / event log / seq into the view while the first snapshot is in
 *  flight. (Includes `seq: 0` so the first snapshot clears the event log.) */
const EMPTY_PROJECTION = {
  agentsById: {} as Record<string, AgentEntity>,
  tasksById: {} as Record<string, TaskEntity>,
  phases: [] as PhaseEntity[],
  currentPhaseId: '',
  completedPhaseIds: [] as string[],
  sidebar: { title: '', indicator: '' },
  status: 'running' as const,
  taskPrompt: '',
  error: undefined as string | undefined,
  failedPhase: undefined as string | undefined,
  seq: 0,
  stats: { totalTokens: 0, agentCount: 0 },
  workflowEventLog: [] as WorkflowEventLogEntry[],
};

const INITIAL_STATE = {
  agentsById: {} as Record<string, AgentEntity>,
  tasksById: {} as Record<string, TaskEntity>,
  phases: [] as PhaseEntity[],
  currentPhaseId: '',
  completedPhaseIds: [] as string[],
  sidebar: { title: '', indicator: '' },
  status: 'running' as const,
  taskPrompt: '',
  error: undefined as string | undefined,
  failedPhase: undefined as string | undefined,
  seq: 0,
  stats: { totalTokens: 0, agentCount: 0 },
  workflowEventLog: [] as WorkflowEventLogEntry[],
  selectedPhaseId: null as string | null,
  selectedTaskId: null as string | null,
  selectedStepIndex: null as number | null,
  userPinnedPhase: false,
  userPinnedStep: false,
  // Prev-tracking fields (mirrors the selectRun reset). Declared optional on
  // the interface; always initialized here so the store starts from a known
  // baseline regardless of what a prior session wrote.
  prevCurrentPhaseId: null as string | null,
  prevSelectedTaskStatus: null as TaskStatus | null,
  // Multi-run fields
  runs: [] as RunSummary[],
  selectedRunId: null as string | null,
  runLogs: {} as Record<string, RunLogEntry[]>,
};

export const useWorkflowStore = create<WorkflowStoreState>()(
  immer((set) => ({
    ...INITIAL_STATE,

    applySnapshot: (runId, snapshot, seq) =>
      set((state) => {
        if (state.selectedRunId !== runId) return;
        // fromSnapshot = true → the shared helper defensively caps untrusted
        // external agent logs (the snapshot arrives verbatim from the server)
        // at the MAX_AGENT_LOG boundary defined in @engin/shared/evolve.
        writeProjectionToState(canonicalView(state), snapshot, true);
        // Only clear the event log on a genuine fresh start (first connect) or
        // server reset (seq went backwards). On reconnection, preserve accumulated
        // event lines — they are immutable seq-keyed facts.
        if (state.seq === 0 || seq < state.seq) {
          state.workflowEventLog = [];
        }
        state.seq = seq;
        reconcileSelection(canonicalView(state));
      }),

    applyEvents: (runId, events) =>
      set((s) => {
        if (s.selectedRunId !== runId) return;
        if (events.length === 0) return;
        let projection = toProjection(canonicalView(s));
        for (const event of events) {
          projection = evolveClient(projection, event);
        }
        // fromSnapshot defaults to false: evolve already enforces the agent-log
        // cap, so the folded result can be written in by reference.
        writeProjectionToState(canonicalView(s), projection);
        s.seq = projection.seq;
        reconcileSelection(canonicalView(s));

        // Build workflow-level event lines from this batch
        const collected: WorkflowEventLogEntry[] = [];
        for (const event of events) {
          const line = formatWorkflowEventLine(event);
          if (line !== null) {
            collected.push({ seq: event.seq, line });
          }
        }
        if (collected.length > 0) {
          const combined = [...s.workflowEventLog, ...collected];
          s.workflowEventLog = combined.slice(Math.max(0, combined.length - MAX_WORKFLOW_EVENT_LOG));
        }
      }),

    setStatus: (runId, status) =>
      set((state) => {
        if (state.selectedRunId !== runId) return;
        state.status = status;
        // Also update the runs[] entry so RunsFrame reflects the change
        const run = state.runs.find((r) => r.runId === runId);
        if (run) run.status = status;
      }),

    setFailed: (runId: string, error: string, failedPhase: string) =>
      set((state) => {
        if (state.selectedRunId !== runId) return;
        state.status = 'failed';
        state.error = error;
        state.failedPhase = failedPhase;
        // Also update the runs[] entry so RunsFrame reflects the change
        const run = state.runs.find((r) => r.runId === runId);
        if (run) run.status = 'failed';
      }),

    setRuns: (runs) =>
      set((state) => {
        state.runs = runs;
      }),

    addRun: (summary) =>
      set((state) => {
        const idx = state.runs.findIndex((r) => r.runId === summary.runId);
        if (idx >= 0) {
          state.runs[idx] = summary;
        } else {
          state.runs.push(summary);
        }
      }),

    selectRun: (runId) =>
      set((state) => {
        const previousRunId = state.selectedRunId;
        // Adopt the new run and reset ALL projection + selection state so the
        // view does not show the previous run's data while the first snapshot
        // is in flight. `seq: 0` makes the incoming snapshot clear the event log.
        state.selectedRunId = runId;
        Object.assign(state, EMPTY_PROJECTION);
        state.selectedPhaseId = null;
        state.selectedTaskId = null;
        state.selectedStepIndex = null;
        state.userPinnedPhase = false;
        state.userPinnedStep = false;
        // Reset the prev-tracking fields too so the previous run's transition
        // state does not leak into the new run's first reconcile pass.
        state.prevCurrentPhaseId = null;
        state.prevSelectedTaskStatus = null;
        // Subscribe to the run on the server. The server's `subscribe` handler
        // replies with a full snapshot, which applySnapshot() then projects.
        // Drop the previously selected run from the multiplex set so we don't
        // accumulate server-side subscriptions for every run ever clicked.
        // (Bridge fns are null until useWebSocket acquires the singleton; in
        // that brief window no message is sent and the user can re-select.)
        if (previousRunId !== null && previousRunId !== runId) {
          _unsubscribeRunFn?.(previousRunId);
        }
        _subscribeRunFn?.(runId);
      }),

    cancelRun: (runId: string) => {
      _sendFn?.({ type: 'cancel_run', runId });
    },

    appendRunLog: (runId, entry) =>
      set((state) => {
        const existing = state.runLogs[runId] ?? [];
        existing.push(entry);
        state.runLogs[runId] = existing.length > MAX_RUN_LOG ? existing.slice(existing.length - MAX_RUN_LOG) : existing;
      }),

    selectPhase: (id: string | null) =>
      set((state) => {
        state.selectedPhaseId = id;
        // Pinned if a completed phase is explicitly selected
        state.userPinnedPhase = id !== null && state.completedPhaseIds.includes(id);
        // Reset task/step when phase changes
        state.selectedTaskId = null;
        state.selectedStepIndex = null;
        state.userPinnedStep = false;
        // Run follow rules to settle on initial task/step
        reconcileSelection(canonicalView(state));
      }),

    selectTask: (id: string | null) =>
      set((state) => {
        state.selectedTaskId = id;
        state.selectedStepIndex = null;
        state.userPinnedStep = false;
        // Run follow rules to settle on initial step
        reconcileSelection(canonicalView(state));
      }),

    selectStep: (index: number | null) =>
      set((state) => {
        state.selectedStepIndex = index;
        state.userPinnedStep = true;
      }),

    resetSelection: () =>
      set((state) => {
        state.selectedPhaseId = null;
        state.selectedTaskId = null;
        state.selectedStepIndex = null;
        state.userPinnedPhase = false;
        state.userPinnedStep = false;
        state.prevCurrentPhaseId = null;
        state.prevSelectedTaskStatus = null;
      }),
  })),
);

// ─── Selector hooks ─────────────────────────────────────────────────────────

export const useAgentIds = () => useWorkflowStore(useShallow((s) => Object.keys(s.agentsById)));

export const useAgentById = (id: string) => useWorkflowStore((s) => s.agentsById[id]);

export const useTaskIds = () => useWorkflowStore(useShallow((s) => Object.keys(s.tasksById)));

export const useTaskById = (id: string) => useWorkflowStore((s) => s.tasksById[id]);

export const useWorkflowEventLog = () => useWorkflowStore((s) => s.workflowEventLog);

export const useCurrentPhaseId = () => useWorkflowStore((s) => s.currentPhaseId);

export const useCompletedPhaseIds = () => useWorkflowStore((s) => s.completedPhaseIds);

export const usePhases = () => useWorkflowStore((s) => s.phases);

export const useSidebar = () => useWorkflowStore((s) => s.sidebar);

export const useStatus = () => useWorkflowStore((s) => s.status);

export const useError = () => useWorkflowStore((s) => s.error);

export const useFailedPhase = () => useWorkflowStore((s) => s.failedPhase);

export const useSelectedPhaseId = () => useWorkflowStore((s) => s.selectedPhaseId);

export const useSelectedTaskId = () => useWorkflowStore((s) => s.selectedTaskId);

export const useSelectedStepIndex = () => useWorkflowStore((s) => s.selectedStepIndex);

export const useHasSnapshot = () => useWorkflowStore((s) => s.seq > 0);

export const useSeq = () => useWorkflowStore((s) => s.seq);

/** Convenience: read seq without subscribing (for useWebSocket transport). */
export const getSeq = () => useWorkflowStore.getState().seq;

// ─── Multi-run selectors ────────────────────────────────────────────────────

export const useRuns = () => useWorkflowStore((s) => s.runs);

export const useSelectedRunId = () => useWorkflowStore((s) => s.selectedRunId);

export const useRunLogs = (runId: string) => useWorkflowStore((s) => s.runLogs[runId] ?? []);
