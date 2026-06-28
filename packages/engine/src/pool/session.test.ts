// ─── Tests for pool/session.ts — session primitive ─────────────────────────
//
// Mock strategy (Path B — plugin path, Decision 2):
//   - `agent-lifecycle.js` → mock `spawnAgent` as a spy. In Path B, runSession
//     should NOT call spawnAgent — it should call requireAgentPlugin().createSession()
//     directly. The spy exists so regression tests can assert it was never invoked.
//   - `agent-registry.js` → REAL registry (not mocked). A mock plugin is registered
//     via `registerAgentPlugin()` in `beforeEach`. Its `createSession` method is
//     a spy (`mockCreateSession`) that captures the options it receives.
//     **Isolation**: the mock plugin uses a unique id (`'test-mock-agent'`) that NO
//     real adapter ever registers under, so cross-file registry interference from
//     sibling test files (cursor/adapter.test.ts, agents/index.test.ts) is avoided.
//   - `structured-output.js` → intercept `promptForStructured`.
//   - `error-classifier.js` → NOT mocked (real `classify` via mock runtime metadata).
//
// Expected: most tests FAIL until the implement worker applies Path B fixes:
//   - Remove `spawnAgent` / `buildProfile` from session.ts
//   - Add `profiles` to `RunSessionContext`
//   - Call `requireAgentPlugin(profile.agent).createSession(...)` directly
//   - Fire only onSessionStart / onSessionComplete (not onSessionStart, etc.)
//   - Wire `onAgentStatus` via `forwardAgentStatus` for activity forwarding
//   - Handle unhandled rejections from raced prompt promises on watchdog abort
//
// Idempotency sentinel convention (documented for the implement worker):
//   Session directory: `{sessionBaseDir}/{spec.id}/`
//   Sentinel: `{sessionBaseDir}/{spec.id}/.complete` (empty file)
//   Result: `{sessionBaseDir}/{spec.id}/result.json` with shape:
//     { checksum: string, length: number, result: SessionResult }
//   - checksum: SHA-256 hex digest of JSON.stringify(result)
//   - length: byte length of JSON.stringify({ result })

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { z } from 'zod';

import type { AgentPlugin, AgentRuntimeEvent, AgentSessionOptions } from '../core/agent-plugin.js';
import type { AgentProfile, StatusCallbacks } from '../core/types.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realStructuredOutput = Object.assign({}, await import('../core/structured-output.js'));

// ─── Mock dependencies ────────────────────────────────────────────────────

// Mock `spawnAgent` — SHOULD NOT be called in Path B. Left as a spy so
// regression tests can assert it was never invoked.
const mockSpawnAgent = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../core/agent-lifecycle.js', () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
}));

// Mock plugin's createSession — registered in real agent-registry.
// Tests set up `mockCreateSession.mockResolvedValue(runtime)` per test.
const mockCreateSession = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

// Mock `promptForStructured` (for structured output mode)
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../core/structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
  extractJsonFromText: realStructuredOutput.extractJsonFromText,
  schemaToString: realStructuredOutput.schemaToString,
}));

// ─── Import real agent-registry (NOT mocked — use real registry) ──────────

import { clearAgentPluginRegistry, registerAgentPlugin } from '../core/agent-registry.js';

// ─── Import module under test (after mocks) ──────────────────────────────

import type { RunSessionContext, SessionResult, SessionSpec } from './session.js';
import { clearTaskSessions, runSession, SessionError } from './session.js';

// ─── Helper: SHA-256 checksum (hex) of JSON.stringify(result) ──────────────
//
// The idempotency sentinel `result.json` stores `checksum` as the SHA-256 hex
// digest of `JSON.stringify(result)`. The implement worker MUST use the same
// algorithm when writing and verifying the sentinel.

function computeChecksum(result: unknown): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

// ─── Helper: mock AgentRuntime ─────────────────────────────────────────────
//
// Creates a minimal mock runtime satisfying `AgentRuntime`. The `subscribe`
// method stores callbacks so `_emit` can fire events to them (for watchdog
// tests). The `promptFn` option controls prompt behavior (hang, resolve,
// reject). The `text` option controls `getLastAssistantText` return value.

interface MockRuntime {
  sessionId: string;
  sessionFile: string | undefined;
  contextWindow: number | undefined;
  prompt: ReturnType<typeof mock>;
  getLastAssistantText: ReturnType<typeof mock>;
  getLastAssistantMessage: ReturnType<typeof mock>;
  abort: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
  subscribe: ReturnType<typeof mock>;
  _subscribers: Array<(e: AgentRuntimeEvent) => void>;
  _emit: (event: AgentRuntimeEvent) => void;
}

function makeMockRuntime(
  opts: {
    promptFn?: (text: string) => Promise<void>;
    text?: string | undefined;
    message?: unknown;
    sessionId?: string;
    sessionFile?: string;
    contextWindow?: number;
  } = {},
): MockRuntime {
  const subscribers: Array<(e: AgentRuntimeEvent) => void> = [];
  return {
    sessionId: opts.sessionId ?? 'mock-session-id',
    sessionFile: opts.sessionFile ?? '/tmp/mock-session.jsonl',
    contextWindow: opts.contextWindow ?? 128_000,
    prompt: mock(opts.promptFn ?? (async () => {})),
    getLastAssistantText: mock(() => opts.text ?? 'mock response'),
    getLastAssistantMessage: mock(() => opts.message as undefined),
    abort: mock(async () => {}),
    dispose: mock(() => {}),
    subscribe: mock((cb: (e: AgentRuntimeEvent) => void) => {
      subscribers.push(cb);
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx !== -1) subscribers.splice(idx, 1);
      };
    }),
    _subscribers: subscribers,
    _emit: (event: AgentRuntimeEvent) => {
      for (const cb of [...subscribers]) cb(event);
    },
  };
}

// ─── Helper: make SessionSpec ──────────────────────────────────────────────

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

// ─── Real profile fixture ──────────────────────────────────────────────────
//
// A realistic AgentProfile with real provider/model/systemPrompt values.
// Used to verify that Path B passes the REAL profile to createSession,
// NOT the hardcoded 'unknown' defaults from buildProfile.

// NOTE: `agent` is set to a unique id ('test-mock-agent') that NO real adapter
// ever registers under. This avoids isolation leaks from other test files that
// register real adapters (e.g. 'pi-coding-agent', 'codex', 'cursor') into the
// shared global agent registry. The mock plugin is registered under this same
// id in `beforeEach`.
const REAL_PROFILE: AgentProfile = {
  id: 'test-profile',
  name: 'Test Profile',
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  agent: 'test-mock-agent',
  thinkingLevel: 'off',
  systemPrompt: 'You are a test agent that follows instructions precisely.',
  excludeTools: [],
  includeTools: [],
};

// ─── Extended context type (includes profiles for Path B) ──────────────────
//
// RunSessionContext does not yet have a `profiles` field — the implement
// worker will add it. This extended type lets tests compile while asserting
// on the profiles map that Path B should consume.

interface TestRunSessionContext extends RunSessionContext {
  profiles: Map<string, AgentProfile>;
}

// ─── Helper: make RunSessionContext ────────────────────────────────────────
//
// Creates a temporary `sessionBaseDir` for each call. Includes a `profiles`
// map with `REAL_PROFILE` — the implement worker's Path B should read the
// profile from this map instead of calling `buildProfile()`.

function makeCtx(overrides: Partial<TestRunSessionContext> = {}): TestRunSessionContext {
  const defaultProfiles = new Map<string, AgentProfile>([['test-profile', REAL_PROFILE]]);
  return {
    spec: makeSpec(),
    sessionBaseDir: mkdtempSync(join(tmpdir(), 'session-test-')),
    cwd: '/tmp/project',
    phaseId: 'test-phase',
    agentId: 'test-agent',
    activeSessions: new Set(),
    profiles: defaultProfiles,
    ...overrides,
  };
}

// ─── Default mock plugin (registered in real agent-registry) ───────────────
//
// Registered in `beforeEach` via `registerAgentPlugin()` so that
// `requireAgentPlugin()` (real) → returns this plugin → calls `createSession`
// (the spy). No module mock needed for agent-registry.

const defaultMockPlugin: AgentPlugin = {
  id: 'test-mock-agent',
  createSession: mockCreateSession,
};

// ─── Cleanup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSpawnAgent.mockReset();
  mockCreateSession.mockReset();
  mockPromptForStructured.mockReset();
  clearAgentPluginRegistry();
  registerAgentPlugin(defaultMockPlugin);
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('runSession', () => {
  // ── 1. Idempotency / replay ─────────────────────────────────────────────
  //
  // Pre-create the deterministic session dir with a valid `.complete`
  // sentinel + `result.json`. A second `runSession` call returns the cached
  // result and neither spawnAgent nor createSession is called.

  it('1. idempotency: returns cached result when .complete + valid result.json exist', async () => {
    const cachedResult: SessionResult = { mode: 'text', text: 'cached output' };
    const resultJson = JSON.stringify({ result: cachedResult });
    const checksum = computeChecksum(cachedResult);
    const length = Buffer.byteLength(resultJson);

    const ctx = makeCtx();
    const sessionDir = join(ctx.sessionBaseDir, ctx.spec.id);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'result.json'), JSON.stringify({ checksum, length, result: cachedResult }));
    writeFileSync(join(sessionDir, '.complete'), '');

    const result = await runSession(ctx);

    expect(result).toEqual(cachedResult);
    // Neither spawnAgent (path A) nor createSession (path B) should be called.
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  // ── 2. Torn-write safety ────────────────────────────────────────────────
  //
  // Pre-create dir with `result.json` but NO `.complete` sentinel →
  // runSession spawns a fresh session (createSession called), overwrites.

  it('2. torn-write safety: result.json without .complete triggers fresh session', async () => {
    const ctx = makeCtx();
    const sessionDir = join(ctx.sessionBaseDir, ctx.spec.id);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'result.json'), JSON.stringify({ stale: true }));

    const session = makeMockRuntime();
    mockCreateSession.mockResolvedValue(session);

    // runSession should spawn a new session (not return cached).
    await runSession(ctx).catch(() => {});

    // Under Path B: createSession is called (fresh session).
    // Under Path A: FAILS — spawnAgent is called instead.
    expect(mockCreateSession).toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  // ── 3. Corrupt result ───────────────────────────────────────────────────
  //
  // `.complete` present but `result.json` checksum is invalid →
  // runSession throws a SessionError with `transient === false` (permanent).

  it('3. corrupt result: .complete with bad checksum throws permanent SessionError', async () => {
    const ctx = makeCtx();
    const sessionDir = join(ctx.sessionBaseDir, ctx.spec.id);
    mkdirSync(sessionDir, { recursive: true });
    // Write result.json with a WRONG checksum (deliberately mismatched)
    writeFileSync(
      join(sessionDir, 'result.json'),
      JSON.stringify({
        checksum: '0000000000000000000000000000000000000000000000000000000000000000',
        length: 42,
        result: {},
      }),
    );
    writeFileSync(join(sessionDir, '.complete'), '');

    await expect(runSession(ctx)).rejects.toThrow(SessionError);
    try {
      await runSession(ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(SessionError);
      expect((err as SessionError).transient).toBe(false);
    }
  });

  // ── 4. Text mode ────────────────────────────────────────────────────────
  //
  // Mock AgentRuntime.prompt + getLastAssistantText → returns
  // `{ mode: 'text', text }`.

  it('4. text mode: returns { mode: "text", text } from agent response', async () => {
    const session = makeMockRuntime({
      text: 'Hello from the agent',
      promptFn: async () => {},
    });
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx({ spec: makeSpec({ outputMode: 'text' }) });
    const result = await runSession(ctx);

    expect(result).toEqual({ mode: 'text', text: 'Hello from the agent' });
  });

  // ── 5. Structured mode ──────────────────────────────────────────────────
  //
  // Mock promptForStructured → returns `{ mode: 'structured', data }`.
  // Verify runSession does NOT decide approve/reject (approval is in data).

  it('5. structured mode: returns { mode: "structured", data } without approval logic', async () => {
    const structuredData = { approved: true, feedback: 'Looks good' };

    const session = makeMockRuntime();
    mockCreateSession.mockResolvedValue(session);
    mockPromptForStructured.mockResolvedValue({ result: structuredData, attempts: 1 });

    const schema = z.object({ approved: z.boolean(), feedback: z.string() }) as unknown as ZodType;
    const ctx = makeCtx({
      spec: makeSpec({ outputMode: 'structured', schema }),
    });
    const result = await runSession(ctx);

    expect(result).toEqual({ mode: 'structured', data: structuredData });
    // promptForStructured was called (structured path taken)
    expect(mockPromptForStructured).toHaveBeenCalled();
  });

  // ── 6. Filesystem mode ──────────────────────────────────────────────────
  //
  // Mock prompt → agent writes files → returns `{ mode: 'filesystem', files }`.

  it('6. filesystem mode: returns { mode: "filesystem", files } with written file paths', async () => {
    // Simulate the agent writing files during the prompt.
    const writeDir = mkdtempSync(join(tmpdir(), 'fs-mode-'));
    const writtenFile = join(writeDir, 'output.txt');

    const session = makeMockRuntime({
      promptFn: async () => {
        writeFileSync(writtenFile, 'generated content');
      },
    });
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx({ spec: makeSpec({ outputMode: 'filesystem' }) });
    const result = await runSession(ctx);

    expect(result.mode).toBe('filesystem');
    expect(result).toHaveProperty('files');
    expect(Array.isArray((result as { mode: string; files: string[] }).files)).toBe(true);
  });

  // ── 7. Watchdog timeout ─────────────────────────────────────────────────
  //
  // Use a small watchdogTimeoutMs (20ms), mock NO activity events →
  // runSession calls session.abort() and throws a SessionError with
  // `transient === true`.

  it('7. watchdog timeout: aborts session and throws transient SessionError', async () => {
    const session = makeMockRuntime({
      // Prompt hangs forever — never resolves.
      promptFn: () => new Promise<void>(() => {}),
    });
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx({ watchdogTimeoutMs: 20 });

    let caughtErr: unknown;
    try {
      await runSession(ctx);
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(SessionError);
    expect((caughtErr as SessionError).transient).toBe(true);
    // The watchdog should have aborted the session.
    expect(session.abort).toHaveBeenCalled();
  });

  // ── 8. Watchdog escalation ──────────────────────────────────────────────
  //
  // After watchdogMaxResumes (e.g. 2) consecutive stalling resumes of the
  // same session id → throws SessionError with `transient === false`.
  //
  // Design: each `createSession` call returns a hanging session. After the
  // initial attempt + `watchdogMaxResumes` resumes (all stalling), the error
  // becomes permanent. The implement worker tracks resume count per
  // `spec.id` (persisted in session dir or in-memory).
  //
  // Observable: `mockCreateSession` is called `1 + watchdogMaxResumes` times,
  // and the final error is `SessionError` with `transient: false`.

  it('8. watchdog escalation: after maxResumes, error becomes permanent', async () => {
    // Every session created hangs forever.
    mockCreateSession.mockImplementation(async () =>
      makeMockRuntime({
        promptFn: () => new Promise<void>(() => {}),
      }),
    );

    const ctx = makeCtx({
      watchdogTimeoutMs: 20,
      watchdogMaxResumes: 2,
    });

    let caughtErr: unknown;
    try {
      await runSession(ctx);
    } catch (err) {
      caughtErr = err;
    }

    // After 2 resumes, the error is permanent.
    expect(caughtErr).toBeInstanceOf(SessionError);
    expect((caughtErr as SessionError).transient).toBe(false);
    // Initial + 2 resumes = 3 total createSession calls.
    expect(mockCreateSession).toHaveBeenCalledTimes(3);
  });

  // ── 9. TOCTOU: already-aborted signal ───────────────────────────────────
  //
  // An already-aborted signal at call time → runSession does not spawn (or
  // aborts immediately) and throws; verify activeSessions is not leaked.

  it('9. TOCTOU: pre-aborted signal throws and does not leak activeSessions', async () => {
    const controller = new AbortController();
    controller.abort(); // Already aborted

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const ctx = makeCtx({ signal: controller.signal, activeSessions });

    let caughtError: unknown;
    try {
      await runSession(ctx);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    // The error should be abort-related (AbortError or SessionError), NOT
    // the stub's "not implemented". The implement worker must check
    // signal.aborted BEFORE the main logic path so that a pre-aborted
    // signal produces a meaningful abort error, not a generic one.
    expect((caughtError as Error).message).not.toBe('not implemented');
    // No session should have been spawned.
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    // No session should have been added to the set.
    expect(activeSessions.size).toBe(0);
  });

  // ── 10. Fail-fast: empty output / error stopReason ──────────────────────
  //
  // Mock getLastAssistantText→undefined / empty and stopReason='error' (or
  // classifier kind 'empty') → throws SessionError.

  it('10. fail-fast: empty/error output throws SessionError', async () => {
    const session = makeMockRuntime({
      text: undefined, // No text content
      message: {
        stopReason: 'error',
        errorMessage: 'provider returned error',
        content: [],
      },
    });
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx();

    let caughtErr: unknown;
    try {
      await runSession(ctx);
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(SessionError);
    // The error message should reference the agent's empty/error output,
    // NOT a spawnAgent failure.
    expect((caughtErr as Error).message).toMatch(/no usable output/);
  });

  // ── 11. clearTaskSessions ───────────────────────────────────────────────
  //
  // Create some session dirs under a tmp sessionBaseDir, call
  // clearTaskSessions(baseDir, taskId), assert the taskId subtree is gone.

  it('11. clearTaskSessions: removes the task session directory', () => {
    const sessionBaseDir = mkdtempSync(join(tmpdir(), 'clear-sessions-'));
    const taskId = 'task-to-clear';

    // Create a session directory with some files.
    const sessionDir = join(sessionBaseDir, taskId, '1-0-review');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.jsonl'), '{}');
    writeFileSync(join(sessionDir, '.complete'), '');

    expect(existsSync(sessionDir)).toBe(true);

    clearTaskSessions(sessionBaseDir, taskId);

    // The entire task subtree should be gone.
    expect(existsSync(join(sessionBaseDir, taskId))).toBe(false);
  });

  // ── 12. onSessionStart / onSessionComplete callbacks ────────────────────
  //
  // Via a spy onStatus, verify that onSessionStart and onSessionComplete are
  // emitted with runnerRole / attempt / sessionId / sessionPath.

  it('12. lifecycle callbacks: onSessionStart + onSessionComplete emitted with correct args', async () => {
    const session = makeMockRuntime({
      sessionId: 'lifecycle-session-42',
      sessionFile: '/tmp/lifecycle-session-42.jsonl',
    });
    mockCreateSession.mockResolvedValue(session);

    const onSessionStart = mock(() => {});
    const onSessionComplete = mock(() => {});
    const onStatus = {
      onSessionStart,
      onSessionComplete,
    } as unknown as StatusCallbacks;

    const ctx = makeCtx({
      onStatus,
      spec: makeSpec({ runnerRole: 'reviewer', attempt: 3 }),
    });
    await runSession(ctx);

    // onSessionStart fires before the prompt.
    expect(onSessionStart).toHaveBeenCalledTimes(1);
    expect(onSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerRole: 'reviewer',
        attempt: 3,
        sessionId: 'lifecycle-session-42',
        agentId: 'test-agent',
      }),
    );

    // onSessionComplete fires after the prompt resolves.
    expect(onSessionComplete).toHaveBeenCalledTimes(1);
    expect(onSessionComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerRole: 'reviewer',
        attempt: 3,
        sessionId: 'lifecycle-session-42',
        agentId: 'test-agent',
      }),
    );
  });

  // ── 13. Activity forwarding resets watchdog ──────────────────────────────
  //
  // Simulate forwarding a turn_start event mid-session and assert the
  // watchdog timer resets (timeout does NOT fire while activity is ongoing
  // within the window).
  //
  // Strategy: set watchdogTimeoutMs to 30ms, prompt takes 80ms. Fire
  // turn_start events every 10ms via setInterval. Without activity, the
  // watchdog fires at 30ms and aborts. With activity, the timer keeps
  // resetting, the prompt resolves at 80ms, and the session succeeds.

  it('13. activity resets watchdog: periodic turn_start events prevent timeout', async () => {
    const session = makeMockRuntime({
      // Prompt takes 80ms — longer than the 30ms watchdog window.
      promptFn: async () => {
        await new Promise((r) => setTimeout(r, 80));
      },
    });
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx({ watchdogTimeoutMs: 30 });

    // Fire turn_start events every 10ms to simulate activity.
    // Events that fire before subscribe() is called are harmless (no
    // subscriber yet). Once runSession subscribes, subsequent events
    // reset the watchdog timer.
    const activityInterval: ReturnType<typeof setInterval> = setInterval(() => {
      session._emit({ type: 'turn_start' });
    }, 10);

    try {
      const result = await runSession(ctx);
      // With activity resetting the watchdog, the prompt resolves at 80ms.
      expect(result.mode).toBe('text');
      // The session was NOT aborted (watchdog didn't fire).
      expect(session.abort).not.toHaveBeenCalled();
    } finally {
      clearInterval(activityInterval);
    }
  });

  // ── REGRESSION: createSession receives real profile from ctx.profiles ───
  //
  // The implement worker must read the profile from ctx.profiles and pass
  // it to createSession — NOT use buildProfile() which hardcodes 'unknown'.

  it('REGRESSION: createSession receives real profile from ctx.profiles, not buildProfile defaults', async () => {
    const session = makeMockRuntime();
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx();
    await runSession(ctx).catch(() => {});

    // Under Path B: createSession called with the REAL profile.
    // Under Path A: FAILS — spawnAgent is called instead (createSession never invoked).
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    const opts = mockCreateSession.mock.calls[0][0] as AgentSessionOptions;
    // These values MUST match REAL_PROFILE — NOT the 'unknown' defaults from buildProfile.
    expect(opts.profile.provider).toBe('anthropic');
    expect(opts.profile.model).toBe('claude-sonnet-4-20250514');
    expect(opts.profile.systemPrompt).toBe('You are a test agent that follows instructions precisely.');
  });

  // ── REGRESSION: spawnAgent must NOT be called ───────────────────────────
  //
  // runSession should use the plugin path (requireAgentPlugin().createSession)
  // directly, NOT delegate to spawnAgent.

  it('REGRESSION: runSession does NOT call spawnAgent — uses plugin path directly', async () => {
    const session = makeMockRuntime();
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx();
    await runSession(ctx).catch(() => {});

    // Under Path B: spawnAgent is NOT called.
    // Under Path A: FAILS — spawnAgent IS called.
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  // ── REGRESSION: only session lifecycle events fire ──────────────────────
  //
  // runSession fires onSessionStart and onSessionComplete. Those are the
  // ONLY session lifecycle callbacks — the old onSessionStart / onSessionComplete
  // / onStepStart callbacks were removed in the C2 cutover.

  it('REGRESSION: runSession fires ONLY onSessionStart/onSessionComplete', async () => {
    const session = makeMockRuntime({ sessionId: 'regression-789' });
    mockCreateSession.mockResolvedValue(session);

    const onSessionStart = mock(() => {});
    const onSessionComplete = mock(() => {});
    const onStatus = {
      onSessionStart,
      onSessionComplete,
    } as unknown as StatusCallbacks;

    const ctx = makeCtx({ onStatus });
    await runSession(ctx);

    // Session lifecycle events: MUST be called exactly once.
    expect(onSessionStart).toHaveBeenCalledTimes(1);
    expect(onSessionComplete).toHaveBeenCalledTimes(1);
  });

  // ── REGRESSION: createSession receives onAgentStatus ────────────────────
  //
  // The createSession options must include `onAgentStatus` (wired via
  // forwardAgentStatus) so that activity events (turn_start, tool_execution_start,
  // etc.) are forwarded to ctx.onStatus for watchdog reset and UI updates.

  it('REGRESSION: createSession options include onAgentStatus for activity forwarding', async () => {
    const session = makeMockRuntime();
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx();
    await runSession(ctx).catch(() => {});

    // Under Path B: createSession receives onAgentStatus.
    // Under Path A: FAILS — createSession is never called.
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    const opts = mockCreateSession.mock.calls[0][0] as AgentSessionOptions;
    expect(opts.onAgentStatus).toBeDefined();
  });

  // ── REGRESSION: watchdog abort does not leak unhandled rejections ───────
  //
  // When the watchdog fires and aborts the session, the raced prompt promise
  // may reject later (abort-triggered). That rejection must NOT propagate as
  // an unhandled rejection — the production code must attach a no-op handler.

  it('REGRESSION: watchdog abort does not leak unhandled rejections from raced prompt', async () => {
    let promptReject: ((err: Error) => void) | undefined;
    const session = makeMockRuntime({
      promptFn: () =>
        new Promise<void>((_, reject) => {
          promptReject = reject;
        }),
    });
    // Override abort to trigger the prompt rejection (simulating real abort behavior)
    session.abort = mock(async () => {
      promptReject?.(new DOMException('Aborted', 'AbortError'));
    });
    mockCreateSession.mockResolvedValue(session);

    const unhandledRejections: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', handler);

    try {
      await expect(runSession(makeCtx({ watchdogTimeoutMs: 20 }))).rejects.toThrow(SessionError);
      // Give time for any delayed rejections to propagate
      await new Promise((r) => setTimeout(r, 100));

      // The mock runtime's prompt MUST have been called — this ensures we actually
      // exercised the watchdog + prompt race path (not a trivial early exit from
      // spawnAgent failing). Under Path A: FAILS — spawnAgent fails before the
      // prompt is ever called.
      expect(session.prompt).toHaveBeenCalled();

      // No unhandled rejections should have occurred.
      // Under Path B: the production code attaches .catch(() => {}) on the raced prompt.
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  // ── REGRESSION: path traversal via spec.id is rejected ─────────────────

  it('REGRESSION: path traversal via spec.id throws and does not touch filesystem', async () => {
    const ctx = makeCtx({
      spec: makeSpec({ id: '../etc/passwd' }),
    });

    await expect(runSession(ctx)).rejects.toThrow();
    // No session should have been created (no filesystem writes).
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('REGRESSION: nested path traversal via spec.id is rejected', async () => {
    const ctx = makeCtx({
      spec: makeSpec({ id: 'safe/../../etc/passwd' }),
    });

    await expect(runSession(ctx)).rejects.toThrow();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('REGRESSION: current dir segment via spec.id is rejected', async () => {
    const ctx = makeCtx({
      spec: makeSpec({ id: './safe/../config' }),
    });

    await expect(runSession(ctx)).rejects.toThrow();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('REGRESSION: valid runner-pathed id with allowed chars is accepted', async () => {
    const session = makeMockRuntime();
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx({
      spec: makeSpec({
        id: 'phase-A/task-1.0/step#review[1]',
        outputMode: 'text',
      }),
    });
    await runSession(ctx).catch(() => {});

    // createSession should have been called (id is valid).
    expect(mockCreateSession).toHaveBeenCalled();
  });

  // ── Write sandbox: allowedWriteDirs wired into createSession ───────────
  //
  // runSession must confine writes to the session cwd by default so a task
  // can never leak edits into the main working directory. The workflow may
  // override the full set via spec.allowedWriteDirs; read-only sessions skip
  // the sandbox (their write tools are already stripped).

  it('write sandbox: defaults to cwd when spec.allowedWriteDirs is omitted', async () => {
    const session = makeMockRuntime();
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx({ cwd: '/tmp/project' });
    await runSession(ctx).catch(() => {});

    const opts = mockCreateSession.mock.calls[0][0] as AgentSessionOptions;
    expect(opts.allowedWriteDirs).toEqual(['/tmp/project']);
  });

  it('write sandbox: prefers worktreeCwd over cwd for the default', async () => {
    const session = makeMockRuntime();
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx({ cwd: '/tmp/project', worktreeCwd: '/tmp/worktree-A' });
    await runSession(ctx).catch(() => {});

    const opts = mockCreateSession.mock.calls[0][0] as AgentSessionOptions;
    expect(opts.allowedWriteDirs).toEqual(['/tmp/worktree-A']);
  });

  it('write sandbox: spec.allowedWriteDirs replaces the default', async () => {
    const session = makeMockRuntime();
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx({
      cwd: '/tmp/project',
      worktreeCwd: '/tmp/worktree-A',
      spec: makeSpec({ allowedWriteDirs: ['/tmp/project', '/tmp/artifacts'] }),
    });
    await runSession(ctx).catch(() => {});

    const opts = mockCreateSession.mock.calls[0][0] as AgentSessionOptions;
    // The workflow-owned list REPLACES the default — cwd/worktreeCwd are not
    // implicitly merged in.
    expect(opts.allowedWriteDirs).toEqual(['/tmp/project', '/tmp/artifacts']);
  });

  it('write sandbox: omitted for read-only sessions', async () => {
    const session = makeMockRuntime();
    mockCreateSession.mockResolvedValue(session);

    const ctx = makeCtx({
      cwd: '/tmp/project',
      spec: makeSpec({ isReadOnly: true, allowedWriteDirs: ['/tmp/should-be-ignored'] }),
    });
    await runSession(ctx).catch(() => {});

    const opts = mockCreateSession.mock.calls[0][0] as AgentSessionOptions;
    expect(opts).not.toHaveProperty('allowedWriteDirs');
  });
});
