import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentProfile } from '../../src/core/types.ts';

// Capture real modules before mocking so we can restore them in afterAll.
const realPiCodingAgent = Object.assign({}, await import('@earendil-works/pi-coding-agent'));
const realPiAi = Object.assign({}, await import('@earendil-works/pi-ai'));
const realAuth = Object.assign({}, await import('../../src/core/auth.ts'));
const realProfile = Object.assign({}, await import('../../src/core/profile.ts'));

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
  AuthStorage: { inMemory: mock(() => mockAuthStorageInstance) },
  DefaultResourceLoader: mock().mockImplementation(() => mockDefaultResourceLoaderInstance),
}));

// Mock getModel
const mockGetModel = mock();
mock.module('@earendil-works/pi-ai', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
}));

// Mock resolveApiKeyOrThrow
const mockResolveApiKeyOrThrow = mock();
mock.module('../../src/core/auth.ts', () => ({
  resolveApiKeyOrThrow: (...args: unknown[]) => mockResolveApiKeyOrThrow(...args),
}));

// Mock loadProfile
const mockLoadProfile = mock();
mock.module('../../src/core/profile.ts', () => ({
  loadProfile: (...args: unknown[]) => mockLoadProfile(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { AuthStorage, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent';
import { createHarness, createHarnessFromProfile } from '../../src/core/harness-factory.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockModel = { id: 'gpt-4o', provider: 'openai', cost: { input: 0, output: 0 } };

function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    provider: 'openai',
    model: 'gpt-4o',
    thinkingLevel: 'medium',
    systemPrompt: 'You are a test agent.',
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mock.clearAllMocks();
  mockGetModel.mockReturnValue(mockModel);
  mockResolveApiKeyOrThrow.mockReturnValue('sk-test-key');
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

  it('creates an in-memory AuthStorage and registers the API key', async () => {
    mockResolveApiKeyOrThrow.mockReturnValue('sk-custom');

    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      apiKeys: { openai: 'sk-custom' },
    });

    expect(AuthStorage.inMemory).toHaveBeenCalled();
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

  it('resolves API key via resolveApiKeyOrThrow', async () => {
    await createHarness({
      profile: makeProfile(),
      cwd: '/tmp',
      apiKeys: { openai: 'sk-custom' },
    });

    expect(mockResolveApiKeyOrThrow).toHaveBeenCalledWith('openai', { openai: 'sk-custom' });
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

// ─── createHarnessFromProfile ───────────────────────────────────────────────

describe('createHarnessFromProfile', () => {
  it('loads profile and delegates to createHarness', async () => {
    const profile = makeProfile({ id: 'loaded-agent', provider: 'anthropic', model: 'claude-sonnet-4-20250514' });
    mockLoadProfile.mockResolvedValue(profile);
    mockGetModel.mockReturnValue({ ...mockModel, provider: 'anthropic' });

    await createHarnessFromProfile('/profiles', 'loaded-agent', {
      cwd: '/tmp',
    });

    expect(mockLoadProfile).toHaveBeenCalledWith('/profiles', 'loaded-agent');
    expect(mockGetModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-20250514');
  });

  it('propagates loadProfile errors', async () => {
    mockLoadProfile.mockRejectedValue(new Error('Profile "missing" not found'));

    await expect(createHarnessFromProfile('/profiles', 'missing', { cwd: '/tmp' })).rejects.toThrow(
      'Profile "missing" not found',
    );
  });

  it('passes all options through to createHarness', async () => {
    const profile = makeProfile();
    mockLoadProfile.mockResolvedValue(profile);

    await createHarnessFromProfile('/profiles', 'test-agent', {
      cwd: '/my/project',
      apiKeys: { openai: 'sk-from-profile' },
    });

    expect(mockResolveApiKeyOrThrow).toHaveBeenCalledWith('openai', { openai: 'sk-from-profile' });
    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockModel,
      }),
    );
  });

  it('returns session and sessionId', async () => {
    mockLoadProfile.mockResolvedValue(makeProfile());

    const result = await createHarnessFromProfile('/profiles', 'test-agent', {
      cwd: '/tmp',
    });

    expect(result).toHaveProperty('session');
    expect(result).toHaveProperty('sessionId');
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('@earendil-works/pi-coding-agent', () => realPiCodingAgent);
  mock.module('@earendil-works/pi-ai', () => realPiAi);
  mock.module('../../src/core/auth.ts', () => realAuth);
  mock.module('../../src/core/profile.ts', () => realProfile);
});
