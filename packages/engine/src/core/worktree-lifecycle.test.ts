// ─── Tests for core/worktree-lifecycle.ts — registry-direct session creation ─
//
// Verifies that `generateCommitMessage` and `pushAndCreatePR` resolve the
// agent session via a direct registry call
// (`requireAgentPlugin(profile.agent).createSession(...)`).
//
// Specifically these tests assert the contract:
//
//   1. `generateCommitMessage` resolves the agent session via
//      `requireAgentPlugin(profile.agent).createSession(...)`.
//   2. The session returned by `createSession` is forwarded to
//      `promptForStructured` (not an intermediate wrapper).
//   3. `createSession` receives `{ profile, cwd, apiKeys }`.
//   4. `session.dispose()` is invoked in the `finally` block of
//      `generateCommitMessage`.
//   5. `pushAndCreatePR` resolves the agent session via
//      `requireAgentPlugin(profile.agent).createSession(...)`.
//   6. `session.dispose()` is invoked in the `finally` block of
//      `pushAndCreatePR`.
//
// Module under test: ./worktree-lifecycle.js

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentProfile } from './types.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realProfile = Object.assign({}, await import('./profile.js'));
const realAgentRegistry = Object.assign({}, await import('./agent-registry.js'));
const realStructuredOutput = Object.assign({}, await import('./structured-output.js'));
const realGit = Object.assign({}, await import('./git.js'));

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./profile.js', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

// `requireAgentPlugin` is the direct entry point. It must return the
// plugin under test, whose `createSession` produces the session object.
const mockRequireAgentPlugin = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./agent-registry.js', () => ({
  requireAgentPlugin: (...args: unknown[]) => mockRequireAgentPlugin(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
  extractJsonFromText: realStructuredOutput.extractJsonFromText,
}));

mock.module('./git.js', () => ({
  ...realGit,
  pushBranch: mock(() => {}),
  stageFiles: mock(() => {}),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import { generateCommitMessage, pushAndCreatePR } from './worktree-lifecycle.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const workerProfile: AgentProfile = {
  id: 'worker',
  name: 'Worker',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium',
  systemPrompt: 'You are a coding agent.',
  excludeTools: [],
  includeTools: [],
  agent: 'custom-agent',
};

/** Build a fake AgentRuntime with a spyable `dispose`. */
function makeFakeSession(id = 'session-1') {
  return {
    sessionId: id,
    sessionFile: undefined as string | undefined,
    prompt: mock(async (_text: string) => {}),
    getLastAssistantText: mock(() => undefined),
    getLastAssistantMessage: mock(() => undefined),
    abort: mock(async () => {}),
    dispose: mock(() => {}),
    subscribe: mock(() => () => {}),
  };
}

/** Build a fake AgentPlugin whose `createSession` resolves the given session. */
function makeFakePlugin(session: ReturnType<typeof makeFakeSession>) {
  return {
    id: 'custom-agent',
    createSession: mock(async (_opts: unknown) => session),
  };
}

function setupWorkerProfile(profile: AgentProfile = workerProfile) {
  const map = new Map<string, AgentProfile>();
  map.set('worker', profile);
  mockLoadProfilesFromDirs.mockResolvedValue(map);
}

/** Set up loadProfilesFromDirs to return an empty map (no 'worker' profile). */
function setupMissingWorkerProfile() {
  mockLoadProfilesFromDirs.mockResolvedValue(new Map());
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRequireAgentPlugin.mockReset();
  mockPromptForStructured.mockReset();
  mockLoadProfilesFromDirs.mockReset();
});

afterAll(() => {
  // Restore real modules so other test files importing the same modules are
  // not affected by our mock.module overrides.
  mock.module('./profile.js', () => realProfile);
  mock.module('./agent-registry.js', () => realAgentRegistry);
  mock.module('./structured-output.js', () => realStructuredOutput);
  mock.module('./git.js', () => realGit);
});

// ─── generateCommitMessage ─────────────────────────────────────────────────

describe('generateCommitMessage — registry-direct session creation', () => {
  it('resolves the session via requireAgentPlugin().createSession()', async () => {
    setupWorkerProfile();
    const session = makeFakeSession();
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);
    mockPromptForStructured.mockResolvedValue({ result: { message: 'fix: thing' }, attempts: 1 });

    await generateCommitMessage(['/profiles'], '/worktree', 'Do the thing', 'diff --git ...');

    // requireAgentPlugin was called with profile.agent.
    expect(mockRequireAgentPlugin).toHaveBeenCalledTimes(1);
    expect(mockRequireAgentPlugin.mock.calls[0][0]).toBe(workerProfile.agent);

    // createSession received the profile, cwd and apiKeys.
    expect(plugin.createSession).toHaveBeenCalledTimes(1);
    const opts = plugin.createSession.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.profile).toBe(workerProfile);
    expect(opts.cwd).toBe('/worktree');
  });

  it('passes the registry-created session to promptForStructured', async () => {
    setupWorkerProfile();
    const session = makeFakeSession('commit-session');
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);
    mockPromptForStructured.mockResolvedValue({ result: { message: 'feat: x' }, attempts: 1 });

    await generateCommitMessage(['/profiles'], '/worktree', 'Task', 'diff');

    // The session forwarded to promptForStructured must be the very object
    // returned by plugin.createSession — i.e. the AgentRuntime.
    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    expect(mockPromptForStructured.mock.calls[0][0]).toBe(session);
  });

  it('forwards apiKeys through to createSession', async () => {
    setupWorkerProfile();
    const session = makeFakeSession();
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);
    mockPromptForStructured.mockResolvedValue({ result: { message: 'msg' }, attempts: 1 });

    const apiKeys = { openai: 'sk-test', anthropic: 'sk-ant' };
    await generateCommitMessage(['/profiles'], '/worktree', 'Task', 'diff', apiKeys);

    const opts = plugin.createSession.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.apiKeys).toBe(apiKeys);
  });

  it('calls session.dispose() in the finally block', async () => {
    setupWorkerProfile();
    const session = makeFakeSession();
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);
    mockPromptForStructured.mockResolvedValue({ result: { message: 'msg' }, attempts: 1 });

    await generateCommitMessage(['/profiles'], '/worktree', 'Task', 'diff');

    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('calls session.dispose() even when promptForStructured throws (fallback path)', async () => {
    setupWorkerProfile();
    const session = makeFakeSession();
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);
    mockPromptForStructured.mockRejectedValue(new Error('boom'));

    // The function swallows the structured-output failure and returns a
    // fallback string — but must still dispose the session.
    const result = await generateCommitMessage(['/profiles'], '/worktree', 'My task', 'diff');

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(result).toBe('Worktree changes for: My task');
  });

  it('throws and never calls createSession when the worker profile is missing', async () => {
    setupMissingWorkerProfile();
    const session = makeFakeSession();
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);

    await expect(generateCommitMessage(['/profiles'], '/worktree', 'Task', 'diff')).rejects.toThrow(
      'Worker profile not found',
    );

    // No session was ever created or disposed.
    expect(mockRequireAgentPlugin).not.toHaveBeenCalled();
    expect(plugin.createSession).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
  });
});

// ─── pushAndCreatePR ───────────────────────────────────────────────────────

describe('pushAndCreatePR — registry-direct session creation', () => {
  it('resolves the session via requireAgentPlugin().createSession()', async () => {
    setupWorkerProfile();
    const session = makeFakeSession();
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);
    mockPromptForStructured.mockResolvedValue({
      result: { prTitle: 'PR', prBody: 'body' },
      attempts: 1,
    });

    await pushAndCreatePR(['/profiles'], '/repo', 'engin/branch', 'Task', 'Title');

    // requireAgentPlugin was called with profile.agent.
    expect(mockRequireAgentPlugin).toHaveBeenCalledTimes(1);
    expect(mockRequireAgentPlugin.mock.calls[0][0]).toBe(workerProfile.agent);

    // createSession received the profile and cwd=repoRoot.
    expect(plugin.createSession).toHaveBeenCalledTimes(1);
    const opts = plugin.createSession.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.profile).toBe(workerProfile);
    expect(opts.cwd).toBe('/repo');
  });

  it('passes the registry-created session to promptForStructured', async () => {
    setupWorkerProfile();
    const session = makeFakeSession('pr-session');
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);
    mockPromptForStructured.mockResolvedValue({
      result: { prTitle: 'PR', prBody: 'body' },
      attempts: 1,
    });

    await pushAndCreatePR(['/profiles'], '/repo', 'engin/branch', 'Task', 'Title');

    expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    expect(mockPromptForStructured.mock.calls[0][0]).toBe(session);
  });

  it('forwards apiKeys through to createSession', async () => {
    setupWorkerProfile();
    const session = makeFakeSession();
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);
    mockPromptForStructured.mockResolvedValue({
      result: { prTitle: 'PR', prBody: 'body' },
      attempts: 1,
    });

    const apiKeys = { openai: 'sk-test', anthropic: 'sk-ant' };
    await pushAndCreatePR(['/profiles'], '/repo', 'engin/branch', 'Task', 'Title', apiKeys);

    const opts = plugin.createSession.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.apiKeys).toBe(apiKeys);
  });

  it('calls session.dispose() in the finally block', async () => {
    setupWorkerProfile();
    const session = makeFakeSession();
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);
    mockPromptForStructured.mockResolvedValue({
      result: { prTitle: 'PR', prBody: 'body' },
      attempts: 1,
    });

    await pushAndCreatePR(['/profiles'], '/repo', 'engin/branch', 'Task', 'Title');

    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('calls session.dispose() even when promptForStructured throws', async () => {
    setupWorkerProfile();
    const session = makeFakeSession();
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);
    mockPromptForStructured.mockRejectedValue(new Error('boom'));

    // pushAndCreatePR does not catch the structured-output error in the outer
    // try, but the finally must still dispose. Await with a catch so the test
    // can assert dispose was invoked regardless.
    await expect(pushAndCreatePR(['/profiles'], '/repo', 'engin/branch', 'Task', 'Title')).rejects.toThrow('boom');

    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('throws and never calls createSession when the worker profile is missing', async () => {
    setupMissingWorkerProfile();
    const session = makeFakeSession();
    const plugin = makeFakePlugin(session);
    mockRequireAgentPlugin.mockReturnValue(plugin);

    await expect(pushAndCreatePR(['/profiles'], '/repo', 'engin/branch', 'Task', 'Title')).rejects.toThrow(
      'Worker profile not found',
    );

    // No session was ever created or disposed.
    expect(mockRequireAgentPlugin).not.toHaveBeenCalled();
    expect(plugin.createSession).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
  });
});
