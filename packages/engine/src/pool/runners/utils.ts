// ─── Runner Utilities (new contract) ──────────────────────────────────────
//
// Shared boilerplate extracted from council-runner, coordinator-runner,
// coalescing-runner, review-runner, single-session, and map-runner. These six
// runners all duplicated nearly identical logic for running a single session
// through the gate:
//
//   1. Resolve the AgentProfile from `ctx.profiles.get(spec.profile)` (throw if
//      missing).
//   2. Acquire a concurrency slot via `ctx.gate.run(profile, …)`.
//   3. Inside the gate callback, build a {@link RunSessionContext} from the
//      {@link RunnerContext} (forwarding all optional fields via conditional
//      spread so `undefined` values are omitted) and delegate to
//      `ctx.runSession`.
//
// This is the SOLE gating authority after the removal of pool-level
// `gate.run`, so correct `handle.signal` propagation is critical.

import type { SessionResult, SessionSpec } from '../session.js';
import type { RunnerContext } from './types.js';

/**
 * Run a single session via `ctx.gate.run` + `ctx.runSession`.
 *
 * Resolves the profile, acquires a concurrency slot, and delegates to
 * `runSession`. Throws on any failure (caller decides how to handle).
 *
 * The returned `handle.signal` from `gate.run` is passed as
 * `RunSessionContext.signal`, ensuring the gate's cooperative cancellation
 * reaches the session.
 *
 * @param ctx — The runner context (profiles, gate, runSession, …).
 * @param spec — The session specification to execute.
 * @returns The {@link SessionResult} produced by `ctx.runSession`.
 * @throws {Error} when the profile is not found in `ctx.profiles`.
 * @throws whatever `ctx.runSession` throws (e.g. {@link SessionError}).
 */
export async function runSessionViaGate(ctx: RunnerContext, spec: SessionSpec): Promise<SessionResult> {
  const profile = ctx.profiles.get(spec.profile);
  if (!profile) {
    throw new Error(`Profile "${spec.profile}" not found in profiles map`);
  }
  return ctx.gate.run(profile, async (handle) => {
    return ctx.runSession({
      spec,
      sessionBaseDir: ctx.sessionBaseDir,
      cwd: ctx.cwd,
      ...(ctx.worktreeCwd !== undefined ? { worktreeCwd: ctx.worktreeCwd } : {}),
      phaseId: ctx.phaseId,
      agentId: ctx.agentId,
      // Forward the owning task's id so session lifecycle callbacks
      // (onSessionStart / onSessionComplete) can tag the session_started /
      // session_completed events with taskId. Without this, the TUI/web cannot
      // associate a session with its task (it filters sessions by taskId).
      taskId: ctx.task.id,
      ...(ctx.apiKeys !== undefined ? { apiKeys: ctx.apiKeys } : {}),
      ...(ctx.onStatus !== undefined ? { onStatus: ctx.onStatus } : {}),
      activeSessions: ctx.activeSessions,
      profiles: ctx.profiles,
      signal: handle.signal,
      ...(ctx.stepTimeoutMs !== undefined ? { watchdogTimeoutMs: ctx.stepTimeoutMs } : {}),
    });
  });
}
