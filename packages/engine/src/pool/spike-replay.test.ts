// ─── Integration Spike: Replay Correctness (SessionPlan contract) ────────
//
// Prove that the session-primitive idempotency layer (`.complete` sentinel +
// `result.json`) correctly returns cached results on re-run — producing ZERO
// redundant model (createSession) calls for already-persisted sessions.
//
// Two cases (driven through the SessionScheduler so the FULL new contract —
// TaskGraph + SessionGate + runner.execute → runScheduledSession → runSession —
// exercises the real cache path):
//
//   1. linearRunner of two singleSession children.
//      Phase A: run only child0 (persists its result).
//      Phase B: re-run the full linearRunner → child0 is cached (0
//      createSession calls), child1 runs fresh (1 createSession call).
//
//   2. coordinatorRunner:
//      Phase A: run only the coordinator session (persists its decision).
//      Phase B: run the full coordinatorRunner → coordinator is replayed from
//      cache (0 model calls), the two workers run fresh (2 createSession calls).
//
// Strategy: use the REAL runScheduledSession (NOT mocked) so the idempotency
// check runs on real disk state via runSession. Register a mock agent plugin
// whose createSession is a spy so we count model calls. The mock plugin's
// createSession returns a mock AgentRuntime that simulates a minimal session.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentPlugin, AgentRuntime, AgentRuntimeEvent, AgentSessionOptions } from '../core/agent-plugin.js';
import { clearAgentPluginRegistry, getAgentPlugin, registerAgentPlugin } from '../core/agent-registry.js';
import type { AgentProfile, Task } from '../core/types.js';

import { coordinatorRunner } from './runners/coordinator-runner.js';
import { linearRunner } from './runners/linear-runner.js';
import { parallelRunner } from './runners/parallel-runner.js';
import type { SessionPlanContext, SessionPlanRunner } from './runners/session-plan-types.js';
import { singleSession } from './runners/single-session.js';
import { SessionGate } from './session-gate.js';
import { SessionScheduler } from './session-scheduler.js';
import { TaskGraph } from './task-graph.js';

// ─── Direct runSession import (bypass mock.module) ──────────────────────────
//
// We import `runSession` via a FRESH dynamic import (with a query-string suffix)
// at call time rather than a static top-level import. This is critical: sibling
// test files (notably `run-scheduled-session.test.ts`) register a process-global
// `mock.module('./session.js', …)` that replaces `runSession` with a mock spy
// for their own tests. When bun reuses the worker process, that mock poisons the
// module cache so a static `import { runSession }` would receive the mock
// instead of the real implementation — causing `createSession` to never be
// called and the cache-path assertions to fail.
//
// A dynamic `import('./session.js?spike-replay')` bypasses `mock.module`
// (bun keys mock interception on the bare module specifier, not the query) so
// we always get the REAL `runSession` that exercises disk persistence + the
// idempotency check.
//
// Type-only imports (`RunSessionContext`, `SessionResult`, `SessionSpec`) are
// erased at compile time and are safe to keep static.

import type { RunSessionContext, SessionResult, SessionSpec } from './session.js';

/**
 * Resolve the REAL `runSession`, bypassing any process-global `mock.module`
 * registered by sibling test files.
 *
 * Uses a dynamic import with a unique query-string suffix so bun's mock
 * interception (keyed on the bare specifier) does not apply.
 *
 * The module path is built at runtime from a variable so tsc cannot statically
 * resolve it (and thus cannot complain about the query-string specifier).
 */
async function realRunSession(): Promise<(ctx: RunSessionContext) => Promise<SessionResult>> {
  // Build the specifier at runtime — tsc sees `string`, not a literal path.
  const specifier = './session.js?spike-replay=1';
  const mod: { runSession: (ctx: RunSessionContext) => Promise<SessionResult> } = await import(
    /* @vite-ignore */ specifier
  );
  return mod.runSession;
}

// NOTE: deliberately NOT importing test-fixtures.ts here — that module mocks
// runScheduledSession via mock.module, which would short-circuit the real
// cache path this spike exercises. We want the REAL runScheduledSession →
// runSession → disk persistence + idempotency check.

// ─── Mock AgentRuntime ─────────────────────────────────────────────────────

/**
 * Create a minimal mock AgentRuntime that satisfies the real runSession.
 *
 * - `prompt()` resolves immediately.
 * - `getLastAssistantText()` returns `textOverride` (defaults to "mock reply").
 * - `getLastAssistantMessage()` returns a safe message with stopReason
 *   'end_turn' so the classifier does NOT flag it as 'empty' or 'error'.
 * - `subscribe()` / `_emit()` fire events to subscribers (watchdog reset).
 */
function makeMockRuntime(
  opts: {
    textOverride?: string;
    sessionId?: string;
  } = {},
): MockRuntime {
  const subscribers: Array<(e: AgentRuntimeEvent) => void> = [];

  let lastText: string | undefined;
  let lastMessage: Record<string, unknown> | undefined;

  const runtime: MockRuntime = {
    sessionId: opts.sessionId ?? 'mock-session-id',
    sessionFile: undefined,
    contextWindow: 128_000,
    prompt: mock(async (_text: string) => {
      // Simulate a turn: store the assistant response.
      lastText = opts.textOverride ?? 'mock reply';
      lastMessage = {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: lastText }],
      };
      // Emit turn_start → turn_end to exercise watchdog resets.
      for (const cb of [...subscribers]) cb({ type: 'turn_start' });
      for (const cb of [...subscribers])
        cb({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: lastText }],
            usage: { input: 10, output: 20 },
          },
        });
    }),
    getLastAssistantText: mock(() => lastText),
    getLastAssistantMessage: mock(() => lastMessage as ReturnType<AgentRuntime['getLastAssistantMessage']>),
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

  return runtime;
}

/** Extend AgentRuntime with test utilities. */
interface MockRuntime extends AgentRuntime {
  _subscribers: Array<(e: AgentRuntimeEvent) => void>;
  _emit: (event: AgentRuntimeEvent) => void;
  prompt: ReturnType<typeof mock>;
  getLastAssistantText: ReturnType<typeof mock>;
  getLastAssistantMessage: ReturnType<typeof mock>;
  abort: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
  subscribe: ReturnType<typeof mock>;
}

// ─── Mock plugin (registered in the real agent-registry) ───────────────────

const mockCreateSession = mock(async (_opts: AgentSessionOptions): Promise<AgentRuntime> => {
  // Return the currently-configured mock runtime.
  return currentMockRuntime;
});

/** The mock runtime instance returned by the latest createSession call. */
let currentMockRuntime: MockRuntime = makeMockRuntime();

/** Plugin instance registered in the global agent registry. */
const replayPlugin: AgentPlugin = {
  id: 'test-replay-plugin',
  createSession: mockCreateSession,
};

// ─── Fixture helpers ───────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'replay-task',
    title: 'Replay test task',
    prompt: 'Do the work',
    profile: 'executor',
    files: [],
    dependencies: [],
    status: 'ready',
    phaseId: 'test',
    worktree: 'none',
    ...overrides,
  };
}

function makeProfile(id: string, overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id,
    name: id,
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    agent: 'test-replay-plugin',
    thinkingLevel: 'off',
    systemPrompt: `You are ${id}.`,
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}

/** Build the shared profile map (executor + coordinator + worker). */
function makeProfiles(): Map<string, AgentProfile> {
  const profiles = new Map<string, AgentProfile>();
  profiles.set('executor', makeProfile('executor'));
  profiles.set('worker', makeProfile('worker'));
  profiles.set('coordinator', makeProfile('coordinator'));
  return profiles;
}

/**
 * Build a SessionScheduler for a single task with the given runnerFactory.
 * Uses a real SessionGate (total=5 — capacity is not the focus of this spike)
 * and the REAL runScheduledSession → runSession path (no mock).
 */
function buildScheduler(sessionBaseDir: string, task: Task, runnerFactory: () => SessionPlanRunner): SessionScheduler {
  const graph = new TaskGraph();
  graph.addTask(task, runnerFactory);
  const gate = new SessionGate({ total: 5, perModel: {} });
  return new SessionScheduler({
    graph,
    gate,
    profiles: makeProfiles(),
    sessionBaseDir,
    cwd: '/tmp/project',
    activeSessions: new Set(),
    phaseId: 'test',
  });
}

/** Race a promise against a safety timeout — proves a run did not hang. */
function withTimeout<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT: hung after ${ms}ms`)), ms)),
  ]);
}

// ─── Phase-A helpers: persist a session via direct runSession call ─────────
//
// The runner test files (`runners/*.test.ts`) register process-global
// `mock.module` calls (e.g. for `../run-scheduled-session.js` and
// `./agent-registry.js`) that can interfere with the scheduler's execute
// path when bun reuses worker processes. To avoid this, Phase A (cache
// setup) calls `runSession` DIRECTLY instead of going through the
// runner/scheduler machinery.
//
// Phase B still uses the full scheduler + runner tree to exercise the
// idempotency replay path — but the top-level runner's `execute` is
// replaced with `bypassExecute` which also calls `runSession` directly.

/**
 * Convert a partial session-spec to a `RunSessionContext` and call
 * `runSession` directly.
 *
 * @param sessionBaseDir  Base directory for session persistence.
 * @param id              Session id (e.g. `replay-task/child0#1`).
 * @param profile         Profile id (e.g. `'executor'`).
 * @param prompt          Session prompt text.
 * @param profiles        Full profiles map.
 * @param activeSessions  Mutable active-session set.
 */
async function runSessionDirect(
  sessionBaseDir: string,
  id: string,
  profile: string,
  prompt: string,
  profiles: Map<string, AgentProfile>,
  activeSessions = new Set<{ abort(): Promise<void> }>(),
): Promise<SessionResult> {
  const spec: SessionSpec = {
    id,
    profile,
    prompt,
    outputMode: 'text',
    runnerRole: profile,
    attempt: 1,
  };
  const ctx: RunSessionContext = {
    spec,
    sessionBaseDir,
    cwd: '/tmp/project',
    phaseId: 'test',
    agentId: 'setup',
    taskId: id.split('/')[0]!,
    activeSessions,
    profiles,
  };
  const runSession = await realRunSession();
  return runSession(ctx);
}

/**
 * Variant of `runScheduledSession` (from `run-scheduled-session.ts`) that
 * calls `runSession` directly, bypassing any process-global mock.module on
 * `run-scheduled-session.js` or `agent-registry.js`.
 *
 * Used by Phase B's `withReplayExecute` wrapper so the scheduler can go
 * through the real idempotency cache path.
 */
async function bypassExecute(ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> {
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
    ...(ctx.stepTimeoutMs !== undefined ? { watchdogTimeoutMs: ctx.stepTimeoutMs } : {}),
  };
  const runSession = await realRunSession();
  return runSession(sessionCtx);
}

/**
 * Wrap a SessionPlanRunner, replacing its `execute` with {@link bypassExecute}.
 *
 * The SessionScheduler only ever invokes the TOP-LEVEL runner's `execute`.
 * Child runners are driven solely through their `plan()` generators, which
 * the parent forwards. So wrapping only the top-level runner is sufficient
 * to intercept every session the scheduler starts.
 */
function withReplayExecute(runner: SessionPlanRunner): SessionPlanRunner {
  return { ...runner, execute: bypassExecute };
}

// ─── Debug: verify plugin registration integrity ────────────────────────────

// ─── Lifecycle ─────────────────────────────────────────────────────────────
//
// `beforeEach` (not `beforeAll`) ensures the mock plugin is re-registered
// before every test, surviving cross-file `clearAgentPluginRegistry()` calls
// from sibling test files. The plugin id 'test-replay-plugin' is unique — no
// real adapter ever registers under this id.

beforeEach(() => {
  clearAgentPluginRegistry();
  registerAgentPlugin(replayPlugin);
  // mockCreateSession is module-level — reset its call history so each test
  // starts from zero (earlier tests' calls would otherwise leak in).
  mockCreateSession.mockClear();
});

afterEach(() => {
  clearAgentPluginRegistry();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('spike-replay', () => {
  // ── 1. linearRunner replay ──────────────────────────────────────────────

  it('1. linearRunner replay: cached child0 gets zero model calls, child1 runs fresh', async () => {
    const sessionBaseDir = mkdtempSync(join(tmpdir(), 'replay-linear-'));

    try {
      // ── Phase A: Run child0 only (single session), persist its result ──
      currentMockRuntime = makeMockRuntime({ textOverride: 'child0-output' });

      const taskA = makeTask();
      const schedulerA = buildScheduler(sessionBaseDir, taskA, () =>
        withReplayExecute(
          singleSession({
            profile: 'executor',
            prompt: 'Child 0 work',
            outputMode: 'text',
            role: 'child0',
            runnerRole: 'executor',
            attempt: 1,
          })(),
        ),
      );

      // Sanity: plugin must be findable before the scheduler runs.
      const found = getAgentPlugin('test-replay-plugin');
      expect(found).toBeDefined();
      expect(found!.id).toBe('test-replay-plugin');

      const phaseAResult = await withTimeout(schedulerA.run());

      // Exactly 1 createSession call for child0.
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      // Verify the session dir was persisted.
      const child0Dir = join(sessionBaseDir, `${taskA.id}/child0#1`);
      expect(existsSync(join(child0Dir, '.complete'))).toBe(true);
      expect(existsSync(join(child0Dir, 'result.json'))).toBe(true);

      // ── Phase B: Reset spy, re-run full linearRunner ──────────────────
      mockCreateSession.mockClear();

      // Configure mock runtime for the fresh child1.
      currentMockRuntime = makeMockRuntime({ textOverride: 'child1-output' });

      const taskB = makeTask();
      const schedulerB = buildScheduler(sessionBaseDir, taskB, () =>
        withReplayExecute(
          linearRunner([
            singleSession({
              profile: 'executor',
              prompt: 'Child 0 work',
              outputMode: 'text',
              role: 'child0',
              runnerRole: 'executor',
              attempt: 1,
            })(),
            singleSession({
              profile: 'executor',
              prompt: 'Child 1 work',
              outputMode: 'text',
              role: 'child1',
              runnerRole: 'executor',
              attempt: 1,
            })(),
          ])(),
        ),
      );

      const result = await withTimeout(schedulerB.run());

      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);

      // child0 was cached → 0 createSession calls for it.
      // child1 ran fresh → 1 createSession call.
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(sessionBaseDir, { recursive: true, force: true });
    }
  });

  // ── 2. coordinatorRunner replay ─────────────────────────────────────────

  it('2. coordinatorRunner replay: coordinator cached, workers run fresh', async () => {
    const sessionBaseDir = mkdtempSync(join(tmpdir(), 'replay-coord-'));

    try {
      const taskId = 'replay-task';
      const coordSpecId = `${taskId}/coord#1`;

      // ── Phase A: Run the coordinator session only, persist its result ──
      //
      // The coordinator's session id is `${taskId}/coord#1`. We run a
      // singleSession whose role is 'coord' (attempt 1) so the generated id
      // matches exactly. Text mode avoids depending on promptForStructured.
      currentMockRuntime = makeMockRuntime({ textOverride: 'plan: do X' });

      const taskA = makeTask();
      const schedulerA = buildScheduler(sessionBaseDir, taskA, () =>
        withReplayExecute(
          singleSession({
            profile: 'coordinator',
            prompt: 'Plan the work',
            outputMode: 'text',
            role: 'coord',
            runnerRole: 'coordinator',
            attempt: 1,
          })(),
        ),
      );

      await withTimeout(schedulerA.run());

      // Coordinator createSession was called once.
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      // Verify the coordinator's session dir was persisted.
      const coordDir = join(sessionBaseDir, coordSpecId);
      expect(existsSync(join(coordDir, '.complete'))).toBe(true);
      expect(existsSync(join(coordDir, 'result.json'))).toBe(true);

      // ── Phase B: Run full coordinatorRunner (coordinator + workers) ────
      mockCreateSession.mockClear();

      currentMockRuntime = makeMockRuntime({ textOverride: 'worker-output' });

      const taskB = makeTask();
      const schedulerB = buildScheduler(sessionBaseDir, taskB, () =>
        withReplayExecute(
          coordinatorRunner(
            {
              id: coordSpecId,
              profile: 'coordinator',
              prompt: 'Plan the work',
              outputMode: 'text',
              runnerRole: 'coordinator',
              attempt: 1,
            },
            {
              childRunner: () =>
                parallelRunner([
                  singleSession({
                    profile: 'worker',
                    prompt: 'Worker 0',
                    outputMode: 'text',
                    role: 'worker[0]',
                    runnerRole: 'worker',
                    attempt: 1,
                  })(),
                  singleSession({
                    profile: 'worker',
                    prompt: 'Worker 1',
                    outputMode: 'text',
                    role: 'worker[1]',
                    runnerRole: 'worker',
                    attempt: 1,
                  })(),
                ])(),
            },
          )(),
        ),
      );

      const result = await withTimeout(schedulerB.run());

      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);

      // Coordinator was cached → 0 createSession calls for coordinator.
      // Two workers ran → 2 createSession calls.
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(sessionBaseDir, { recursive: true, force: true });
    }
  });
});
