// ─── Barrel re-export for @engin/shared ──────────────────────────────────────
//
// Each module is re-exported with explicit named exports to avoid silent drops
// from ambiguous wildcard re-exports (several type names appear in two or three
// source modules — see below).
//
// Collision map:
//   types.js ⇄ event-types.js:
//     StepDefinition, TaskEntity, TaskStatus
//   event-types.js ⇄ protocol-types.js:
//     SessionEntity, EventRecord, EventType, LogEntry, PhaseEntity,
//     TaskEntity, WorkflowProjection
//
// Types are re-exported from their canonical homes (where they are *defined*):
//   types.js          → StepDefinition, TaskEntity, TaskStatus
//   event-types.js    → LogEntry, EventType, EventRecord, PhaseEntity,
//                       SessionEntity, WorkflowProjection, createInitialProjection
//   protocol-types.js → ServerMessage, ClientMessage, isServerMessage

// ─── Value exports ───────────────────────────────────────────────────────────

export { MAX_RUN_LOG, MAX_WORKFLOW_EVENT_LOG, createInitialProjection } from './event-types.js';
export { MAX_SESSION_LOG, evolve } from './evolve.js';
export { formatTokenCount } from './format-token-count.js';
export { formatToolCall } from './format-tool-call.js';
export { formatWorkflowEventLine } from './format-workflow-event.js';
export { formatWorkflowSummary } from './format-workflow-summary.js';
export {
  capSessionLogs,
  isTerminalTaskStatus,
  pickMostRecentlyStartedActive,
  pickMostRecentlyStartedParked,
  reconcileSelection,
  selectNextSession,
  toProjection,
  writeProjectionToState,
} from './projection-helpers.js';
export { isServerMessage } from './protocol-types.js';

// ─── Type exports from canonical homes ──────────────────────────────────────

export type { StepDefinition, TaskEntity, TaskStatus } from './types.js';

export type {
  EventRecord,
  EventType,
  LogEntry,
  PhaseEntity,
  SessionEntity,
  WorkflowProjection,
} from './event-types.js';

export type { ClientMessage, ServerMessage } from './protocol-types.js';
