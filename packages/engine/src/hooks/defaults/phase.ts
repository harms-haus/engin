// ─── Default implementations of the phase-level hooks ──────────────────────
//
// `defaultShouldRetryPhase`, `defaultBeforePhaseTransition`,
// `defaultOnPhaseSettled`, and `createDefaultAfterPhase` are the DEFAULT
// implementations of the four phase-level hooks declared in hooks/types.ts
// (the "Phase level (influence) hooks" block). Each ships a "zero-config"
// behavior so a workflow that registers NO phase-level hooks still gets
// sensible retry-bounded, linear-progression, result-folding, and sidebar-
// indicator semantics.
//
//   1. defaultShouldRetryPhase       — FirstWinsHook<boolean | undefined, ShouldRetryPhaseArgs>
//        → true when the result signals retry-needed AND round < 3; otherwise
//          undefined (abstain). Recognizes BOTH the new `{ retry: true }`
//          shape AND the legacy `'scouting'` string jump-back signal for
//          backward compat with spir.ts.
//   2. defaultBeforePhaseTransition  — FirstWinsHook<PhaseTransition | undefined, BeforePhaseTransitionArgs>
//        → { type: 'advance' } (linear progression — the fallback when no
//          workflow hook overrides it).
//   3. defaultOnPhaseSettled         — AllRunHook<unknown, OnPhaseSettledArgs>
//        → contribution { [task.id]: task.result } for tasks with status
//          'complete'; the folded result is stored on
//          args.state[`${phaseId}Results`].
//   4. createDefaultAfterPhase(onSidebarUpdate?) — ObserveHook<AfterPhaseArgs>
//        → fires the captured `onSidebarUpdate` status callback (the sidebar
//          indicator update previously inlined in spir.ts's `completePhase`).
//          Implemented as a FACTORY because an ObserveHook<AfterPhaseArgs> has
//          no other channel to receive the StatusCallbacks.onSidebarUpdate
//          dependency (it is not on HookContext nor on AfterPhaseArgs).
//
// The companion `PHASE_RESULTS_REDUCER` (which folds per-subscriber
// `onPhaseSettled` contribution objects) lives in ../reducers.ts alongside
// `CONTEXT_BLOCK_REDUCER`.

import type {
  AfterPhaseArgs,
  BeforePhaseTransitionArgs,
  FirstWinsHook,
  HookContext,
  ObserveHook,
  OnPhaseSettledArgs,
  PhaseTransition,
  ShouldRetryPhaseArgs,
} from '../types.js';

/**
 * The default round ceiling for {@link defaultShouldRetryPhase}. Matches the
 * historical `PhaseRunnerOptions.maxRounds` default of 3 from spir.ts —
 * bounded retries prevent unbounded phase loops.
 */
const DEFAULT_MAX_RETRY_ROUNDS = 3;

/**
 * Sidebar-update info shape — mirrors the `StatusCallbacks.onSidebarUpdate`
 * callback signature from core/types.ts. Inlined here (rather than imported)
 * so this module has ZERO runtime dependency on the StatusCallbacks graph;
 * the factory only needs the structural shape.
 */
interface SidebarUpdateInfo {
  title?: string;
  indicator?: string;
}

/**
 * The legacy jump-back signal recognized by {@link defaultShouldRetryPhase}.
 *
 * For backward compat with spir.ts, the default treats a phase `result` that
 * is EXACTLY the string `'scouting'` as a retry request (the old "jump back to
 * scouting" signal). Only this single string is recognized; any other string
 * is an ordinary phase result and does NOT trigger a retry.
 */
const LEGACY_JUMP_BACK_SIGNAL = 'scouting';

/**
 * Returns `true` iff `result` carries a retry request the default recognizes.
 *
 * Recognizes BOTH shapes:
 *  - the generalized object signal `{ retry: true }` (STRICT `=== true` — a
 *    truthy-but-not-true value like `1` or `'yes'` is NOT a retry), and
 *  - the legacy string jump-back signal `'scouting'` (exact match — any other
 *    string is an ordinary result and abstains).
 *
 * `null`, `undefined`, numbers, booleans, and objects without a `retry` field
 * all abstain (return `false`).
 */
function isRetryRequested(result: unknown): boolean {
  if (result === LEGACY_JUMP_BACK_SIGNAL) return true;
  if (result !== null && typeof result === 'object' && (result as { retry?: unknown }).retry === true) {
    return true;
  }
  return false;
}

/**
 * DEFAULT `shouldRetryPhase` (first-wins) hook.
 *
 * Returns `true` when the phase result signals retry-needed (either the
 * generalized `{ retry: true }` object shape or the legacy `'scouting'`
 * string jump-back signal) AND the current `args.round` is below the
 * `maxRounds` ceiling (default {@link DEFAULT_MAX_RETRY_ROUNDS} = 3).
 *
 * Returns `undefined` (ABSTAINS) in every other case:
 *  - `args.round >= 3` — the historical ≤3-round bound is reached; even a
 *    retry-signalling result no longer triggers a retry (the loop is broken).
 *  - the result does not carry a recognized retry signal — non-retry results,
 *    `null` / `undefined` / numbers / non-`'scouting'` strings / objects with
 *    `retry !== true` all abstain so other subscribers (or the no-retry
 *    fallback) decide.
 *
 * The decision is driven SOLELY by `args.result` and `args.round`; `phaseId`
 * and `state` are ignored.
 *
 * Returns a non-`undefined` `true` (when retrying) so it WINS in a first-wins
 * composition when no earlier subscriber has decided; otherwise it abstains.
 */
export const defaultShouldRetryPhase: FirstWinsHook<boolean | undefined, ShouldRetryPhaseArgs> = async (args, _ctx) => {
  const maxRounds = DEFAULT_MAX_RETRY_ROUNDS;
  if (args.round >= maxRounds) return undefined;
  return isRetryRequested(args.result) ? true : undefined;
};

/**
 * DEFAULT `beforePhaseTransition` (first-wins) hook.
 *
 * Returns the constant linear-progression transition `{ type: 'advance' }` —
 * the default workflow advances from `args.from` to `args.to` with no jump
 * target. The decision ignores the `from` / `to` / `state` args entirely: a
 * workflow that registers no `beforePhaseTransition` subscriber gets the
 * legacy one-phase-after-another progression unchanged.
 *
 * Returns a non-`undefined` value so it WINS in a first-wins composition when
 * no earlier subscriber has decided (a workflow override can short-circuit it
 * with a `{ type: 'loop' | 'jump', target? }` decision).
 */
export const defaultBeforePhaseTransition: FirstWinsHook<
  PhaseTransition | undefined,
  BeforePhaseTransitionArgs
> = async (_args, _ctx) => ({ type: 'advance' });

/**
 * DEFAULT `onPhaseSettled` (all-run) hook.
 *
 * The CONTRIBUTION: reads `args.tasks`, filters to `status === 'complete'`,
 * and returns `{ [task.id]: task.result }`. Tasks in any other status
 * (`ready` / `active` / `failed` / `cancelled` / `blocked` / …) are excluded.
 * A complete task with an `undefined` `result` STILL contributes — its id maps
 * to `undefined` (the key is present). Returns `{}` when there are no complete
 * tasks (or `args.tasks` is empty).
 *
 * The SIDE EFFECT: the same contribution object is also stored on
 * `args.state[`${phaseId}Results`]` so downstream phases / the workflow can
 * read the folded per-phase results. Each phase writes its own
 * `${phaseId}Results` key, so multiple phases accumulate side-by-side without
 * clobbering each other or any preexisting, unrelated state keys.
 *
 * When composed through the HookRegistry with {@link PHASE_RESULTS_REDUCER},
 * per-subscriber contribution objects are shallow-merged (later contributions
 * win on key conflicts) into a single folded record. The side-effect write
 * reflects only THIS subscriber's contribution (the registry owns the fold);
 * the test suite pins both behaviors.
 */
export const defaultOnPhaseSettled = async (
  args: OnPhaseSettledArgs,
  _ctx: HookContext,
): Promise<Record<string, unknown>> => {
  const contribution: Record<string, unknown> = {};
  for (const task of args.tasks) {
    if (task.status === 'complete') {
      contribution[task.id] = task.result;
    }
  }
  args.state[`${args.phaseId}Results`] = contribution;
  return contribution;
};

/**
 * DEFAULT `afterPhase` (observe) hook FACTORY.
 *
 * Captures an optional `onSidebarUpdate` status callback (the
 * `StatusCallbacks.onSidebarUpdate` dependency) and returns an observe hook
 * that fires it ONCE per invocation with a payload derived from `args.phaseId`
 * — reproducing the sidebar indicator update previously inlined in spir.ts's
 * `completePhase`.
 *
 * Implemented as a FACTORY because an `ObserveHook<AfterPhaseArgs>` has no
 * other channel to receive the `onSidebarUpdate` dependency: it is neither on
 * `HookContext` nor on `AfterPhaseArgs`. Capturing it via a factory mirrors
 * `createDefaultOnPersist(tracker)` / `createDefaultOnRestore(workDir)`.
 *
 * The fired payload carries BOTH a `title` (a short "Phase: <phaseId>" label)
 * and an `indicator` (the phaseId itself), so the sidebar can render the
 * active phase. Both fields derive from `args.phaseId`, so distinct phases
 * produce distinct payloads.
 *
 * When `onSidebarUpdate` is omitted (or explicitly `undefined`) the returned
 * hook is a GRACEFUL NO-OP: it resolves `undefined` and performs no side
 * effect, so a workflow that registers no status callback still has a
 * well-defined default. The hook does NOT mutate `args`.
 *
 * @param onSidebarUpdate optional status callback fired with the phase info.
 * @returns an `ObserveHook<AfterPhaseArgs>` that fires the captured callback.
 */
export function createDefaultAfterPhase(
  onSidebarUpdate?: (info: SidebarUpdateInfo) => void,
): ObserveHook<AfterPhaseArgs> {
  return async (args, _ctx) => {
    if (!onSidebarUpdate) return;
    onSidebarUpdate({
      title: `Phase: ${args.phaseId}`,
      indicator: args.phaseId,
    });
  };
}
