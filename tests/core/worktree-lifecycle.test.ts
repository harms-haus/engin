import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { join } from 'node:path';
import { makeProfile } from '../helpers/make-profile.js';

// ─── Capture real modules before mocking ────────────────────────────────────
const realProfile = Object.assign({}, await import('../../packages/engine/src/core/profile.js'));
const realHarnessFactory = Object.assign({}, await import('../../packages/engine/src/core/harness-factory.js'));
const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.js'));
const realStructuredOutput = Object.assign({}, await import('../../packages/engine/src/core/structured-output.js'));

// ─── Mock state ─────────────────────────────────────────────────────────────

let mockGetWorkerProfileResult: ReturnType<typeof makeProfile> | null = null;
let mockGetWorkerProfileError: string | null = null;

const mockCreateHarness = mock(async () => ({
  session: {
    prompt: mock(async () => {}),
    subscribe: mock(() => mock()),
    getLastAssistantText: mock(() => ''),
    messages: [],
    sessionId: 'test-session-id',
    dispose: mock(),
  },
  sessionId: 'test-session-id',
  dispose: mock(),
}));

const mockPromptForStructured = mock(async (_harness: unknown, _prompt: string, _schema: unknown) => ({
  result: {} as Record<string, string>,
  attempts: 1,
}));

const mockIsGitRepo = mock(() => true);
const mockGetRepoRoot = mock(() => '/fake/repo/root');
const mockCreateWorktree = mock(() => {});
const mockRemoveWorktree = mock(() => {});
const mockListConflictedFiles = mock(() => []);
const mockStageAll = mock(() => {});
const mockCommitChanges = mock(() => {});
const mockCheckoutBranch = mock(() => {});
const mockMergeBranch = mock(() => ({ success: true }));
const mockAbortMerge = mock(() => {});
const mockPushBranch = mock(() => {});
const mockGetDiff = mock(() => 'diff --git a/file.txt b/file.txt');
const mockReadWorktreeCopyList = mock((): string[] => []);
const mockCopyFilesToWorktree = mock(() => {});
const mockGetMainBranch = mock(() => 'main');
const mockGetCurrentBranch = mock(() => 'main');

// ─── Mock module setup ──────────────────────────────────────────────────────

mock.module('../../packages/engine/src/core/profile.ts', () => ({
  loadProfilesFromDirs: mock(async (_dirs: string[]) => {
    if (mockGetWorkerProfileError) {
      // Return empty map — the module should detect missing 'worker' and throw
      return new Map();
    }
    const profile = mockGetWorkerProfileResult ?? makeProfile({ id: 'worker' });
    const map = new Map();
    map.set('worker', profile);
    return map;
  }),
}));

mock.module('../../packages/engine/src/core/harness-factory.ts', () => ({
  createHarness: mockCreateHarness,
}));

mock.module('../../packages/engine/src/core/structured-output.ts', () => ({
  promptForStructured: mockPromptForStructured,
}));

mock.module('../../packages/engine/src/core/git.ts', () => ({
  isGitRepo: mockIsGitRepo,
  getRepoRoot: mockGetRepoRoot,
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  listConflictedFiles: mockListConflictedFiles,
  stageAll: mockStageAll,
  commitChanges: mockCommitChanges,
  checkoutBranch: mockCheckoutBranch,
  mergeBranch: mockMergeBranch,
  abortMerge: mockAbortMerge,
  pushBranch: mockPushBranch,
  getDiff: mockGetDiff,
  readWorktreeCopyList: mockReadWorktreeCopyList,
  copyFilesToWorktree: mockCopyFilesToWorktree,
  getMainBranch: mockGetMainBranch,
  getCurrentBranch: mockGetCurrentBranch,
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import {
  generateCommitMessage,
  pushAndCreatePR,
  resolveConflictsWithAgent,
  setupWorktree,
  type WorktreeSetupResult,
} from '../../packages/engine/src/core/worktree-lifecycle.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function resetMocks() {
  mock.clearAllMocks();
  mockGetWorkerProfileResult = null;
  mockGetWorkerProfileError = null;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetMocks();

  // Default: createHarness returns a valid harness with dispose
  mockCreateHarness.mockResolvedValue({
    session: {
      prompt: mock(async () => {}),
      subscribe: mock(() => mock()),
      getLastAssistantText: mock(() => ''),
      messages: [],
      sessionId: 'test-session-id',
      dispose: mock(),
    },
    sessionId: 'test-session-id',
    dispose: mock(),
  });

  // Default: promptForStructured succeeds with various defaults
  mockPromptForStructured.mockImplementation(async (_harness: unknown, prompt: string, schema: unknown) => {
    // Inspect the schema to provide a reasonable default response
    const schemaAny = schema as { _def: { shape: () => Record<string, unknown> } };
    try {
      const shape = schemaAny._def?.shape?.() ?? {};
      const result: Record<string, string> = {};
      for (const key of Object.keys(shape)) {
        result[key] = 'mock-value';
      }
      // If 'branchName' is in the shape, provide a nice kebab-case name
      if ('branchName' in shape) {
        result.branchName = 'feature-test-task';
      }
      if ('message' in shape) {
        result.message = 'fix: resolve bug in parser';
      }
      if ('resolvedContent' in shape) {
        result.resolvedContent = 'resolved file content';
      }
      if ('prTitle' in shape) {
        result.prTitle = 'PR Title';
      }
      if ('prBody' in shape) {
        result.prBody = 'PR body content';
      }
      return { result, attempts: 1 };
    } catch {
      return { result: {}, attempts: 1 };
    }
  });

  mockIsGitRepo.mockReturnValue(true);
  mockGetRepoRoot.mockReturnValue('/fake/repo/root');
  mockCreateWorktree.mockReturnValue(undefined);
  mockRemoveWorktree.mockReturnValue(undefined);
  mockReadWorktreeCopyList.mockReturnValue([]);
  mockCopyFilesToWorktree.mockReturnValue(undefined);
  mockPushBranch.mockReturnValue(undefined);
  mockGetDiff.mockReturnValue('diff content here');
  mockStageAll.mockReturnValue(undefined);
  mockListConflictedFiles.mockReturnValue([]);
  mockGetMainBranch.mockReturnValue('main');
  mockGetCurrentBranch.mockReturnValue('main');
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../packages/engine/src/core/profile.ts', () => realProfile);
  mock.module('../../packages/engine/src/core/harness-factory.ts', () => realHarnessFactory);
  mock.module('../../packages/engine/src/core/git.ts', () => realGit);
  mock.module('../../packages/engine/src/core/structured-output.ts', () => realStructuredOutput);
});

// ─── setupWorktree ──────────────────────────────────────────────────────────

describe('setupWorktree', () => {
  it('throws if cwd is not a git repository', async () => {
    mockIsGitRepo.mockReturnValue(false);

    await expect(setupWorktree('/not/a/repo', [], 'test task')).rejects.toThrow(
      'Not a git repository. --worktree requires a git repo.',
    );
  });

  it('calls isGitRepo with the provided cwd', async () => {
    await setupWorktree('/my/project', ['/profiles'], 'test task');

    expect(mockIsGitRepo).toHaveBeenCalledWith('/my/project');
  });

  it('gets repo root via getRepoRoot', async () => {
    await setupWorktree('/my/project', ['/profiles'], 'test task');

    expect(mockGetRepoRoot).toHaveBeenCalledWith('/my/project');
  });

  it('throws if worker profile is not found', async () => {
    mockGetWorkerProfileError = 'not found';

    await expect(setupWorktree('/my/project', ['/profiles'], 'test task')).rejects.toThrow(/worker/i);
  });

  it('creates a harness with the worker profile', async () => {
    await setupWorktree('/my/project', ['/profiles'], 'test task', { openai: 'sk-key' });

    expect(mockCreateHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeys: { openai: 'sk-key' },
      }),
    );
  });

  it('prompts agent for branch name generation', async () => {
    await setupWorktree('/my/project', ['/profiles'], 'Implement login feature');

    expect(mockPromptForStructured).toHaveBeenCalledWith(
      expect.anything(), // harness
      expect.stringContaining('Implement login feature'),
      expect.anything(), // schema
    );
  });

  it('uses agent-generated branch name when available', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { branchName: 'implement-login' },
      attempts: 1,
    });

    const result = await setupWorktree('/my/project', ['/profiles'], 'Implement login feature');

    expect(result.branchName).toBe('implement-login');
  });

  it('sanitizes branch name by replacing non-alphanumeric-non-dash chars', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { branchName: 'fix bug #123!!!' },
      attempts: 1,
    });

    const result = await setupWorktree('/my/project', ['/profiles'], 'fix bug');

    // Non-alphanumeric, non-dash chars should be replaced with dash
    expect(result.branchName).toMatch(/^[a-z0-9-]+$/);
  });

  it('collapses multiple consecutive dashes in branch name', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { branchName: 'fix---bug---test' },
      attempts: 1,
    });

    const result = await setupWorktree('/my/project', ['/profiles'], 'fix bug');

    expect(result.branchName).not.toContain('---');
    // Should have collapsed to single dashes
    expect(result.branchName).toBe('fix-bug-test');
  });

  it('falls back to engin-worktree- prefix when prompt fails', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('Prompt failed'));

    const result = await setupWorktree('/my/project', ['/profiles'], 'test task');

    expect(result.branchName).toMatch(/^engin-worktree-\d+$/);
  });

  it('creates worktree with correct repo root, branch name, and path', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { branchName: 'my-feature' },
      attempts: 1,
    });

    await setupWorktree('/my/project', ['/profiles'], 'test task');

    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/fake/repo/root',
      'my-feature',
      join('/fake/repo/root', '..', '.engin-worktree-my-feature'),
    );
  });

  it('copies files from .worktreecopy when list is non-empty', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { branchName: 'my-feature' },
      attempts: 1,
    });
    mockReadWorktreeCopyList.mockReturnValue(['.env', 'config.json']);

    await setupWorktree('/my/project', ['/profiles'], 'test task');

    expect(mockCopyFilesToWorktree).toHaveBeenCalledWith(
      '/my/project',
      join('/fake/repo/root', '..', '.engin-worktree-my-feature'),
      ['.env', 'config.json'],
    );
  });

  it('does not call copyFilesToWorktree when .worktreecopy list is empty', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { branchName: 'my-feature' },
      attempts: 1,
    });
    mockReadWorktreeCopyList.mockReturnValue([]);

    await setupWorktree('/my/project', ['/profiles'], 'test task');

    expect(mockCopyFilesToWorktree).not.toHaveBeenCalled();
  });

  it('returns a result with worktreePath, branchName, worktreeInfo, and cleanup', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { branchName: 'test-branch' },
      attempts: 1,
    });

    const result = await setupWorktree('/my/project', ['/profiles'], 'test task');

    expect(result).toHaveProperty('worktreePath');
    expect(result).toHaveProperty('branchName');
    expect(result).toHaveProperty('worktreeInfo');
    expect(result).toHaveProperty('cleanup');
    expect(typeof result.cleanup).toBe('function');
  });

  it('returns worktreeInfo with worktreePath and branchName', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { branchName: 'test-branch' },
      attempts: 1,
    });

    const result = await setupWorktree('/my/project', ['/profiles'], 'test task');

    expect(result.worktreeInfo.branchName).toBe('test-branch');
    expect(result.worktreeInfo.worktreePath).toBe(join('/fake/repo/root', '..', '.engin-worktree-test-branch'));
  });

  it('cleanup function calls removeWorktree', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { branchName: 'cleanup-test' },
      attempts: 1,
    });

    const result = await setupWorktree('/my/project', ['/profiles'], 'test task');
    await result.cleanup();

    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      '/fake/repo/root',
      join('/fake/repo/root', '..', '.engin-worktree-cleanup-test'),
    );
  });

  it('disposes the harness even when prompt succeeds', async () => {
    const mockDispose = mock();
    mockCreateHarness.mockResolvedValue({
      session: {
        prompt: mock(async () => {}),
        subscribe: mock(() => mock()),
        getLastAssistantText: mock(() => ''),
        messages: [],
        sessionId: 'test-session-id',
        dispose: mock(),
      },
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });

    await setupWorktree('/my/project', ['/profiles'], 'test task');

    expect(mockDispose).toHaveBeenCalled();
  });

  it('disposes the harness when prompt fails (fallback branch name)', async () => {
    const mockDispose = mock();
    mockCreateHarness.mockResolvedValue({
      session: {
        prompt: mock(async () => {}),
        subscribe: mock(() => mock()),
        getLastAssistantText: mock(() => ''),
        messages: [],
        sessionId: 'test-session-id',
        dispose: mock(),
      },
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });
    mockPromptForStructured.mockRejectedValue(new Error('Agent failed'));

    await setupWorktree('/my/project', ['/profiles'], 'test task');

    expect(mockDispose).toHaveBeenCalled();
  });
});

// ─── generateCommitMessage ──────────────────────────────────────────────────

describe('generateCommitMessage', () => {
  it('creates a harness with the worker profile', async () => {
    await generateCommitMessage(['/profiles'], '/my/project', 'fix bug', 'diff content', {
      openai: 'sk-key',
    });

    expect(mockCreateHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeys: { openai: 'sk-key' },
      }),
    );
  });

  it('prompts with task and diff context', async () => {
    await generateCommitMessage(['/profiles'], '/my/project', 'Fix login bug', 'diff --git a/login.ts');

    expect(mockPromptForStructured).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Fix login bug'),
      expect.anything(),
    );
    expect(mockPromptForStructured).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('diff --git a/login.ts'),
      expect.anything(),
    );
  });

  it('uses z.object({ message: z.string() }) schema', async () => {
    await generateCommitMessage(['/profiles'], '/my/project', 'task', 'diff');

    const schemaArg = (mockPromptForStructured as ReturnType<typeof mock>).mock.calls[0][2];
    // Verify schema can parse a valid message object
    expect(schemaArg.safeParse({ message: 'test' }).success).toBe(true);
  });

  it('returns the generated commit message', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { message: 'fix: resolve parser bug' },
      attempts: 1,
    });

    const msg = await generateCommitMessage(['/profiles'], '/my/project', 'task', 'diff');

    expect(msg).toBe('fix: resolve parser bug');
  });

  it('truncates diff to 8000 characters in the prompt', async () => {
    const longDiff = 'x'.repeat(10000);

    await generateCommitMessage(['/profiles'], '/my/project', 'task', longDiff);

    const promptArg = (mockPromptForStructured as ReturnType<typeof mock>).mock.calls[0][1] as string;
    // The diff in the prompt should be truncated to 8000 chars
    // Find the diff portion — it should not contain more than 8000 x's
    const xRun = promptArg.match(/x+/)?.[0];
    expect(xRun?.length).toBeLessThanOrEqual(8000);
  });

  it('falls back to "Worktree changes for:" message on error', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('Agent failed'));

    const msg = await generateCommitMessage(['/profiles'], '/my/project', 'Fix the login page', 'diff');

    expect(msg).toBe('Worktree changes for: Fix the login page');
  });

  it('truncates task prompt in fallback message', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('Agent failed'));
    const longTask = 'A'.repeat(200);

    const msg = await generateCommitMessage(['/profiles'], '/my/project', longTask, 'diff');

    expect(msg).toContain('Worktree changes for:');
  });

  it('disposes the harness after successful prompt', async () => {
    const mockDispose = mock();
    mockCreateHarness.mockResolvedValue({
      session: {
        prompt: mock(async () => {}),
        subscribe: mock(() => mock()),
        getLastAssistantText: mock(() => ''),
        messages: [],
        sessionId: 'test-session-id',
        dispose: mock(),
      },
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });

    await generateCommitMessage(['/profiles'], '/my/project', 'task', 'diff');

    expect(mockDispose).toHaveBeenCalled();
  });

  it('disposes the harness even when prompt fails', async () => {
    const mockDispose = mock();
    mockCreateHarness.mockResolvedValue({
      session: {
        prompt: mock(async () => {}),
        subscribe: mock(() => mock()),
        getLastAssistantText: mock(() => ''),
        messages: [],
        sessionId: 'test-session-id',
        dispose: mock(),
      },
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });
    mockPromptForStructured.mockRejectedValue(new Error('Agent failed'));

    await generateCommitMessage(['/profiles'], '/my/project', 'task', 'diff');

    expect(mockDispose).toHaveBeenCalled();
  });
});

// ─── resolveConflictsWithAgent ──────────────────────────────────────────────

describe('resolveConflictsWithAgent', () => {
  it('returns true when all conflicted files are resolved successfully', async () => {
    // Mock readFileSync via the module that imports it
    // Since we mock the git module, and the source uses readFileSync directly,
    // we need to test behavior through the function

    mockPromptForStructured.mockResolvedValue({
      result: { resolvedContent: 'resolved content for file' },
      attempts: 1,
    });

    const result = await resolveConflictsWithAgent(
      ['/profiles'],
      '/fake/repo',
      ['conflicted-file.ts'],
      'Fix the merge conflicts',
    );

    expect(result).toBe(true);
    expect(mockStageAll).toHaveBeenCalledWith('/fake/repo');
  });

  it('processes each conflicted file individually', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { resolvedContent: 'resolved' },
      attempts: 1,
    });

    await resolveConflictsWithAgent(['/profiles'], '/fake/repo', ['file1.ts', 'file2.ts', 'file3.ts'], 'Fix conflicts');

    // Should have called promptForStructured once per file
    expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
  });

  it('returns false when any file resolution fails', async () => {
    mockPromptForStructured
      .mockResolvedValueOnce({ result: { resolvedContent: 'ok' }, attempts: 1 })
      .mockRejectedValueOnce(new Error('Failed to resolve'));

    const result = await resolveConflictsWithAgent(
      ['/profiles'],
      '/fake/repo',
      ['file1.ts', 'file2.ts'],
      'Fix conflicts',
    );

    expect(result).toBe(false);
  });

  it('does not call stageAll when resolution fails', async () => {
    mockPromptForStructured.mockRejectedValue(new Error('Failed'));

    await resolveConflictsWithAgent(['/profiles'], '/fake/repo', ['file1.ts'], 'Fix conflicts');

    expect(mockStageAll).not.toHaveBeenCalled();
  });

  it('passes apiKeys to harness creation', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { resolvedContent: 'resolved' },
      attempts: 1,
    });

    await resolveConflictsWithAgent(['/profiles'], '/fake/repo', ['file.ts'], 'task', { openai: 'sk-test' });

    expect(mockCreateHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeys: { openai: 'sk-test' },
      }),
    );
  });

  it('disposes the harness after processing all files', async () => {
    const mockDispose = mock();
    mockCreateHarness.mockResolvedValue({
      session: {
        prompt: mock(async () => {}),
        subscribe: mock(() => mock()),
        getLastAssistantText: mock(() => ''),
        messages: [],
        sessionId: 'test-session-id',
        dispose: mock(),
      },
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });
    mockPromptForStructured.mockResolvedValue({
      result: { resolvedContent: 'ok' },
      attempts: 1,
    });

    await resolveConflictsWithAgent(['/profiles'], '/fake/repo', ['file.ts'], 'task');

    expect(mockDispose).toHaveBeenCalled();
  });

  it('disposes the harness even when resolution fails', async () => {
    const mockDispose = mock();
    mockCreateHarness.mockResolvedValue({
      session: {
        prompt: mock(async () => {}),
        subscribe: mock(() => mock()),
        getLastAssistantText: mock(() => ''),
        messages: [],
        sessionId: 'test-session-id',
        dispose: mock(),
      },
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });
    mockPromptForStructured.mockRejectedValue(new Error('Failed'));

    await resolveConflictsWithAgent(['/profiles'], '/fake/repo', ['file.ts'], 'task');

    expect(mockDispose).toHaveBeenCalled();
  });

  it('returns true for empty conflicted files list', async () => {
    const result = await resolveConflictsWithAgent(['/profiles'], '/fake/repo', [], 'task');

    // No files to resolve = vacuously true
    expect(result).toBe(true);
  });
});

// ─── pushAndCreatePR ────────────────────────────────────────────────────────

describe('pushAndCreatePR', () => {
  it('pushes the branch before creating PR', async () => {
    await pushAndCreatePR(['/profiles'], '/my/project', 'feature-branch', 'task prompt', 'PR title');

    expect(mockPushBranch).toHaveBeenCalledWith('/my/project', 'feature-branch');
  });

  it('creates a harness with the worker profile and apiKeys', async () => {
    await pushAndCreatePR(['/profiles'], '/my/project', 'feature-branch', 'task prompt', 'PR title', {
      openai: 'sk-key',
    });

    expect(mockCreateHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeys: { openai: 'sk-key' },
      }),
    );
  });

  it('prompts for PR title and body', async () => {
    await pushAndCreatePR(['/profiles'], '/my/project', 'feature-branch', 'Implement login', 'Login Feature');

    expect(mockPromptForStructured).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything());

    // Verify schema has prTitle and prBody
    const schemaArg = (mockPromptForStructured as ReturnType<typeof mock>).mock.calls[0][2];
    expect(schemaArg.safeParse({ prTitle: 'test', prBody: 'body' }).success).toBe(true);
  });

  it('disposes the harness after PR creation', async () => {
    const mockDispose = mock();
    mockCreateHarness.mockResolvedValue({
      session: {
        prompt: mock(async () => {}),
        subscribe: mock(() => mock()),
        getLastAssistantText: mock(() => ''),
        messages: [],
        sessionId: 'test-session-id',
        dispose: mock(),
      },
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });

    await pushAndCreatePR(['/profiles'], '/my/project', 'feature-branch', 'task', 'title');

    expect(mockDispose).toHaveBeenCalled();
  });

  it('disposes harness even if gh pr create fails', async () => {
    const mockDispose = mock();
    mockCreateHarness.mockResolvedValue({
      session: {
        prompt: mock(async () => {}),
        subscribe: mock(() => mock()),
        getLastAssistantText: mock(() => ''),
        messages: [],
        sessionId: 'test-session-id',
        dispose: mock(),
      },
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });
    mockPromptForStructured.mockResolvedValue({
      result: { prTitle: 'Title', prBody: 'Body' },
      attempts: 1,
    });

    // Bun.spawnSync is used by the source for gh pr create - can't easily mock that
    // The test verifies dispose is called which is in the try/finally pattern
    // We test the dispose behavior indirectly
    expect(mockDispose).not.toHaveBeenCalled();

    try {
      await pushAndCreatePR(['/profiles'], '/my/project', 'feature-branch', 'task', 'title');
    } catch {
      // Expected: gh pr create will fail in test environment
    }

    expect(mockDispose).toHaveBeenCalled();
  });
});

// ─── WorktreeSetupResult interface shape ────────────────────────────────────

describe('WorktreeSetupResult interface', () => {
  it('result has the expected shape', async () => {
    mockPromptForStructured.mockResolvedValue({
      result: { branchName: 'interface-test' },
      attempts: 1,
    });

    const result: WorktreeSetupResult = await setupWorktree('/my/project', ['/profiles'], 'test');

    // Verify interface contract
    expect(typeof result.worktreePath).toBe('string');
    expect(typeof result.branchName).toBe('string');
    expect(typeof result.worktreeInfo).toBe('object');
    expect(typeof result.worktreeInfo.branchName).toBe('string');
    expect(typeof result.worktreeInfo.worktreePath).toBe('string');
    expect(typeof result.cleanup).toBe('function');
  });
});
