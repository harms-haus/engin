import type { AgentWindowState, ServerMessage, TaskInfo } from './protocol-types';

// ─── AgentState ─────────────────────────────────────────────────────────────

export interface AgentState extends AgentWindowState {
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
}

// ─── AppState ───────────────────────────────────────────────────────────────

export interface AppState {
  currentPhase: string;
  completedPhases: string[];
  tasks: TaskInfo[];
  agents: Map<string, AgentState>;
  sidebar: {
    title: string;
    indicator: string;
    phases?: { id: string; label: string; icon: string }[];
  };
  status: 'running' | 'complete' | 'failed';
  error?: string;
}

// ─── Type guard ─────────────────────────────────────────────────────────────

export function isServerMessage(data: unknown): data is ServerMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'init':
    case 'workflow_phase':
    case 'workflow_complete':
    case 'workflow_failed':
    case 'agent_spawned':
    case 'agent_log':
    case 'agent_complete':
    case 'agent_stats':
    case 'tasks_updated':
    case 'workflow_sidebar':
      return true;
    default:
      return false;
  }
}
