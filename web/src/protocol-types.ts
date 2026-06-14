/**
 * WebSocket protocol types for the engin web interface.
 * Mirror copy – keep in sync with src/web/protocol-types.ts.
 */

// ─── Shared value types ─────────────────────────────────────────────────────

export interface PhaseDescriptor {
  id: string;
  label: string;
  icon: string;
}

// ─── Mirror of src/tracking/event-types.ts — keep in sync ──────────────────
//
// These types are canonically defined in the engine's tracking core.  The web
// client cannot import from the engine package, so we define identical
// structural mirrors here.  All fields must remain JSON-serializable
// (Record / Array / string / number / boolean only).

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

export interface LogEntry {
  id: string;
  timestamp: string;
  type: 'text' | 'thinking' | 'tool_call' | 'tool_call_start' | 'tool_call_end' | 'decision' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

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

// ─── Server → Client messages ───────────────────────────────────────────────
//
// The protocol uses a snapshot/delta model:
//   - `snapshot`   — full WorkflowProjection, sent on connect / full resync.
//   - `events`     — batch of raw EventRecords since the last seq.
//   - `workflow_complete` / `workflow_failed` — dedicated top-level lifecycle
//     signals (not derivable from events alone in all edge cases).

export type ServerMessage =
  | { type: 'snapshot'; seq: number; state: WorkflowProjection }
  | { type: 'events'; seq: number; events: EventRecord[] }
  | { type: 'workflow_complete' }
  | { type: 'workflow_failed'; error: string; phase: string };

// ─── Client → Server messages ───────────────────────────────────────────────

export type ClientMessage = { type: 'terminate_server' } | { type: 'resync'; lastSeq?: number };

// ─── Type guard ─────────────────────────────────────────────────────────────

export function isServerMessage(data: unknown): data is ServerMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'snapshot':
    case 'events':
    case 'workflow_complete':
    case 'workflow_failed':
      return true;
    default:
      return false;
  }
}
