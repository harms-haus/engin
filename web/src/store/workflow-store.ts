/**
 * Vanilla Zustand store (created outside React) for the workflow projection.
 * Uses Immer middleware for safe structural updates.
 */

import { formatWorkflowEventLine } from '@engin/tui/format-workflow-event';
import type { Draft } from 'immer';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from 'zustand/react/shallow';
import type { AgentEntity, EventRecord, PhaseEntity, TaskEntity, WorkflowProjection } from '../protocol-types';
import { evolveClient, MAX_AGENT_LOG } from './evolve-client';

const MAX_WORKFLOW_EVENT_LOG = 1000;

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

  // Actions
  applySnapshot: (snapshot: WorkflowProjection, seq: number) => void;
  applyEvents: (events: EventRecord[]) => void;
  setStatus: (status: 'running' | 'complete' | 'failed') => void;
  setFailed: (error: string, failedPhase: string) => void;
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
};

export const useWorkflowStore = create<WorkflowStoreState>()(
  immer((set) => ({
    ...INITIAL_STATE,

    applySnapshot: (snapshot, seq) =>
      set((state) => {
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

    applyEvents: (events) =>
      set((s) => {
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

    setStatus: (status) =>
      set((state) => {
        state.status = status;
      }),

    setFailed: (error: string, failedPhase: string) =>
      set((state) => {
        state.status = 'failed';
        state.error = error;
        state.failedPhase = failedPhase;
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
