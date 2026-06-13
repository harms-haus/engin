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

export interface LogEntry {
  id: string;
  timestamp: string;
  type: 'text' | 'thinking' | 'tool_call' | 'tool_call_start' | 'tool_call_end' | 'decision' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AgentWindowState {
  agentId: string;
  profile: string;
  taskId?: string;
  phase?: string;
  active: boolean;
  log: LogEntry[];
}

export interface TaskInfo {
  id: string;
  title: string;
  status: string;
  phase?: string;
  agentId?: string;
  startedAt?: number;
}

export interface SidebarInfo {
  title: string;
  indicator: string;
  phases?: PhaseDescriptor[];
}

// ─── Server → Client messages ───────────────────────────────────────────────

export type ServerMessage =
  | {
      type: 'init';
      currentPhase: string;
      completedPhases: string[];
      tasks: TaskInfo[];
      agents: AgentWindowState[];
      sidebar: SidebarInfo;
    }
  | { type: 'workflow_phase'; phase: string; completed: string[]; currentPhase: string }
  | { type: 'workflow_complete' }
  | { type: 'workflow_failed'; error: string; phase: string }
  | { type: 'agent_spawned'; agent: AgentWindowState }
  | { type: 'agent_log'; agentId: string; entry: LogEntry; taskId?: string }
  | { type: 'agent_complete'; agentId: string; phase?: string; taskId?: string }
  | {
      type: 'agent_stats';
      agentId: string;
      toolCallCount?: number;
      inputTokens?: number;
      outputTokens?: number;
      taskId?: string;
    }
  | { type: 'tasks_updated'; tasks: TaskInfo[] }
  | { type: 'workflow_sidebar'; sidebar: SidebarInfo };

// ─── Client → Server messages ───────────────────────────────────────────────

export type ClientMessage = { type: 'terminate_server' };
