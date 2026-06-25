// ─── Tests for spawnAgent — contextWindow forwarding ─────────────────────────
//
// Verifies that `spawnAgent` reads `contextWindow` from the
// `AgentRuntime` returned by `plugin.createSession` and forwards it on the
// `onAgentSpawn` info object, and — when wired through `createStoreCallbacks` —
// that the appended `agent_spawned` event carries `data.contextWindow` equal to
// the resolved model's value.
//
// `requireAgentPlugin` (and thus the plugin's `createSession`) is mocked so we
// can inject a known `contextWindow` without touching the network/credentials.
// The end-to-end test is the task's mandated verification: "a test that spawns
// via store-callbacks and asserts the appended agent_spawned event has
// data.contextWindow set to the model's value."

import type { EventType } from '@engin/shared/event-types';
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentProfile } from './types.js';

// ─── Capture the real agent-registry before mocking it ─────────────────────

const realAgentRegistry = Object.assign({}, await import('./agent-registry.js'));

const mockRequireAgentPlugin = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./agent-registry.js', () => ({
  requireAgentPlugin: (...args: unknown[]) => mockRequireAgentPlugin(...args),
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

/**
 * Build an `AgentRuntime` stub. `spawnAgent` unwraps `sessionId`,
 * `sessionFile`, `dispose`, and `contextWindow` directly from the runtime
 * returned by `plugin.createSession`, so the stub carries all of them.
 */
function makeMockSession(id = 's1', contextWindow?: number) {
  return {
    sessionId: id,
    sessionFile: undefined as string | undefined,
    contextWindow,
    subscribe: mock(() => () => {}),
    dispose: mock(() => {}),
    abort: mock(async () => {}),
    prompt: mock(async (_text: string) => {}),
    getLastAssistantText: mock(() => undefined),
    getLastAssistantMessage: mock(() => undefined),
  };
}

/** The mock plugin whose `createSession` is wired per-test. */
let mockPlugin: { id: string; createSession: ReturnType<typeof mock> };

beforeEach(() => {
  mockRequireAgentPlugin.mockReset();
  mockPlugin = { id: 'pi-coding-agent', createSession: mock() };
  mockRequireAgentPlugin.mockReturnValue(mockPlugin);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('spawnAgent — forwards contextWindow to onAgentSpawn', () => {
  it('forwards the model contextWindow from createSession to the spawn callback', async () => {
    const session = makeMockSession('s1', 131072);
    mockPlugin.createSession.mockResolvedValue(session);

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
    // The forwarded contextWindow must equal the model's value from the runtime.
    expect(captured[0].contextWindow).toBe(131072);
  });

  it('does not crash when the runtime omits contextWindow (backward compat)', async () => {
    const session = makeMockSession('s3');
    // Runtime WITHOUT contextWindow (e.g. older adapter).
    mockPlugin.createSession.mockResolvedValue(session);

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
    const session = makeMockSession('s2', MODEL_CONTEXT_WINDOW);
    mockPlugin.createSession.mockResolvedValue(session);

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

  it('resolves the plugin via requireAgentPlugin(profile.agent) and delegates to createSession', async () => {
    const session = makeMockSession('s4', 4096);
    mockPlugin.createSession.mockResolvedValue(session);

    await spawnAgent(
      {
        profileId: 'coder',
        agentId: 'a4',
        cwd: '/tmp/work',
        phaseId: 'p1',
        taskId: 't4',
        stepIndex: 0,
      },
      new Map([['coder', profile]]),
    );

    // requireAgentPlugin called exactly once (direct registry call).
    expect(mockRequireAgentPlugin).toHaveBeenCalledTimes(1);
    // createSession called exactly once with the adjusted profile + cwd.
    expect(mockPlugin.createSession).toHaveBeenCalledTimes(1);
    const callOpts = mockPlugin.createSession.mock.calls[0][0] as Record<string, unknown>;
    expect(callOpts.cwd).toBe('/tmp/work');
    expect((callOpts.profile as AgentProfile).id).toBe('coder');
  });
});

// ─── Restore real modules ───────────────────────────────────────────────────

afterAll(() => {
  mock.module('./agent-registry.js', () => realAgentRegistry);
});
