// ─── Runner Types (New Contract) ───────────────────────────────────────────
//
// These types define the new runner contract that coexists with the OLD
// TaskRunner/TaskRunnerContext until Phase C. The new types are:
//
//   - TaskOutcome: simplified (no output/feedback — just status + error)
//   - RunnerContext: no completeTask/failTask — runner returns the outcome
//   - Runner: function that takes RunnerContext and returns TaskOutcome
//
// The old types remain in ../types.ts and are NOT modified.
//

import type { RendererRegistry } from '../../core/renderer-registry.js';
import type { AgentProfile, StatusCallbacks, Task } from '../../core/types.js';
import type { HookRegistry } from '../../hooks/types.js';
import type { AuditLog } from '../../tracking/audit-log.js';
import type { SessionGate } from '../session-gate.js';
import type { RunSessionContext, SessionResult } from '../session.js';

/** Simplified task outcome — the new runner contract. */
export type TaskOutcome = { status: 'completed' } | { status: 'failed'; error?: string };

/** RunnerContext — the context passed to every Runner function.
 *
 * Unlike the old TaskRunnerContext, this does NOT include completeTask/failTask
 * callbacks. The runner returns a TaskOutcome directly. */
export interface RunnerContext {
  task: Task;
  gate: SessionGate;
  runSession: (ctx: RunSessionContext) => Promise<SessionResult>;
  profiles: Map<string, AgentProfile>;
  sessionBaseDir: string;
  cwd: string;
  worktreeCwd?: string;
  apiKeys?: Record<string, string>;
  activeSessions: Set<{ abort(): Promise<void> }>;
  onStatus?: StatusCallbacks;
  hookRegistry?: HookRegistry;
  rendererRegistry?: RendererRegistry;
  auditLog?: AuditLog;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  phaseId: string;
  agentId: string;
  maxTaskRetries?: number;
}

/** A Runner function — takes a RunnerContext, returns a TaskOutcome. */
export type Runner = (ctx: RunnerContext) => Promise<TaskOutcome>;
