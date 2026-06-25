// ─── Phase lifecycle handlers ───────────────────────────────────────────────
//
// Handlers for phase registration and status transitions:
// phase_registered, phase_started, phase_completed.

import type { EventRecord, PhaseEntity, WorkflowProjection } from './event-types.js';
import { clone } from './evolve-utils.js';

export function handlePhaseRegistered(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const id = String(event.data.id ?? '');
  if (!id) return clone(state, { seq: event.seq });
  // No-op if phase already registered
  if (state.phases.some((p) => p.id === id)) return clone(state, { seq: event.seq });
  const entity: PhaseEntity = {
    id,
    label: String(event.data.label ?? id),
    icon: String(event.data.icon ?? ''),
    taskIds: [],
  };
  return clone(state, {
    phases: [...state.phases, entity],
    seq: event.seq,
  });
}

export function handlePhaseStarted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  return clone(state, {
    currentPhaseId: String(event.data.phase ?? event.metadata.phaseId ?? state.currentPhaseId),
    seq: event.seq,
  });
}

export function handlePhaseCompleted(state: WorkflowProjection, event: EventRecord): WorkflowProjection {
  const phaseId = String(event.data.phase ?? state.currentPhaseId);
  if (phaseId && !state.completedPhaseIds.includes(phaseId)) {
    return clone(state, {
      completedPhaseIds: [...state.completedPhaseIds, phaseId],
      seq: event.seq,
    });
  }
  return clone(state, { seq: event.seq });
}
