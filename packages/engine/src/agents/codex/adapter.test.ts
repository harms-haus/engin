// ─── Tests for sessions/codex/adapter.ts — Codex SDK adapter ──────────────────
//
// Verifies the Codex SDK adapter that implements the neutral `AgentPlugin`
// contract. The `@openai/codex-sdk` package is mocked entirely via
// `mock.module` so no real Codex CLI / network calls are made.
//
// Coverage:
//   1. Self-registration with id 'codex'.
//   2. createSession() configures the Codex instance + ThreadOptions:
//        - sandboxMode / additionalDirectories based on allowedWriteDirs.
//        - model + workingDirectory forwarding.
//        - API key resolution (opts.apiKeys / env).
//   3. Resume path uses resumeThread() with the thread id.
//   4. prompt() drives a streamed turn, buffers assistant text, and translates
//      native ThreadEvents into AgentRuntimeEvents.
//   5. getLastAssistantText / getLastAssistantMessage / abort / dispose /
//      subscribe behaviour.
//   6. onAgentStatus forwarding via createAgentEventForwarder.
//
// Module under test: ./adapter.js

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { AgentRuntimeEvent } from '../../core/agent-plugin.js';
import type { AgentProfile } from '../../core/types.js';

// ─── Mock SDK state ────────────────────────────────────────────────────────
//
// A single mutable state object controls the behaviour of the mocked
// `@openai/codex-sdk` module. Tests mutate it directly before driving the
// adapter. This keeps the mock.module factory stable while letting each test
// script the event stream / recorded args.

interface MockThread {
  id: string | null;
  runStreamed: (input: unknown, opts?: unknown) => Promise<{ events: AsyncGenerator }>;
}

interface MockState {
  /** Options passed to the Codex constructor. */
  lastCodexOptions: unknown;
  /** Options passed to startThread(). */
  lastThreadOptions: unknown;
  /** Whether startThread() was called. */
  startThreadCalled: boolean;
  /** Id passed to resumeThread(). */
  lastResumeId: string | undefined;
  /** Whether resumeThread() was called. */
  resumeThreadCalled: boolean;
  /** thread_id returned by the mock thread (from thread.started). */
  threadId: string;
  /** Events to yield from runStreamed on the next call. */
  nextEvents: unknown[];
  /** Input passed to the last runStreamed() call. */
  lastInput: unknown;
  /** TurnOptions passed to the last runStreamed() call. */
  lastTurnOptions: unknown;
  /** AbortSignal captured from the last runStreamed() call. */
  lastSignal: AbortSignal | undefined;
  /** Whether runStreamed was invoked. */
  runStreamedCalls: number;
  /** Throw from runStreamed instead of streaming (simulates failure). */
  runStreamedError: Error | undefined;
}

const state: MockState = {
  lastCodexOptions: undefined,
  lastThreadOptions: undefined,
  startThreadCalled: false,
  lastResumeId: undefined,
  resumeThreadCalled: false,
  threadId: 'thread_test_abc',
  nextEvents: [],
  lastInput: undefined,
  lastTurnOptions: undefined,
  lastSignal: undefined,
  runStreamedCalls: 0,
  runStreamedError: undefined,
};

function makeAsyncGen(events: unknown[]): AsyncGenerator {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

function makeMockThread(): MockThread {
  return {
    id: null,
    async runStreamed(input: unknown, opts?: unknown) {
      state.runStreamedCalls += 1;
      state.lastInput = input;
      state.lastTurnOptions = opts;
      state.lastSignal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      if (state.runStreamedError) throw state.runStreamedError;
      const events = state.nextEvents;
      // Reset so a subsequent call yields nothing unless re-scripted.
      state.nextEvents = [];
      return { events: makeAsyncGen(events) };
    },
  };
}

class MockCodex {
  constructor(public options?: unknown) {
    state.lastCodexOptions = options;
  }
  startThread(options?: unknown): MockThread {
    state.startThreadCalled = true;
    state.lastThreadOptions = options;
    const t = makeMockThread();
    t.id = state.threadId;
    return t;
  }
  resumeThread(id: string, options?: unknown): MockThread {
    state.resumeThreadCalled = true;
    state.lastResumeId = id;
    state.lastThreadOptions = options;
    const t = makeMockThread();
    t.id = id;
    return t;
  }
}

mock.module('@openai/codex-sdk', () => ({ Codex: MockCodex }));

// ─── Import after mocks ────────────────────────────────────────────────────

import { clearAgentPluginRegistry, getAgentPlugin, registerAgentPlugin } from '../../core/agent-registry.js';
import { codexAdapter } from './adapter.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'codex-profile',
    name: 'Codex',
    provider: 'openai',
    model: 'codex-test-model',
    thinkingLevel: 'medium',
    systemPrompt: 'You are a coding agent.',
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}

/** A typical successful turn: turn.started -> agent_message -> turn.completed. */
function successTurnEvents(text = 'Hello from Codex'): unknown[] {
  return [
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text } },
    {
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 42, reasoning_output_tokens: 0 },
    },
  ];
}

function resetState(): void {
  state.lastCodexOptions = undefined;
  state.lastThreadOptions = undefined;
  state.startThreadCalled = false;
  state.lastResumeId = undefined;
  state.resumeThreadCalled = false;
  state.threadId = 'thread_test_abc';
  state.nextEvents = [];
  state.lastInput = undefined;
  state.lastTurnOptions = undefined;
  state.lastSignal = undefined;
  state.runStreamedCalls = 0;
  state.runStreamedError = undefined;
}

beforeEach(() => {
  resetState();
  // Ensure the adapter is registered into the test's own registry handle so
  // each test is independent of cross-file registry state. Other test files
  // that import the engine barrel trigger the real adapters' self-registration
  // and can clear/replace the shared registry concurrently; re-registering
  // here guarantees this suite always observes the codex plugin regardless of
  // execution order.
  registerAgentPlugin(codexAdapter);
});

afterEach(() => {
  // Re-register the self-registered plugin in case a test cleared the registry.
  if (!getAgentPlugin('codex')) {
    registerAgentPlugin(codexAdapter);
  }
});

// ─── Self-registration ─────────────────────────────────────────────────────

describe('codex adapter — self-registration', () => {
  it("is registered under the id 'codex'", () => {
    const plugin = getAgentPlugin('codex');
    expect(plugin).toBeDefined();
    expect(plugin!.id).toBe('codex');
  });

  it('exports the adapter object with id codex', () => {
    expect(codexAdapter).toBeDefined();
    expect(codexAdapter.id).toBe('codex');
    expect(typeof codexAdapter.createSession).toBe('function');
  });

  it('re-registers itself when the registry is cleared and the module re-imported value is used', () => {
    clearAgentPluginRegistry();
    expect(getAgentPlugin('codex')).toBeUndefined();
    // The exported adapter still self-registers via registerAgentPlugin.
    registerAgentPlugin(codexAdapter);
    expect(getAgentPlugin('codex')?.id).toBe('codex');
  });
});

// ─── createSession — Codex instance + ThreadOptions configuration ───────────

describe('codex adapter — createSession configuration', () => {
  it('constructs a Codex instance with the resolved API key from opts.apiKeys', async () => {
    await codexAdapter.createSession({
      profile: makeProfile(),
      cwd: '/tmp/project',
      apiKeys: { openai: 'sk-test-openai' },
    });

    expect(state.lastCodexOptions).toEqual(expect.objectContaining({ apiKey: 'sk-test-openai' }));
    expect(state.startThreadCalled).toBe(true);
  });

  it('prefers the codex key over openai when both are present', async () => {
    await codexAdapter.createSession({
      profile: makeProfile(),
      cwd: '/tmp/project',
      apiKeys: { openai: 'sk-openai', codex: 'sk-codex' },
    });

    expect(state.lastCodexOptions).toEqual(expect.objectContaining({ apiKey: 'sk-codex' }));
  });

  it('falls back to process.env.OPENAI_API_KEY when no apiKeys supplied', async () => {
    const prev = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-env-key';
    try {
      await codexAdapter.createSession({
        profile: makeProfile(),
        cwd: '/tmp/project',
      });
      expect(state.lastCodexOptions).toEqual(expect.objectContaining({ apiKey: 'sk-env-key' }));
    } finally {
      if (prev === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = prev;
    }
  });

  it('forwards the profile model and cwd into ThreadOptions', async () => {
    await codexAdapter.createSession({
      profile: makeProfile({ model: 'codex-gpt-5' }),
      cwd: '/tmp/work',
    });

    expect(state.lastThreadOptions).toEqual(
      expect.objectContaining({ model: 'codex-gpt-5', workingDirectory: '/tmp/work' }),
    );
  });

  it('uses workspace-write sandbox with additionalDirectories when allowedWriteDirs is set', async () => {
    await codexAdapter.createSession({
      profile: makeProfile(),
      cwd: '/tmp/work',
      allowedWriteDirs: ['/tmp/work/src', '/tmp/work/out'],
    });

    expect(state.lastThreadOptions).toEqual(
      expect.objectContaining({
        sandboxMode: 'workspace-write',
        additionalDirectories: ['/tmp/work/src', '/tmp/work/out'],
      }),
    );
  });

  it('uses workspace-write sandbox with empty additionalDirectories by default', async () => {
    await codexAdapter.createSession({
      profile: makeProfile(),
      cwd: '/tmp/work',
    });

    expect(state.lastThreadOptions).toEqual(
      expect.objectContaining({
        sandboxMode: 'workspace-write',
        additionalDirectories: [],
      }),
    );
  });
});

// ─── Resume path ───────────────────────────────────────────────────────────

describe('codex adapter — resume', () => {
  it('uses resumeThread with the resumeSessionPath as thread id', async () => {
    const runtime = await codexAdapter.createSession({
      profile: makeProfile(),
      cwd: '/tmp/work',
      resumeSessionPath: 'thread_resume_999',
    });

    expect(state.resumeThreadCalled).toBe(true);
    expect(state.startThreadCalled).toBe(false);
    expect(state.lastResumeId).toBe('thread_resume_999');
    // sessionId reflects the resumed thread id.
    expect(runtime.sessionId).toBe('thread_resume_999');
  });
});

// ─── Runtime surface ───────────────────────────────────────────────────────

describe('codex adapter — runtime surface', () => {
  it('exposes sessionId from the thread.started event', async () => {
    state.threadId = 'thread_xyz';
    const runtime = await codexAdapter.createSession({
      profile: makeProfile(),
      cwd: '/tmp/work',
    });
    expect(runtime.sessionId).toBe('thread_xyz');
  });

  it('leaves sessionFile and contextWindow undefined', async () => {
    const runtime = await codexAdapter.createSession({
      profile: makeProfile(),
      cwd: '/tmp/work',
    });
    expect(runtime.sessionFile).toBeUndefined();
    expect(runtime.contextWindow).toBeUndefined();
  });
});

// ─── prompt() — event streaming & translation ──────────────────────────────

describe('codex adapter — prompt() event translation', () => {
  it('emits turn_start and turn_end (with usage) for a minimal turn', async () => {
    state.nextEvents = [
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 },
      },
    ];
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });

    const received: AgentRuntimeEvent[] = [];
    runtime.subscribe((e) => received.push(e));
    await runtime.prompt('hi');

    const types = received.map((e) => e.type);
    expect(types).toContain('turn_start');
    const end = received.find((e) => e.type === 'turn_end');
    expect(end).toBeDefined();
    if (end && end.type === 'turn_end') {
      expect(end.message.role).toBe('assistant');
      expect(end.message.usage).toEqual({ input: 7, output: 3 });
    }
  });

  it('buffers the last agent_message text for getLastAssistantText', async () => {
    state.nextEvents = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'first' } },
      { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'second' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
      },
    ];
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });
    await runtime.prompt('do something');

    expect(runtime.getLastAssistantText()).toBe('second');
  });

  it('getLastAssistantMessage carries content and usage from the last turn', async () => {
    state.nextEvents = successTurnEvents('final answer');
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });
    await runtime.prompt('go');

    const msg = runtime.getLastAssistantMessage();
    expect(msg).toBeDefined();
    expect(msg!.usage).toEqual({ input: 100, output: 42 });
    expect(Array.isArray(msg!.content)).toBe(true);
  });

  it('returns undefined usage when the turn has no usage (omits rather than fabricating)', async () => {
    state.nextEvents = [{ type: 'turn.started' }, { type: 'turn.completed', usage: undefined }];
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });

    const received: AgentRuntimeEvent[] = [];
    runtime.subscribe((e) => received.push(e));
    await runtime.prompt('hi');

    const end = received.find((e) => e.type === 'turn_end');
    expect(end).toBeDefined();
    if (end && end.type === 'turn_end') {
      // Usage must be omitted, never fabricated.
      expect(end.message.usage).toBeUndefined();
    }
  });

  it('translates command_execution items into tool_execution_start/end', async () => {
    state.nextEvents = [
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'cmd1',
          type: 'command_execution',
          command: 'ls -la',
          aggregated_output: '',
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'cmd1',
          type: 'command_execution',
          command: 'ls -la',
          aggregated_output: 'out',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
      },
    ];
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });

    const received: AgentRuntimeEvent[] = [];
    runtime.subscribe((e) => received.push(e));
    await runtime.prompt('list files');

    const start = received.find((e) => e.type === 'tool_execution_start');
    expect(start).toBeDefined();
    expect(start && start.type === 'tool_execution_start' && start.toolCallId).toBe('cmd1');

    const end = received.find((e) => e.type === 'tool_execution_end');
    expect(end).toBeDefined();
    expect(end && end.type === 'tool_execution_end' && end.toolCallId).toBe('cmd1');
    expect(end && end.type === 'tool_execution_end' && end.isError).toBe(false);
  });

  it('marks a failed command_execution as isError', async () => {
    state.nextEvents = [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: {
          id: 'cmd2',
          type: 'command_execution',
          command: 'false',
          aggregated_output: '',
          exit_code: 1,
          status: 'failed',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
      },
    ];
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });

    const received: AgentRuntimeEvent[] = [];
    runtime.subscribe((e) => received.push(e));
    await runtime.prompt('run');

    const end = received.find((e) => e.type === 'tool_execution_end');
    expect(end && end.type === 'tool_execution_end' && end.isError).toBe(true);
  });

  it('translates mcp_tool_call items with the tool name as toolName', async () => {
    state.nextEvents = [
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'mcp1',
          type: 'mcp_tool_call',
          server: 'srv',
          tool: 'search',
          arguments: { q: 'x' },
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'mcp1',
          type: 'mcp_tool_call',
          server: 'srv',
          tool: 'search',
          arguments: { q: 'x' },
          status: 'completed',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
      },
    ];
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });

    const received: AgentRuntimeEvent[] = [];
    runtime.subscribe((e) => received.push(e));
    await runtime.prompt('use mcp');

    const start = received.find((e) => e.type === 'tool_execution_start');
    expect(start && start.type === 'tool_execution_start' && start.toolName).toBe('search');
    const end = received.find((e) => e.type === 'tool_execution_end');
    expect(end && end.type === 'tool_execution_end' && end.toolCallId).toBe('mcp1');
  });

  it('passes the input text to runStreamed', async () => {
    state.nextEvents = successTurnEvents();
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });
    await runtime.prompt('build it');
    expect(state.lastInput).toBe('build it');
  });
});

// ─── prompt() — failure handling ───────────────────────────────────────────

describe('codex adapter — turn failure', () => {
  it('rejects prompt when the turn fails', async () => {
    state.nextEvents = [{ type: 'turn.started' }, { type: 'turn.failed', error: { message: 'boom' } }];
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });
    await expect(runtime.prompt('go')).rejects.toThrow();
  });
});

// ─── abort / dispose ───────────────────────────────────────────────────────

describe('codex adapter — abort & dispose', () => {
  it('aborts an in-flight turn via the AbortSignal forwarded to runStreamed', async () => {
    // Script a turn that never yields (the generator completes immediately with
    // no events), so prompt resolves on its own. The adapter still forwards an
    // AbortSignal derived from its internal controller to runStreamed; we
    // verify abort() flips that captured signal to aborted.
    state.nextEvents = [];
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });

    const promptPromise = runtime.prompt('long running');

    // Drain the microtask queue so runStreamed is invoked and the signal is captured.
    await Promise.resolve();
    await Promise.resolve();

    // Sanity: runStreamed was called and a signal was forwarded.
    expect(state.runStreamedCalls).toBeGreaterThanOrEqual(1);
    expect(state.lastSignal).toBeInstanceOf(AbortSignal);
    expect(state.lastSignal!.aborted).toBe(false);

    await runtime.abort();
    expect(state.lastSignal!.aborted).toBe(true);

    // Ensure the prompt promise settles (no hanging).
    await promptPromise;
  });

  it('dispose() can be called without throwing', async () => {
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });
    expect(() => runtime.dispose()).not.toThrow();
  });

  it('dispose() is idempotent', async () => {
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });
    runtime.dispose();
    expect(() => runtime.dispose()).not.toThrow();
  });
});

// ─── subscribe / unsubscribe ───────────────────────────────────────────────

describe('codex adapter — subscribe', () => {
  it('subscribe returns an unsubscribe function that stops delivery', async () => {
    state.nextEvents = [
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
      },
    ];
    const runtime = await codexAdapter.createSession({ profile: makeProfile(), cwd: '/tmp/work' });

    const received: AgentRuntimeEvent[] = [];
    const unsub = runtime.subscribe((e) => received.push(e));
    expect(typeof unsub).toBe('function');

    await runtime.prompt('first');
    expect(received.length).toBeGreaterThan(0);

    unsub();
    received.length = 0;

    state.nextEvents = [
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
      },
    ];
    await runtime.prompt('second');
    expect(received.length).toBe(0);
  });
});

// ─── onAgentStatus forwarding ──────────────────────────────────────────────

describe('codex adapter — onAgentStatus forwarding', () => {
  it('forwards translated events to onAgentStatus callbacks when handlers present', async () => {
    state.nextEvents = successTurnEvents('done');

    const turnStart = mock();
    const turnEnd = mock();

    const runtime = await codexAdapter.createSession({
      profile: makeProfile(),
      cwd: '/tmp/work',
      agentId: 'agent-7',
      onAgentStatus: { onTurnStart: turnStart, onTurnEnd: turnEnd },
    });

    await runtime.prompt('go');

    expect(turnStart).toHaveBeenCalledTimes(1);
    expect(turnStart.mock.calls[0][0]).toEqual(expect.objectContaining({ agentId: 'agent-7' }));

    expect(turnEnd).toHaveBeenCalledTimes(1);
    const endArg = turnEnd.mock.calls[0][0];
    expect(endArg.agentId).toBe('agent-7');
    expect(endArg.tokens).toEqual({ input: 100, output: 42 });
  });
});
