// ─── Single-Session Runner (SessionPlan contract) ─────────────────────────
//
// A SessionPlanRunner that executes exactly one session via the session
// primitive. The session ID follows the deterministic convention:
//
//   `${taskId}/${role}#${attempt}`
//
// The runner delegates to `runScheduledSession` (a gate-free wrapper around
// `runSession`). It does NOT acquire or release any gate — the scheduler owns
// the gate.
//
// plan() yields one batch `[fullSpec]` and returns `undefined` (the scheduler
// tracks terminal results). execute() delegates to `runScheduledSession`.

import type { SessionResult, SessionSpec } from '../session.js';
import { defaultExecute } from './runner-utils.js';
import type { SessionPlanContext, SessionPlanFactory, SessionPlanRunner } from './session-plan-types.js';

/**
 * Create a SessionPlanRunner that runs one session via the session primitive.
 *
 * Deterministic ID: `${taskId}/${role}#${attempt}` (attempt defaults to 1).
 *
 * @param spec - Session spec fields (id is auto-generated). The `role` field
 *   is used both as the role segment in the session ID and as `runnerRole`
 *   in the generated spec. `attempt` defaults to 1.
 * @returns A factory that constructs a fresh {@link SessionPlanRunner} for
 *   each call.
 */
export function singleSession(
  spec: Omit<SessionSpec, 'id' | 'attempt'> & { role: string; attempt?: number },
): SessionPlanFactory {
  return (): SessionPlanRunner => {
    return {
      plan: async function* (
        ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        const role = spec.role;
        const attempt = spec.attempt ?? 1;
        const id = `${ctx.task.id}/${role}#${attempt}`;

        const fullSpec: SessionSpec = {
          id,
          profile: spec.profile,
          prompt: spec.prompt,
          ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
          outputMode: spec.outputMode,
          ...(spec.isReadOnly !== undefined ? { isReadOnly: spec.isReadOnly } : {}),
          ...(spec.allowedWriteDirs !== undefined ? { allowedWriteDirs: spec.allowedWriteDirs } : {}),
          runnerRole: role,
          attempt,
        };

        // Yield the single batch. The scheduler will feed back results via
        // gen.next(results) once this batch settles.
        const _results: SessionResult[] = yield [fullSpec];
        // We do not aggregate terminal results — return undefined.
        return;
      },

      execute: defaultExecute,
    };
  };
}
