import type { EventRecord, WorkflowProjection } from '../tracking/event-types.js';

// Re-export all state types so the web layer depends on tracking core.
// This file is the single source of truth for the web-facing protocol:
// the web app (`web/src/protocol-types.ts`) re-exports everything here.
export type {
  AgentEntity,
  EventRecord,
  EventType,
  LogEntry,
  TaskEntity,
  WorkflowProjection,
} from '../tracking/event-types.js';

// ─── Shared UI value types ──────────────────────────────────────────────────
// Describes a sidebar phase indicator entry (see WorkflowProjection.sidebar).

export interface PhaseDescriptor {
  id: string;
  label: string;
  icon: string;
}

// ─── Server to Client Messages ──────────────────────────────────────────────
//
// The protocol uses a snapshot/delta model:
//   - `snapshot`   — full WorkflowProjection, sent on connect / full resync.
//   - `events`     — batch of raw EventRecords since the last seq.
//   - `workflow_complete` / `workflow_failed` — dedicated top-level lifecycle
//     signals (not derivable from events alone in all edge cases).

export type ServerMessage =
  | { type: 'snapshot'; seq: number; state: WorkflowProjection }
  | { type: 'events'; seq: number; events: EventRecord[] }
  | { type: 'workflow_complete' }
  | { type: 'workflow_failed'; error: string; phase: string };

// ─── Client to Server Messages ──────────────────────────────────────────────

export type ClientMessage = { type: 'terminate_server' } | { type: 'resync'; lastSeq?: number };

// ─── Type guard ─────────────────────────────────────────────────────────────

export function isServerMessage(data: unknown): data is ServerMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'snapshot':
    case 'events':
    case 'workflow_complete':
    case 'workflow_failed':
      return true;
    default:
      return false;
  }
}
