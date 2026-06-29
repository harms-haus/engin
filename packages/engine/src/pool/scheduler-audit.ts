// ─── Scheduler audit types + pure helpers (extracted from session-scheduler) ─
//
// These are split out from session-scheduler.ts so the drain-trace shape
// (`CandidateTrace`) and the capacity-failure explanation are testable in
// isolation, without standing up a full SessionScheduler + SessionGate.

import type { AgentProfile } from '../core/types.js';

/** Shape returned by {@link SessionGate.snapshot}. Mirrored here (rather than
 *  imported) so this module has no runtime dependency on the gate — the pure
 *  helper below can be exercised with synthetic snapshots. */
export interface GateSnapshot {
  totalAvailable: number;
  totalCap: number;
  models: { key: string; available: number; cap: number | null }[];
}

/** Structured outcome of a single candidate within a drain pass, captured by
 *  tryStartBatchSpecs for the scheduler_drain audit event. */
export interface CandidateTrace {
  taskId: string;
  status: string;
  dependents: number;
  started: { specId: string; profile: string }[];
  parkedSpecs: { specId: string; profile: string; reason: string }[];
  skipped: boolean;
  skipReason?: string;
}

/**
 * Explain WHY `gate.canStart(profile)` would return false, for the audit log.
 *
 * Distinguishes total-capacity saturation from per-model saturation and names
 * the offending model key + cap. Pure: it reads only the supplied snapshot
 * (no gate access), so callers must pass the gate's current
 * {@link SessionGate.snapshot} themselves.
 */
export function buildCapacityFailureDescription(profile: AgentProfile, snapshot: GateSnapshot): string {
  if (snapshot.totalAvailable <= 0) {
    return `total saturated (0 of ${snapshot.totalCap} slots free)`;
  }
  // Total has room → must be the per-model bucket.
  const key = `${profile.provider}:${profile.model}`;
  const bucket = snapshot.models.find((m) => m.key === key || m.key === `${key}:${profile.agent}`);
  if (bucket) {
    return `model '${bucket.key}' saturated (0 of ${bucket.cap ?? '∞'} free; total has ${snapshot.totalAvailable})`;
  }
  return `model '${key}' has no capacity`;
}
