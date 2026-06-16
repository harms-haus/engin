/**
 * Vanilla Zustand store (created outside React) for the workflow projection.
 * Uses Immer middleware for safe structural updates.
 */

import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';
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
import { evolveClient, MAX_AGENT_LOG, MAX_RUN_LOG } from './evolve-client';

const MAX_WORKFLOW_EVENT_LOG = 1000;

// ─── Send bridge ─────────────────────────────────────────────────────────────
// Module-level send reference set by useWebSocket on acquire, cleared on release.
// Allows store actions (e.g. cancelRun) to send WS messages without depending
// on the React hook layer.
let _sendFn: ((msg: ClientMessage) => void) | null = null;

/** Called by useWebSocket when the singleton EngineClient is acquired / released. */
export function setStoreSendFn(fn: ((msg: ClientMessage) => void) | null): void {
  _sendFn = fn;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Reconstruct a WorkflowProjection from the current store state. */
function toProjection(s: WorkflowStoreState): WorkflowProjection {
  return {
    seq: s.seq,
    taskPrompt: s.taskPrompt,
    phases: s.phases,
    currentPhaseId: s.currentPhaseId,
    completedPhaseIds: s.completedPhaseIds,
    tasks: s.tasksById,
    agents: s.agentsById,
    sidebar: s.sidebar,
    status: s.status,
    error: s.error,
    failedPhase: s.failedPhase,
    stats: s.stats,
    runLog: [],
  };
}

/** Defensive cap on agent log length. */
function capAgentLogs(agents: Record<string, AgentEntity>): Record<string, AgentEntity> {
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

/** Write every normalized projection field into the Immer draft (except seq). Uses defensive copies for externally-sourced collections. */
function writeProjectionToState(state: Draft<WorkflowStoreState>, p: WorkflowProjection): void {
  state.agentsById = capAgentLogs(p.agents);
  state.tasksById = { ...p.tasks };
  state.phases = [...p.phases];
  state.currentPhaseId = p.currentPhaseId;
  state.completedPhaseIds = [...p.completedPhaseIds];
  state.sidebar = { ...p.sidebar };
  state.status = p.status;
  state.taskPrompt = p.taskPrompt;
  state.error = p.error;
  state.failedPhase = p.failedPhase;
  state.stats = { ...p.stats };
}

/**
 * Reconcile selection state after projection updates (snapshot or events).
 * Implements follow rules:
 * - Phase follow: if selectedPhaseId not null, not completed, and differs from currentPhaseId → set to currentPhaseId.
 * - Task follow: if selectedTaskId null or not in selected phase tasks → auto-select first active.
 * - Step follow: if !userPinnedStep → sync with activeStepIndex of selected task.
 */
function reconcileSelection(state: Draft<WorkflowStoreState>): void {
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
    const tasksInPhase = Object.values(state.tasksById).filter((t) => t.phaseId === state.selectedPhaseId);
    if (state.selectedTaskId === null || !tasksInPhase.some((t) => t.id === state.selectedTaskId)) {
      const firstActive = tasksInPhase.find((t) => t.status === 'active');
      state.selectedTaskId = firstActive?.id ?? tasksInPhase[0]?.id ?? null;
      // Reset step selection when task changes
      state.selectedStepIndex = null;
      state.userPinnedStep = false;
    }
  }

  // Step follow
  if (state.selectedTaskId !== null && !state.userPinnedStep) {
    const task = state.tasksById[state.selectedTaskId];
    if (task?.activeStepIndex !== undefined) {
      state.selectedStepIndex = task.activeStepIndex;
    }
  }
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
        writeProjectionToState(state, snapshot);
        // Only clear the event log on a genuine fresh start (first connect) or
        // server reset (seq went backwards). On reconnection, preserve accumulated
        // event lines — they are immutable seq-keyed facts.
        if (state.seq === 0 || seq < state.seq) {
          state.workflowEventLog = [];
        }
        state.seq = seq;
        reconcileSelection(state);
      }),

    applyEvents: (runId, events) =>
      set((s) => {
        if (s.selectedRunId !== runId) return;
        if (events.length === 0) return;
        let projection = toProjection(s);
        for (const event of events) {
          projection = evolveClient(projection, event);
        }
        writeProjectionToState(s, projection);
        s.seq = projection.seq;
        reconcileSelection(s);

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
          s.workflowEventLog = combined.slice(combined.length - MAX_WORKFLOW_EVENT_LOG);
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
        state.selectedRunId = runId;
        state.selectedPhaseId = null;
        state.selectedTaskId = null;
        state.selectedStepIndex = null;
        state.userPinnedPhase = false;
        state.userPinnedStep = false;
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
        reconcileSelection(state);
      }),

    selectTask: (id: string | null) =>
      set((state) => {
        state.selectedTaskId = id;
        state.selectedStepIndex = null;
        state.userPinnedStep = false;
        // Run follow rules to settle on initial step
        reconcileSelection(state);
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
