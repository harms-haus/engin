// ─── Tests for pool/run-scheduled-session.ts ──────────────────────────────
//
// Mock strategy:
//   - `session.js` → mock `runSession` as a spy. We do NOT need the real
//     runSession (which would create real agent sessions, touch the filesystem,
//     etc.). The mock returns a canned SessionResult so we can verify:
//       1. The helper calls runSession exactly once.
//       2. It constructs the RunSessionContext correctly from spec + ctx.
//       3. It returns runSession's result as-is.
//       4. It does NOT interact with any gate (no gate field exists in ctx).
//       5. Errors propagate unchanged (not swallowed).

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentProfile, StatusCallbacks, Task } from '../core/types.js';
import type { SessionPlanContext } from './runners/session-plan-types.js';
import type { SessionResult, SessionSpec } from './session.js';
import { DEFAULT_WATCHDOG_TIMEOUT_MS } from './session.js';

// ─── Mock runSession ──────────────────────────────────────────────────────

const mockRunSession = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => Promise<SessionResult>);

mock.module('../pool/session.js', () => ({
  runSession: (...args: unknown[]) => mockRunSession(...args),
  SessionError: class SessionError extends Error {
    readonly classification: { kind: string; retryable: boolean };
    readonly transient: boolean;
    constructor(message: string, classification: { kind: string; retryable: boolean }) {
      super(message);
      this.name = 'SessionError';
      this.classification = classification;
      this.transient = classification.retryable;
    }
  },
}));

// ─── Import module under test (after mocks) ──────────────────────────────

import { runScheduledSession } from './run-scheduled-session.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const DEFAULT_PROFILE: AgentProfile = {
  id: 'test-profile',
  name: 'Test Profile',
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  agent: 'test-mock-agent',
  thinkingLevel: 'off',
  systemPrompt: 'You are a test agent.',
  excludeTools: [],
  includeTools: [],
};

const DEFAULT_TASK: Task = {
  id: 'task-42',
  title: 'Implement feature X',
  prompt: 'Write the code for feature X',
  profile: 'test-profile',
  files: ['src/feature-x.ts'],
  dependencies: [],
  status: 'active' as const,
  phaseId: 'build-phase',
  worktree: 'none',
};

function makeSpec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    id: 'test-session',
    profile: 'test-profile',
    prompt: 'do something',
    outputMode: 'text',
    runnerRole: 'executor',
    attempt: 1,
    ...overrides,
  };
}

function makePlanContext(overrides: Partial<SessionPlanContext> = {}): SessionPlanContext {
  return {
    task: DEFAULT_TASK,
    profiles: new Map<string, AgentProfile>([['test-profile', DEFAULT_PROFILE]]),
    sessionBaseDir: '/tmp/sessions',
    cwd: '/tmp/project',
    activeSessions: new Set(),
    phaseId: 'build-phase',
    agentId: 'test-agent',
    ...overrides,
  };
}

// ─── Canned result for the mock ────────────────────────────────────────────

const CANNED_RESULT: SessionResult = { mode: 'text', text: 'session output' };

// ─── Cleanup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRunSession.mockReset();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('runScheduledSession', () => {
  // ── 1. Calls runSession exactly once ───────────────────────────────────
  //
  // The helper is a thin wrapper — it must call runSession exactly once and
  // return its result.

  it('1. calls runSession exactly once and returns its result', async () => {
    mockRunSession.mockResolvedValue(CANNED_RESULT);

    const spec = makeSpec();
    const ctx = makePlanContext();

    const result = await runScheduledSession(spec, ctx);

    expect(result).toBe(CANNED_RESULT);
    expect(mockRunSession).toHaveBeenCalledTimes(1);
  });

  // ── 2. Builds correct RunSessionContext from SessionPlanContext ─────────
  //
  // Verify that every field from SessionPlanContext is forwarded correctly
  // into RunSessionContext. Required fields must be present; optional fields
  // must be omitted when undefined.

  it('2. forwards required fields from SessionPlanContext to RunSessionContext', async () => {
    mockRunSession.mockResolvedValue(CANNED_RESULT);

    const spec = makeSpec();
    const ctx = makePlanContext();

    await runScheduledSession(spec, ctx);

    const callArgs = mockRunSession.mock.calls[0][0] as Record<string, unknown>;

    // Required fields from spec
    expect(callArgs.spec).toBe(spec);
    // Required fields from context
    expect(callArgs.sessionBaseDir).toBe('/tmp/sessions');
    expect(callArgs.cwd).toBe('/tmp/project');
    expect(callArgs.phaseId).toBe('build-phase');
    expect(callArgs.agentId).toBe('test-agent');
    expect(callArgs.taskId).toBe('task-42');
    expect(callArgs.activeSessions).toBe(ctx.activeSessions);
    expect(callArgs.profiles).toBe(ctx.profiles);
  });

  // ── 3. Optional fields omitted when undefined ──────────────────────────
  //
  // worktreeCwd, apiKeys, onStatus, and signal must not be present in
  // RunSessionContext when they are undefined in SessionPlanContext.
  // watchdogTimeoutMs is the EXCEPTION: it ALWAYS carries a value — the
  // explicit stepTimeoutMs when provided, otherwise DEFAULT_WATCHDOG_TIMEOUT_MS
  // — so a session is never left without inactivity-freeze protection.

  it('3. omits optional fields when undefined in SessionPlanContext', async () => {
    mockRunSession.mockResolvedValue(CANNED_RESULT);

    const spec = makeSpec();
    const ctx = makePlanContext({
      // Explicitly set all optional fields to undefined
      worktreeCwd: undefined,
      apiKeys: undefined,
      onStatus: undefined,
      signal: undefined,
      stepTimeoutMs: undefined,
    });

    await runScheduledSession(spec, ctx);

    const callArgs = mockRunSession.mock.calls[0][0] as Record<string, unknown>;

    // These optional fields should NOT appear in RunSessionContext
    expect(callArgs).not.toHaveProperty('worktreeCwd');
    expect(callArgs).not.toHaveProperty('apiKeys');
    expect(callArgs).not.toHaveProperty('onStatus');
    expect(callArgs).not.toHaveProperty('signal');
    // watchdogTimeoutMs defaults to the inactivity-watchdog default so sessions
    // are never without freeze protection.
    expect(callArgs.watchdogTimeoutMs).toBe(DEFAULT_WATCHDOG_TIMEOUT_MS);
  });

  // ── 4. Optional fields present when defined ────────────────────────────
  //
  // When SessionPlanContext has optional fields set, they must appear in
  // RunSessionContext.

  it('4. forwards optional fields when defined in SessionPlanContext', async () => {
    mockRunSession.mockResolvedValue(CANNED_RESULT);

    const onStatusMock = {} as StatusCallbacks;
    const abortController = new AbortController();

    const spec = makeSpec();
    const ctx = makePlanContext({
      worktreeCwd: '/tmp/worktree',
      apiKeys: { anthropic: 'sk-xxx' },
      onStatus: onStatusMock,
      signal: abortController.signal,
      stepTimeoutMs: 30_000,
    });

    await runScheduledSession(spec, ctx);

    const callArgs = mockRunSession.mock.calls[0][0] as Record<string, unknown>;

    expect(callArgs.worktreeCwd).toBe('/tmp/worktree');
    expect(callArgs.apiKeys).toEqual({ anthropic: 'sk-xxx' });
    expect(callArgs.onStatus).toBe(onStatusMock);
    expect(callArgs.signal).toBe(abortController.signal);
    // stepTimeoutMs maps to watchdogTimeoutMs in RunSessionContext
    expect(callArgs.watchdogTimeoutMs).toBe(30_000);
  });

  // ── 5. Does not interact with any gate ─────────────────────────────────
  //
  // The helper must not reference a gate. The SessionPlanContext has no gate
  // property — verify that the helper never calls any gate method.

  it('5. does not interact with any gate (no gate property in context)', async () => {
    mockRunSession.mockResolvedValue(CANNED_RESULT);

    const spec = makeSpec();
    const ctx = makePlanContext();

    // Verify that SessionPlanContext does not have a gate property
    expect(ctx).not.toHaveProperty('gate');

    await runScheduledSession(spec, ctx);

    // runSession was called — the helper delegated correctly without gate.
    expect(mockRunSession).toHaveBeenCalledTimes(1);
  });

  // ── 6. Propagates errors from runSession ───────────────────────────────
  //
  // Errors thrown by runSession must propagate unchanged (not caught or
  // wrapped). Test with both a plain Error and a SessionError.

  it('6. propagates a plain Error from runSession unchanged', async () => {
    const originalError = new Error('something went wrong');
    mockRunSession.mockRejectedValue(originalError);

    const spec = makeSpec();
    const ctx = makePlanContext();

    await expect(runScheduledSession(spec, ctx)).rejects.toThrow(originalError);
  });

  it('6b. propagates a SessionError from runSession unchanged', async () => {
    // Import SessionError from session module for instanceof checks.
    // Our mock module above exports it too.
    const { SessionError } = await import('../pool/session.js');
    const sessionError = new SessionError('session failed', {
      kind: 'transient',
      retryable: true,
    });
    mockRunSession.mockRejectedValue(sessionError);

    const spec = makeSpec();
    const ctx = makePlanContext();

    await expect(runScheduledSession(spec, ctx)).rejects.toThrow(sessionError);
  });

  // ── 7. Propagates abort signal from ctx.signal ─────────────────────────
  //
  // When ctx.signal is already aborted, runScheduledSession forwards it to
  // runSession. The mock runSession can simulate abort behavior.

  it('7. forwards signal to runSession (pre-aborted signal propagates)', async () => {
    const controller = new AbortController();
    controller.abort();

    // Mock runSession to throw on aborted signal (simulating real behavior)
    const abortError = new DOMException('Aborted', 'AbortError');
    mockRunSession.mockImplementation(async (sctx: { signal?: AbortSignal }) => {
      if (sctx.signal?.aborted) throw abortError;
      return CANNED_RESULT;
    });

    const spec = makeSpec();
    const ctx = makePlanContext({ signal: controller.signal });

    await expect(runScheduledSession(spec, ctx)).rejects.toThrow(abortError);
    expect(mockRunSession).toHaveBeenCalledTimes(1);
  });

  // ── 8. Does not leak activeSessions across calls ───────────────────────
  //
  // The helper does not add/remove sessions to/from activeSessions — that's
  // handled by runSession. Verify that the set is passed as-is.

  it('8. passes activeSessions set through without modification', async () => {
    mockRunSession.mockResolvedValue(CANNED_RESULT);

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const spec = makeSpec();
    const ctx = makePlanContext({ activeSessions });

    await runScheduledSession(spec, ctx);

    const callArgs = mockRunSession.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.activeSessions).toBe(activeSessions);
    // The set should not have been modified by the helper itself
    expect(activeSessions.size).toBe(0);
  });

  // ── 9. spec is passed through as the same reference ────────────────────
  //
  // The helper must not clone or modify the spec — pass the original reference.

  it('9. passes spec through as the same reference', async () => {
    mockRunSession.mockResolvedValue(CANNED_RESULT);

    const spec = makeSpec();
    const ctx = makePlanContext();

    await runScheduledSession(spec, ctx);

    const callArgs = mockRunSession.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.spec).toBe(spec);
  });

  // ── 10. All outputModes are supported ──────────────────────────────────
  //
  // The helper doesn't interpret outputMode — it just passes spec through.

  it('10. supports all outputModes by passing them through to runSession', async () => {
    mockRunSession.mockResolvedValue(CANNED_RESULT);

    const modes: Array<SessionSpec['outputMode']> = ['text', 'structured', 'filesystem'];
    const ctx = makePlanContext();

    for (const outputMode of modes) {
      mockRunSession.mockReset();
      mockRunSession.mockResolvedValue(CANNED_RESULT);

      const spec = makeSpec({ outputMode });
      await runScheduledSession(spec, ctx);

      const callArgs = mockRunSession.mock.calls[0][0] as Record<string, unknown>;
      expect((callArgs.spec as SessionSpec).outputMode).toBe(outputMode);
    }
  });
});
