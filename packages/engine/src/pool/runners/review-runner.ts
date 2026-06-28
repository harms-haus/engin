// ─── Review Runner (SessionPlan contract) ──────────────────────────────────
//
// Implements the execute→review loop:
//
//   for round = 1..maxRounds:
//     1. Yield execute session batch
//     2. Receive execute result via gen.next return
//     3. Build review prompt with execute output
//     4. Yield review session batch
//     5. Receive review result via gen.next return
//     6. If review approves → generator returns (task completes)
//     7. If review rejects → accumulate feedback, continue
//   maxRounds exhausted → throw (task fails)
//
// ID convention: `${taskId}/${role}` — stable across rounds.
// Round 2+ sets resume:true so the agent sees its prior work + feedback.
// attempt is always 1 (a resume continues the same session entity,
// keeping the projection key stable).
//
// The scheduler owns gate acquisition and feeds results back via
// gen.next(results). This runner never calls execute() from inside plan() —
// it only yields specs and reads results from the yield return value.

import { DEFAULT_MAX_ROUNDS } from '../constants.js';
import type { SessionResult, SessionSpec } from '../session.js';
import { defaultExecute } from './runner-utils.js';
import type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

/** Suffix appended to the execute prompt when a review rejects. */
const FEEDBACK_SUFFIX = '\n\nReview feedback:\n';

/** Prefix inserted before the execute result when building the review prompt. */
const EXECUTE_OUTPUT_PREFIX = '\n\n---\nExecute output:\n';

/** Note appended to the review prompt when the execute result is a filesystem session. */
const FILESYSTEM_OUTPUT_NOTE = '\n\n---\nExecute output: (filesystem session — see files)';

/**
 * Build the review prompt by appending the execute session result to
 * `reviewSpec.prompt`. Format depends on the execute result mode:
 *
 *   text        → `prompt + "\n\n---\nExecute output:\n" + result.text`
 *   structured  → `prompt + "\n\n---\nExecute output:\n" + JSON.stringify(result.data)`
 *   filesystem  → `prompt + "\n\n---\nExecute output: (filesystem session — see files)"`
 */
function buildReviewPrompt(reviewPrompt: string, executeResult: SessionResult): string {
  switch (executeResult.mode) {
    case 'text':
      return `${reviewPrompt}${EXECUTE_OUTPUT_PREFIX}${executeResult.text}`;
    case 'structured':
      return `${reviewPrompt}${EXECUTE_OUTPUT_PREFIX}${JSON.stringify(executeResult.data)}`;
    case 'filesystem':
      return `${reviewPrompt}${FILESYSTEM_OUTPUT_NOTE}`;
  }
}

/**
 * Create a SessionPlanFactory that implements the execute→review loop.
 *
 * Each call to the factory creates a fresh runner instance. The runner's
 * `plan()` is an async generator that yields execute/review pairs until
 * the review approves or maxRounds is exhausted.
 *
 * IDs are derived from each spec's `role` — stable across rounds; round 2+
 * sets resume:true. attempt is always 1 (a resume is a continuation of the
 * same session, not a retry) so the projection keeps one SessionEntity.
 *
 * @param executeSpec - Spec for the execute session (id and attempt are
 *   auto-generated). The `role` field determines the session id segment.
 * @param reviewSpec - Spec for the review session (id and attempt are
 *   auto-generated). The `role` field determines the session id segment.
 * @param options - Optional config: maxRounds (defaults to DEFAULT_MAX_ROUNDS),
 *   onReviewReject callback.
 * @returns A factory that constructs a fresh {@link SessionPlanRunner} for
 *   each call.
 */
export function reviewRunner(
  executeSpec: Omit<SessionSpec, 'id' | 'attempt' | 'runnerRole'> & { role: string },
  reviewSpec: Omit<SessionSpec, 'id' | 'attempt' | 'runnerRole'> & { role: string },
  options?: {
    maxRounds?: number;
    /** Fires when a review REJECTS (round `round` just completed with
     *  approved=false), BEFORE the next execute round resumes. Lets callers
     *  preserve artifacts produced during the rejected round (e.g. snapshot
     *  a plan file to plan-rev{round}.json before the planner overwrites it).
     *  Not called on approval or after the final round. */
    onReviewReject?: (round: number) => void | Promise<void>;
  },
): SessionPlanFactory {
  const maxRounds = options?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const onReviewReject = options?.onReviewReject;

  return (): SessionPlanRunner => {
    return {
      plan: async function* (
        ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        const taskId = ctx.task.id;
        const collectedFeedback: string[] = [];
        const executeRole = executeSpec.role;
        const reviewRole = reviewSpec.role;

        // Stable IDs across rounds — round 2+ uses resume:true
        const executeId = `${taskId}/${executeRole}`;
        const reviewId = `${taskId}/${reviewRole}`;

        for (let round = 1; round <= maxRounds; round++) {
          // ── 1. Build execute spec (with feedback appended from prior rounds) ──
          let executePrompt = executeSpec.prompt;
          if (collectedFeedback.length > 0) {
            executePrompt = `${executeSpec.prompt}${FEEDBACK_SUFFIX}${collectedFeedback.join('\n')}`;
          }

          const execSessionSpec: SessionSpec = {
            id: executeId,
            profile: executeSpec.profile,
            prompt: executePrompt,
            ...(executeSpec.schema !== undefined ? { schema: executeSpec.schema } : {}),
            outputMode: executeSpec.outputMode,
            ...(executeSpec.isReadOnly !== undefined ? { isReadOnly: executeSpec.isReadOnly } : {}),
            runnerRole: executeRole,
            // attempt stays at 1 across rounds: a resume is a CONTINUATION of the
            // same session, not a new retry attempt. This keeps the projection's
            // session key stable (agentId::taskId::role::1) so round 2+ UPDATES
            // the existing SessionEntity instead of creating a new one.
            attempt: 1,
            // On round 2+ (a prior review rejected), RESUME the prior execute
            // session so the agent sees its earlier work + the appended feedback,
            // instead of starting a fresh session. Round 1 creates the session.
            ...(round > 1 ? { resume: true } : {}),
          };

          // Yield execute batch. The scheduler runs the session via
          // runner.execute() and feeds back one result per spec (in order)
          // via gen.next(results).
          const execResults: SessionResult[] = yield [execSessionSpec];
          const execResult = execResults[0];

          // ── 2. Build review prompt with execute result ─────────────────────
          const reviewPrompt = buildReviewPrompt(reviewSpec.prompt, execResult);

          const reviewSessionSpec: SessionSpec = {
            id: reviewId,
            profile: reviewSpec.profile,
            prompt: reviewPrompt,
            ...(reviewSpec.schema !== undefined ? { schema: reviewSpec.schema } : {}),
            outputMode: reviewSpec.outputMode,
            ...(reviewSpec.isReadOnly !== undefined ? { isReadOnly: reviewSpec.isReadOnly } : {}),
            runnerRole: reviewRole,
            attempt: 1,
            ...(round > 1 ? { resume: true } : {}),
          };

          // Yield review batch
          const reviewResults: SessionResult[] = yield [reviewSessionSpec];
          const reviewResult = reviewResults[0];

          // ── 3. Check approval ─────────────────────────────────────────────
          const reviewData = reviewResult.mode === 'structured' ? (reviewResult.data as Record<string, unknown>) : {};
          if (reviewData.approved === true) {
            // Approved — generator returns, task completes
            return;
          }

          // Rejected — collect feedback for the next round
          const feedback = typeof reviewData.feedback === 'string' ? reviewData.feedback : '';
          if (feedback) {
            collectedFeedback.push(feedback);
          }

          // Fire onReviewReject callback (non-fatal)
          if (onReviewReject) {
            try {
              await onReviewReject(round);
            } catch {
              /* non-fatal: snapshot failures must not abort the review loop */
            }
          }
        }

        // Max rounds exhausted without approval — signal failure by throwing.
        // The scheduler treats a thrown generator error as task failure.
        throw new Error(`Review rejected after ${maxRounds} rounds`);
      },

      execute: defaultExecute,
    };
  };
}
