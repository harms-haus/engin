// ─── Event Types ─────────────────────────────────────────────────────────────
// Superset of the StatusCallbacks defined in core/types.ts (callbacks +
// derived / server-only events such as 'log'). auto_retry_started and
// auto_retry_completed are added ahead of their engine emitter, which will
// be wired in a later task. task_parked and task_unparked are similarly
// forward-declared ahead of the parking scheduler, which will be wired in a
// later task.

// ─── Re-exports from core/types.ts ──────────────────────────────────────────
import type { StepDefinition, TaskEntity, TaskStatus } from './types.js';
export type { StepDefinition, TaskEntity, TaskStatus };

// ─── LogEntry ──────────────────────────────────────────────────────────────
// Canonical definition lives here (tracking core). The web layer re-exports
// this type via @engin/shared/protocol-types.

export interface LogEntry {
  id: string;
  timestamp: string;
  type: 'text' | 'thinking' | 'tool_call' | 'tool_call_start' | 'tool_call_end' | 'decision' | 'error' | 'render';
  content: string;
  metadata?: Record<string, unknown>;
}

export type EventType =
  | 'workflow_started'
  | 'phase_registered'
  | 'phase_started'
  | 'phase_completed'
  | 'session_started'
  | 'session_completed'
  | 'session_failed'
  | 'auto_retry_started'
  | 'auto_retry_completed'
  | 'task_registered'
  | 'task_started'
  | 'task_completed'
  | 'task_rejected'
  | 'task_parked'
  | 'task_unparked'
  | 'decision'
  | 'error'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'sidebar_updated'
  | 'turn_started'
  | 'turn_ended'
  | 'tool_call_started'
  | 'tool_call_ended'
  | 'log'
  | 'agent_rendered'
  | 'workflow_data_set';

// ─── Event Record ────────────────────────────────────────────────────────────

export interface EventRecord {
  seq: number;
  type: EventType;
  data: Record<string, unknown>;
  metadata: {
    timestamp: string;
    agentId?: string;
    taskId?: string;
    phaseId?: string;
    runnerRole?: string;
    attempt?: number;
  };
}

// ─── Entities ────────────────────────────────────────────────────────────────

export interface PhaseEntity {
  id: string;
  label: string;
  icon: string;
  taskIds: string[];
}

export interface SessionEntity {
  uid: string;
  agentId: string;
  profile: string;
  phaseId: string;
  taskId?: string;
  sessionId?: string;
  sessionPath?: string;
  active: boolean;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  log: LogEntry[];
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  contextWindow?: number;
  startedAt?: string;
  taskTitle: string;
  completedAt?: string;
  runnerRole: string;
  attempt: number;
  /**
   * Transient render-ordering marker: the session.log length recorded when
   * the current turn started. Consumed by the `turn_ended` handler to splice
   * that turn's thinking/text content blocks in BEFORE the turn's tool-call
   * entries (which are appended during the turn, before `turn_ended` fires),
   * yielding the intended think → message → tool order. Not part of the wire
   * protocol; derived deterministically during evolve.
   */
  _turnStartLogIndex?: number;
}

// ─── Run Log Cap ────────────────────────────────────────────────────────────
// Maximum number of entries retained in WorkflowProjection.runLog. Older
// entries are dropped (FIFO) when this limit is exceeded.
export const MAX_RUN_LOG = 200;

// ─── Workflow Event Log Cap ──────────────────────────────────────────────────
// Maximum number of entries retained in the workflow event log (FIFO). Older
// entries are dropped once this limit is exceeded so memory stays bounded for
// long-running workflows. The cap is generous (well above any visible window)
// to preserve ample scroll-back.
export const MAX_WORKFLOW_EVENT_LOG = 10000;

// ─── Workflow Projection ─────────────────────────────────────────────────────

export interface WorkflowProjection {
  seq: number;
  taskPrompt: string;
  phases: PhaseEntity[];
  currentPhaseId: string;
  completedPhaseIds: string[];
  tasks: Record<string, TaskEntity>;
  sessions: Record<string, SessionEntity>;
  sidebar: {
    title: string;
    indicator: string;
  };
  status: 'running' | 'complete' | 'failed';
  error?: string;
  failedPhase?: string;
  stats: {
    totalTokens: number;
    sessionCount: number;
  };
  /** Server-captured console output (capped at MAX_RUN_LOG entries). */
  runLog: LogEntry[];

  /** Arbitrary data attached via workflow_data_set events (shallow-merged). */
  workflowData?: Record<string, unknown>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createInitialProjection(): WorkflowProjection {
  return {
    seq: 0,
    taskPrompt: '',
    phases: [],
    currentPhaseId: '',
    completedPhaseIds: [],
    tasks: {},
    sessions: {},
    sidebar: { title: '', indicator: '' },
    status: 'running',
    stats: { totalTokens: 0, sessionCount: 0 },
    runLog: [],
    workflowData: undefined,
  };
}
