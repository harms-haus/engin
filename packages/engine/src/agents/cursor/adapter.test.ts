// ─── Tests for sessions/cursor/adapter.ts — Cursor SDK adapter ────────────────
//
// Validates the Cursor SDK adapter implementing `AgentPlugin` with
// `id: 'cursor'`. The Cursor SDK (`@cursor/sdk`) is mocked at the module
// level so no real network / filesystem I/O occurs.
//
// Coverage:
//   1. The adapter module loads and self-registers with id 'cursor'.
//   2. `createSession` calls `Agent.create` with model derived from the
//      profile, the cursor (or anthropic) api key, and a binary sandbox
//      derived from `allowedWriteDirs`.
//   3. `prompt()` calls `agent.send(text)` then iterates `run.stream()`,
//      translating SDKMessage variants into neutral AgentRuntimeEvents.
//   4. assistant messages buffer text for `getLastAssistantText()` /
//      `getLastAssistantMessage()`.
//   5. tool_call messages synthesize a tool_execution_start + tool_execution_end
//      pair (Cursor emits a single tool_call event).
//   6. No usage / turn_start / turn_end / auto_retry events are fabricated.
//   7. `abort()` calls `run.cancel()` on the active run.
//   8. `subscribe()` registers a callback and returns an unsubscribe fn.
//   9. `sessionId` reflects the first run id.
//  10. Resume path uses `Agent.getRun` when `resumeSessionPath` is set.
//
// Module under test: ./adapter.js

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { AgentRuntimeEvent } from '../../core/agent-plugin.js';
import type { AgentProfile } from '../../core/types.js';

// ─── Mock the @cursor/sdk package ──────────────────────────────────────────
//
// We expose controllable mock functions so each test can drive the SDK shape
// (Agent.create / Agent.getRun, agent.send, run.stream, run.cancel).

const createAgentMock = mock(async (_options: unknown) => makeMockSdkAgent());
const getRunMock = mock(async (_runId: string, _options?: unknown) => makeMockRun([]));

mock.module('@cursor/sdk', () => ({
  Agent: {
    create: (...args: unknown[]) => createAgentMock(...(args as [unknown])),
    getRun: (...args: unknown[]) => getRunMock(...(args as [string, unknown?])),
  },
}));

// ─── Import adapter (and registry) AFTER the mock is registered ────────────

import {
  clearAgentPluginRegistry,
  getAgentPlugin,
  hasAgentPlugin,
  registerAgentPlugin,
} from '../../core/agent-registry.js';
import { cursorAdapter } from './adapter.js';

// ─── Mock SDK shape helpers ────────────────────────────────────────────────

/** Build a mock SDKMessage stream backed by an array of messages. */
function makeMockRun(messages: Array<Record<string, unknown>>) {
  const cancelMock = mock(async () => {});
  const streamMock = mock(async function* (): AsyncGenerator<Record<string, unknown>, void> {
    for (const m of messages) yield m;
  });
  return {
    id: 'run-123',
    agentId: 'agent-1',
    status: 'running' as const,
    supports: (_op: string) => true,
    unsupportedReason: () => undefined,
    stream: streamMock,
    conversation: async () => [],
    wait: async () => ({ id: 'run-123', status: 'finished' as const }),
    cancel: cancelMock,
    onDidChangeStatus: () => () => {},
    result: undefined,
    model: undefined,
    durationMs: undefined,
    git: undefined,
    createdAt: undefined,
    // expose mocks for assertion convenience
    _cancel: cancelMock,
    _stream: streamMock,
  };
}

/** Build a mock SDKAgent whose `send` resolves to the given run. */
function makeMockSdkAgent(run?: ReturnType<typeof makeMockRun>) {
  const sendMock = mock(async (_msg: unknown) => run ?? makeMockRun([]));
  return {
    agentId: 'agent-1',
    model: undefined,
    send: sendMock,
    close: () => {},
    reload: async () => {},
    async [Symbol.asyncDispose]() {},
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.alloc(0),
    _send: sendMock,
  };
}

// ─── Test fixtures ─────────────────────────────────────────────────────────

const baseProfile: AgentProfile = {
  id: 'cursor-profile',
  name: 'Cursor',
  provider: 'cursor',
  model: 'claude-sonnet-4-20250514',
  thinkingLevel: 'medium',
  systemPrompt: 'You are a coding agent.',
  excludeTools: [],
  includeTools: [],
};

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    profile: baseProfile,
    cwd: '/tmp/project',
    apiKeys: { cursor: 'cur-key', anthropic: 'ant-key' },
    ...overrides,
  };
}

// ─── Setup / teardown ──────────────────────────────────────────────────────
//
// The adapter self-registers on import; we don't want side effects from one
// test to leak into registry assertions in another. The adapter exports the
// plugin instance directly so we can assert on it regardless of registry state.

beforeEach(() => {
  createAgentMock.mockReset();
  getRunMock.mockReset();
  // restore default implementations after reset
  createAgentMock.mockImplementation(async () => makeMockSdkAgent());
  getRunMock.mockImplementation(async () => makeMockRun([]));
});

afterEach(() => {
  clearAgentPluginRegistry();
});

// ─── Self-registration ─────────────────────────────────────────────────────

describe('cursor adapter self-registration', () => {
  it('exports a plugin with id "cursor"', () => {
    expect(cursorAdapter).toBeDefined();
    expect(cursorAdapter.id).toBe('cursor');
    expect(typeof cursorAdapter.createSession).toBe('function');
  });

  it('satisfies the AgentPlugin contract shape', () => {
    // AgentPlugin requires a readonly id string and a createSession function.
    expect(typeof cursorAdapter.id).toBe('string');
    expect(cursorAdapter.createSession).toBeInstanceOf(Function);
  });

  it('registers under its plugin id in the registry', () => {
    // The adapter is expected to call registerAgentPlugin(cursorAdapter) on
    // import. Module caching means re-import won't re-fire the side effect,
    // so we verify the registry contract directly: the exported instance,
    // when registered, is retrievable by its declared id.
    registerAgentPlugin(cursorAdapter);
    expect(hasAgentPlugin('cursor')).toBe(true);
    expect(getAgentPlugin('cursor')).toBe(cursorAdapter);
  });
});

// ─── createSession — Agent.create wiring ───────────────────────────────────

describe('createSession wiring', () => {
  it('calls Agent.create exactly once', async () => {
    await cursorAdapter.createSession(baseOpts());
    expect(createAgentMock).toHaveBeenCalledTimes(1);
  });

  it('passes model.id from the profile model', async () => {
    await cursorAdapter.createSession(baseOpts());
    const opts = createAgentMock.mock.calls[0][0] as { model?: { id?: string } };
    expect(opts.model).toBeDefined();
    expect(opts.model?.id).toBe('claude-sonnet-4-20250514');
  });

  it('prefers the cursor api key when present', async () => {
    await cursorAdapter.createSession(baseOpts({ apiKeys: { cursor: 'cur-key', anthropic: 'ant-key' } }));
    const opts = createAgentMock.mock.calls[0][0] as { apiKey?: string };
    expect(opts.apiKey).toBe('cur-key');
  });

  it('falls back to the anthropic api key when cursor is absent', async () => {
    await cursorAdapter.createSession(baseOpts({ apiKeys: { anthropic: 'ant-key' } }));
    const opts = createAgentMock.mock.calls[0][0] as { apiKey?: string };
    expect(opts.apiKey).toBe('ant-key');
  });

  it('passes local.cwd from opts.cwd', async () => {
    await cursorAdapter.createSession(baseOpts({ cwd: '/workspace/x' }));
    const opts = createAgentMock.mock.calls[0][0] as { local?: { cwd?: string } };
    expect(opts.local?.cwd).toBe('/workspace/x');
  });

  it('enables the binary sandbox when allowedWriteDirs is non-empty', async () => {
    await cursorAdapter.createSession(baseOpts({ allowedWriteDirs: ['/tmp/project/src'] }));
    const opts = createAgentMock.mock.calls[0][0] as {
      local?: { sandboxOptions?: { enabled?: boolean } };
    };
    // Cursor's sandbox is binary — granular dirs cannot be expressed.
    expect(opts.local?.sandboxOptions?.enabled).toBe(true);
  });

  it('disables the sandbox when allowedWriteDirs is absent', async () => {
    await cursorAdapter.createSession(baseOpts());
    const opts = createAgentMock.mock.calls[0][0] as {
      local?: { sandboxOptions?: { enabled?: boolean } };
    };
    expect(opts.local?.sandboxOptions?.enabled).toBe(false);
  });

  it('disables the sandbox when allowedWriteDirs is empty', async () => {
    await cursorAdapter.createSession(baseOpts({ allowedWriteDirs: [] }));
    const opts = createAgentMock.mock.calls[0][0] as {
      local?: { sandboxOptions?: { enabled?: boolean } };
    };
    expect(opts.local?.sandboxOptions?.enabled).toBe(false);
  });
});

// ─── prompt() streaming + event translation ────────────────────────────────

describe('prompt() streaming and event translation', () => {
  /** Create a session whose agent.send resolves to a run streaming the given messages. */
  async function sessionFromMessages(
    messages: Array<Record<string, unknown>>,
    extraOpts: Record<string, unknown> = {},
  ) {
    const run = makeMockRun(messages);
    const agent = makeMockSdkAgent(run);
    createAgentMock.mockImplementation(async () => agent);
    const runtime = await cursorAdapter.createSession(baseOpts(extraOpts));
    return { runtime, agent, run };
  }

  it('calls agent.send with the prompt text', async () => {
    const { runtime, agent } = await sessionFromMessages([]);
    await runtime.prompt('hello world');
    expect(agent._send).toHaveBeenCalledTimes(1);
    expect(agent._send.mock.calls[0][0]).toBe('hello world');
  });

  it('emits a tool_execution_start + tool_execution_end pair for a tool_call', async () => {
    const messages = [
      {
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-123',
        call_id: 'call-9',
        name: 'bash',
        status: 'completed',
        args: { command: 'ls' },
      },
    ];
    const { runtime } = await sessionFromMessages(messages);

    const events: AgentRuntimeEvent[] = [];
    runtime.subscribe((e: AgentRuntimeEvent) => events.push(e));
    await runtime.prompt('go');

    const starts = events.filter((e: AgentRuntimeEvent) => e.type === 'tool_execution_start');
    const ends = events.filter((e: AgentRuntimeEvent) => e.type === 'tool_execution_end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect((starts[0] as { toolName: string }).toolName).toBe('bash');
    expect((starts[0] as { toolCallId: string }).toolCallId).toBe('call-9');
    expect((ends[0] as { toolCallId: string }).toolCallId).toBe('call-9');
    expect((ends[0] as { isError: boolean }).isError).toBe(false);
  });

  it('marks tool_execution_end as error when tool_call status is error', async () => {
    const messages = [
      {
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-123',
        call_id: 'call-err',
        name: 'read',
        status: 'error',
      },
    ];
    const { runtime } = await sessionFromMessages(messages);

    const events: AgentRuntimeEvent[] = [];
    runtime.subscribe((e: AgentRuntimeEvent) => events.push(e));
    await runtime.prompt('go');

    const ends = events.filter((e: AgentRuntimeEvent) => e.type === 'tool_execution_end');
    expect(ends).toHaveLength(1);
    expect((ends[0] as { isError: boolean }).isError).toBe(true);
  });

  it('does not emit turn_start / turn_end events', async () => {
    const messages = [
      {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'run-123',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    ];
    const { runtime } = await sessionFromMessages(messages);

    const events: AgentRuntimeEvent[] = [];
    runtime.subscribe((e: AgentRuntimeEvent) => events.push(e));
    await runtime.prompt('go');

    expect(events.filter((e: AgentRuntimeEvent) => e.type === 'turn_start')).toHaveLength(0);
    expect(events.filter((e: AgentRuntimeEvent) => e.type === 'turn_end')).toHaveLength(0);
  });

  it('does not emit auto_retry events', async () => {
    const messages: Array<Record<string, unknown>> = [
      { type: 'status', agent_id: 'agent-1', run_id: 'run-123', status: 'RUNNING' },
    ];
    const { runtime } = await sessionFromMessages(messages);

    const events: AgentRuntimeEvent[] = [];
    runtime.subscribe((e: AgentRuntimeEvent) => events.push(e));
    await runtime.prompt('go');

    expect(events.filter((e: AgentRuntimeEvent) => e.type === 'auto_retry_start')).toHaveLength(0);
    expect(events.filter((e: AgentRuntimeEvent) => e.type === 'auto_retry_end')).toHaveLength(0);
  });
});

// ─── assistant text buffering ──────────────────────────────────────────────

describe('assistant text buffering', () => {
  async function sessionFromMessages(messages: Array<Record<string, unknown>>) {
    const run = makeMockRun(messages);
    const agent = makeMockSdkAgent(run);
    createAgentMock.mockImplementation(async () => agent);
    return cursorAdapter.createSession(baseOpts());
  }

  it('returns undefined before any prompt', async () => {
    const runtime = await sessionFromMessages([]);
    expect(runtime.getLastAssistantText()).toBeUndefined();
    expect(runtime.getLastAssistantMessage()).toBeUndefined();
  });

  it('buffers assistant text blocks for getLastAssistantText()', async () => {
    const messages = [
      {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'run-123',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'part-1 ' },
            { type: 'text', text: 'part-2' },
          ],
        },
      },
    ];
    const runtime = await sessionFromMessages(messages);
    await runtime.prompt('go');
    expect(runtime.getLastAssistantText()).toBe('part-1 part-2');
  });

  it('returns content blocks via getLastAssistantMessage() with no usage', async () => {
    const messages = [
      {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'run-123',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
        },
      },
    ];
    const runtime = await sessionFromMessages(messages);
    await runtime.prompt('go');

    const msg = runtime.getLastAssistantMessage();
    expect(msg).toBeDefined();
    expect(Array.isArray(msg?.content)).toBe(true);
    // Cursor exposes no token usage — do NOT fabricate.
    expect(msg?.usage).toBeUndefined();
  });
});

// ─── abort / sessionId / subscribe ─────────────────────────────────────────

describe('abort / sessionId / subscribe', () => {
  async function sessionFromMessages(messages: Array<Record<string, unknown>> = []) {
    const run = makeMockRun(messages);
    const agent = makeMockSdkAgent(run);
    createAgentMock.mockImplementation(async () => agent);
    const runtime = await cursorAdapter.createSession(baseOpts());
    return { runtime, run };
  }

  it('calls run.cancel() on abort after a prompt has started', async () => {
    const { runtime, run } = await sessionFromMessages([]);
    // Start the prompt (don't await) so an active run exists, then abort.
    const p = runtime.prompt('go');
    await runtime.abort();
    await p;
    expect(run._cancel).toHaveBeenCalled();
  });

  it('sessionId reflects the first run id', async () => {
    const { runtime } = await sessionFromMessages([]);
    await runtime.prompt('go');
    expect(runtime.sessionId).toBe('run-123');
  });

  it('sessionFile is undefined', async () => {
    const { runtime } = await sessionFromMessages([]);
    expect(runtime.sessionFile).toBeUndefined();
  });

  it('contextWindow is undefined', async () => {
    const { runtime } = await sessionFromMessages([]);
    expect(runtime.contextWindow).toBeUndefined();
  });

  it('subscribe returns an unsubscribe function that stops delivery', async () => {
    const messages = [
      {
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-123',
        call_id: 'c1',
        name: 'ls',
        status: 'completed',
      },
    ];
    const { runtime } = await sessionFromMessages(messages);

    const received: AgentRuntimeEvent[] = [];
    const unsub = runtime.subscribe((e: AgentRuntimeEvent) => received.push(e));
    expect(typeof unsub).toBe('function');
    unsub();

    await runtime.prompt('go');
    // After unsubscribing, no events should be delivered.
    expect(received).toHaveLength(0);
  });

  it('subscribe delivers events to multiple subscribers', async () => {
    const messages = [
      {
        type: 'tool_call',
        agent_id: 'agent-1',
        run_id: 'run-123',
        call_id: 'c1',
        name: 'ls',
        status: 'completed',
      },
    ];
    const { runtime } = await sessionFromMessages(messages);

    const a: AgentRuntimeEvent[] = [];
    const b: AgentRuntimeEvent[] = [];
    runtime.subscribe((e: AgentRuntimeEvent) => a.push(e));
    runtime.subscribe((e: AgentRuntimeEvent) => b.push(e));
    await runtime.prompt('go');

    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
  });

  it('dispose is safe to call and does not throw', async () => {
    const { runtime } = await sessionFromMessages([]);
    expect(() => runtime.dispose()).not.toThrow();
  });
});

// ─── resume path ───────────────────────────────────────────────────────────

describe('resume', () => {
  it('uses Agent.getRun when resumeSessionPath is set', async () => {
    const messages = [
      {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'run-123',
        message: { role: 'assistant', content: [{ type: 'text', text: 'resumed' }] },
      },
    ];
    const run = makeMockRun(messages);
    getRunMock.mockImplementation(async () => run);

    const runtime = await cursorAdapter.createSession(baseOpts({ resumeSessionPath: 'run-123' }));

    // Should NOT have created a new agent; should have fetched the run.
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(getRunMock).toHaveBeenCalledTimes(1);
    expect(getRunMock.mock.calls[0][0]).toBe('run-123');

    await runtime.prompt('continue');
    expect(runtime.getLastAssistantText()).toBe('resumed');
  });
});
