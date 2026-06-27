// ─── Review Runner ─────────────────────────────────────────────────────────
//
// Implements the execute→review loop:
//
//   for round = 1..maxRounds:
//     1. Run execute session (id `${taskId}/execute`, attempt = 1).
//        On round 2+ the execute session RESUMES the prior one (resume:true)
//        so the agent sees its earlier work + the appended review feedback,
//        instead of starting a fresh session. attempt stays 1 (a resume is a
//        continuation, not a retry) so the projection keeps one SessionEntity.
//     2. Feed the execute result into the review prompt
//     3. Run review session (id `${taskId}/review`, structured output).
//        On round 2+ the review session RESUMES the prior one too.
//     4. If review approves → return completed
//     5. If review rejects → append feedback to execute prompt, continue
//   maxRounds exhausted → return failed
//
// Transient SessionError in execute → retry-in-place (same round, re-run
// execute). Permanent SessionError → return failed immediately.

import { safeErrorMessage } from '../../core/utils.js';
import { DEFAULT_MAX_ROUNDS } from '../constants.js';
import type { SessionResult, SessionSpec } from '../session.js';
import { SessionError } from '../session.js';
import type { Runner, RunnerContext, TaskOutcome } from './types.js';
import { runSessionViaGate } from './utils.js';

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
 * Create a Runner that implements the execute→review loop.
 *
 * IDs: `execute` and `review` (stable across rounds; round 2+ resumes).
 * approved → completed; rejected → increment round, re-run execute,
 * append feedback; maxRounds exhausted → failed.
 * Catch transient SessionError in execute, retry-in-place; permanent rethrow.
 */
export function reviewRunner(
  executeSpec: Omit<SessionSpec, 'id'> & { role: string },
  reviewSpec: Omit<SessionSpec, 'id'> & { role: string },
  options?: { maxRounds?: number },
): Runner {
  const maxRounds = options?.maxRounds ?? DEFAULT_MAX_ROUNDS;

  return async (ctx: RunnerContext): Promise<TaskOutcome> => {
    const taskId = ctx.task.id;
    const collectedFeedback: string[] = [];

    for (let round = 1; round <= maxRounds; round++) {
      // ── 1. Run execute session (with feedback appended from prior rounds) ──
      let executePrompt = executeSpec.prompt;
      if (collectedFeedback.length > 0) {
        executePrompt = `${executeSpec.prompt}${FEEDBACK_SUFFIX}${collectedFeedback.join('\n')}`;
      }

      const executeId = `${taskId}/execute`;

      const executeSessionSpec: SessionSpec = {
        id: executeId,
        profile: executeSpec.profile,
        prompt: executePrompt,
        ...(executeSpec.schema !== undefined ? { schema: executeSpec.schema } : {}),
        outputMode: executeSpec.outputMode,
        ...(executeSpec.isReadOnly !== undefined ? { isReadOnly: executeSpec.isReadOnly } : {}),
        runnerRole: executeSpec.role,
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

      let executeResult: SessionResult | undefined;
      try {
        executeResult = await runSessionViaGate(ctx, executeSessionSpec);
      } catch (err) {
        if (err instanceof SessionError && err.transient) {
          // Transient error — retry-in-place (same round, re-run execute)
          try {
            executeResult = await runSessionViaGate(ctx, executeSessionSpec);
          } catch (err2) {
            const msg = safeErrorMessage(err2);
            return { status: 'failed', error: msg };
          }
        } else {
          const msg = safeErrorMessage(err);
          return { status: 'failed', error: msg };
        }
      }

      // ── 2. Build review prompt (feed in execute result) ──────────────────
      if (!executeResult) {
        return { status: 'failed', error: 'Execute session produced no result' };
      }
      const reviewPrompt = buildReviewPrompt(reviewSpec.prompt, executeResult);

      // ── 3. Run review session ─────────────────────────────────────────────
      // Stable review id across rounds; on round 2+ RESUME the prior review
      // session so the reviewer sees its earlier verdict + the updated execute
      // output, instead of starting a fresh session each round.
      const reviewId = `${taskId}/review`;

      const reviewSessionSpec: SessionSpec = {
        id: reviewId,
        profile: reviewSpec.profile,
        prompt: reviewPrompt,
        ...(reviewSpec.schema !== undefined ? { schema: reviewSpec.schema } : {}),
        outputMode: reviewSpec.outputMode,
        ...(reviewSpec.isReadOnly !== undefined ? { isReadOnly: reviewSpec.isReadOnly } : {}),
        runnerRole: reviewSpec.role,
        // attempt stays at 1: a resume continues the same session, keeping the
        // projection key stable so round 2+ updates the existing entity.
        attempt: 1,
        ...(round > 1 ? { resume: true } : {}),
      };

      let reviewResult;
      try {
        reviewResult = await runSessionViaGate(ctx, reviewSessionSpec);
      } catch (err) {
        if (err instanceof SessionError && err.transient) {
          try {
            reviewResult = await runSessionViaGate(ctx, reviewSessionSpec);
          } catch (err2) {
            const msg = safeErrorMessage(err2);
            return { status: 'failed', error: msg };
          }
        } else {
          const msg = safeErrorMessage(err);
          return { status: 'failed', error: msg };
        }
      }

      // ── 4. Check review result ────────────────────────────────────────────
      const reviewData = reviewResult.mode === 'structured' ? (reviewResult.data as Record<string, unknown>) : {};
      if (reviewData.approved === true) {
        return { status: 'completed' };
      }

      // Rejected — collect feedback for the next round
      const feedback = typeof reviewData.feedback === 'string' ? reviewData.feedback : '';
      if (feedback) {
        collectedFeedback.push(feedback);
      }
    }

    return { status: 'failed', error: `Review rejected after ${maxRounds} rounds` };
  };
}
