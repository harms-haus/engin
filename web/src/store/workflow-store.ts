/**
 * Vanilla Zustand store (created outside React) for the workflow projection.
 * Uses Immer middleware for safe structural updates.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from 'zustand/react/shallow';
import type {
  AgentEntity,
  EventRecord,
  LogEntry,
  PhaseDescriptor,
  TaskEntity,
  WorkflowProjection,
} from '../protocol-types';
import { evolveClient, MAX_AGENT_LOG } from './evolve-client';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Reconstruct a WorkflowProjection from the current store state. */
function toProjection(s: WorkflowStoreState): WorkflowProjection {
  return {
    seq: s.seq,
    taskPrompt: s.taskPrompt,
    currentPhase: s.currentPhase,
    completedPhases: s.completedPhases,
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

// ─── Store state interface ──────────────────────────────────────────────────

export interface WorkflowStoreState {
  // Normalized projection fields
  agentsById: Record<string, AgentEntity>;
  tasksById: Record<string, TaskEntity>;
  currentPhase: string;
  completedPhases: string[];
  sidebar: {
    title: string;
    indicator: string;
    phases?: PhaseDescriptor[];
  };
  status: 'running' | 'complete' | 'failed';
  taskPrompt: string;
  error?: string;
  failedPhase?: string;
  seq: number;
  stats: { totalTokens: number; agentCount: number };

  // Actions
  applySnapshot: (snapshot: WorkflowProjection, seq: number) => void;
  applyEvents: (events: EventRecord[]) => void;
  setStatus: (status: 'running' | 'complete' | 'failed') => void;
  setFailed: (error: string, failedPhase: string) => void;
}

// ─── Store creation ─────────────────────────────────────────────────────────

const INITIAL_STATE = {
  agentsById: {} as Record<string, AgentEntity>,
  tasksById: {} as Record<string, TaskEntity>,
  currentPhase: '',
  completedPhases: [] as string[],
  sidebar: { title: '', indicator: '' },
  status: 'running' as const,
  taskPrompt: '',
  error: undefined as string | undefined,
  failedPhase: undefined as string | undefined,
  seq: 0,
  stats: { totalTokens: 0, agentCount: 0 },
};

export const useWorkflowStore = create<WorkflowStoreState>()(
  immer((set) => ({
    ...INITIAL_STATE,

    applySnapshot: (snapshot, seq) =>
      set((state) => {
        state.agentsById = capAgentLogs(snapshot.agents);
        state.tasksById = { ...snapshot.tasks };
        state.currentPhase = snapshot.currentPhase;
        state.completedPhases = [...snapshot.completedPhases];
        state.sidebar = { ...snapshot.sidebar };
        state.status = snapshot.status;
        state.taskPrompt = snapshot.taskPrompt;
        state.error = snapshot.error;
        state.failedPhase = snapshot.failedPhase;
        state.seq = seq;
        state.stats = { ...snapshot.stats };
      }),

    applyEvents: (events) =>
      set((s) => {
        let projection = toProjection(s);
        for (const event of events) {
          projection = evolveClient(projection, event);
        }
        s.agentsById = capAgentLogs(projection.agents);
        s.tasksById = projection.tasks;
        s.currentPhase = projection.currentPhase;
        s.completedPhases = projection.completedPhases;
        s.sidebar = projection.sidebar;
        s.status = projection.status;
        s.taskPrompt = projection.taskPrompt;
        s.error = projection.error;
        s.failedPhase = projection.failedPhase;
        s.seq = projection.seq;
        s.stats = projection.stats;
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
  })),
);

// ─── Selector hooks ─────────────────────────────────────────────────────────

export const useAgentIds = () => useWorkflowStore(useShallow((s) => Object.keys(s.agentsById)));

export const useAgentById = (id: string) => useWorkflowStore((s) => s.agentsById[id]);

export const useTaskIds = () => useWorkflowStore(useShallow((s) => Object.keys(s.tasksById)));

export const useTaskById = (id: string) => useWorkflowStore((s) => s.tasksById[id]);

/**
 * Flatten all agent logs into a single timestamp-sorted LogEntry[]
 * (oldest-first, matching EventLog's auto-scroll-bottom behavior),
 * capped at `limit` entries. Memoized via useShallow to avoid
 * re-renders when the derived array hasn't changed.
 */
export const useRecentLogEntries = (limit = 100): LogEntry[] =>
  useWorkflowStore(
    useShallow((s) => {
      const all: LogEntry[] = [];
      for (const agent of Object.values(s.agentsById)) {
        all.push(...agent.log);
      }
      // ISO-8601 timestamps sort lexicographically; direct `<`/`>` is faster
      // than localeCompare and yields the same ordering.
      all.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      return all.length > limit ? all.slice(all.length - limit) : all;
    }),
  );

export const useCurrentPhase = () => useWorkflowStore((s) => s.currentPhase);

export const useCompletedPhases = () => useWorkflowStore((s) => s.completedPhases);

export const useSidebar = () => useWorkflowStore((s) => s.sidebar);

export const useStatus = () => useWorkflowStore((s) => s.status);

export const useError = () => useWorkflowStore((s) => s.error);

export const useFailedPhase = () => useWorkflowStore((s) => s.failedPhase);

export const useHasSnapshot = () => useWorkflowStore((s) => s.seq > 0);

export const useSeq = () => useWorkflowStore((s) => s.seq);

/** Convenience: read seq without subscribing (for useWebSocket transport). */
export const getSeq = () => useWorkflowStore.getState().seq;
