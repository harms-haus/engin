/**
 * Frontend types for the engin web interface.
 *
 * Protocol value types are defined in protocol-types.ts (mirror of
 * src/web/protocol-types.ts) and re-exported here for backward compatibility.
 *
 * The additional frontend-specific types (WorkflowRunState, AppGlobalState)
 * manage UI state client-side.
 */

// ─── Protocol value types (from mirror) ─────────────────────────────────────

import type { AgentWindowState, ServerMessage, WorkflowSummary } from './protocol-types.js';

export type {
  AgentWindowState,
  ClientMessage,
  LogEntry,
  PhaseDescriptor,
  ServerMessage,
  SidebarInfo,
  WorkflowEntry,
  WorkflowSummary,
} from './protocol-types.js';

// ─── Frontend-specific state types ──────────────────────────────────────────

export interface WorkflowRunState {
  summary: WorkflowSummary;
  agents: Map<string, AgentWindowState>;
  currentPhase: string;
  completedPhases: string[];
  error?: string;
}

export interface AppGlobalState {
  workflows: WorkflowSummary[];
  selectedRunId: string | null;
  runStates: Map<string, WorkflowRunState>;
}

// ─── Type guard ─────────────────────────────────────────────────────────────

export function isServerMessage(data: unknown): data is ServerMessage {
  return typeof data === 'object' && data !== null && 'type' in data;
}
