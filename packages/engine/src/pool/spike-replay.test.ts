// ─── Integration Spike: Replay Correctness ────────────────────────────────
//
// Prove that the session-primitive idempotency layer (tryReadCachedResult)
// correctly returns cached results on re-run — producing ZERO redundant
// model (createSession) calls for already-persisted sessions.
//
// Two cases:
//   1. linearRunner of two singleSession children. First run: both execute.
//      Then "kill between sessions": persist only child0, re-run the full
//      linearRunner → child0 is cached (0 createSession calls), child1 runs
//      fresh (1 createSession call).
//   2. coordinatorRunner: run coordinator session (persists its decision),
//      then re-instantiate + re-walk → coordinator is replayed from cache
//      (0 model calls), children are produced identically.
//
// Strategy: use the REAL runSession (not mocked) so the idempotency check
// runs on real disk state. Register a mock plugin whose createSession is a
// spy so we count model calls. The mock plugin's createSession returns a
// mock AgentRuntime that simulates a minimal session.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentPlugin, AgentRuntime, AgentRuntimeEvent, AgentSessionOptions } from '../core/agent-plugin.js';
import { clearAgentPluginRegistry, registerAgentPlugin } from '../core/agent-registry.js';
import type { AgentProfile, Task } from '../core/types.js';
import { coordinatorRunner } from './runners/coordinator-runner.js';
import { linearRunner } from './runners/linear-runner.js';
import { parallelRunner } from './runners/parallel-runner.js';
import { singleSession } from './runners/single-session.js';
import type { RunnerContext } from './runners/types.js';
import { SessionGate } from './session-gate.js';
import { runSession } from './session.js';

// ─── Mock AgentRuntime ─────────────────────────────────────────────────────

/**
 * Create a minimal mock AgentRuntime that satisfies the real runSession.
 *
 * - `prompt()` resolves immediately.
 * - `getLastAssistantText()` returns `textOverride` (defaults to "mock reply").
 * - `getLastAssistantMessage()` returns a safe message with stopReason
 *   'end_turn' so the classifier does NOT flag it as 'empty' or 'error'.
 * - `_emit()` fires events to subscribers (for watchdog reset).
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
          message: { role: 'assistant', content: [{ type: 'text', text: lastText }], usage: { input: 10, output: 20 } },
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

// ─── Mock plugin (registered in real agent-registry) ───────────────────────

const mockCreateSession = mock(async (_opts: AgentSessionOptions): Promise<AgentRuntime> => {
  // Return a basic mock runtime. Callers can further configure by setting
  // mockRuntimeOverrides before triggering a session.
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
    status: 'active',
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

function makeCtx(sessionBaseDir: string, overrides?: Partial<RunnerContext>): RunnerContext {
  const task = makeTask();
  const gate = new SessionGate({ total: 5, perModel: {} });
  const profiles = new Map<string, AgentProfile>();
  profiles.set('executor', makeProfile('executor'));
  profiles.set('worker', makeProfile('worker'));
  profiles.set('coordinator', makeProfile('coordinator'));

  return {
    task,
    gate,
    runSession,
    profiles,
    sessionBaseDir,
    cwd: '/tmp/project',
    activeSessions: new Set(),
    phaseId: 'test',
    agentId: 'agent-1',
    ...overrides,
  };
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────
//
// `beforeEach` (not `beforeAll`) ensures the mock plugin is re-registered
// before every test, surviving cross-file `clearAgentPluginRegistry()` calls
// from sibling test files (e.g. cursor/adapter.test.ts, session.test.ts).
// The plugin id 'test-replay-plugin' is unique — no real adapter ever
// registers under this id.

beforeEach(() => {
  clearAgentPluginRegistry();
  registerAgentPlugin(replayPlugin);
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
      const child0Spec = {
        profile: 'executor',
        prompt: 'Child 0 work',
        outputMode: 'text' as const,
        role: 'child0',
        runnerRole: 'executor',
        attempt: 1,
      };

      // Configure mock runtime to return deterministic text for child0.
      currentMockRuntime = makeMockRuntime({ textOverride: 'child0-output' });

      const ctxA = makeCtx(sessionBaseDir);
      const runnerA = singleSession(child0Spec);
      await runnerA(ctxA);

      // Exactly 1 createSession call for child0.
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      // Verify the session dir was persisted.
      const child0Dir = join(sessionBaseDir, `${ctxA.task.id}/child0#1`);
      expect(existsSync(join(child0Dir, '.complete'))).toBe(true);
      expect(existsSync(join(child0Dir, 'result.json'))).toBe(true);

      // ── Phase B: Reset spy, re-run full linearRunner ──────────────────
      mockCreateSession.mockClear();

      // Configure mock runtime for the fresh child1.
      currentMockRuntime = makeMockRuntime({ textOverride: 'child1-output' });

      const ctxB = makeCtx(sessionBaseDir);
      const runnerB = linearRunner([
        singleSession({
          profile: 'executor',
          prompt: 'Child 0 work',
          outputMode: 'text',
          role: 'child0',
          runnerRole: 'executor',
          attempt: 1,
        }),
        singleSession({
          profile: 'executor',
          prompt: 'Child 1 work',
          outputMode: 'text',
          role: 'child1',
          runnerRole: 'executor',
          attempt: 1,
        }),
      ]);

      const outcome = await runnerB(ctxB);

      expect(outcome).toEqual({ status: 'completed' });

      // child0 was cached → 0 createSession calls for it.
      // child1 ran fresh → 1 createSession call.
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(sessionBaseDir, { recursive: true, force: true });
    }
  }, 10_000);

  // ── 2. coordinatorRunner replay ─────────────────────────────────────────

  it('2. coordinatorRunner replay: coordinator cached, workers produced identically', async () => {
    const sessionBaseDir = mkdtempSync(join(tmpdir(), 'replay-coord-'));

    try {
      // ── Phase A: Run the coordinator session only, persist its result ──
      //
      // Text mode is used to avoid depending on promptForStructured (which
      // other test files may have globally mocked). The coordinator runner
      // treats text results the same way — it extracts the data from the
      // SessionResult and passes it through to childRunner.
      const coordSpec = {
        id: 'replay-task/coord#1',
        profile: 'coordinator',
        prompt: 'Plan the work',
        outputMode: 'text' as const,
        runnerRole: 'coordinator',
        attempt: 1,
      };

      currentMockRuntime = makeMockRuntime({ textOverride: 'plan: do X' });

      // Run just the coordinator session via real runSession.
      const gate = new SessionGate({ total: 5, perModel: {} });
      const profiles = new Map<string, AgentProfile>();
      profiles.set('coordinator', makeProfile('coordinator'));
      profiles.set('worker', makeProfile('worker'));

      const activeSessions = new Set<{ abort(): Promise<void> }>();
      await runSession({
        spec: coordSpec,
        sessionBaseDir,
        cwd: '/tmp/project',
        phaseId: 'test',
        agentId: 'agent-1',
        profiles,
        activeSessions,
      });

      // Coordinator createSession was called once.
      const coordCallsBefore = mockCreateSession.mock.calls.length;
      expect(coordCallsBefore).toBeGreaterThanOrEqual(1);

      // Reset spy.
      mockCreateSession.mockClear();

      // Verify the coordinator's session dir was persisted.
      const coordDir = join(sessionBaseDir, 'replay-task/coord#1');
      expect(existsSync(join(coordDir, '.complete'))).toBe(true);
      expect(existsSync(join(coordDir, 'result.json'))).toBe(true);

      // ── Phase B: Run full coordinatorRunner (coordinator + workers) ────
      currentMockRuntime = makeMockRuntime({ textOverride: 'worker-output' });

      const task = makeTask();
      const ctxB: RunnerContext = {
        task,
        gate: new SessionGate({ total: 5, perModel: {} }),
        runSession,
        profiles,
        sessionBaseDir,
        cwd: '/tmp/project',
        activeSessions: new Set(),
        phaseId: 'test',
        agentId: 'agent-1',
      };

      const runner = coordinatorRunner(coordSpec, {
        childRunner: (_data: unknown) =>
          parallelRunner([
            singleSession({
              profile: 'worker',
              prompt: 'Worker 0',
              outputMode: 'text',
              role: 'worker[0]',
              runnerRole: 'worker',
              attempt: 1,
            }),
            singleSession({
              profile: 'worker',
              prompt: 'Worker 1',
              outputMode: 'text',
              role: 'worker[1]',
              runnerRole: 'worker',
              attempt: 1,
            }),
          ]),
      });

      const outcome = await runner(ctxB);

      expect(outcome).toEqual({ status: 'completed' });

      // Coordinator was cached → 0 createSession calls for coordinator.
      // Two workers ran → 2 createSession calls.
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(sessionBaseDir, { recursive: true, force: true });
    }
  }, 10_000);
});
