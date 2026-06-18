// ─── Tests for spawnAgent — contextWindow forwarding ─────────────────────────
//
// Verifies that `spawnAgent` destructures `contextWindow` from the
// `createHarness` result and forwards it on the `onAgentSpawn` info object, and
// — when wired through `createStoreCallbacks` — that the appended
// `agent_spawned` event carries `data.contextWindow` equal to the resolved
// model's value.
//
// `createHarness` is mocked so we can inject a known `contextWindow` without
// touching the network/credentials. The end-to-end test is the task's mandated
// verification: "a test that spawns via store-callbacks and asserts the appended
// agent_spawned event has data.contextWindow set to the model's value."

import type { EventType } from '@engin/shared/event-types';
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentProfile } from './types.js';

// ─── Capture the real harness-factory before mocking it ────────────────────

const realHarnessFactory = Object.assign({}, await import('./harness-factory.js'));

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./harness-factory.js', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import { createStoreCallbacks } from '../tracking/store-callbacks.js';
import { spawnAgent } from './agent-lifecycle.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const profile: AgentProfile = {
  id: 'coder',
  name: 'Coder',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium',
  systemPrompt: 'You are a coding agent.',
  excludeTools: [],
  includeTools: [],
};

function makeMockSession(id = 's1') {
  return {
    sessionId: id,
    sessionFile: undefined as string | undefined,
    subscribe: mock(() => () => {}),
    dispose: mock(() => {}),
    abort: mock(async () => {}),
  };
}

beforeEach(() => {
  mockCreateHarness.mockReset();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('spawnAgent — forwards contextWindow to onAgentSpawn', () => {
  it('forwards the model contextWindow from createHarness to the spawn callback', async () => {
    const session = makeMockSession('s1');
    mockCreateHarness.mockResolvedValue({
      session,
      sessionId: 's1',
      dispose: mock(() => {}),
      contextWindow: 131072,
    });

    const captured: Array<{ contextWindow?: number; agentId?: string; sessionId?: string }> = [];

    await spawnAgent(
      {
        profileId: 'coder',
        agentId: 'a1',
        cwd: '/tmp',
        phaseId: 'p1',
        taskId: 't1',
        stepIndex: 0,
        onStatus: { onAgentSpawn: (info) => captured.push(info) },
      },
      new Map([['coder', profile]]),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].agentId).toBe('a1');
    // The forwarded contextWindow must equal the model's value from createHarness.
    expect(captured[0].contextWindow).toBe(131072);
  });

  it('does not crash when createHarness omits contextWindow (backward compat)', async () => {
    const session = makeMockSession('s3');
    // Harness result WITHOUT contextWindow (e.g. older harness).
    mockCreateHarness.mockResolvedValue({
      session,
      sessionId: 's3',
      dispose: mock(() => {}),
    });

    // `agentId` is included so the element type shares a key with the
    // onAgentSpawn info type (avoids TS2559 'no properties in common' before
    // the info type is widened with contextWindow).
    const captured: Array<{ contextWindow?: number; agentId?: string }> = [];

    const handle = await spawnAgent(
      {
        profileId: 'coder',
        agentId: 'a3',
        cwd: '/tmp',
        phaseId: 'p1',
        taskId: 't3',
        stepIndex: 0,
        onStatus: { onAgentSpawn: (info) => captured.push(info) },
      },
      new Map([['coder', profile]]),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].contextWindow).toBeUndefined();
    handle.dispose();
  });

  // ── End-to-end: spawn via store-callbacks ──────────────────────────────
  //
  // The task's verification: "a test that spawns via store-callbacks and
  // asserts the appended agent_spawned event has data.contextWindow set to the
  // model's value."

  it('end-to-end: spawn via store-callbacks records data.contextWindow == model value', async () => {
    const MODEL_CONTEXT_WINDOW = 128000;
    const session = makeMockSession('s2');
    mockCreateHarness.mockResolvedValue({
      session,
      sessionId: 's2',
      dispose: mock(() => {}),
      contextWindow: MODEL_CONTEXT_WINDOW,
    });

    interface RecordedCall {
      type: EventType;
      data: Record<string, unknown>;
      metadata?: { agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number };
    }
    const calls: RecordedCall[] = [];
    const store = {
      append: (type: EventType, data: Record<string, unknown>, metadata?: RecordedCall['metadata']) =>
        calls.push({ type, data, metadata }),
    };
    const onStatus = createStoreCallbacks(store);

    await spawnAgent(
      {
        profileId: 'coder',
        agentId: 'a2',
        cwd: '/tmp',
        phaseId: 'p1',
        taskId: 't2',
        stepIndex: 1,
        onStatus,
      },
      new Map([['coder', profile]]),
    );

    const spawn = calls.find((c) => c.type === 'agent_spawned');
    expect(spawn, 'agent_spawned event should be appended').toBeDefined();
    expect(spawn!.data.contextWindow).toBe(MODEL_CONTEXT_WINDOW);
  });
});

// ─── Restore real modules ───────────────────────────────────────────────────

afterAll(() => {
  mock.module('./harness-factory.js', () => realHarnessFactory);
});
