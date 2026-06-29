// ─── Tests for pool/scheduler-audit.ts ─────────────────────────────────────
//
// This module is being EXTRACTED from session-scheduler.ts (RED-team phase):
//   - The `CandidateTrace` interface (the per-candidate drain trace recorded
//     for the scheduler_drain audit event).
//   - A PURE helper `buildCapacityFailureDescription(profile, snapshot)` that
//     encapsulates the former private `SessionScheduler.describeCapacityFailure`
//     method. Unlike the method, the helper takes the gate snapshot as an
//     argument (no `this.gate` access) so it is fully pure + testable in
//     isolation.
//
// These tests pin the EXACT output strings the old private method produced so
// the extraction is observably a no-op. Until the green team creates
// scheduler-audit.ts with these exports, this file fails to load (value import
// of a not-yet-existing module) — that failure IS the spec for the extraction.

import { describe, expect, it } from 'bun:test';

import type { AgentProfile } from '../core/types.js';

import type { CandidateTrace } from './scheduler-audit.js';
import { buildCapacityFailureDescription } from './scheduler-audit.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Shape returned by SessionGate.snapshot() — mirrored here so the pure helper
 *  can be exercised with synthetic snapshots (no real gate required). */
interface GateSnapshot {
  totalAvailable: number;
  totalCap: number;
  models: { key: string; available: number; cap: number | null }[];
}

/** Minimal AgentProfile; caller overrides provider/model/agent as needed. */
function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'p',
    name: 'p',
    provider: 'p',
    model: 'm',
    thinkingLevel: 'off',
    systemPrompt: '',
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}

// ─── buildCapacityFailureDescription ───────────────────────────────────────

describe('buildCapacityFailureDescription', () => {
  it('is exported from scheduler-audit as a standalone function', () => {
    // Drives the extraction: the helper must be importable as a value.
    expect(typeof buildCapacityFailureDescription).toBe('function');
  });

  it('reports total saturation when totalAvailable <= 0', () => {
    const profile = makeProfile();
    const snapshot: GateSnapshot = { totalAvailable: 0, totalCap: 4, models: [] };
    expect(buildCapacityFailureDescription(profile, snapshot)).toBe('total saturated (0 of 4 slots free)');
  });

  it('treats a negative totalAvailable as total saturation too (<= 0 guard)', () => {
    const profile = makeProfile();
    const snapshot: GateSnapshot = { totalAvailable: -1, totalCap: 2, models: [] };
    expect(buildCapacityFailureDescription(profile, snapshot)).toBe('total saturated (0 of 2 slots free)');
  });

  it('reports per-model saturation when the provider:model bucket matches', () => {
    // profile key = `${provider}:${model}` = 'p:m'
    const profile = makeProfile({ provider: 'p', model: 'm' });
    const snapshot: GateSnapshot = {
      totalAvailable: 2,
      totalCap: 4,
      models: [{ key: 'p:m', available: 0, cap: 3 }],
    };
    expect(buildCapacityFailureDescription(profile, snapshot)).toBe("model 'p:m' saturated (0 of 3 free; total has 2)");
  });

  it('matches the provider:model:agent bucket when the profile has an agent', () => {
    // profile key 'p:m'; agent-key 'p:m:codex'. The bucket is keyed by the
    // agent-qualified form and must still be found.
    const profile = makeProfile({ provider: 'p', model: 'm', agent: 'codex' });
    const snapshot: GateSnapshot = {
      totalAvailable: 1,
      totalCap: 4,
      models: [{ key: 'p:m:codex', available: 0, cap: 1 }],
    };
    expect(buildCapacityFailureDescription(profile, snapshot)).toBe(
      "model 'p:m:codex' saturated (0 of 1 free; total has 1)",
    );
  });

  it('renders an uncapped model bucket (cap null) as ∞', () => {
    const profile = makeProfile({ provider: 'p', model: 'm' });
    const snapshot: GateSnapshot = {
      totalAvailable: 2,
      totalCap: 4,
      models: [{ key: 'p:m', available: 0, cap: null }],
    };
    expect(buildCapacityFailureDescription(profile, snapshot)).toBe("model 'p:m' saturated (0 of ∞ free; total has 2)");
  });

  it('falls back to "has no capacity" when total has room but no matching model bucket exists', () => {
    const profile = makeProfile({ provider: 'p', model: 'm' });
    const snapshot: GateSnapshot = {
      totalAvailable: 3,
      totalCap: 4,
      models: [{ key: 'other:x', available: 0, cap: 2 }],
    };
    expect(buildCapacityFailureDescription(profile, snapshot)).toBe("model 'p:m' has no capacity");
  });

  it('is pure: it does not touch a gate — only the passed snapshot', () => {
    // Pass the same profile two different snapshots and confirm each result is
    // derived solely from its snapshot (no hidden state / `this.gate` read).
    const profile = makeProfile({ provider: 'p', model: 'm' });
    const saturated: GateSnapshot = { totalAvailable: 0, totalCap: 5, models: [] };
    const free: GateSnapshot = {
      totalAvailable: 4,
      totalCap: 5,
      models: [{ key: 'p:m', available: 2, cap: 2 }],
    };
    // Saturated total → total message; free total + matching bucket → model msg.
    expect(buildCapacityFailureDescription(profile, saturated)).toBe('total saturated (0 of 5 slots free)');
    expect(buildCapacityFailureDescription(profile, free)).toBe("model 'p:m' saturated (0 of 2 free; total has 4)");
    // Re-running on the first snapshot yields the SAME answer (no mutation).
    expect(buildCapacityFailureDescription(profile, saturated)).toBe('total saturated (0 of 5 slots free)');
  });
});

// ─── CandidateTrace (type-only export) ─────────────────────────────────────

describe('CandidateTrace', () => {
  it('is importable from scheduler-audit and structurally matches a drain trace', () => {
    // Compile-time: CandidateTrace must be exported. Runtime: a well-formed
    // trace object must be usable and its fields readable. This pins the
    // interface shape that tryStartBatchSpecs produces for the audit event.
    const trace: CandidateTrace = {
      taskId: 'A',
      status: 'active',
      dependents: 2,
      started: [{ specId: 's1', profile: 'writer' }],
      parkedSpecs: [{ specId: 's2', profile: 'reviewer', reason: 'total saturated (0 of 1 slots free)' }],
      skipped: false,
    };

    expect(trace.taskId).toBe('A');
    expect(trace.status).toBe('active');
    expect(trace.dependents).toBe(2);
    expect(trace.started).toHaveLength(1);
    expect(trace.started[0]?.specId).toBe('s1');
    expect(trace.parkedSpecs[0]?.reason).toContain('saturated');
    expect(trace.skipped).toBe(false);
  });

  it('accepts the skipped-trace variant with an optional skipReason', () => {
    const trace: CandidateTrace = {
      taskId: 'B',
      status: 'ready',
      dependents: 0,
      started: [],
      parkedSpecs: [],
      skipped: true,
      skipReason: 'advancing (batch mid-advance)',
    };
    expect(trace.skipped).toBe(true);
    expect(trace.skipReason).toBe('advancing (batch mid-advance)');
  });
});
