// ─── Barrel re-export for @engin/shared ──────────────────────────────────────
//
// Each module is re-exported with explicit named exports to avoid silent drops
// from ambiguous wildcard re-exports (several type names appear in two or three
// source modules — see below).
//
// Collision map:
//   types.js ⇄ event-types.js:
//     StepDefinition, StepEntity, TaskEntity, TaskStatus
//   event-types.js ⇄ protocol-types.js:
//     AgentEntity, EventRecord, EventType, LogEntry, PhaseEntity, StepEntity,
//     TaskEntity, WorkflowProjection
//
// Types are re-exported from their canonical homes (where they are *defined*):
//   types.js          → StepDefinition, StepEntity, TaskEntity, TaskStatus
//   event-types.js    → LogEntry, EventType, EventRecord, PhaseEntity,
//                       AgentEntity, WorkflowProjection, createInitialProjection
//   protocol-types.js → ServerMessage, ClientMessage, isServerMessage

// ─── Value exports ───────────────────────────────────────────────────────────

export { MAX_RUN_LOG, MAX_WORKFLOW_EVENT_LOG, createInitialProjection } from './event-types.js';
export { MAX_AGENT_LOG, evolve } from './evolve.js';
export { formatTokenCount } from './format-token-count.js';
export { formatToolCall } from './format-tool-call.js';
export { formatWorkflowEventLine } from './format-workflow-event.js';
export { formatWorkflowSummary } from './format-workflow-summary.js';
export {
  capAgentLogs,
  isTerminalTaskStatus,
  pickMostRecentlyStartedActive,
  reconcileSelection,
  toProjection,
  writeProjectionToState,
} from './projection-helpers.js';
export { isServerMessage } from './protocol-types.js';

// ─── Type exports from canonical homes ──────────────────────────────────────

export type { StepDefinition, StepEntity, TaskEntity, TaskStatus } from './types.js';

export type { AgentEntity, EventRecord, EventType, LogEntry, PhaseEntity, WorkflowProjection } from './event-types.js';

export type { ClientMessage, ServerMessage } from './protocol-types.js';
