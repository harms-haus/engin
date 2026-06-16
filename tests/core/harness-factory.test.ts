import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { makeProfile } from '../helpers/make-profile.js';

// Capture real modules before mocking so we can restore them in afterAll.
const realPiCodingAgent = Object.assign({}, await import('@earendil-works/pi-coding-agent'));
const realPiAi = Object.assign({}, await import('@earendil-works/pi-ai'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock createAgentSession
const mockCreateAgentSession = mock(async () => ({
  session: {
    prompt: mock(async () => {}),
    subscribe: mock(() => mock()),
    getLastAssistantText: mock(() => 'mock response'),
    messages: [],
    sessionId: 'mock-session-id',
  },
}));

const mockSessionManagerInMemory = mock(() => ({
  getSessionId: () => 'mock-session-id',
}));

const mockAuthStorageInstance = {
  setRuntimeApiKey: mock(),
};

const mockDefaultResourceLoaderInstance = {
  reload: mock(async () => {}),
};

const mockSessionManagerCreate = mock(() => ({
  getSessionId: () => 'persisted-session-id',
}));

const mockSessionManagerOpen = mock(() => ({
  getSessionId: () => 'resumed-session-id',
}));

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: {
    inMemory: mockSessionManagerInMemory,
    create: mockSessionManagerCreate,
    open: mockSessionManagerOpen,
  },
  AuthStorage: { create: mock(() => mockAuthStorageInstance) },
  DefaultResourceLoader: mock().mockImplementation(() => mockDefaultResourceLoaderInstance),
}));

// Mock getModel
const mockGetModel = mock();
mock.module('@earendil-works/pi-ai', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { AuthStorage, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent';
import { createHarness } from '../../packages/engine/src/core/harness-factory.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockModel = { id: 'gpt-4o', provider: 'openai', cost: { input: 0, output: 0 } };

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mock.clearAllMocks();
  mockGetModel.mockReturnValue(mockModel);
  // Reset mockAuthStorageInstance.setRuntimeApiKey since it's not auto-cleared
  mockAuthStorageInstance.setRuntimeApiKey = mock();
  // Re-seed the mock module factories so fresh instances are returned
  mockCreateAgentSession.mockResolvedValue({
    session: {
      prompt: mock(async () => {}),
      subscribe: mock(() => mock()),
      getLastAssistantText: mock(() => 'mock response'),
      messages: [],
      sessionId: 'mock-session-id',
    },
  });
  mockDefaultResourceLoaderInstance.reload = mock(async () => {});
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createHarness', () => {
  it('creates an in-memory session via SessionManager.inMemory', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/my/project',
    });

    expect(SessionManager.inMemory).toHaveBeenCalledWith('/my/project');
  });

  it('creates AuthStorage via AuthStorage.create() and registers API keys as runtime overrides', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      apiKeys: { openai: 'sk-custom' },
    });

    expect(AuthStorage.create).toHaveBeenCalled();
    expect(mockAuthStorageInstance.setRuntimeApiKey).toHaveBeenCalledWith('openai', 'sk-custom');
  });

  it('resolves model via getModel and throws on unknown model', async () => {
    mockGetModel.mockReturnValue(undefined);

    await expect(
      createHarness({
        profile: makeProfile({ provider: 'unknown', model: 'nonexistent' }),
        cwd: '/tmp',
      }),
    ).rejects.toThrow(/Unknown model "nonexistent" for provider "unknown"/);

    expect(mockGetModel).toHaveBeenCalledWith('unknown', 'nonexistent');
  });

  it('passes the resolved model to createAgentSession', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
    });

    expect(mockGetModel).toHaveBeenCalledWith('openai', 'gpt-4o');
    expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({ model: mockModel }));
  });

  it('registers all apiKeys entries as runtime overrides on AuthStorage', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      apiKeys: { openai: 'sk-openai', anthropic: 'sk-ant-xyz' },
    });

    expect(AuthStorage.create).toHaveBeenCalled();
    expect(mockAuthStorageInstance.setRuntimeApiKey).toHaveBeenCalledWith('openai', 'sk-openai');
    expect(mockAuthStorageInstance.setRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-xyz');
  });

  it('does not call setRuntimeApiKey when apiKeys is undefined', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
    });

    expect(AuthStorage.create).toHaveBeenCalled();
    expect(mockAuthStorageInstance.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it('passes thinkingLevel from profile to createAgentSession', async () => {
    await createHarness({
      profile: makeProfile({ thinkingLevel: 'high' }),
      cwd: '/tmp',
    });

    expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'high' }));
  });

  it('creates a DefaultResourceLoader with systemPrompt', async () => {
    await createHarness({
      profile: makeProfile({ systemPrompt: 'Custom system prompt.' }),
      cwd: '/tmp',
    });

    expect(DefaultResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp',
        agentDir: '/tmp',
      }),
    );
    // Verify reload was called on the resource loader
    expect(mockDefaultResourceLoaderInstance.reload).toHaveBeenCalled();
  });

  it('builds tool list from profile includeTools', async () => {
    await createHarness({
      profile: makeProfile({
        includeTools: ['read', 'bash'],
      }),
      cwd: '/tmp',
    });

    expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({ tools: ['read', 'bash'] }));
  });

  it('builds tool list excluding excludeTools', async () => {
    await createHarness({
      profile: makeProfile({
        excludeTools: ['edit'],
      }),
      cwd: '/tmp',
    });

    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ['read', 'bash', 'write', 'grep', 'find', 'ls'] }),
    );
  });

  it('returns session and sessionId', async () => {
    const result = await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
    });

    expect(result).toHaveProperty('session');
    expect(result).toHaveProperty('sessionId');
    expect(typeof result.sessionId).toBe('string');
  });

  it('returns mock-session-id as sessionId', async () => {
    const result = await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
    });

    expect(result.sessionId).toBe('mock-session-id');
  });

  it('creates persisted session when sessionDir is provided', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      sessionDir: '/tmp/sessions/task1',
    });

    expect(SessionManager.create).toHaveBeenCalledWith('/tmp', '/tmp/sessions/task1');
  });

  it('resumes session when resumeSessionPath is provided', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      resumeSessionPath: '/tmp/sessions/task1/session.json',
    });

    expect(SessionManager.open).toHaveBeenCalledWith('/tmp/sessions/task1/session.json', undefined, '/tmp');
  });

  it('resumeSessionPath takes priority over sessionDir', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      sessionDir: '/tmp/sessions/task1',
      resumeSessionPath: '/tmp/sessions/task1/session.json',
    });

    expect(SessionManager.open).toHaveBeenCalledWith('/tmp/sessions/task1/session.json', undefined, '/tmp');
    expect(SessionManager.create).not.toHaveBeenCalled();
  });

  it('falls back to in-memory when no session options', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
    });

    expect(SessionManager.inMemory).toHaveBeenCalledWith('/tmp');
    expect(SessionManager.create).not.toHaveBeenCalled();
    expect(SessionManager.open).not.toHaveBeenCalled();
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('@earendil-works/pi-coding-agent', () => realPiCodingAgent);
  mock.module('@earendil-works/pi-ai', () => realPiAi);
});
