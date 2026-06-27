// ─── Tests for sessions/pi-coding-agent/adapter.ts — AgentPlugin extraction ────
//
// Validates the pi-coding-agent adapter that implements `AgentPlugin`. This is
// a pure extraction of `createHarness` (core/harness-factory.ts) into the
// `sessions/pi-coding-agent/` directory. Every behavior must be byte-for-byte
// identical to the current `createHarness`.
//
// The adapter wires together heavy pi-specific internals (AuthStorage,
// SessionManager, createAgentSession, DefaultResourceLoader, getModel). To keep
// the tests deterministic and free of network/credential access, the external
// packages `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and the
// local `./write-sandbox.js` are mocked via `mock.module`. The real core
// helpers (extractLastAssistantMessage, createAgentEventForwarder, DEFAULT_TOOLS)
// are used as-is — those are pure and already unit-tested elsewhere.
//
// Module under test: ./adapter.js

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { AgentProfile } from '../../core/types.js';

// ─── Capture real modules before mocking ───────────────────────────────────
//
// Saved so they can be restored in `afterAll`, mirroring the pattern used in
// agent-lifecycle.test.ts / phase-tasks.test.ts.

const realPiAi = Object.assign({}, await import('@earendil-works/pi-ai'));
const realPiAgent = Object.assign({}, await import('@earendil-works/pi-coding-agent'));
const realWriteSandbox = Object.assign({}, await import('./write-sandbox.js'));

// ─── Mock handles ───────────────────────────────────────────────────────────

/** getModel(provider, model) → Model | null. */
const getModelMock = mock((_provider: any, _model: any): { contextWindow: number } | null => ({
  contextWindow: 200000,
}));

/** AuthStorage.create() returns this instance; spies record setRuntimeApiKey calls. */
let authStorageInstance: { setRuntimeApiKey: ReturnType<typeof mock> };
const authStorageCreateMock = mock((): typeof authStorageInstance => authStorageInstance);

/** createAgentSession(config) → { session }. Captures the resolved config. */
let createAgentSessionCaptured: Record<string, unknown> | undefined;
let currentSession: MockSession;
const createAgentSessionMock = mock(async (config: Record<string, unknown>) => {
  createAgentSessionCaptured = config;
  return { session: currentSession };
});

/** createWriteSandboxExtension({ allowedDirs, cwd }) → ExtensionFactory. */
const createWriteSandboxExtensionMock = mock(() => (): void => undefined);

/** DefaultResourceLoader — class capturing constructor args + a spyable reload(). */
let resourceLoaderCaptured: Record<string, unknown> | undefined;
let resourceLoaderInstance: { reload: ReturnType<typeof mock> } | undefined;
class MockDefaultResourceLoader {
  reload: ReturnType<typeof mock>;
  constructor(config: Record<string, unknown>) {
    resourceLoaderCaptured = config;
    this.reload = mock(async () => {});
    resourceLoaderInstance = { reload: this.reload };
  }
}

/** SessionManager — records which static method was invoked. */
let sessionManagerMethod: 'open' | 'create' | 'inMemory' | undefined;
let sessionManagerArgs: unknown[] | undefined;
const SessionManagerMock = {
  open: mock((...args: unknown[]) => {
    sessionManagerMethod = 'open';
    sessionManagerArgs = args;
    return { kind: 'session-manager', mode: 'open' };
  }),
  create: mock((...args: unknown[]) => {
    sessionManagerMethod = 'create';
    sessionManagerArgs = args;
    return { kind: 'session-manager', mode: 'create' };
  }),
  inMemory: mock((...args: unknown[]) => {
    sessionManagerMethod = 'inMemory';
    sessionManagerArgs = args;
    return { kind: 'session-manager', mode: 'inMemory' };
  }),
};

// ─── Register mocks ─────────────────────────────────────────────────────────

mock.module('@earendil-works/pi-ai', () => ({
  ...realPiAi,
  getModel: getModelMock,
}));

mock.module('@earendil-works/pi-coding-agent', () => ({
  ...realPiAgent,
  AuthStorage: Object.assign(
    class FakeAuthStorage {
      static create = authStorageCreateMock;
      setRuntimeApiKey(_provider: string, _key: string): void {}
    },
    { create: authStorageCreateMock },
  ),
  createAgentSession: createAgentSessionMock,
  DefaultResourceLoader: MockDefaultResourceLoader,
  SessionManager: SessionManagerMock,
}));

mock.module('./write-sandbox.js', () => ({
  ...realWriteSandbox,
  createWriteSandboxExtension: createWriteSandboxExtensionMock,
}));

// ─── Import adapter AFTER mocks are registered ──────────────────────────────
//
// Importing the adapter triggers its self-registration side effect
// (`registerAgentPlugin(piCodingAgentAdapter)`).

import type { AgentRuntime, AgentRuntimeEvent } from '../../core/agent-plugin.js';
import { getAgentPlugin, hasAgentPlugin, registerAgentPlugin } from '../../core/agent-registry.js';
import './adapter.js';
import { piCodingAgentAdapter } from './adapter.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a fully-spyable mock pi AgentSession. */
function makeMockSession(id = 'session-1'): MockSession {
  const subscribeListeners: Array<(e: unknown) => void> = [];
  return {
    sessionId: id,
    sessionFile: '/tmp/sessions/' + id + '.jsonl',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'hello there' }],
        usage: { input: 12, output: 34 },
      },
    ],
    prompt: mock(async (_text: string, _opts?: unknown) => {}),
    getLastAssistantText: mock(() => 'hello there'),
    abort: mock(async () => {}),
    dispose: mock(() => {}),
    subscribe: mock((listener: (e: unknown) => void) => {
      subscribeListeners.push(listener);
      return () => {
        const idx = subscribeListeners.indexOf(listener);
        if (idx >= 0) subscribeListeners.splice(idx, 1);
      };
    }),
    _listeners: subscribeListeners,
  };
}

interface MockSession {
  sessionId: string;
  sessionFile?: string;
  messages: unknown[];
  prompt: ReturnType<typeof mock>;
  getLastAssistantText: ReturnType<typeof mock>;
  abort: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
  subscribe: ReturnType<typeof mock>;
  _listeners: Array<(e: unknown) => void>;
}

/** Minimal valid AgentProfile for tests. */
function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'coder',
    name: 'Coder',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    thinkingLevel: 'medium',
    systemPrompt: 'You are a coding agent.',
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}

/** Reset all mock call records + captured state before each test. */
beforeEach(() => {
  // Re-register the adapter into the test's own registry handle so each test
  // is independent of cross-file registry state. Other test files that import
  // the engine barrel trigger the real adapters' self-registration and can
  // clear/replace the shared registry concurrently; re-registering here
  // guarantees this suite always observes the pi-coding-agent plugin
  // regardless of execution order.
  registerAgentPlugin(piCodingAgentAdapter);
  getModelMock.mockReset();
  // Restore default getModel return value after mockReset clears it.
  getModelMock.mockReturnValue({ contextWindow: 200000 });
  authStorageCreateMock.mockReset();
  createAgentSessionMock.mockReset();
  createWriteSandboxExtensionMock.mockReset();
  SessionManagerMock.open.mockReset();
  SessionManagerMock.open.mockImplementation((...args: unknown[]) => {
    sessionManagerMethod = 'open';
    sessionManagerArgs = args;
    return { kind: 'session-manager', mode: 'open' };
  });
  SessionManagerMock.create.mockReset();
  SessionManagerMock.create.mockImplementation((...args: unknown[]) => {
    sessionManagerMethod = 'create';
    sessionManagerArgs = args;
    return { kind: 'session-manager', mode: 'create' };
  });
  SessionManagerMock.inMemory.mockReset();
  SessionManagerMock.inMemory.mockImplementation((...args: unknown[]) => {
    sessionManagerMethod = 'inMemory';
    sessionManagerArgs = args;
    return { kind: 'session-manager', mode: 'inMemory' };
  });

  authStorageInstance = { setRuntimeApiKey: mock() };
  authStorageCreateMock.mockReturnValue(authStorageInstance);

  createAgentSessionMock.mockImplementation(async (config) => {
    createAgentSessionCaptured = config;
    return { session: currentSession };
  });

  createWriteSandboxExtensionMock.mockReturnValue((): void => undefined);

  createAgentSessionCaptured = undefined;
  resourceLoaderCaptured = undefined;
  resourceLoaderInstance = undefined;
  sessionManagerMethod = undefined;
  sessionManagerArgs = undefined;

  currentSession = makeMockSession();
});

// ─── Self-registration ─────────────────────────────────────────────────────

describe('pi-coding-agent adapter — self-registration', () => {
  it('registers under id "pi-coding-agent" when the module is imported', () => {
    expect(hasAgentPlugin('pi-coding-agent')).toBe(true);
    const plugin = getAgentPlugin('pi-coding-agent');
    expect(plugin).toBeDefined();
    expect(plugin!.id).toBe('pi-coding-agent');
  });

  it('exposes a createSession function', () => {
    const plugin = getAgentPlugin('pi-coding-agent');
    expect(typeof plugin!.createSession).toBe('function');
  });
});

// ─── Model resolution ──────────────────────────────────────────────────────

describe('createSession — model resolution', () => {
  it('throws when getModel returns null/undefined', async () => {
    getModelMock.mockReturnValue(null);
    const profile = makeProfile({ provider: 'bogus', model: 'no-such-model' });
    const plugin = getAgentPlugin('pi-coding-agent')!;

    let thrown: unknown;
    try {
      await plugin.createSession({ profile, cwd: '/tmp/proj' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('Unknown model "no-such-model"');
    expect((thrown as Error).message).toContain('provider "bogus"');
    expect((thrown as Error).message).toContain('Check the provider and model identifiers.');
  });

  it('calls getModel with profile.provider and profile.model', async () => {
    const profile = makeProfile({ provider: 'openai', model: 'gpt-4o' });
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({ profile, cwd: '/tmp/proj' });

    expect(getModelMock).toHaveBeenCalledTimes(1);
    expect(getModelMock).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('surfaces the resolved model contextWindow on the runtime', async () => {
    getModelMock.mockReturnValue({ contextWindow: 131072 });
    const plugin = getAgentPlugin('pi-coding-agent')!;

    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(runtime.contextWindow).toBe(131072);
  });
});

// ─── Auth storage ───────────────────────────────────────────────────────────

describe('createSession — auth storage', () => {
  it('creates an AuthStorage via AuthStorage.create()', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(authStorageCreateMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionCaptured!.authStorage).toBe(authStorageInstance);
  });

  it('applies apiKeys as runtime overrides via setRuntimeApiKey', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      apiKeys: { anthropic: 'sk-ant-xxx', openai: 'sk-oai-yyy' },
    });

    expect(authStorageInstance.setRuntimeApiKey).toHaveBeenCalledTimes(2);
    expect(authStorageInstance.setRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-xxx');
    expect(authStorageInstance.setRuntimeApiKey).toHaveBeenCalledWith('openai', 'sk-oai-yyy');
  });

  it('does not call setRuntimeApiKey when apiKeys is omitted', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(authStorageInstance.setRuntimeApiKey).not.toHaveBeenCalled();
  });
});

// ─── Tool building ──────────────────────────────────────────────────────────

describe('createSession — tool building (include/exclude)', () => {
  it('uses the full DEFAULT_TOOLS set when no include/exclude is given', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(createAgentSessionCaptured!.tools).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  });

  it('restricts to the intersection of includeTools and DEFAULT_TOOLS', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    // includeTools includes a name not in DEFAULT_TOOLS to confirm filtering.
    const profile = makeProfile({ includeTools: ['bash', 'read', 'nonexistent-tool'] });

    await plugin.createSession({ profile, cwd: '/tmp/proj' });

    // Only names that are in DEFAULT_TOOLS survive; order follows DEFAULT_TOOLS.
    expect(createAgentSessionCaptured!.tools).toEqual(['read', 'bash']);
  });

  it('falls back to full DEFAULT_TOOLS when includeTools is empty', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const profile = makeProfile({ includeTools: [] });

    await plugin.createSession({ profile, cwd: '/tmp/proj' });

    expect(createAgentSessionCaptured!.tools).toHaveLength(7);
  });

  it('removes excluded tools from the built set', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const profile = makeProfile({ excludeTools: ['bash', 'edit'] });

    await plugin.createSession({ profile, cwd: '/tmp/proj' });

    const tools = createAgentSessionCaptured!.tools as string[];
    expect(tools).not.toContain('bash');
    expect(tools).not.toContain('edit');
    expect(tools).toEqual(['read', 'write', 'grep', 'find', 'ls']);
  });

  it('applies include then exclude in sequence', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const profile = makeProfile({ includeTools: ['read', 'bash', 'write'], excludeTools: ['write'] });

    await plugin.createSession({ profile, cwd: '/tmp/proj' });

    // read, bash survive include filtering; write is then excluded.
    expect(createAgentSessionCaptured!.tools).toEqual(['read', 'bash']);
  });

  it('forwards thinkingLevel from the profile', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const profile = makeProfile({ thinkingLevel: 'high' });

    await plugin.createSession({ profile, cwd: '/tmp/proj' });

    expect(createAgentSessionCaptured!.thinkingLevel).toBe('high');
  });
});

// ─── Write sandbox ──────────────────────────────────────────────────────────

describe('createSession — write sandbox', () => {
  it('does not build a write-sandbox extension when allowedWriteDirs is empty', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj', allowedWriteDirs: [] });

    expect(createWriteSandboxExtensionMock).not.toHaveBeenCalled();
  });

  it('does not build a write-sandbox extension when allowedWriteDirs is omitted', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(createWriteSandboxExtensionMock).not.toHaveBeenCalled();
  });

  it('builds a write-sandbox extension with allowedDirs and cwd when allowedWriteDirs is non-empty', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      allowedWriteDirs: ['/tmp/proj/src', '/tmp/proj/out'],
    });

    expect(createWriteSandboxExtensionMock).toHaveBeenCalledTimes(1);
    expect(createWriteSandboxExtensionMock).toHaveBeenCalledWith({
      allowedDirs: ['/tmp/proj/src', '/tmp/proj/out'],
      cwd: '/tmp/proj',
    });
  });

  it('passes the sandbox factory into the resource loader extensionFactories', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const sentinel = (): void => undefined;
    createWriteSandboxExtensionMock.mockReturnValue(sentinel);

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      allowedWriteDirs: ['/tmp/proj/src'],
    });

    expect(Array.isArray(resourceLoaderCaptured!.extensionFactories)).toBe(true);
    expect(resourceLoaderCaptured!.extensionFactories).toContain(sentinel);
  });

  it('passes an empty extensionFactories array when no sandbox is requested', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(resourceLoaderCaptured!.extensionFactories).toEqual([]);
  });
});

// ─── Resource loader ────────────────────────────────────────────────────────

describe('createSession — resource loader', () => {
  it('constructs DefaultResourceLoader with cwd, agentDir, systemPromptOverride, and calls reload', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const profile = makeProfile({ systemPrompt: 'CUSTOM PROMPT' });

    await plugin.createSession({ profile, cwd: '/tmp/proj' });

    expect(resourceLoaderCaptured).toBeDefined();
    expect(resourceLoaderCaptured!.cwd).toBe('/tmp/proj');
    expect(resourceLoaderCaptured!.agentDir).toBe('/tmp/proj');
    const override = resourceLoaderCaptured!.systemPromptOverride as () => string;
    expect(typeof override).toBe('function');
    expect(override()).toBe('CUSTOM PROMPT');
    // reload() must be awaited exactly once before session creation.
    expect(resourceLoaderInstance).toBeDefined();
    expect(resourceLoaderInstance!.reload).toHaveBeenCalledTimes(1);
    expect(createAgentSessionCaptured!.resourceLoader).toBeDefined();
  });
});

// ─── Session manager selection ──────────────────────────────────────────────

describe('createSession — session manager selection', () => {
  it('uses SessionManager.open when resumeSessionPath is provided', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      resumeSessionPath: '/tmp/sessions/abc.jsonl',
    });

    expect(sessionManagerMethod).toBe('open');
    expect(sessionManagerArgs).toEqual(['/tmp/sessions/abc.jsonl', undefined, '/tmp/proj']);
  });

  it('uses SessionManager.create when sessionDir is provided', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      sessionDir: '/tmp/sessions',
    });

    expect(sessionManagerMethod).toBe('create');
    expect(sessionManagerArgs).toEqual(['/tmp/proj', '/tmp/sessions']);
  });

  it('uses SessionManager.inMemory when neither resume nor sessionDir is provided', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(sessionManagerMethod).toBe('inMemory');
    expect(sessionManagerArgs).toEqual(['/tmp/proj']);
  });

  it('prefers resumeSessionPath over sessionDir', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      sessionDir: '/tmp/sessions',
      resumeSessionPath: '/tmp/sessions/abc.jsonl',
    });

    expect(sessionManagerMethod).toBe('open');
  });

  it('passes the session manager into createAgentSession', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(createAgentSessionCaptured!.sessionManager).toEqual({ kind: 'session-manager', mode: 'inMemory' });
  });
});

// ─── createAgentSession wiring ─────────────────────────────────────────────

describe('createSession — createAgentSession wiring', () => {
  it('passes model, tools, resourceLoader, and authStorage to createAgentSession', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const model = { contextWindow: 99000 };
    getModelMock.mockReturnValue(model);

    await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionCaptured!.model).toBe(model);
    expect(createAgentSessionCaptured!.tools).toBeDefined();
    expect(createAgentSessionCaptured!.resourceLoader).toBeDefined();
    expect(createAgentSessionCaptured!.authStorage).toBe(authStorageInstance);
  });
});

// ─── AgentRuntime delegation ────────────────────────────────────────────────

describe('createSession — AgentRuntime delegation', () => {
  it('surfaces sessionId and sessionFile from the underlying session', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    currentSession = makeMockSession('xyz-123');

    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(runtime.sessionId).toBe('xyz-123');
    expect(runtime.sessionFile).toBe('/tmp/sessions/xyz-123.jsonl');
  });

  it('prompt delegates to session.prompt with text and options', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    const signal = new AbortController().signal;
    await runtime.prompt('do something', { signal });

    expect(currentSession.prompt).toHaveBeenCalledTimes(1);
    expect(currentSession.prompt).toHaveBeenCalledWith('do something', { signal });
  });

  it('prompt works without options', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    await runtime.prompt('hello');

    expect(currentSession.prompt).toHaveBeenCalledWith('hello', undefined);
  });

  it('getLastAssistantText delegates to session.getLastAssistantText', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(runtime.getLastAssistantText()).toBe('hello there');
    expect(currentSession.getLastAssistantText).toHaveBeenCalledTimes(1);
  });

  it('getLastAssistantMessage extracts from session.messages via extractLastAssistantMessage', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    const msg = runtime.getLastAssistantMessage();
    expect(msg).toBeDefined();
    expect(msg!.stopReason).toBe('end_turn');
    expect(msg!.usage?.input).toBe(12);
    expect(msg!.usage?.output).toBe(34);
  });

  it('getLastAssistantMessage returns undefined when no assistant message exists', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    currentSession = makeMockSession();
    currentSession.messages = [{ role: 'user', content: [] }];

    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    expect(runtime.getLastAssistantMessage()).toBeUndefined();
  });

  it('abort delegates to session.abort', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    await runtime.abort();

    expect(currentSession.abort).toHaveBeenCalledTimes(1);
  });

  it('dispose calls session.dispose', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    runtime.dispose();

    expect(currentSession.dispose).toHaveBeenCalledTimes(1);
  });
});

// ─── AgentRuntime subscribe delegation ──────────────────────────────────────

describe('createSession — runtime.subscribe delegation', () => {
  it('delegates subscribe to session.subscribe and forwards emitted events', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    const received: AgentRuntimeEvent[] = [];
    runtime.subscribe((e) => received.push(e));

    // session.subscribe was called by runtime.subscribe (in addition to any
    // forwarding subscription from createSession).
    expect(currentSession.subscribe.mock.calls.length).toBeGreaterThanOrEqual(1);

    const event: AgentRuntimeEvent = { type: 'turn_start' };
    // Emit through the most-recently-registered listener.
    const lastListener = currentSession._listeners[currentSession._listeners.length - 1];
    lastListener(event);

    expect(received).toEqual([{ type: 'turn_start' }]);
  });

  it('returns an unsubscribe function that stops event delivery', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const runtime = await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    const received: AgentRuntimeEvent[] = [];
    const unsub = runtime.subscribe((e) => received.push(e));
    expect(typeof unsub).toBe('function');

    const listenerCountBefore = currentSession._listeners.length;
    unsub();
    expect(currentSession._listeners.length).toBe(listenerCountBefore - 1);

    // The unsubscribed callback is gone; no remaining listener can deliver to it.
    expect(received).toHaveLength(0);
  });
});

// ─── Status-callback forwarding subscription ────────────────────────────────

describe('createSession — agent status forwarding', () => {
  it('does not subscribe a forwarder when onAgentStatus is omitted', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({ profile: makeProfile(), cwd: '/tmp/proj' });

    // No forwarding subscription — session.subscribe should not have been
    // called during createSession.
    expect(currentSession.subscribe).not.toHaveBeenCalled();
  });

  it('does not subscribe a forwarder when onAgentStatus has no handlers', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      onAgentStatus: {},
    });

    expect(currentSession.subscribe).not.toHaveBeenCalled();
  });

  it('subscribes a forwarder when at least one handler is defined', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const onTurnStart = mock((_info: { agentId: string; turn: number }) => {});

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      onAgentStatus: { onTurnStart },
    });

    expect(currentSession.subscribe).toHaveBeenCalledTimes(1);

    // Emit a turn_start event through the forwarder; the handler should fire.
    const listener = currentSession._listeners[0];
    listener({ type: 'turn_start' });

    expect(onTurnStart).toHaveBeenCalledTimes(1);
    expect(onTurnStart.mock.calls[0][0].turn).toBe(1);
  });

  it('uses agentId for forwarded events when provided', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const onTurnStart = mock((_info: { agentId: string; turn: number }) => {});

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      agentId: 'agent-XYZ',
      onAgentStatus: { onTurnStart },
    });

    const listener = currentSession._listeners[0];
    listener({ type: 'turn_start' });

    expect(onTurnStart).toHaveBeenCalledTimes(1);
    expect(onTurnStart.mock.calls[0][0].agentId).toBe('agent-XYZ');
  });

  it('falls back to sessionId for forwarded events when agentId is omitted', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const onTurnStart = mock((_info: { agentId: string; turn: number }) => {});
    currentSession = makeMockSession('fallback-sid');

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      onAgentStatus: { onTurnStart },
    });

    const listener = currentSession._listeners[0];
    listener({ type: 'turn_start' });

    expect(onTurnStart.mock.calls[0][0].agentId).toBe('fallback-sid');
  });

  it('forwards tool_execution_end events to onToolCallEnd', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const onToolCallEnd = mock(
      (_info: { agentId: string; toolName: string; toolCallId: string; isError: boolean }) => {},
    );

    await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      onAgentStatus: { onToolCallEnd },
    });

    const listener = currentSession._listeners[0];
    listener({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'tc-1', isError: false });

    expect(onToolCallEnd).toHaveBeenCalledTimes(1);
    expect(onToolCallEnd.mock.calls[0][0].toolName).toBe('bash');
    expect(onToolCallEnd.mock.calls[0][0].isError).toBe(false);
  });
});

// ─── dispose unsubscribes the forwarder ─────────────────────────────────────

describe('createSession — dispose unsubscribes forwarder', () => {
  it('dispose removes the forwarding subscription before disposing the session', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const onTurnStart = mock(() => {});

    const runtime = await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
      onAgentStatus: { onTurnStart },
    });

    // createSession registered exactly one forwarding listener.
    expect(currentSession._listeners).toHaveLength(1);

    runtime.dispose();

    // Forwarder unsubscribed, then session disposed.
    expect(currentSession._listeners).toHaveLength(0);
    expect(currentSession.dispose).toHaveBeenCalledTimes(1);
  });
});

// ─── AgentRuntime interface satisfaction ────────────────────────────────────

describe('createSession — returned object satisfies AgentRuntime', () => {
  it('the returned runtime satisfies the AgentRuntime interface', async () => {
    const plugin = getAgentPlugin('pi-coding-agent')!;
    const runtime: AgentRuntime = await plugin.createSession({
      profile: makeProfile(),
      cwd: '/tmp/proj',
    });

    expect(typeof runtime.prompt).toBe('function');
    expect(typeof runtime.getLastAssistantText).toBe('function');
    expect(typeof runtime.getLastAssistantMessage).toBe('function');
    expect(typeof runtime.abort).toBe('function');
    expect(typeof runtime.dispose).toBe('function');
    expect(typeof runtime.subscribe).toBe('function');
    expect(typeof runtime.sessionId).toBe('string');
  });
});

// ─── Restore real modules ───────────────────────────────────────────────────

afterAll(() => {
  mock.module('@earendil-works/pi-ai', () => realPiAi);
  mock.module('@earendil-works/pi-coding-agent', () => realPiAgent);
  mock.module('./write-sandbox.js', () => realWriteSandbox);
});
