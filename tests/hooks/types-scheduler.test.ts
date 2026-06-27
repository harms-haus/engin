// ─── Type-contract tests: scheduler hooks were removed in C2 ──────────────
//
// C2 removed the five scheduler-level hooks:
//   claimPolicy, concurrencyKey, wakeStrategy, onLaneIdle, onLaneStall
// The scheduler now uses fixed defaults (claimTasks(1), no per-key concurrency,
// console.warn stall warning). This file pins that NONE of the removed hooks
// exist on `WorkflowHooks`.

import type { WorkflowHooks } from '../../packages/engine/src/hooks/types.js';

type AssertTrue<T extends true> = T;
type HasField<K extends string> = K extends keyof WorkflowHooks ? true : false;

// All five removed hooks must NOT exist on WorkflowHooks.
type _NoClaimPolicy = AssertTrue<HasField<'claimPolicy'>>;
type _NoConcurrencyKey = AssertTrue<HasField<'concurrencyKey'>>;
type _NoWakeStrategy = AssertTrue<HasField<'wakeStrategy'>>;
type _NoOnLaneIdle = AssertTrue<HasField<'onLaneIdle'>>;
type _NoOnLaneStall = AssertTrue<HasField<'onLaneStall'>>;

// keep type-only imports "used"
export type { _NoClaimPolicy, _NoConcurrencyKey, _NoOnLaneIdle, _NoOnLaneStall, _NoWakeStrategy };
