// ─── Agent Lifecycle Helper ─────────────────────────────────────────────────
//
// `spawnAgent` extracts the duplicated agent lifecycle previously inlined in
// `pool/step-execution.ts:runStep` and `core/phase-tasks.ts:runStepTask` /
// `runMultiStepTask`:
//   - profile lookup + read-only adjustment (strip write/edit)
//   - session creation via the agent plugin registry
//   - activeSessions tracking (before any status callback — TOCTOU safety)
//   - onSessionStart firing (with sessionId + sessionPath)
//   - onStepStart firing
//   - returns a handle exposing session/dispose/sessionId/sessionPath + a
//     `complete()` method that fires onSessionComplete and removes the session
//     from activeSessions.
//
// Renderer invocation is intentionally NOT part of spawnAgent — it stays in the
// callers (runStep / runStepTask / runMultiStepTask), which have different
// rendering needs. Likewise, disposal of the underlying session is the caller's
// responsibility (via `handle.dispose()`); `complete()` only fires the lifecycle
// callback and untracks the session.

import type { AgentRuntime } from './agent-plugin.js';

import { requireAgentPlugin } from './agent-registry.js';
import type { AgentProfile, StatusCallbacks } from './types.js';
import { forwardAgentStatus } from './utils.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentLifecycleOptions {
  profileId: string;
  agentId: string;
  cwd: string;
  phaseId: string;
  taskId: string;
  /** Optional role label propagated to onSessionStart / onSessionComplete. */
  runnerRole?: string;
  /** Attempt number (1-based). */
  attempt?: number;
  /** When true, write/edit tools are stripped from the agent's toolset. */
  isReadOnly?: boolean;
  /** Optional API key overrides by provider. */
  apiKeys?: Record<string, string>;
  /** Optional write sandbox directories (resolved against `cwd`). */
  allowedWriteDirs?: string[];
  /** Directory for a new persisted session. Ignored when `resumeSessionPath` is set. */
  sessionDir?: string;
  /** Path to an existing session file to resume. Takes precedence over `sessionDir`. */
  resumeSessionPath?: string;
  /** Status callback handlers (session start / complete are fired here). */
  onStatus?: StatusCallbacks;
  /** Mutable set of active sessions. The spawned session is added here (before any
   *  callback fires) and removed by `handle.complete()`. Enables abort listeners
   *  to reach a freshly-created session (TOCTOU safety). */
  activeSessions?: Set<{ abort(): Promise<void> }>;
}

export interface AgentLifecycleHandle {
  /** The created {@link AgentRuntime}. */
  session: AgentRuntime;
  /** Disposes the underlying session (session.dispose). Caller-invoked. */
  dispose: () => void;
  /** The session id from the created session. */
  sessionId: string;
  /** Resolved session path: sessionFile ?? resumeSessionPath ?? sessionDir ?? sessionId. */
  sessionPath: string;
  /** Fires onSessionComplete and removes the session from activeSessions. Does NOT dispose. */
  complete: () => void;
}

// ─── spawnAgent ─────────────────────────────────────────────────────────────

/**
 * Spawn an agent: look up + adjust the profile, create the session via the
 * agent plugin registry, track the session, and fire the spawn/step-start
 * lifecycle callbacks.
 *
 * The session is added to `activeSessions` IMMEDIATELY after session creation
 * and BEFORE any status callback fires. This closes the Time-of-Check-Time-of-Use
 * (TOCTOU) gap: an abort listener iterating `activeSessions` will reach the
 * freshly-created session even if the abort fires between session creation and
 * the first prompt.
 *
 * @returns a {@link AgentLifecycleHandle}. The caller drives the prompt,
 *          renderer invocation, and disposal; `handle.complete()` fires the
 *          completion callback + untracks the session.
 */
export async function spawnAgent(
  opts: AgentLifecycleOptions,
  profiles: Map<string, AgentProfile>,
): Promise<AgentLifecycleHandle> {
  // 1. Look up the profile.
  const profile = profiles.get(opts.profileId);
  if (!profile) {
    throw new Error(`Profile "${opts.profileId}" not found`);
  }

  // 2. Read-only adjustment — build a COPY (do not mutate the original profile).
  let adjustedProfile: AgentProfile = profile;
  if (opts.isReadOnly) {
    adjustedProfile = {
      ...profile,
      excludeTools: [...new Set([...profile.excludeTools, 'write', 'edit'])],
    };
  }

  // 3. Create the session via the agent plugin registry. resumeSessionPath
  //    takes precedence over sessionDir (mirrors the existing call sites);
  //    when neither is set, createSession falls back to an in-memory session.
  const plugin = requireAgentPlugin(adjustedProfile.agent);
  const session = await plugin.createSession({
    profile: adjustedProfile,
    cwd: opts.cwd,
    apiKeys: opts.apiKeys,
    agentId: opts.agentId,
    allowedWriteDirs: opts.allowedWriteDirs,
    onAgentStatus: forwardAgentStatus(opts.onStatus),
    ...(opts.resumeSessionPath
      ? { resumeSessionPath: opts.resumeSessionPath }
      : opts.sessionDir
        ? { sessionDir: opts.sessionDir }
        : {}),
  });
  const sessionId = session.sessionId;
  const dispose = () => session.dispose();
  const contextWindow = session.contextWindow;

  // 4. TOCTOU: track the session BEFORE firing any callback or awaiting again.
  //    An abort listener firing in the [tracked, prompt] window reaches this session.
  opts.activeSessions?.add(session);

  // 5. Resolve the observable session path. session.sessionFile is set at
  //    session creation (before the first turn), so it is correct on first run
  //    and resume. The sessionId fallback preserves the historical in-memory
  //    behavior.
  const sessionPath = session.sessionFile ?? opts.resumeSessionPath ?? opts.sessionDir ?? sessionId;

  // 6. Fire onSessionStart (after tracking) with sessionId + sessionPath + contextWindow.
  opts.onStatus?.onSessionStart?.({
    agentId: opts.agentId,
    profile: opts.profileId,
    phaseId: opts.phaseId,
    taskId: opts.taskId,
    sessionId,
    sessionPath,
    contextWindow,
  });

  // 7. Return the handle. complete() fires onSessionComplete + untracks; dispose()
  //    tears down the session. The two are deliberately separate so callers can
  //    fire the completion callback (e.g. in a finally block) without disposing
  //    when they intend to keep the session alive, or dispose without the callback.
  return {
    session,
    dispose,
    sessionId,
    sessionPath,
    complete: () => {
      opts.onStatus?.onSessionComplete?.({
        agentId: opts.agentId,
        profile: opts.profileId,
        phaseId: opts.phaseId,
        taskId: opts.taskId,
        sessionId,
      });
      opts.activeSessions?.delete(session);
    },
  };
}
