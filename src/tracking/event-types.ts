// ─── Event Types ─────────────────────────────────────────────────────────────
// Maps 1:1 to the 19 StatusCallbacks methods in core/types.ts.

// ─── Re-exports from core/types.ts ──────────────────────────────────────────
import type { StepDefinition, StepEntity, TaskEntity, TaskStatus } from '../core/types.js';
export type { StepDefinition, StepEntity, TaskEntity, TaskStatus };

// ─── LogEntry ──────────────────────────────────────────────────────────────
// Canonical definition lives here (tracking core). The web layer re-exports
// this type from src/web/protocol-types.ts so that web depends on core, not
// the other way around.

export interface LogEntry {
  id: string;
  timestamp: string;
  type: 'text' | 'thinking' | 'tool_call' | 'tool_call_start' | 'tool_call_end' | 'decision' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export type EventType =
  | 'workflow_started'
  | 'phase_registered'
  | 'phase_started'
  | 'phase_completed'
  | 'agent_spawned'
  | 'agent_completed'
  | 'task_registered'
  | 'task_started'
  | 'step_started'
  | 'task_completed'
  | 'task_rejected'
  | 'decision'
  | 'error'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'sidebar_updated'
  | 'turn_started'
  | 'turn_ended'
  | 'tool_call_started'
  | 'tool_call_ended';

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
    stepIndex?: number;
  };
}

// ─── Entities ────────────────────────────────────────────────────────────────

export interface PhaseEntity {
  id: string;
  label: string;
  icon: string;
  taskIds: string[];
}

export interface AgentEntity {
  uid: string;
  agentId: string;
  profile: string;
  phaseId: string;
  stepIndex?: number;
  taskId?: string;
  sessionId?: string;
  sessionPath?: string;
  active: boolean;
  log: LogEntry[];
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  taskTitle: string;
  completedAt?: string;
}

// ─── Workflow Projection ─────────────────────────────────────────────────────

export interface WorkflowProjection {
  seq: number;
  taskPrompt: string;
  phases: PhaseEntity[];
  currentPhaseId: string;
  completedPhaseIds: string[];
  tasks: Record<string, TaskEntity>;
  agents: Record<string, AgentEntity>;
  sidebar: {
    title: string;
    indicator: string;
  };
  status: 'running' | 'complete' | 'failed';
  error?: string;
  failedPhase?: string;
  stats: {
    totalTokens: number;
    agentCount: number;
  };
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
    agents: {},
    sidebar: { title: '', indicator: '' },
    status: 'running',
    stats: { totalTokens: 0, agentCount: 0 },
  };
}
