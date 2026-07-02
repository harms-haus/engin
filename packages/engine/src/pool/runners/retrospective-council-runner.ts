// ─── Retrospective Council Runner (SessionPlan contract) ──────────────────
//
// A SessionPlanRunner that FUSES council's parallel-members batch pattern with
// review's loop/terminate pattern, driven entirely by caller-provided transform
// callbacks. It is generic and schema-agnostic (no council schemas, no finding
// shapes, no profile knowledge, no getDiff import).
//
// Flow:
//   1. Yield the convener session (a single spec).
//   2. buildMembers(convenerResult) → SessionSpec[] — the members for round 1.
//      Pressure-valve: if empty, return immediately (no members to run).
//   3. for round = 1..maxRounds:
//        a. Yield the members batch (all members run in parallel).
//        b. Optionally build a retrospective prompt via buildRetrospectivePrompt.
//        c. Yield the retrospective session.
//        d. interpretRetrospective(retroResult) → { terminate, nextMembers }.
//        e. If terminate or nextMembers is empty → return.
//        f. members = nextMembers; continue.
//   4. On maxRounds exhaustion (the loop falls through): call
//      onMaxRoundsExhausted (non-fatal, errors swallowed) and return.
//      Does NOT throw.
//
// `execute()` delegates to {@link defaultExecute} (gate-free).

import { DEFAULT_MAX_ROUNDS } from '../constants.js';
import type { SessionResult, SessionSpec } from '../session.js';
import { defaultExecute } from './runner-utils.js';
import type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

/**
 * Options for {@link retrospectiveCouncilRunner}.
 */
export interface RetrospectiveCouncilRunnerOptions {
  /** The convener session spec — runs first, produces the initial result that
   *  buildMembers uses to construct the first members batch. */
  convener: SessionSpec;

  /**
   * Transform the convener result into the first batch of member session specs.
   * Called once after the convener completes.
   *
   * When the returned array is empty the generator returns immediately — no
   * members or retrospective sessions run (pressure-valve).
   */
  buildMembers: (convenerResult: SessionResult) => SessionSpec[];

  /** Template spec for the retrospective session. The prompt may be overridden
   *  each round via `buildRetrospectivePrompt`. */
  retrospective: SessionSpec;

  /**
   * Optional callback that builds a custom prompt for the retrospective session
   * each round. When omitted, `retrospective.prompt` is used as-is every round.
   *
   * The callback MAY be async (return a `Promise<string>`); the runner awaits
   * the result before yielding the retrospective spec. A sync callback that
   * returns a plain string is also accepted (await on a non-promise value is
   * a no-op), so existing sync callers continue to work unchanged.
   *
   * @param ctx - Session plan context.
   * @param round - The current 1-based round number.
   * @param memberResults - The `SessionResult[]` from the member batch that
   *   just settled this round, in spec order. On round 1 these are the members
   *   built from the convener result; on later rounds they are the `nextMembers`
   *   from the prior retrospective's `interpretRetrospective` call.
   */
  buildRetrospectivePrompt?: (
    ctx: SessionPlanContext,
    round: number,
    memberResults: SessionResult[],
  ) => string | Promise<string>;

  /**
   * Interpret the retrospective session result and decide whether to terminate
   * the loop or continue with a new members batch.
   *
   * `terminate`: when true, the loop ends and the generator returns.
   * `nextMembers`: the members for the next round. When empty, the loop ends
   *   (same as terminate).
   *
   * Both conditions are checked: if `terminate` is true OR `nextMembers` is
   * empty, the generator returns.
   */
  interpretRetrospective: (retroResult: SessionResult) => { terminate: boolean; nextMembers: SessionSpec[] };

  /** Maximum number of members→retrospective rounds before the loop ends.
   *  Defaults to DEFAULT_MAX_ROUNDS (3). */
  maxRounds?: number;

  /**
   * Optional callback invoked when the loop exhausts `maxRounds` without
   * having terminated via interpretRetrospective. Errors thrown by this
   * callback are swallowed (non-fatal). Not called on normal termination.
   */
  onMaxRoundsExhausted?: () => void | Promise<void>;
}

/**
 * Create a SessionPlanFactory that fuses council's parallel-members batch
 * pattern with review's loop/terminate pattern.
 *
 * Each call to the factory creates a fresh runner instance. The runner's
 * `plan()` is an async generator that runs:
 *
 *   1. Convener session (single spec)
 *   2. buildMembers → members batch (all run in parallel)
 *   3. Loop up to maxRounds:
 *        a. Members batch (parallel)
 *        b. Retrospective session (single spec)
 *        c. interpretRetrospective → decide to terminate or continue
 *
 * @param options - Configuration object (see {@link RetrospectiveCouncilRunnerOptions}).
 * @returns A factory that constructs a fresh {@link SessionPlanRunner} for
 *   each call.
 */
export function retrospectiveCouncilRunner(options: RetrospectiveCouncilRunnerOptions): SessionPlanFactory {
  return (): SessionPlanRunner => {
    return {
      plan: async function* (
        ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        // ── Step 1: Convener ────────────────────────────────────────────
        const convenerResults: SessionResult[] = yield [options.convener];

        // ── Step 2: Build initial members ───────────────────────────────
        let members: SessionSpec[] = options.buildMembers(convenerResults[0]);

        // Pressure-valve #1: no members → nothing to do
        if (members.length === 0) {
          return;
        }

        const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;

        // ── Step 3: Loop rounds ─────────────────────────────────────────
        for (let round = 1; round <= maxRounds; round++) {
          // ── a. Yield members batch (parallel) ─────────────────────────
          const memberResults: SessionResult[] = yield members;

          // ── b. Build retrospective spec ───────────────────────────────
          // The callback may be async. Await FIRST so the resolved string is
          // what ends up on the spec, not a `[object Promise]`.
          const retroPrompt =
            options.buildRetrospectivePrompt !== undefined
              ? await options.buildRetrospectivePrompt(ctx, round, memberResults)
              : options.retrospective.prompt;

          // Session-idempotency guard: when buildRetrospectivePrompt is
          // provided, the retrospective gets a FRESH prompt each round —
          // implying a fresh session. Without a unique id, round 2+ would
          // cache-hit round 1's completed session (the engine keys on
          // SessionSpec.id) and silently replay the stale round-1 result,
          // breaking the multi-round loop. Appending `-r${round}` prevents
          // this while staying schema-agnostic. When buildRetrospectivePrompt
          // is NOT provided, the template id is kept unchanged (that path is
          // for single-round or caller-managed resume reuse).
          const retroSpec: SessionSpec = {
            ...options.retrospective,
            prompt: retroPrompt,
            ...(options.buildRetrospectivePrompt !== undefined ? { id: `${options.retrospective.id}-r${round}` } : {}),
          };

          // ── c. Yield retrospective session ────────────────────────────
          const retroResults: SessionResult[] = yield [retroSpec];

          // ── d. Interpret result ───────────────────────────────────────
          const { terminate, nextMembers } = options.interpretRetrospective(retroResults[0]);

          // ── e. Pressure-valve #2: terminate or empty → return ─────────
          if (terminate || nextMembers.length === 0) {
            return;
          }

          // ── f. Continue with next members batch ───────────────────────
          members = nextMembers;
        }

        // ── Step 4: Max rounds exhausted (no terminate) ─────────────────
        // NOTE: Deliberate divergence from sibling runners. Unlike the
        // reviewRunner or coalescingRunner which THROW on maxRounds exhaustion
        // (treating it as a task failure callback), this runner RETURNS
        // silently because reaching the cap is a NORMAL outcome for a review
        // task — there are still findings to process, not an error. The caller
        // manages side-effects (audit/status) via the optional
        // onMaxRoundsExhausted callback.
        // Non-fatal: call onMaxRoundsExhausted if provided, then return.
        try {
          await options.onMaxRoundsExhausted?.();
        } catch {
          /* non-fatal: errors swallowed */
        }

        return;
      },

      execute: defaultExecute,
    };
  };
}
