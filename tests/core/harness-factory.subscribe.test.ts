import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { makeProfile } from '../helpers/make-profile.js';

// Capture real modules before mocking so we can restore them in afterAll.
const realPiCodingAgent = Object.assign({}, await import('@earendil-works/pi-coding-agent'));
const realPiAi = Object.assign({}, await import('@earendil-works/pi-ai'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

// We need a reference to the listener so tests can simulate events.
let capturedListener: ((event: any) => void) | undefined;
let mockUnsubscribe: (() => void) | undefined;

const mockAuthStorageInstance = {
  setRuntimeApiKey: mock(),
};

const mockDefaultResourceLoaderInstance = {
  reload: mock(async () => {}),
};

// Mock createAgentSession — subscribe is on the session object
const mockCreateAgentSession = mock(async () => ({
  session: {
    prompt: mock(async () => {}),
    subscribe: mock().mockImplementation((listener: (event: any) => void) => {
      capturedListener = listener;
      mockUnsubscribe = mock();
      return mockUnsubscribe;
    }),
    getLastAssistantText: mock(() => 'mock response'),
    messages: [],
    sessionId: 'mock-session-id',
  },
}));

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: { inMemory: mock(() => ({ getSessionId: () => 'mock-session-id' })) },
  AuthStorage: { create: mock(() => mockAuthStorageInstance) },
  DefaultResourceLoader: mock().mockImplementation(() => mockDefaultResourceLoaderInstance),
}));

// Mock getModel
const mockGetModel = mock();
mock.module('@earendil-works/pi-ai', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { createHarness } from '../../src/core/harness-factory.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockModel = { id: 'gpt-4o', provider: 'openai', cost: { input: 0, output: 0 } };

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mock.clearAllMocks();
  mockGetModel.mockReturnValue(mockModel);
  mockAuthStorageInstance.setRuntimeApiKey = mock();
  capturedListener = undefined;
  mockUnsubscribe = undefined;
  mockDefaultResourceLoaderInstance.reload = mock(async () => {});
  // Re-seed createAgentSession with a fresh subscribe mock
  mockCreateAgentSession.mockResolvedValue({
    session: {
      prompt: mock(async () => {}),
      subscribe: mock().mockImplementation((listener: (event: any) => void) => {
        capturedListener = listener;
        mockUnsubscribe = mock();
        return mockUnsubscribe;
      }),
      getLastAssistantText: mock(() => 'mock response'),
      messages: [],
      sessionId: 'mock-session-id',
      dispose: mock(),
    },
  });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('harness subscribe forwarding', () => {
  it('subscribe not called when onAgentStatus is undefined', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
    });

    const sessionResult = mockCreateAgentSession.mock.results[0].value;
    const session = await sessionResult;
    expect(session.session.subscribe).not.toHaveBeenCalled();
  });

  it('subscribe not called when onAgentStatus has no methods', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: {},
    });

    const sessionResult = mockCreateAgentSession.mock.results[0].value;
    const session = await sessionResult;
    expect(session.session.subscribe).not.toHaveBeenCalled();
  });

  it('subscribe called when onTurnStart is defined', async () => {
    const onTurnStart = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnStart },
    });

    const sessionResult = mockCreateAgentSession.mock.results[0].value;
    const session = await sessionResult;
    expect(session.session.subscribe).toHaveBeenCalledTimes(1);
    expect(capturedListener).toBeTypeOf('function');
  });

  it('turn_start event forwarded', async () => {
    const onTurnStart = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnStart },
    });

    capturedListener!({ type: 'turn_start' });

    expect(onTurnStart).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      turn: 1,
    });
  });

  it('turn_end event forwarded with tokens', async () => {
    const onTurnEnd = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnEnd },
    });

    capturedListener!({
      type: 'turn_end',
      message: { role: 'assistant', usage: { input: 100, output: 50 } },
    });

    expect(onTurnEnd).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      turn: 0,
      tokens: { input: 100, output: 50 },
      contentBlocks: undefined,
    });
  });

  it('turn_end forwards assistant content blocks', async () => {
    const onTurnEnd = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnEnd },
    });

    capturedListener!({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello world' },
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/foo.ts' } },
        ],
      },
    });

    expect(onTurnEnd).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      turn: 0,
      tokens: undefined,
      contentBlocks: [
        { type: 'text', text: 'Hello world' },
        { type: 'thinking', thinking: 'Let me think...' },
        { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/foo.ts' } },
      ],
    });
  });

  it('turn_end with non-assistant message passes undefined contentBlocks', async () => {
    const onTurnEnd = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnEnd },
    });

    capturedListener!({
      type: 'turn_end',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'user message' }],
        usage: { input: 10, output: 5 },
      },
    });

    expect(onTurnEnd).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      turn: 0,
      tokens: undefined,
      contentBlocks: undefined,
    });
  });

  it('turn_end with redacted thinking block', async () => {
    const onTurnEnd = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnEnd },
    });

    capturedListener!({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', redacted: true }],
      },
    });

    expect(onTurnEnd).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      turn: 0,
      tokens: undefined,
      contentBlocks: [{ type: 'thinking', thinking: '', redacted: true }],
    });
  });

  it('turn_end with empty content array', async () => {
    const onTurnEnd = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnEnd },
    });

    capturedListener!({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [],
      },
    });

    expect(onTurnEnd).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      turn: 0,
      tokens: undefined,
      contentBlocks: [],
    });
  });

  it('turn counter increments', async () => {
    const onTurnStart = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnStart },
    });

    capturedListener!({ type: 'turn_start' });
    capturedListener!({ type: 'turn_start' });

    expect(onTurnStart).toHaveBeenCalledTimes(2);
    expect(onTurnStart).toHaveBeenNthCalledWith(1, {
      agentId: 'mock-session-id',
      turn: 1,
    });
    expect(onTurnStart).toHaveBeenNthCalledWith(2, {
      agentId: 'mock-session-id',
      turn: 2,
    });
  });

  it('tool_execution_start event forwarded', async () => {
    const onToolCallStart = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onToolCallStart },
    });

    capturedListener!({
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'call_abc',
    });

    expect(onToolCallStart).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      toolName: 'read',
      toolCallId: 'call_abc',
      arguments: {},
    });
  });

  it('tool_execution_start forwards args from upstream event', async () => {
    const onToolCallStart = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onToolCallStart },
    });

    capturedListener!({
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'call_def',
      args: { path: '/foo.ts' },
    });

    expect(onToolCallStart).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      toolName: 'read',
      toolCallId: 'call_def',
      arguments: { path: '/foo.ts' },
    });
  });

  it('tool_execution_start defaults arguments to {} when args is undefined', async () => {
    const onToolCallStart = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onToolCallStart },
    });

    capturedListener!({
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'call_ghi',
    });

    expect(onToolCallStart).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      toolName: 'bash',
      toolCallId: 'call_ghi',
      arguments: {},
    });
  });

  it('tool_execution_end event forwarded', async () => {
    const onToolCallEnd = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onToolCallEnd },
    });

    capturedListener!({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'call_xyz',
      isError: true,
    });

    expect(onToolCallEnd).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      toolName: 'bash',
      toolCallId: 'call_xyz',
      isError: true,
    });
  });

  it('harness-specific events ignored', async () => {
    const onTurnStart = mock();
    const onTurnEnd = mock();
    const onToolCallStart = mock();
    const onToolCallEnd = mock();

    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnStart, onTurnEnd, onToolCallStart, onToolCallEnd },
    });

    capturedListener!({ type: 'settled' });

    expect(onTurnStart).not.toHaveBeenCalled();
    expect(onTurnEnd).not.toHaveBeenCalled();
    expect(onToolCallStart).not.toHaveBeenCalled();
    expect(onToolCallEnd).not.toHaveBeenCalled();
  });

  it('unsubscribe function is returned and callable', async () => {
    const onTurnStart = mock();
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnStart },
    });

    // Unsubscribe before firing an event
    mockUnsubscribe!();

    capturedListener!({ type: 'turn_start' });

    // The mock session cannot simulate actual forwarding suppression.
    // Verify the unsubscribe function was returned and is callable.
    expect(mockUnsubscribe).toBeTypeOf('function');
    expect(onTurnStart).toHaveBeenCalledWith({
      agentId: 'mock-session-id',
      turn: 1,
    });
  });

  it('dispose always returned in result', async () => {
    const onTurnStart = mock();
    const result = await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      onAgentStatus: { onTurnStart },
    });

    expect(result.dispose).toBeTypeOf('function');
  });

  it('dispose returned in result when subscribe was not called', async () => {
    const result = await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
    });

    expect(result.dispose).toBeTypeOf('function');
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('@earendil-works/pi-coding-agent', () => realPiCodingAgent);
  mock.module('@earendil-works/pi-ai', () => realPiAi);
});
