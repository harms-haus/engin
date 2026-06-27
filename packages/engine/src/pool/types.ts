// ─── Pool Types (slimmed) ──────────────────────────────────────────────────
//
// After the session-first redesign, the old LanePool / Scheduler / TaskRunner
// types were removed. This module retains a single re-export — `StepDefinition`
// — because hooks/types.ts and other internal modules import it from here.

export type { StepDefinition } from '../core/types.js';
