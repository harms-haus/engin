// ─── Event Types ─────────────────────────────────────────────────────────────
// Maps 1:1 to the 19 StatusCallbacks methods in core/types.ts.

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
  | 'phase_started'
  | 'phase_completed'
  | 'agent_spawned'
  | 'agent_completed'
  | 'task_started'
  | 'task_step_started'
  | 'task_completed'
  | 'task_rejected'
  | 'decision'
  | 'error'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'tasks_added'
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
    phase?: string;
  };
}

// ─── Entities ────────────────────────────────────────────────────────────────

export interface AgentEntity {
  uid: string;
  agentId: string;
  profile: string;
  phase: string;
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

export interface TaskEntity {
  id: string;
  title: string;
  status: string;
  phase?: string;
  agentId?: string;
  startedAt?: number;
  stepInfo?: string;
  completedAt?: string;
}

// ─── Workflow Projection ─────────────────────────────────────────────────────

export interface WorkflowProjection {
  seq: number;
  taskPrompt: string;
  currentPhase: string;
  completedPhases: string[];
  tasks: Record<string, TaskEntity>;
  agents: Record<string, AgentEntity>;
  sidebar: {
    title: string;
    indicator: string;
    phases?: { id: string; label: string; icon: string }[];
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
    currentPhase: '',
    completedPhases: [],
    tasks: {},
    agents: {},
    sidebar: { title: '', indicator: '' },
    status: 'running',
    stats: { totalTokens: 0, agentCount: 0 },
  };
}
