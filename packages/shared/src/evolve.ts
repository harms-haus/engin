// ─── Evolve dispatcher ──────────────────────────────────────────────────────
//
// Thin dispatcher that routes each `EventRecord` to its per-event-type handler.
// Handler implementations live in domain-grouped modules (workflow-handlers.ts,
// phase-handlers.ts, session-handlers.ts, task-handlers.ts, log-handlers.ts,
// tool-handlers.ts, retry-handlers.ts). Shared helpers (clone, capLog,
// sessionKey, resolveSession) live in evolve-utils.ts.

import type { EventRecord, WorkflowProjection } from './event-types.js';
import { clone, type EventHandler, MAX_SESSION_LOG } from './evolve-utils.js';
import { handleAgentRendered, handleDecision, handleError, handleLog, handleSidebarUpdated } from './log-handlers.js';
import { handlePhaseCompleted, handlePhaseRegistered, handlePhaseStarted } from './phase-handlers.js';
import { handleAutoRetryCompleted, handleAutoRetryStarted } from './retry-handlers.js';
import {
  handleSessionCompleted,
  handleSessionStarted,
  handleTurnEnded,
  handleTurnStarted,
} from './session-handlers.js';
import { handleTaskCompleted, handleTaskRegistered, handleTaskRejected, handleTaskStarted } from './task-handlers.js';
import { handleToolCallEnded, handleToolCallStarted } from './tool-handlers.js';
import { handleWorkflowCompleted, handleWorkflowFailed, handleWorkflowStarted } from './workflow-handlers.js';

export { MAX_SESSION_LOG };

const handlers: Record<string, EventHandler> = {
  // Workflow lifecycle
  workflow_started: handleWorkflowStarted,
  workflow_completed: handleWorkflowCompleted,
  workflow_failed: handleWorkflowFailed,

  // Phase lifecycle
  phase_registered: handlePhaseRegistered,
  phase_started: handlePhaseStarted,
  phase_completed: handlePhaseCompleted,

  // Session lifecycle
  session_started: handleSessionStarted,
  session_completed: handleSessionCompleted,
  turn_started: handleTurnStarted,
  turn_ended: handleTurnEnded,

  // Task lifecycle
  task_registered: handleTaskRegistered,
  task_started: handleTaskStarted,
  task_completed: handleTaskCompleted,
  task_rejected: handleTaskRejected,

  // Log / decision / render / sidebar
  decision: handleDecision,
  error: handleError,
  agent_rendered: handleAgentRendered,
  log: handleLog,
  sidebar_updated: handleSidebarUpdated,

  // Tool calls
  tool_call_started: handleToolCallStarted,
  tool_call_ended: handleToolCallEnded,

  // Auto-retry
  auto_retry_started: handleAutoRetryStarted,
  auto_retry_completed: handleAutoRetryCompleted,
};

/**
 * Pure, immutable state transition. Returns a **new** `WorkflowProjection`
 * reflecting the given event.
 */
export function evolve(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const handler = handlers[event.type];
  return handler ? handler(state, event) : clone(state, { seq: event.seq });
}
