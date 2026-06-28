// ─── run-scheduled-session ─────────────────────────────────────────────────
//
// Thin wrapper around {@link runSession} for the SessionPlan scheduler.
//
// The scheduler has already acquired a concurrency slot via `gate.acquire()`
// before calling this function. Unlike the legacy gate-acquiring helper
// (now removed), this helper does NOT acquire or release any gate — it simply
// {@link RunSessionContext} from the {@link SessionPlanContext} + spec and
// delegates to {@link runSession}.
//
// All errors (including {@link SessionError}) PROPAGATE to the caller. The
// scheduler is responsible for classification and retry decisions.

import type { SessionPlanContext } from './runners/session-plan-types.js';
import type { RunSessionContext, SessionResult, SessionSpec } from './session.js';
import { DEFAULT_WATCHDOG_TIMEOUT_MS, runSession } from './session.js';

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Run a single scheduled session.
 *
 * Constructs a {@link RunSessionContext} from the provided
 * {@link SessionPlanContext} + {@link SessionSpec} and delegates to
 * {@link runSession}.
 *
 * The scheduler owns gate acquisition — this helper does NOT interact with any
 * gate. Errors propagate unchanged.
 *
 * @param spec - The session specification to execute.
 * @param ctx  - The session plan context (no gate — the scheduler owns it).
 * @returns The {@link SessionResult} from `runSession`.
 * @throws whatever `runSession` throws (e.g. {@link SessionError}).
 */
export async function runScheduledSession(spec: SessionSpec, ctx: SessionPlanContext): Promise<SessionResult> {
  const sessionCtx: RunSessionContext = {
    spec,
    sessionBaseDir: ctx.sessionBaseDir,
    cwd: ctx.cwd,
    ...(ctx.worktreeCwd !== undefined ? { worktreeCwd: ctx.worktreeCwd } : {}),
    phaseId: ctx.phaseId,
    agentId: ctx.agentId,
    taskId: ctx.task.id,
    ...(ctx.apiKeys !== undefined ? { apiKeys: ctx.apiKeys } : {}),
    ...(ctx.onStatus !== undefined ? { onStatus: ctx.onStatus } : {}),
    activeSessions: ctx.activeSessions,
    profiles: ctx.profiles,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    // Inactivity watchdog: RESETS on every session activity event, only fires
    // on a genuine model freeze. stepTimeoutMs overrides the default; absent
    // that, fall back to DEFAULT_WATCHDOG_TIMEOUT_MS so sessions are never left
    // without freeze protection.
    ...(ctx.stepTimeoutMs !== undefined
      ? { watchdogTimeoutMs: ctx.stepTimeoutMs }
      : { watchdogTimeoutMs: DEFAULT_WATCHDOG_TIMEOUT_MS }),
  };

  return runSession(sessionCtx);
}
