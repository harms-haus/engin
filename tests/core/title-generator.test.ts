import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import type { AgentProfile, StatusCallbacks } from '../../packages/engine/src/core/types.js';

// Capture real modules before mocking so we can restore them in afterAll.
const realProfile = Object.assign({}, await import('../../packages/engine/src/core/profile.js'));
const realAgentRegistry = Object.assign({}, await import('../../packages/engine/src/core/agent-registry.js'));
const realStructuredOutput = Object.assign({}, await import('../../packages/engine/src/core/structured-output.js'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockLoadProfilesFromDirs = mock();

/**
 * Mock session object returned by `plugin.createSession`. After the migration
 * the title generator calls `session.dispose()` directly on the AgentRuntime,
 * so the dispose mock lives on the session itself.
 */
const mockSessionDispose = mock();
const mockSession = {
  sessionId: 'test-session-id',
  dispose: mockSessionDispose,
};

const mockCreateSession = mock();
const mockRequireAgentPlugin = mock();

const mockPromptForStructured = mock();

mock.module('../../packages/engine/src/core/profile.js', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

mock.module('../../packages/engine/src/core/agent-registry.js', () => ({
  requireAgentPlugin: (...args: unknown[]) => mockRequireAgentPlugin(...args),
}));

mock.module('../../packages/engine/src/core/structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import {
  TitleAndBranchSchema,
  TitleSchema,
  generateTitleAndBranch,
  generateWorkflowTitle,
  type TitleGeneratorOptions,
} from '../../packages/engine/src/core/title-generator.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'scout',
    name: 'Scout',
    provider: 'openai',
    model: 'gpt-4o',
    thinkingLevel: 'medium',
    systemPrompt: 'You are a scout agent.',
    excludeTools: [],
    includeTools: [],
    ...overrides,
  };
}

const defaultProfile = makeProfile();

function defaultOptions(overrides?: Partial<TitleGeneratorOptions>): TitleGeneratorOptions {
  return {
    profilesDirs: ['/profiles'],
    taskPrompt: 'Build a REST API with Express',
    cwd: '/tmp/project',
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mock.clearAllMocks();

  // Default: loadProfilesFromDirs returns a Map with the 'scout' profile
  mockLoadProfilesFromDirs.mockResolvedValue(new Map([['scout', defaultProfile]]));

  // Default: requireAgentPlugin returns a plugin whose createSession
  // resolves to our mock session (an AgentRuntime with a dispose method).
  mockSessionDispose.mockReturnValue(undefined);
  mockCreateSession.mockResolvedValue(mockSession);
  mockRequireAgentPlugin.mockReturnValue({
    id: 'pi-coding-agent',
    createSession: mockCreateSession,
  });

  // Default: promptForStructured returns a title
  mockPromptForStructured.mockResolvedValue({
    result: { title: 'Build REST API with Express' },
    attempts: 1,
  });
});

// ─── TitleSchema ────────────────────────────────────────────────────────────

describe('TitleSchema', () => {
  it('validates an object with a title string', () => {
    const result = TitleSchema.safeParse({ title: 'My Task Title' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('My Task Title');
    }
  });

  it('rejects an object without a title field', () => {
    const result = TitleSchema.safeParse({ name: 'something' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string title', () => {
    const result = TitleSchema.safeParse({ title: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object input', () => {
    const result = TitleSchema.safeParse('just a string');
    expect(result.success).toBe(false);
  });

  it('accepts an empty string title (valid schema shape)', () => {
    const result = TitleSchema.safeParse({ title: '' });
    expect(result.success).toBe(true);
  });
});

// ─── generateWorkflowTitle – registry interaction ───────────────────────────

describe('generateWorkflowTitle – registry interaction', () => {
  it('resolves the session via the registry (uses requireAgentPlugin directly)', async () => {
    // requireAgentPlugin is the entry point for session creation.
    // requireAgentPlugin is the entry point for session creation.
    await generateWorkflowTitle(defaultOptions());

    expect(mockRequireAgentPlugin).toHaveBeenCalled();
  });

  it('calls requireAgentPlugin with the profile.agent field', async () => {
    const profileWithAgent = makeProfile({ agent: 'my-custom-agent' });
    mockLoadProfilesFromDirs.mockResolvedValue(new Map([['scout', profileWithAgent]]));

    await generateWorkflowTitle(defaultOptions());

    expect(mockRequireAgentPlugin).toHaveBeenCalledWith('my-custom-agent');
  });

  it('calls requireAgentPlugin with undefined when profile.agent is not set', async () => {
    // defaultProfile has no `agent` field set
    await generateWorkflowTitle(defaultOptions());

    expect(mockRequireAgentPlugin).toHaveBeenCalledWith(undefined);
  });

  it('calls plugin.createSession to obtain the session', async () => {
    await generateWorkflowTitle(defaultOptions());

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });
});

// ─── generateWorkflowTitle – happy path ─────────────────────────────────────

describe('generateWorkflowTitle – happy path', () => {
  it('returns the generated title from promptForStructured', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { title: 'Build REST API with Express' },
      attempts: 1,
    });

    const title = await generateWorkflowTitle(defaultOptions());
    expect(title).toBe('Build REST API with Express');
  });

  it('passes profilesDirs to loadProfilesFromDirs', async () => {
    await generateWorkflowTitle(defaultOptions({ profilesDirs: ['/dir1', '/dir2'] }));

    expect(mockLoadProfilesFromDirs).toHaveBeenCalledWith(['/dir1', '/dir2']);
  });

  it('uses "scout" as default profile ID', async () => {
    await generateWorkflowTitle(defaultOptions());

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ id: 'scout' }) }),
    );
  });

  it('uses a custom profile ID when provided', async () => {
    const customProfile = makeProfile({ id: 'custom-agent' });
    mockLoadProfilesFromDirs.mockResolvedValue(new Map([['custom-agent', customProfile]]));

    await generateWorkflowTitle(defaultOptions({ profileId: 'custom-agent' }));

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ id: 'custom-agent' }) }),
    );
  });

  it('uses "title-generator" as default agentId', async () => {
    await generateWorkflowTitle(defaultOptions());

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'title-generator' }));
  });

  it('uses a custom agentId when provided', async () => {
    await generateWorkflowTitle(defaultOptions({ agentId: 'my-title-agent' }));

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'my-title-agent' }));
  });

  it('passes cwd to createSession', async () => {
    await generateWorkflowTitle(defaultOptions({ cwd: '/my/project' }));

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/my/project' }));
  });

  it('passes apiKeys to createSession', async () => {
    const apiKeys = { openai: 'sk-test-key' };
    await generateWorkflowTitle(defaultOptions({ apiKeys }));

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ apiKeys }));
  });

  it('passes undefined apiKeys when not provided', async () => {
    await generateWorkflowTitle(defaultOptions());

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ apiKeys: undefined }));
  });

  it('forwards onAgentStatus from onStatus callbacks', async () => {
    const onStatus: StatusCallbacks = {
      onTurnStart: mock(),
      onTurnEnd: mock(),
    };

    await generateWorkflowTitle(defaultOptions({ onStatus }));

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ onAgentStatus: onStatus }));
  });

  it('passes undefined onAgentStatus when onStatus is not provided', async () => {
    await generateWorkflowTitle(defaultOptions());

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ onAgentStatus: undefined }));
  });
});

// ─── generateWorkflowTitle – default prompt text ────────────────────────────

describe('generateWorkflowTitle – default prompt text', () => {
  it('builds the default prompt with task description', async () => {
    await generateWorkflowTitle(defaultOptions({ taskPrompt: 'Build a REST API' }));

    const promptArg = mockPromptForStructured.mock.calls[0][1] as string;
    expect(promptArg).toContain('You are a title generator.');
    expect(promptArg).toContain('Generate a concise 3-8 word title summarizing the following task.');
    expect(promptArg).toContain('Task: Build a REST API');
    expect(promptArg).toContain('Respond with a JSON object containing a title field');
  });

  it('uses customPrompt when provided, replacing default text entirely', async () => {
    await generateWorkflowTitle(
      defaultOptions({
        customPrompt: 'Give me a creative title for:',
        taskPrompt: 'Refactor the auth module',
      }),
    );

    const promptArg = mockPromptForStructured.mock.calls[0][1] as string;
    expect(promptArg).toContain('Give me a creative title for:');
    expect(promptArg).toContain('Task: Refactor the auth module');
    // Default prompt text should NOT be present
    expect(promptArg).not.toContain('You are a title generator.');
    expect(promptArg).not.toContain('Generate a concise 3-8 word');
  });
});

// ─── generateWorkflowTitle – schema handling ────────────────────────────────

describe('generateWorkflowTitle – schema handling', () => {
  it('uses TitleSchema by default', async () => {
    await generateWorkflowTitle(defaultOptions());

    const schemaArg = mockPromptForStructured.mock.calls[0][2];
    // Verify it's a Zod schema
    expect(schemaArg).toBeDefined();
    expect(typeof schemaArg.safeParse).toBe('function');
  });

  it('uses a custom schema when provided', async () => {
    const customSchema = z.object({
      title: z.string(),
      subtitle: z.string().optional(),
    });
    mockPromptForStructured.mockResolvedValue({
      result: { title: 'My Title', subtitle: 'My Subtitle' },
      attempts: 1,
    });

    const title = await generateWorkflowTitle(defaultOptions({ schema: customSchema }));

    const schemaArg = mockPromptForStructured.mock.calls[0][2];
    expect(schemaArg).toBe(customSchema);
    // The function extracts .title from the result regardless of schema
    expect(title).toBe('My Title');
  });
});

// ─── generateWorkflowTitle – session passed to promptForStructured ──────────

describe('generateWorkflowTitle – session usage', () => {
  it('passes the AgentRuntime session to promptForStructured', async () => {
    await generateWorkflowTitle(defaultOptions());

    const sessionArg = mockPromptForStructured.mock.calls[0][0];
    expect(sessionArg).toBeDefined();
    // The session passed should be the AgentRuntime returned by createSession
    expect(sessionArg).toBe(mockSession);
  });
});

// ─── generateWorkflowTitle – session.dispose always called ──────────────────

describe('generateWorkflowTitle – session.dispose always called', () => {
  it('calls session.dispose on success', async () => {
    await generateWorkflowTitle(defaultOptions());

    expect(mockSessionDispose).toHaveBeenCalledTimes(1);
  });

  it('calls session.dispose even when promptForStructured throws', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('LLM failed'));

    await generateWorkflowTitle(defaultOptions());

    expect(mockSessionDispose).toHaveBeenCalledTimes(1);
  });

  it('does not call session.dispose when createSession throws (session never created)', async () => {
    mockCreateSession.mockRejectedValue(new Error('Session creation failed'));

    await generateWorkflowTitle(defaultOptions());

    expect(mockSessionDispose).not.toHaveBeenCalled();
  });

  it('does not call session.dispose when requireAgentPlugin throws', async () => {
    mockRequireAgentPlugin.mockImplementation(() => {
      throw new Error('No agent plugin registered');
    });

    await generateWorkflowTitle(defaultOptions());

    expect(mockSessionDispose).not.toHaveBeenCalled();
  });

  it('does not call session.dispose when loadProfilesFromDirs throws', async () => {
    mockLoadProfilesFromDirs.mockRejectedValue(new Error('Disk error'));

    await generateWorkflowTitle(defaultOptions());

    expect(mockSessionDispose).not.toHaveBeenCalled();
  });

  it('does not call session.dispose when profile is not found', async () => {
    mockLoadProfilesFromDirs.mockResolvedValue(new Map()); // empty, no 'scout' profile

    await generateWorkflowTitle(defaultOptions());

    expect(mockSessionDispose).not.toHaveBeenCalled();
  });
});

// ─── generateWorkflowTitle – fallback on error ──────────────────────────────

describe('generateWorkflowTitle – fallback on error', () => {
  it('returns truncated taskPrompt when over 60 chars', async () => {
    const longPrompt = 'A'.repeat(70); // 70 chars, over 60
    mockPromptForStructured.mockRejectedValue(new Error('Failed'));

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: longPrompt }));
    // Should be first 57 chars + '...'
    expect(title).toBe('A'.repeat(57) + '...');
    expect(title.length).toBe(60);
  });

  it('returns full taskPrompt as fallback when exactly 60 chars', async () => {
    const sixtyChars = 'A'.repeat(60);
    mockPromptForStructured.mockRejectedValue(new Error('Failed'));

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: sixtyChars }));
    // 60 chars is not over 60, so return full prompt
    expect(title).toBe(sixtyChars);
  });

  it('returns full taskPrompt as fallback when under 60 chars', async () => {
    const shortPrompt = 'Short task';
    mockPromptForStructured.mockRejectedValue(new Error('Failed'));

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: shortPrompt }));
    expect(title).toBe('Short task');
  });

  it('returns full taskPrompt when exactly 61 chars (over 60 → truncated)', async () => {
    const prompt61 = 'A'.repeat(61);
    mockPromptForStructured.mockRejectedValue(new Error('Failed'));

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: prompt61 }));
    expect(title).toBe('A'.repeat(57) + '...');
  });

  it('falls back when createSession throws', async () => {
    mockCreateSession.mockRejectedValue(new Error('No model'));

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: 'Build API' }));
    expect(title).toBe('Build API');
  });

  it('falls back when requireAgentPlugin throws', async () => {
    mockRequireAgentPlugin.mockImplementation(() => {
      throw new Error('No agent plugin registered');
    });

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: 'Build API' }));
    expect(title).toBe('Build API');
  });

  it('falls back when profile not found', async () => {
    mockLoadProfilesFromDirs.mockResolvedValue(new Map()); // no 'scout' profile

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: 'Build API' }));
    expect(title).toBe('Build API');
  });

  it('falls back when loadProfilesFromDirs throws', async () => {
    mockLoadProfilesFromDirs.mockRejectedValue(new Error('IO error'));

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: 'Build API' }));
    expect(title).toBe('Build API');
  });

  it('does not throw on error, always returns a string', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('catastrophic'));

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: 'Hello' }));
    expect(typeof title).toBe('string');
    expect(title).toBe('Hello');
  });

  it('fallback truncation: 58-char prompt stays intact (not over 60)', async () => {
    const prompt58 = 'A'.repeat(58);
    mockPromptForStructured.mockRejectedValue(new Error('fail'));

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: prompt58 }));
    expect(title).toBe(prompt58);
    expect(title.length).toBe(58);
  });

  it('fallback truncation: 59-char prompt stays intact (not over 60)', async () => {
    const prompt59 = 'A'.repeat(59);
    mockPromptForStructured.mockRejectedValue(new Error('fail'));

    const title = await generateWorkflowTitle(defaultOptions({ taskPrompt: prompt59 }));
    expect(title).toBe(prompt59);
    expect(title.length).toBe(59);
  });
});

// ─── generateWorkflowTitle – promptForStructured interaction ────────────────

describe('generateWorkflowTitle – promptForStructured interaction', () => {
  it('extracts result.title from promptForStructured response', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { title: 'Refactor Authentication Module' },
      attempts: 2,
    });

    const title = await generateWorkflowTitle(defaultOptions());
    expect(title).toBe('Refactor Authentication Module');
  });

  it('returns the title even if multiple attempts were needed', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { title: 'Complex Task Summary' },
      attempts: 3,
    });

    const title = await generateWorkflowTitle(defaultOptions());
    expect(title).toBe('Complex Task Summary');
  });
});

// ─── TitleAndBranchSchema ───────────────────────────────────────────────────

describe('TitleAndBranchSchema', () => {
  it('validates an object with title and branchName strings', () => {
    const result = TitleAndBranchSchema.safeParse({ title: 'My Task', branchName: 'my-task' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('My Task');
      expect(result.data.branchName).toBe('my-task');
    }
  });

  it('rejects an object without a branchName field', () => {
    const result = TitleAndBranchSchema.safeParse({ title: 'My Task' });
    expect(result.success).toBe(false);
  });

  it('rejects an object without a title field', () => {
    const result = TitleAndBranchSchema.safeParse({ branchName: 'my-task' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string title', () => {
    const result = TitleAndBranchSchema.safeParse({ title: 123, branchName: 'my-task' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string branchName', () => {
    const result = TitleAndBranchSchema.safeParse({ title: 'My Task', branchName: 42 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object input', () => {
    const result = TitleAndBranchSchema.safeParse('just a string');
    expect(result.success).toBe(false);
  });

  it('accepts empty strings for both fields (valid schema shape)', () => {
    const result = TitleAndBranchSchema.safeParse({ title: '', branchName: '' });
    expect(result.success).toBe(true);
  });
});

// ─── generateTitleAndBranch – registry interaction ──────────────────────────

describe('generateTitleAndBranch – registry interaction', () => {
  it('resolves the session via the registry (uses requireAgentPlugin directly)', async () => {
    await generateTitleAndBranch(defaultOptions());

    expect(mockRequireAgentPlugin).toHaveBeenCalled();
  });

  it('calls requireAgentPlugin with the profile.agent field', async () => {
    const profileWithAgent = makeProfile({ agent: 'my-custom-agent' });
    mockLoadProfilesFromDirs.mockResolvedValue(new Map([['scout', profileWithAgent]]));

    await generateTitleAndBranch(defaultOptions());

    expect(mockRequireAgentPlugin).toHaveBeenCalledWith('my-custom-agent');
  });

  it('calls requireAgentPlugin with undefined when profile.agent is not set', async () => {
    await generateTitleAndBranch(defaultOptions());

    expect(mockRequireAgentPlugin).toHaveBeenCalledWith(undefined);
  });

  it('calls plugin.createSession to obtain the session', async () => {
    await generateTitleAndBranch(defaultOptions());

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });
});

// ─── generateTitleAndBranch – happy path ────────────────────────────────────

describe('generateTitleAndBranch – happy path', () => {
  beforeEach(() => {
    mockPromptForStructured.mockResolvedValue({
      result: { title: 'Build REST API', branchName: 'build-rest-api' },
      attempts: 1,
    });
  });

  it('returns both title and branchName from promptForStructured', async () => {
    const result = await generateTitleAndBranch(defaultOptions());
    expect(result.title).toBe('Build REST API');
    expect(result.branchName).toBe('build-rest-api');
  });

  it('returns an object with exactly title and branchName properties', async () => {
    const result = await generateTitleAndBranch(defaultOptions());
    expect(result).toEqual({ title: 'Build REST API', branchName: 'build-rest-api' });
  });

  it('passes profilesDirs to loadProfilesFromDirs', async () => {
    await generateTitleAndBranch(defaultOptions({ profilesDirs: ['/dir1', '/dir2'] }));

    expect(mockLoadProfilesFromDirs).toHaveBeenCalledWith(['/dir1', '/dir2']);
  });

  it('uses "scout" as default profile ID', async () => {
    await generateTitleAndBranch(defaultOptions());

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ id: 'scout' }) }),
    );
  });

  it('uses a custom profile ID when provided', async () => {
    const customProfile = makeProfile({ id: 'custom-agent' });
    mockLoadProfilesFromDirs.mockResolvedValue(new Map([['custom-agent', customProfile]]));

    await generateTitleAndBranch(defaultOptions({ profileId: 'custom-agent' }));

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ id: 'custom-agent' }) }),
    );
  });

  it('uses "title-generator" as default agentId', async () => {
    await generateTitleAndBranch(defaultOptions());

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'title-generator' }));
  });

  it('uses a custom agentId when provided', async () => {
    await generateTitleAndBranch(defaultOptions({ agentId: 'my-branch-agent' }));

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'my-branch-agent' }));
  });

  it('passes cwd to createSession', async () => {
    await generateTitleAndBranch(defaultOptions({ cwd: '/my/project' }));

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/my/project' }));
  });

  it('passes apiKeys to createSession', async () => {
    const apiKeys = { openai: 'sk-test-key' };
    await generateTitleAndBranch(defaultOptions({ apiKeys }));

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ apiKeys }));
  });

  it('passes undefined apiKeys when not provided', async () => {
    await generateTitleAndBranch(defaultOptions());

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ apiKeys: undefined }));
  });

  it('forwards onAgentStatus from onStatus callbacks', async () => {
    const onStatus: StatusCallbacks = {
      onTurnStart: mock(),
      onTurnEnd: mock(),
    };

    await generateTitleAndBranch(defaultOptions({ onStatus }));

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ onAgentStatus: onStatus }));
  });

  it('passes undefined onAgentStatus when onStatus is not provided', async () => {
    await generateTitleAndBranch(defaultOptions());

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ onAgentStatus: undefined }));
  });
});

// ─── generateTitleAndBranch – default prompt text ───────────────────────────

describe('generateTitleAndBranch – default prompt text', () => {
  it('builds the default prompt asking for both a title and a branch name', async () => {
    await generateTitleAndBranch(defaultOptions({ taskPrompt: 'Build a REST API' }));

    const promptArg = mockPromptForStructured.mock.calls[0][1] as string;
    expect(promptArg).toContain('You are a title and branch name generator.');
    expect(promptArg).toContain('kebab-case git branch name');
    expect(promptArg).toContain('3-8 word');
    expect(promptArg).toContain('Task: Build a REST API');
    expect(promptArg).toContain('Respond with a JSON object containing a title field and a branchName field');
  });

  it('includes the task prompt in the generated prompt', async () => {
    await generateTitleAndBranch(defaultOptions({ taskPrompt: 'Refactor authentication flow' }));

    const promptArg = mockPromptForStructured.mock.calls[0][1] as string;
    expect(promptArg).toContain('Task: Refactor authentication flow');
  });

  it('uses customPrompt when provided, replacing default text entirely', async () => {
    await generateTitleAndBranch(
      defaultOptions({
        customPrompt: 'Produce a title and branch for this:',
        taskPrompt: 'Add dark mode support',
      }),
    );

    const promptArg = mockPromptForStructured.mock.calls[0][1] as string;
    expect(promptArg).toContain('Produce a title and branch for this:');
    expect(promptArg).toContain('Task: Add dark mode support');
    // Default prompt text should NOT be present
    expect(promptArg).not.toContain('You are a title and branch name generator.');
    expect(promptArg).not.toContain('kebab-case git branch name');
  });
});

// ─── generateTitleAndBranch – schema handling ───────────────────────────────

describe('generateTitleAndBranch – schema handling', () => {
  it('uses TitleAndBranchSchema by default', async () => {
    await generateTitleAndBranch(defaultOptions());

    const schemaArg = mockPromptForStructured.mock.calls[0][2];
    expect(schemaArg).toBeDefined();
    expect(typeof schemaArg.safeParse).toBe('function');
    // Validates the title + branchName shape
    expect(schemaArg.safeParse({ title: 'T', branchName: 'b' }).success).toBe(true);
    // Rejects missing branchName
    expect(schemaArg.safeParse({ title: 'T' }).success).toBe(false);
    // Rejects missing title
    expect(schemaArg.safeParse({ branchName: 'b' }).success).toBe(false);
  });

  it('passes a schema that accepts both title and branchName to promptForStructured', async () => {
    await generateTitleAndBranch(defaultOptions());

    const schemaArg = mockPromptForStructured.mock.calls[0][2];
    const parsed = schemaArg.safeParse({ title: 'My Title', branchName: 'my-branch' });
    expect(parsed.success).toBe(true);
  });
});

// ─── generateTitleAndBranch – session usage ─────────────────────────────────

describe('generateTitleAndBranch – session usage', () => {
  it('passes the AgentRuntime session to promptForStructured', async () => {
    await generateTitleAndBranch(defaultOptions());

    const sessionArg = mockPromptForStructured.mock.calls[0][0];
    expect(sessionArg).toBeDefined();
    // The session passed should be the AgentRuntime returned by createSession
    expect(sessionArg).toBe(mockSession);
  });
});

// ─── generateTitleAndBranch – session.dispose always called ─────────────────

describe('generateTitleAndBranch – session.dispose always called', () => {
  it('calls session.dispose on success', async () => {
    await generateTitleAndBranch(defaultOptions());

    expect(mockSessionDispose).toHaveBeenCalledTimes(1);
  });

  it('calls session.dispose even when promptForStructured throws', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('LLM failed'));

    await generateTitleAndBranch(defaultOptions());

    expect(mockSessionDispose).toHaveBeenCalledTimes(1);
  });

  it('does not call session.dispose when createSession throws (session never created)', async () => {
    mockCreateSession.mockRejectedValue(new Error('Session creation failed'));

    await generateTitleAndBranch(defaultOptions());

    expect(mockSessionDispose).not.toHaveBeenCalled();
  });

  it('does not call session.dispose when requireAgentPlugin throws', async () => {
    mockRequireAgentPlugin.mockImplementation(() => {
      throw new Error('No agent plugin registered');
    });

    await generateTitleAndBranch(defaultOptions());

    expect(mockSessionDispose).not.toHaveBeenCalled();
  });

  it('does not call session.dispose when loadProfilesFromDirs throws', async () => {
    mockLoadProfilesFromDirs.mockRejectedValue(new Error('Disk error'));

    await generateTitleAndBranch(defaultOptions());

    expect(mockSessionDispose).not.toHaveBeenCalled();
  });

  it('does not call session.dispose when profile is not found', async () => {
    mockLoadProfilesFromDirs.mockResolvedValue(new Map()); // empty, no 'scout' profile

    await generateTitleAndBranch(defaultOptions());

    expect(mockSessionDispose).not.toHaveBeenCalled();
  });
});

// ─── generateTitleAndBranch – fallback on error ─────────────────────────────

describe('generateTitleAndBranch – fallback on error', () => {
  it('returns fallback title and fallback branchName when promptForStructured throws', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('LLM failed'));

    const result = await generateTitleAndBranch(defaultOptions({ taskPrompt: 'Build API' }));
    expect(result.title).toBe('Build API');
    expect(result.branchName).toBe('build-api');
  });

  it('fallback branchName is lowercase, hyphenated, and derived from the prompt', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('fail'));

    const result = await generateTitleAndBranch(defaultOptions({ taskPrompt: 'Refactor the auth module' }));
    // Only valid branch-name characters, no whitespace, no uppercase
    expect(result.branchName).toMatch(/^[a-z0-9-]+$/);
    expect(result.branchName).not.toMatch(/\s/);
    expect(result.branchName).not.toMatch(/[A-Z]/);
    // Derived from key words in the prompt
    expect(result.branchName).toContain('refactor');
    expect(result.branchName).toContain('auth');
  });

  it('fallback title is truncated when taskPrompt exceeds 60 chars', async () => {
    const longPrompt = 'A'.repeat(70); // 70 chars, over 60
    mockPromptForStructured.mockRejectedValue(new Error('fail'));

    const result = await generateTitleAndBranch(defaultOptions({ taskPrompt: longPrompt }));
    expect(result.title).toBe('A'.repeat(57) + '...');
  });

  it('fallback title is the full prompt when 60 chars or fewer', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('fail'));

    const result = await generateTitleAndBranch(defaultOptions({ taskPrompt: 'Short task' }));
    expect(result.title).toBe('Short task');
  });

  it('falls back when createSession throws', async () => {
    mockCreateSession.mockRejectedValue(new Error('No model'));

    const result = await generateTitleAndBranch(defaultOptions({ taskPrompt: 'Build API' }));
    expect(result.title).toBe('Build API');
    expect(result.branchName).toBe('build-api');
  });

  it('falls back when requireAgentPlugin throws', async () => {
    mockRequireAgentPlugin.mockImplementation(() => {
      throw new Error('No agent plugin registered');
    });

    const result = await generateTitleAndBranch(defaultOptions({ taskPrompt: 'Build API' }));
    expect(result.title).toBe('Build API');
    expect(result.branchName).toBe('build-api');
  });

  it('falls back when profile is not found', async () => {
    mockLoadProfilesFromDirs.mockResolvedValue(new Map()); // no 'scout' profile

    const result = await generateTitleAndBranch(defaultOptions({ taskPrompt: 'Build API' }));
    expect(result.title).toBe('Build API');
    expect(result.branchName).toBe('build-api');
  });

  it('falls back when loadProfilesFromDirs throws', async () => {
    mockLoadProfilesFromDirs.mockRejectedValue(new Error('IO error'));

    const result = await generateTitleAndBranch(defaultOptions({ taskPrompt: 'Build API' }));
    expect(result.title).toBe('Build API');
    expect(result.branchName).toBe('build-api');
  });

  it('does not throw on error, always returns an object with title and branchName', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('catastrophic'));

    const result = await generateTitleAndBranch(defaultOptions({ taskPrompt: 'Hello World' }));
    expect(typeof result.title).toBe('string');
    expect(typeof result.branchName).toBe('string');
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.branchName.length).toBeGreaterThan(0);
  });
});

// ─── generateTitleAndBranch – promptForStructured interaction ────────────────

describe('generateTitleAndBranch – promptForStructured interaction', () => {
  it('extracts both result.title and result.branchName from the response', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { title: 'Refactor Authentication Module', branchName: 'refactor-auth-module' },
      attempts: 2,
    });

    const result = await generateTitleAndBranch(defaultOptions());
    expect(result.title).toBe('Refactor Authentication Module');
    expect(result.branchName).toBe('refactor-auth-module');
  });

  it('returns the values regardless of how many attempts were needed', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { title: 'Complex Task Summary', branchName: 'complex-task-summary' },
      attempts: 3,
    });

    const result = await generateTitleAndBranch(defaultOptions());
    expect(result.title).toBe('Complex Task Summary');
    expect(result.branchName).toBe('complex-task-summary');
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../packages/engine/src/core/profile.js', () => realProfile);
  mock.module('../../packages/engine/src/core/agent-registry.js', () => realAgentRegistry);
  mock.module('../../packages/engine/src/core/structured-output.js', () => realStructuredOutput);
});
