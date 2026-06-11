/**
 * WebSocket protocol types for the engin web interface.
 *
 * These types define the message protocol between the server and connected
 * clients (e.g. the web UI). All messages are JSON-serialisable.
 *
 * Discriminated unions use the `type` field as the discriminant.
 */

import type { PastRunEntry } from '../core/config.js';
import type { WorkflowEntry, WorkflowModule } from '../core/types.js';

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
  | { type: 'agent_log'; workflowId: string; agentId: string; entry: LogEntry }
  | { type: 'agent_complete'; workflowId: string; agentId: string }
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

// ─── Server options ─────────────────────────────────────────────────────────

export interface WebServerOptions {
  host: string;
  port: number;
  cwd: string;
}

// ─── Dependency injection for testing ───────────────────────────────────────

/**
 * Injectable dependencies for `startWebServer`.
 * All fields are optional; when omitted the real implementations are used.
 */
export interface WebServerDependencies {
  loadWorkflow: (name: string, cwd: string) => Promise<WorkflowModule>;
  getDefaultWorkDir: (cwd: string, workflowName: string) => string;
  scanPastRuns: (cwd: string) => Promise<PastRunEntry[]>;
  listWorkflows: (cwd: string) => Promise<WorkflowEntry[]>;
}
