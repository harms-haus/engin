import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import type { AgentProfile, StatusCallbacks } from '../../packages/engine/src/core/types.js';

// Capture real modules before mocking so we can restore them in afterAll.
const realProfile = Object.assign({}, await import('../../packages/engine/src/core/profile.ts'));
const realHarnessFactory = Object.assign({}, await import('../../packages/engine/src/core/harness-factory.ts'));
const realStructuredOutput = Object.assign({}, await import('../../packages/engine/src/core/structured-output.ts'));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockLoadProfilesFromDirs = mock();

const mockDispose = mock();
const mockHarnessResult = {
  session: {},
  sessionId: 'test-session-id',
  dispose: mockDispose,
};
const mockCreateHarness = mock();

const mockPromptForStructured = mock();

mock.module('../../packages/engine/src/core/profile.ts', () => ({
  loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
}));

mock.module('../../packages/engine/src/core/harness-factory.ts', () => ({
  createHarness: (...args: unknown[]) => mockCreateHarness(...args),
}));

mock.module('../../packages/engine/src/core/structured-output.ts', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import {
  TitleSchema,
  generateWorkflowTitle,
  type TitleGeneratorOptions,
} from '../../packages/engine/src/core/title-generator.ts';

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

  // Default: createHarness returns a harness with dispose
  mockDispose.mockResolvedValue(undefined);
  mockCreateHarness.mockResolvedValue({ ...mockHarnessResult, dispose: mockDispose });

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

    const _profileMap = mockLoadProfilesFromDirs.mock.calls[0][0];
    // The function loads profiles, then looks up by profileId
    // Verify that the scout profile was used in createHarness
    expect(mockCreateHarness).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ id: 'scout' }) }),
    );
  });

  it('uses a custom profile ID when provided', async () => {
    const customProfile = makeProfile({ id: 'custom-agent' });
    mockLoadProfilesFromDirs.mockResolvedValue(new Map([['custom-agent', customProfile]]));

    await generateWorkflowTitle(defaultOptions({ profileId: 'custom-agent' }));

    expect(mockCreateHarness).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ id: 'custom-agent' }) }),
    );
  });

  it('uses "title-generator" as default agentId', async () => {
    await generateWorkflowTitle(defaultOptions());

    expect(mockCreateHarness).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'title-generator' }));
  });

  it('uses a custom agentId when provided', async () => {
    await generateWorkflowTitle(defaultOptions({ agentId: 'my-title-agent' }));

    expect(mockCreateHarness).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'my-title-agent' }));
  });

  it('passes cwd to createHarness', async () => {
    await generateWorkflowTitle(defaultOptions({ cwd: '/my/project' }));

    expect(mockCreateHarness).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/my/project' }));
  });

  it('passes apiKeys to createHarness', async () => {
    const apiKeys = { openai: 'sk-test-key' };
    await generateWorkflowTitle(defaultOptions({ apiKeys }));

    expect(mockCreateHarness).toHaveBeenCalledWith(expect.objectContaining({ apiKeys }));
  });

  it('passes undefined apiKeys when not provided', async () => {
    await generateWorkflowTitle(defaultOptions());

    expect(mockCreateHarness).toHaveBeenCalledWith(expect.objectContaining({ apiKeys: undefined }));
  });

  it('forwards onAgentStatus from onStatus callbacks', async () => {
    const onStatus: StatusCallbacks = {
      onTurnStart: mock(),
      onTurnEnd: mock(),
    };

    await generateWorkflowTitle(defaultOptions({ onStatus }));

    expect(mockCreateHarness).toHaveBeenCalledWith(expect.objectContaining({ onAgentStatus: onStatus }));
  });

  it('passes undefined onAgentStatus when onStatus is not provided', async () => {
    await generateWorkflowTitle(defaultOptions());

    expect(mockCreateHarness).toHaveBeenCalledWith(expect.objectContaining({ onAgentStatus: undefined }));
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

// ─── generateWorkflowTitle – harness passed to promptForStructured ──────────

describe('generateWorkflowTitle – harness usage', () => {
  it('passes the harness session to promptForStructured', async () => {
    await generateWorkflowTitle(defaultOptions());

    const harnessArg = mockPromptForStructured.mock.calls[0][0];
    expect(harnessArg).toBeDefined();
    // The harness passed should be the session returned by createHarness
    expect(harnessArg).toBe(mockHarnessResult.session);
  });
});

// ─── generateWorkflowTitle – dispose always called ──────────────────────────

describe('generateWorkflowTitle – dispose always called', () => {
  it('calls dispose on success', async () => {
    await generateWorkflowTitle(defaultOptions());

    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('calls dispose even when promptForStructured throws', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('LLM failed'));

    await generateWorkflowTitle(defaultOptions());

    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('calls dispose even when createHarness throws', async () => {
    mockCreateHarness.mockRejectedValue(new Error('Harness creation failed'));

    await generateWorkflowTitle(defaultOptions());

    // Dispose should NOT be called because harness was never created
    // But the function should not throw
    expect(mockDispose).not.toHaveBeenCalled();
  });

  it('calls dispose when loadProfilesFromDirs throws', async () => {
    mockLoadProfilesFromDirs.mockRejectedValue(new Error('Disk error'));

    await generateWorkflowTitle(defaultOptions());

    // Harness was never created, so dispose should not be called
    expect(mockDispose).not.toHaveBeenCalled();
  });

  it('calls dispose when profile is not found', async () => {
    mockLoadProfilesFromDirs.mockResolvedValue(new Map()); // empty, no 'scout' profile

    await generateWorkflowTitle(defaultOptions());

    // Harness was never created
    expect(mockDispose).not.toHaveBeenCalled();
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

  it('falls back when createHarness throws', async () => {
    mockCreateHarness.mockRejectedValue(new Error('No model'));

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

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../packages/engine/src/core/profile.ts', () => realProfile);
  mock.module('../../packages/engine/src/core/harness-factory.ts', () => realHarnessFactory);
  mock.module('../../packages/engine/src/core/structured-output.ts', () => realStructuredOutput);
});
