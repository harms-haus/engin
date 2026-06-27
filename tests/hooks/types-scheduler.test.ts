// ─── Type-contract tests: scheduler hooks removed in C2 ───────────────────
//
// C2 removed claimPolicy, concurrencyKey, and onLaneStall from WorkflowHooks.
// (wakeStrategy and onLaneIdle remain — they were deleted in a later sweep
//  that also removed the deleted ClaimPolicyArgs/ConcurrencyKeyArgs/OnLaneStallArgs
//  interfaces.)

import type { WorkflowHooks } from '../../packages/engine/src/hooks/types.js';

type AssertTrue<T extends true> = T;
type HasField<K extends string> = K extends keyof WorkflowHooks ? true : false;

// The three removed hooks must NOT exist on WorkflowHooks.
// `HasField<K>` returns `true` when K is a key of WorkflowHooks, so we need
// to negate it: `AssertTrue<false extends HasField<K> ? true : false>`.
type _NoClaimPolicy = AssertTrue<false extends HasField<'claimPolicy'> ? true : false>;
type _NoConcurrencyKey = AssertTrue<false extends HasField<'concurrencyKey'> ? true : false>;
type _NoOnLaneStall = AssertTrue<false extends HasField<'onLaneStall'> ? true : false>;

// wakeStrategy and onLaneIdle still exist — they were NOT removed.
type _HasWakeStrategy = AssertTrue<HasField<'wakeStrategy'>>;
type _HasOnLaneIdle = AssertTrue<HasField<'onLaneIdle'>>;

// keep type-only imports "used"
export type { _HasOnLaneIdle, _HasWakeStrategy, _NoClaimPolicy, _NoConcurrencyKey, _NoOnLaneStall };
