/**
 * Shared WebSocket protocol value types for the engin web interface.
 *
 * These types define the message protocol between the server and connected
 * clients (e.g. the web UI). All messages are JSON-serialisable.
 *
 * Discriminated unions use the `type` field as the discriminant.
 *
 * IMPORTANT: This file is the canonical source for these types.
 * - src/tui/components/phase-bar.ts imports from here.
 * - web/src/protocol-types.ts is a mirror copy for the frontend bundle.
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

export interface SidebarInfo {
  title: string;
  indicator: string;
  phases?: PhaseDescriptor[];
}

export interface WorkflowSummary {
  id: string;
  workflowName: string;
  status: 'running' | 'completed' | 'failed';
  sidebar: SidebarInfo;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

// ─── Server → Client messages ───────────────────────────────────────────────

export type ServerMessage =
  | { type: 'init'; workflows: WorkflowSummary[] }
  | { type: 'workflow_started'; summary: WorkflowSummary }
  | { type: 'workflow_sidebar'; workflowId: string; sidebar: SidebarInfo }
  | { type: 'workflow_phase'; workflowId: string; phase: string; completed: string[] }
  | { type: 'workflow_complete'; summary: WorkflowSummary }
  | { type: 'workflow_failed'; summary: WorkflowSummary; error: string; phase: string }
  | { type: 'agent_spawned'; workflowId: string; agent: AgentWindowState }
  | { type: 'agent_log'; workflowId: string; agentId: string; entry: LogEntry; taskId?: string }
  | { type: 'agent_complete'; workflowId: string; agentId: string; phase?: string; taskId?: string }
  | {
      type: 'load_past_run';
      workflowId: string;
      summary: WorkflowSummary;
      currentPhase: string;
      completedPhases: string[];
      agents: AgentWindowState[];
    };

// ─── Client → Server messages ───────────────────────────────────────────────

export type ClientMessage =
  | { type: 'start_workflow'; workflowName: string; taskPrompt: string; maxConcurrent?: number }
  | { type: 'select_workflow'; workflowId: string }
  | { type: 'cancel_workflow'; workflowId: string };
