/**
 * WebSocket protocol types for the engin web interface.
 *
 * Protocol value types (PhaseDescriptor, LogEntry, etc.) are defined in
 * protocol-types.ts and re-exported here for backward compatibility.
 *
 * This file retains backend-only types: WebServerOptions, WebServerDependencies.
 */

import type { PastRunEntry } from '../core/config.js';
import type { WorkflowEntry, WorkflowModule } from '../core/types.js';

// ─── Re-exported protocol value types ───────────────────────────────────────

export type {
  AgentWindowState,
  ClientMessage,
  LogEntry,
  PhaseDescriptor,
  ServerMessage,
  SidebarInfo,
  WorkflowSummary,
} from './protocol-types.js';

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
