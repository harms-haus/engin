// ─── Single-Session Runner ─────────────────────────────────────────────────
//
// A Runner that executes exactly one session via the session primitive.
// The session ID follows the deterministic convention:
//
//   `${taskId}/${role}#${attempt}`
//
// The runner delegates to the shared `runSessionViaGate` helper, which resolves
// the profile from `ctx.profiles`, acquires a concurrency slot via
// `ctx.gate.run`, and calls `ctx.runSession`. On success it returns
// `{ status: 'completed' }`. SessionError from `runSession` is allowed to
// propagate (the pool layer handles task settling).

import type { SessionSpec } from '../session.js';
import type { Runner, RunnerContext, TaskOutcome } from './types.js';
import { runSessionViaGate } from './utils.js';

/**
 * Create a Runner that runs one session via the session primitive.
 *
 * Deterministic ID: `${taskId}/${role}#${attempt}` (attempt starts 1).
 * Returns `{ status: 'completed' }` on success; rethrows SessionError on failure.
 */
export function singleSession(spec: Omit<SessionSpec, 'id'> & { role: string }): Runner {
  return async (ctx: RunnerContext): Promise<TaskOutcome> => {
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
      runnerRole: role,
      attempt,
    };

    await runSessionViaGate(ctx, fullSpec);

    return { status: 'completed' };
  };
}
