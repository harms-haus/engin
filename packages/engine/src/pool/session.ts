// ─── Session Primitive ─────────────────────────────────────────────────────
//
// `runSession` is the single-step session primitive that RunnerPool delegates
// to. It encapsulates the full agent session lifecycle for one prompt turn:
//
//   1. Idempotency check (`.complete` sentinel + `result.json`)
//   2. Agent session creation via the agent plugin registry (direct
//      `plugin.createSession` — NOT `spawnAgent`; the session primitive is a
//      single-step unit that manages its own lifecycle callbacks).
//   3. Prompt delivery (text / structured / filesystem output mode)
//   4. Response parsing & result persistence
//   5. Watchdog (activity-based timeout + escalation)
//   6. Lifecycle callbacks (onSessionStart / onSessionComplete only)
//
// Unlike the legacy step runner (which delegated to `spawnAgent` and
// fired the full agent/step callback cascade), `runSession` fires ONLY
// `onSessionStart` and `onSessionComplete`. This keeps the session primitive
// a clean single-step building block for higher-level orchestrators that
// manage their own task/step lifecycle.
//
// Idempotency sentinel convention:
//   Session directory: `{sessionBaseDir}/{spec.id}/`
//   Sentinel: `{sessionBaseDir}/{spec.id}/.complete` (empty file)
//   Result: `{sessionBaseDir}/{spec.id}/result.json` with shape:
//     { checksum: string, length: number, result: SessionResult }
//   - checksum: SHA-256 hex digest of JSON.stringify(result)
//   - length: byte length of JSON.stringify({ result })

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { ZodType } from 'zod';

import type { AgentRuntime } from '../core/agent-plugin.js';
import { DEFAULT_AGENT_PLUGIN_ID, requireAgentPlugin } from '../core/agent-registry.js';
import type { Classification } from '../core/error-classifier.js';
import { classify } from '../core/error-classifier.js';
import { promptForStructured } from '../core/structured-output.js';
import type { AgentProfile, StatusCallbacks } from '../core/types.js';
import { forwardAgentStatus, safeErrorMessage } from '../core/utils.js';
import { assertSafeName } from './validation.js';

// ─── Types ────────────────────────────────────────────────────────────────

/** How the session response is interpreted. */
export type OutputMode = 'text' | 'structured' | 'filesystem';

/** Specification for a single agent session. */
export interface SessionSpec {
  /** Unique session identifier (also used as the task id for session persistence). */
  id: string;
  /** Agent profile id (resolved against `ctx.profiles`). */
  profile: string;
  /** The prompt text sent to the agent. */
  prompt: string;
  /** Optional Zod schema for structured output mode. */
  schema?: ZodType;
  /** How the response is interpreted. */
  outputMode: OutputMode;
  /** When true, write/edit tools are stripped from the agent's toolset. */
  isReadOnly?: boolean;
  /** Role label for the runner (e.g. 'executor', 'reviewer'). Propagated to
   *  onSessionStart / onSessionComplete callbacks. */
  runnerRole: string;
  /** 1-based attempt number (for multi-retry workflows). Propagated to callbacks. */
  attempt: number;
  /** When true, RESUME an existing session at this id (continue its conversation
   *  with `prompt`) instead of creating a fresh one. Used by review loops so a
   *  rejected execute step is re-prompted in the SAME session (the agent sees
   *  its prior work + the new feedback) rather than starting over. The session
   *  must already have run at least once at this id. Bypasses the idempotency
   *  cache check and does NOT wipe the session directory. */
  resume?: boolean;
}

/** Discriminated union of session results keyed on `mode`. */
export type SessionResult =
  | { mode: 'text'; text: string }
  | { mode: 'structured'; data: unknown }
  | { mode: 'filesystem'; files: string[] };

/** Error thrown by `runSession` when the session fails. */
export class SessionError extends Error {
  /** Structured error classification from the error classifier. */
  readonly classification: Classification;
  /** Shortcut for `classification.retryable`. `true` for transient / retryable
   *  errors (e.g. watchdog timeout); `false` for permanent errors (e.g. corrupt
   *  cache, abort). */
  readonly transient: boolean;

  constructor(message: string, classification: Classification) {
    super(message);
    this.name = 'SessionError';
    this.classification = classification;
    this.transient = classification.retryable;
  }
}

/** Context passed to {@link runSession}. */
export interface RunSessionContext {
  /** The session specification to execute. */
  spec: SessionSpec;
  /** Base directory for persisted session storage.
   *  Session directory: `{sessionBaseDir}/{spec.id}/` */
  sessionBaseDir: string;
  /** Working directory for agent operations. */
  cwd: string;
  /** Optional per-task worktree path. When set, the agent session runs inside
   *  the isolated worktree (`cwd` falls back to this). `undefined` when no
   *  worktree is in use. */
  worktreeCwd?: string;
  /** Phase identifier propagated to lifecycle callbacks. */
  phaseId: string;
  /** Agent identifier propagated to lifecycle callbacks. */
  agentId: string;
  /** Owning task id propagated to lifecycle callbacks (onSessionStart /
   *  onSessionComplete) so downstream consumers (TUI/web) can associate the
   *  session with its task. Optional because some meta-sessions (e.g. title
   *  generation) are genuinely task-less. */
  taskId?: string;
  /** Optional API key overrides by provider. */
  apiKeys?: Record<string, string>;
  /** Status callback handlers (onSessionStart / onSessionComplete / agent-status
   *  forwarding). */
  onStatus?: StatusCallbacks;
  /** Mutable set of active sessions (for cooperative abort). */
  activeSessions: Set<{ abort(): Promise<void> }>;
  /** Resolved agent profiles keyed by profile id. `runSession` looks up the
   *  profile for `spec.profile` here and passes it (after read-only adjustment)
   *  to `plugin.createSession`. */
  profiles: Map<string, AgentProfile>;
  /** Cooperative cancellation signal. */
  signal?: AbortSignal;
  /** Watchdog timeout in milliseconds. When a positive finite number, the
   *  session is aborted if no activity events (turn_start, tool_execution_start,
   *  etc.) are received within this window. Unset / 0 / NaN / negative → no
   *  watchdog. */
  watchdogTimeoutMs?: number;
  /** Maximum number of watchdog-triggered resumes before the error becomes
   *  permanent (transient → false). When unset, every watchdog abort is
   *  transient (no internal retry). When set to a positive finite number,
   *  `runSession` internally retries up to this many times before throwing a
   *  permanent error. */
  watchdogMaxResumes?: number;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/** Returns `true` when `n` is a positive finite number. */
function isPositiveFinite(n: number | undefined): n is number {
  return n != null && Number.isFinite(n) && n > 0;
}

/** Default inactivity watchdog window (5 minutes) used when no explicit
 *  `watchdogTimeoutMs` is configured. The watchdog RESETS on every session
 *  activity event (turn_start, tool_execution_start, turn_end) and only fires
 *  when the model goes silent for this whole window — it is NOT a wall-clock
 *  cap on the session. */
export const DEFAULT_WATCHDOG_TIMEOUT_MS = 300_000;

/** Sentinel error thrown internally when the watchdog timer fires. */
class WatchdogTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Session watchdog timed out after ${timeoutMs}ms of inactivity`);
    this.name = 'WatchdogTimeoutError';
  }
}

/** Write `data` to `filePath` and fsync the file descriptor (durability). */
function writeAndFsync(filePath: string, data: string): void {
  const fd = openSync(filePath, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Best-effort fsync of a directory file descriptor. Some platforms do not
 *  support opening directories — failures are silently ignored. */
function fsyncDir(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, 'r');
    fsyncSync(fd);
  } catch {
    // best-effort — not all platforms support opening directories read-only
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Compute the SHA-256 hex checksum of `JSON.stringify(result)`. */
function computeChecksum(result: unknown): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

/**
 * Attempt to read a valid cached result from `{sessionDir}/`.
 *
 * Returns the cached `SessionResult` when `.complete` + a valid `result.json`
 * exist. Returns `null` when there is no `.complete` sentinel (caller should
 * proceed to spawn). Throws a permanent `SessionError` when `.complete` exists
 * but `result.json` is missing, unparseable, or fails checksum/length
 * validation (corrupt state — must not be replayed).
 */
function tryReadCachedResult(sessionDir: string): SessionResult | null {
  const completePath = join(sessionDir, '.complete');
  if (!existsSync(completePath)) return null;

  const resultPath = join(sessionDir, 'result.json');
  if (!existsSync(resultPath)) {
    throw new SessionError('Session result is corrupt: .complete exists but result.json is missing', {
      kind: 'permanent',
      retryable: false,
    });
  }

  let payload: { checksum?: unknown; length?: unknown; result?: unknown };
  try {
    payload = JSON.parse(readFileSync(resultPath, 'utf-8'));
  } catch {
    throw new SessionError('Session result is corrupt: result.json could not be parsed', {
      kind: 'permanent',
      retryable: false,
    });
  }

  if (typeof payload.checksum !== 'string' || typeof payload.length !== 'number' || payload.result === undefined) {
    throw new SessionError('Session result is corrupt: result.json has invalid structure', {
      kind: 'permanent',
      retryable: false,
    });
  }

  const expectedChecksum = computeChecksum(payload.result);
  if (payload.checksum !== expectedChecksum) {
    throw new SessionError('Session result is corrupt: checksum mismatch', {
      kind: 'permanent',
      retryable: false,
    });
  }

  const expectedLength = Buffer.byteLength(JSON.stringify({ result: payload.result }));
  if (payload.length !== expectedLength) {
    throw new SessionError('Session result is corrupt: length mismatch', {
      kind: 'permanent',
      retryable: false,
    });
  }

  return payload.result as SessionResult;
}

/** Atomically persist `{ checksum, length, result }` to `{sessionDir}/result.json`
 *  followed by the `.complete` sentinel. */
function persistResult(sessionDir: string, result: SessionResult): void {
  const checksum = computeChecksum(result);
  const length = Buffer.byteLength(JSON.stringify({ result }));
  const payload = JSON.stringify({ checksum, length, result });

  const tmpPath = join(sessionDir, 'result.json.tmp');
  const resultPath = join(sessionDir, 'result.json');
  const completePath = join(sessionDir, '.complete');

  // 1. Write payload to temp file + fsync
  writeAndFsync(tmpPath, payload);
  // 2. Atomic rename → result.json
  renameSync(tmpPath, resultPath);
  // 3. fsync directory so the rename is durable
  fsyncDir(sessionDir);
  // 4. Write .complete sentinel LAST
  writeAndFsync(completePath, '');
}

/** Look up the profile from `ctx.profiles` and apply read-only tool exclusion.
 *
 *  Returns a COPY of the profile (the original is never mutated). When
 *  `isReadOnly` is true, `write` and `edit` are added to `excludeTools`.
 *  Throws when the profile is not found in the map. */
function resolveProfile(spec: SessionSpec, profiles: Map<string, AgentProfile>): AgentProfile {
  const profile = profiles.get(spec.profile);
  if (!profile) {
    throw new SessionError(`Profile "${spec.profile}" not found in profiles map`, {
      kind: 'permanent',
      retryable: false,
    });
  }
  if (!spec.isReadOnly) return profile;
  return {
    ...profile,
    excludeTools: [...new Set([...profile.excludeTools, 'write', 'edit'])],
  };
}

/** Allowed characters for a single segment of a session id.
 *  Runner IDs contain `/`, `#`, `[`, `]`, `.`, `-`, `_`, alphanumerics.
 *  Each `/`-delimited segment must match this pattern. */
const SESSION_ID_SEGMENT_RE = /^[a-zA-Z0-9_.#[\]-]+$/;

/**
 * Validate `sessionId` against path traversal.
 *
 * Splits the id on `/` and checks each segment:
 *   - Is non-empty
 *   - Is not `.` or `..`
 *   - Matches the allowed character set
 *
 * Then applies a defense-in-depth `resolve` check to ensure the resolved
 * path stays within `baseDir`.
 *
 * @throws {Error} with a descriptive message if validation fails.
 */
function validateSessionId(id: string, baseDir: string): void {
  if (!id) {
    throw new Error(`Invalid session id: "${id}" is empty`);
  }

  const segments = id.split('/');
  for (const segment of segments) {
    if (segment === '') {
      throw new Error(`Invalid session id: "${id}" contains an empty segment`);
    }
    if (segment === '.') {
      throw new Error(`Invalid session id: "${id}" contains a segment "." (current directory)`);
    }
    if (segment === '..') {
      throw new Error(`Invalid session id: "${id}" contains a segment ".." (path traversal)`);
    }
    if (!SESSION_ID_SEGMENT_RE.test(segment)) {
      throw new Error(`Invalid session id: "${id}" contains invalid characters in segment "${segment}"`);
    }
  }

  // Defense-in-depth: ensure the resolved path stays within baseDir.
  const resolvedBase = resolve(baseDir);
  const resolvedDir = resolve(join(baseDir, id));
  const basePrefix = resolvedBase === '/' ? '/' : resolvedBase + '/';
  if (!resolvedDir.startsWith(basePrefix)) {
    throw new Error(`Invalid session id: "${id}" resolves outside the base directory`);
  }
}

// ─── Single-attempt execution ──────────────────────────────────────────────

/**
 * Create a session directly via the agent plugin registry, wire up the watchdog
 * + status forwarding, fire `onSessionStart`, execute the prompt by output
 * mode, persist the result, fire `onSessionComplete`, and clean up.
 *
 * Throws `WatchdogTimeoutError` when the watchdog fires (the caller decides
 * whether to retry). Throws `SessionError` for fail-fast conditions. Any other
 * thrown error is wrapped by the caller via `classify`.
 *
 * Unlike `spawnAgent`, this function fires ONLY `onSessionStart` /
 * `onSessionComplete` — not `onSessionStart` / `onSessionStart` / `onSessionComplete`.
 */
async function executeAttempt(
  ctx: RunSessionContext,
  sessionDir: string,
  watchdogTimeoutMs: number | undefined,
): Promise<SessionResult> {
  // Clear any partial state from a previous (failed or incomplete) attempt.
  // For resume requests: PRESERVE the session directory (the conversation file
  // lives there) and instead locate the existing .jsonl to resume from, then
  // drop the stale `.complete` sentinel so the new result overwrites cleanly.
  let resumeSessionPath: string | undefined;
  if (ctx.spec.resume === true) {
    mkdirSync(sessionDir, { recursive: true });
    // Locate the prior conversation file (*.jsonl) written by SessionManager.
    const files = readdirSync(sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(sessionDir, f))
      .filter((f) => existsSync(f));
    if (files.length > 0) {
      // Most recent by mtime (a dir should hold one session file, but be safe).
      const sorted = files.map((f) => ({ f, m: statSync(f).mtimeMs })).sort((a, b) => b.m - a.m);
      if (sorted[0] !== undefined) resumeSessionPath = sorted[0].f;
    }
    // Drop the stale completion marker so this re-run persists a fresh result.
    try {
      rmSync(join(sessionDir, '.complete'), { force: true });
    } catch {
      /* best-effort */
    }
  } else {
    rmSync(sessionDir, { recursive: true, force: true });
    mkdirSync(sessionDir, { recursive: true });
  }

  // ── Resolve profile + create session directly via the plugin registry ──
  const adjustedProfile = resolveProfile(ctx.spec, ctx.profiles);
  const plugin = requireAgentPlugin(adjustedProfile.agent ?? DEFAULT_AGENT_PLUGIN_ID);
  const session: AgentRuntime = await plugin.createSession({
    profile: adjustedProfile,
    cwd: ctx.worktreeCwd ?? ctx.cwd,
    apiKeys: ctx.apiKeys,
    agentId: ctx.agentId,
    ...(resumeSessionPath !== undefined ? { resumeSessionPath: resumeSessionPath } : { sessionDir }),
    // Always provide an onAgentStatus sink so the runtime has a callback
    // target for activity events. When ctx.onStatus is set, events are
    // forwarded to it; otherwise a no-op object is passed.
    onAgentStatus: forwardAgentStatus(ctx.onStatus) ?? {},
  });

  // ── TOCTOU: track the session IMMEDIATELY after createSession returns ──
  // (before any await) so an abort listener iterating `activeSessions` reaches
  // this session even if the abort fires in the [created, prompt] window.
  ctx.activeSessions.add(session);

  const sessionId = session.sessionId;
  const sessionPath = session.sessionFile ?? sessionDir;

  // ── Watchdog setup ─────────────────────────────────────────────────────
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  const armWatchdog = (): void => {
    if (watchdogTimeoutMs === undefined) return;
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      // Abort the session. The raced prompt/structured promise rejects when
      // the abort propagates — that rejection is swallowed by
      // `raceWithWatchdog` (a no-op `.catch` is attached to the loser).
      session.abort().catch(() => {
        /* swallow abort errors */
      });
      // Deliver the watchdog timeout via the shared reject captured by
      // `raceWithWatchdog`.
      watchdogReject?.(new WatchdogTimeoutError(watchdogTimeoutMs));
    }, watchdogTimeoutMs);
  };

  let watchdogReject: ((reason: unknown) => void) | undefined;

  /**
   * Race `work` against the watchdog timer. When the watchdog fires first,
   * `work`'s eventual rejection (triggered by `session.abort()`) is swallowed
   * via a no-op `.catch` so it never surfaces as an unhandled rejection.
   * Returns the resolved value of `work`, or throws `WatchdogTimeoutError`
   * when the watchdog wins the race.
   */
  const raceWithWatchdog = <T>(work: Promise<T>): Promise<T> => {
    if (watchdogTimeoutMs === undefined) return work;
    const watchdogPromise = new Promise<never>((_, reject) => {
      watchdogReject = reject;
    });
    // Pre-attach a no-op catch so that when the watchdog wins and the abort
    // propagates into `work`, the resulting rejection is swallowed (mirrors
    // the same pattern from the legacy step runner).
    work.catch(() => {
      /* swallow abort-triggered rejection from the raced loser */
    });
    return Promise.race([work, watchdogPromise]) as Promise<T>;
  };

  // Subscribe to runtime events for watchdog reset. `onAgentStatus` (wired
  // above via forwardAgentStatus) handles status-callback forwarding; this
  // subscription is ONLY for resetting the watchdog idle timer on activity.
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'turn_start' || event.type === 'tool_execution_start' || event.type === 'turn_end') {
      armWatchdog();
    }
  });

  // Arm the initial watchdog timer.
  armWatchdog();

  // ── Fire onSessionStart ────────────────────────────────────────────────
  ctx.onStatus?.onSessionStart?.({
    agentId: ctx.agentId,
    profile: ctx.spec.profile,
    phaseId: ctx.phaseId,
    taskId: ctx.taskId,
    sessionId,
    sessionPath,
    ...(session.contextWindow !== undefined ? { contextWindow: session.contextWindow } : {}),
    runnerRole: ctx.spec.runnerRole,
    attempt: ctx.spec.attempt,
  });

  try {
    // ── TOCTOU: re-check signal after createSession, before prompt ──────
    if (ctx.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const promptText = ctx.spec.prompt;

    // ── Execute by output mode ──────────────────────────────────────────
    let result: SessionResult;

    if (ctx.spec.outputMode === 'structured') {
      // Structured output: prompt + Zod validation. No approve/reject decision
      // here — the caller decides based on the returned data.
      const schema = ctx.spec.schema;
      if (!schema) {
        throw new SessionError('Structured output mode requires a schema', { kind: 'permanent', retryable: false });
      }
      const structuredPromise = promptForStructured(session, promptText, schema, { maxRetries: 3 });
      const { result: data } = await raceWithWatchdog(structuredPromise);
      result = { mode: 'structured', data };
    } else if (ctx.spec.outputMode === 'filesystem') {
      // Filesystem: prompt the agent; files are written during the turn.
      await raceWithWatchdog(session.prompt(promptText));
      result = { mode: 'filesystem', files: [] };
    } else {
      // Text mode: prompt + extract text + fail-fast on empty/error.
      await raceWithWatchdog(session.prompt(promptText));

      const text = session.getLastAssistantText();
      const lastAssistant = session.getLastAssistantMessage();
      const classification = classify(undefined, { lastAssistantMessage: lastAssistant });

      // Fail-fast: if the agent produced no usable text or the provider reported
      // an error, throw a SessionError so the caller fails the task.
      if (lastAssistant?.stopReason === 'error' || classification.kind === 'empty' || !text) {
        const detail = lastAssistant?.errorMessage ? `: ${lastAssistant.errorMessage}` : '';
        throw new SessionError(
          `Session produced no usable output (stopReason: ${lastAssistant?.stopReason ?? 'unknown'})${detail}`,
          classification,
        );
      }

      result = { mode: 'text', text };
    }

    // ── Persist atomically ──────────────────────────────────────────────
    persistResult(sessionDir, result);

    // ── Fire onSessionComplete ──────────────────────────────────────────
    ctx.onStatus?.onSessionComplete?.({
      agentId: ctx.agentId,
      profile: ctx.spec.profile,
      phaseId: ctx.phaseId,
      taskId: ctx.taskId,
      sessionId,
      runnerRole: ctx.spec.runnerRole,
      attempt: ctx.spec.attempt,
    });

    return result;
  } finally {
    // ── Cleanup (every exit path) ────────────────────────────────────────
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    unsubscribe();
    ctx.activeSessions.delete(session);
    try {
      session.dispose();
    } catch {
      /* best-effort */
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Run a single agent session. Full lifecycle: idempotency check → plugin
 * session creation → prompt → response parsing → persistence → callbacks.
 *
 * When `watchdogTimeoutMs` is a positive finite number, an activity-based idle
 * timer is started. Each runtime event (`turn_start`, `tool_execution_start`,
 * `turn_end`) resets the timer. If the timer fires (no activity within the
 * window), the session is aborted.
 *
 * When `watchdogMaxResumes` is ALSO a positive finite number, `runSession`
 * internally retries (re-creates the session) up to that many times on watchdog
 * timeouts before throwing a permanent `SessionError`. The resume count is
 * tracked as a local counter within this call (the module is stateless — no
 * module-global map). When `watchdogMaxResumes` is unset, each watchdog timeout
 * throws a transient `SessionError` (no internal retry).
 *
 * @throws {SessionError} on any failure (classified by the error classifier).
 */
export async function runSession(ctx: RunSessionContext): Promise<SessionResult> {
  // ── 1. Pre-aborted signal check (before any session creation) ──────────
  if (ctx.signal?.aborted) {
    throw new SessionError('Session aborted before start', { kind: 'abort', retryable: false });
  }

  // ── 2. Validate spec.id against path traversal ─────────────────────────
  validateSessionId(ctx.spec.id, ctx.sessionBaseDir);

  const sessionDir = join(ctx.sessionBaseDir, ctx.spec.id);

  // ── 3. Idempotency check ───────────────────────────────────────────────
  // If `.complete` + valid result.json exist → return cached result (no spawn).
  // If `.complete` exists but result.json is corrupt → throw permanent error.
  // If no `.complete` → proceed to create a session.
  // (A `resume` request always proceeds past this cache — it must re-prompt
  // the existing session even though a prior result is cached.)
  if (ctx.spec.resume !== true) {
    const cached = tryReadCachedResult(sessionDir);
    if (cached !== null) {
      return cached;
    }
  }

  // ── 4. Determine watchdog settings ─────────────────────────────────────
  const watchdogTimeoutMs = isPositiveFinite(ctx.watchdogTimeoutMs) ? ctx.watchdogTimeoutMs : undefined;
  const maxResumes = isPositiveFinite(ctx.watchdogMaxResumes) ? ctx.watchdogMaxResumes : undefined;
  const internalRetry = watchdogTimeoutMs !== undefined && maxResumes !== undefined;

  // ── 5. Execution loop ──────────────────────────────────────────────────
  // When internalRetry is enabled, the loop re-creates the session on watchdog
  // timeouts until maxResumes is exceeded. Otherwise, a single attempt is made.
  // The resume counter is local to this call (stateless module).
  let resumeCount = 0;

  while (true) {
    try {
      const result = await executeAttempt(ctx, sessionDir, watchdogTimeoutMs);
      return result;
    } catch (err) {
      if (err instanceof WatchdogTimeoutError) {
        // ── Watchdog timeout ─────────────────────────────────────────────
        resumeCount += 1;

        if (internalRetry && maxResumes !== undefined && resumeCount <= maxResumes) {
          // Internal retry: loop back to re-create the session.
          continue;
        }

        if (internalRetry) {
          // Retry budget exhausted → permanent error.
          throw new SessionError(
            `Session "${ctx.spec.id}" stalled after ${resumeCount} watchdog timeouts (maxResumes: ${maxResumes})`,
            { kind: 'permanent', retryable: false },
          );
        }

        // No internal retry → throw transient SessionError.
        throw new SessionError(`Session "${ctx.spec.id}" timed out (watchdog: ${watchdogTimeoutMs}ms)`, {
          kind: 'transient',
          retryable: true,
        });
      }

      // ── Non-watchdog error ─────────────────────────────────────────────
      if (err instanceof SessionError) {
        throw err;
      }

      // Classify and wrap as SessionError. The session's last assistant
      // message metadata (stopReason, content, etc.) is used by the classifier.
      const classification = classify(err);
      throw new SessionError(safeErrorMessage(err), classification);
    }
  }
}

/**
 * Lightweight idempotency pre-check: does a cached result exist for the
 * given session id?
 *
 * Returns `true` when `{sessionBaseDir}/{specId}/.complete` exists. Does NOT
 * validate the cached result — callers that need the actual value should use
 * {@link runSession} (which calls {@link tryReadCachedResult} internally and
 * validates checksum/length). This function is intended for fast pre-checks
 * (e.g. the scheduler skipping a gate slot for cached sessions).
 *
 * No-op (returns `false`) when the directory or sentinel does not exist.
 */
export function isSessionCached(sessionBaseDir: string, specId: string): boolean {
  return existsSync(join(sessionBaseDir, specId, '.complete'));
}

/**
 * Recursively delete every persisted session for a task.
 *
 * A task's sessions live at `{sessionBaseDir}/{taskId}/`. Clearing the whole
 * directory guarantees a retry / resume restarts with a clean slate.
 *
 * This is the canonical `clearTaskSessions` for the session primitive path.
 *
 * No-op (does not throw) when the directory does not exist.
 */
export function clearTaskSessions(sessionBaseDir: string, taskId: string): void {
  assertSafeName(taskId, 'task id');
  const taskDir = join(sessionBaseDir, taskId);
  rmSync(taskDir, { recursive: true, force: true });
}
