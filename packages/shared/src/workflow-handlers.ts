// ─── Workflow lifecycle handlers ────────────────────────────────────────────
//
// Handlers for the top-level workflow status transitions:
// workflow_started, workflow_completed, workflow_failed.

import type { EventRecord, WorkflowProjection } from './event-types.js';
import { clone } from './evolve-utils.js';

export function handleWorkflowStarted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  return clone(state, {
    taskPrompt: String(event.data.taskPrompt ?? ''),
    status: 'running' as const,
    seq: event.seq,
  });
}

export function handleWorkflowCompleted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  return clone(state, { status: 'complete' as const, seq: event.seq });
}

export function handleWorkflowFailed(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  return clone(state, {
    status: 'failed' as const,
    error: typeof event.data.error === 'string' ? event.data.error : String(event.data.error ?? ''),
    failedPhase:
      typeof event.data.phaseId === 'string'
        ? event.data.phaseId
        : typeof event.data.phase === 'string'
          ? event.data.phase
          : undefined,
    seq: event.seq,
  });
}
