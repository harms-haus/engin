import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorktreeInfo } from '../../packages/engine/src/core/types.js';
import type { WorktreeManagerOptions } from '../../packages/engine/src/core/worktree-manager.js';
import { makeProfile } from '../helpers/make-profile.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Capture real modules before mocking ────────────────────────────────────
const realProfile = Object.assign({}, await import('../../packages/engine/src/core/profile.js'));
const realAgentRegistry = Object.assign({}, await import('../../packages/engine/src/core/agent-registry.js'));
const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.js'));
const realStructuredOutput = Object.assign({}, await import('../../packages/engine/src/core/structured-output.js'));
const realWorktreeFixup = Object.assign({}, await import('../../packages/engine/src/core/worktree-fixup.js'));
const realWorktreeManager = Object.assign({}, await import('../../packages/engine/src/core/worktree-manager.js'));
const realTitleGenerator = Object.assign({}, await import('../../packages/engine/src/core/title-generator.js'));

// ─── Mock state ─────────────────────────────────────────────────────────────

let mockGetWorkerProfileResult: ReturnType<typeof makeProfile> | null = null;
let mockGetWorkerProfileError: string | null = null;

const mockLoadProfilesFromDirs = mock(async (_dirs: string[]) => {
  if (mockGetWorkerProfileError) {
    // Return empty map — the module should detect missing 'worker' and throw
    return new Map();
  }
  const profile = mockGetWorkerProfileResult ?? makeProfile({ id: 'worker' });
  const map = new Map();
  map.set('worker', profile);
  return map;
});

// `createHarness` is mocked but should NOT be called after the registry-direct
// migration — tests assert it is never invoked for generateCommitMessage /
// pushAndCreatePR.
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

// `requireAgentPlugin` is the new direct entry point. It returns a fake plugin
// whose `createSession` produces a controllable AgentRuntime-shaped session.
const mockSessionDispose = mock();
const mockCreateSession = mock(async () => ({
  prompt: mock(async () => {}),
  subscribe: mock(() => mock()),
  getLastAssistantText: mock(() => ''),
  getLastAssistantMessage: mock(() => undefined),
  abort: mock(async () => {}),
  sessionId: 'test-session-id',
  dispose: mockSessionDispose,
}));
const mockPlugin = { id: 'pi-coding-agent', createSession: mockCreateSession };
const mockRequireAgentPlugin = mock(() => mockPlugin);

const mockPromptForStructured = mock(async (_harness: unknown, _prompt: string, _schema: unknown) => ({
  result: {} as Record<string, string>,
  attempts: 1,
}));

// Shape of the options object passed to runTooledFixup by resolveConflictsWithAgent.
interface FixupCallOpts {
  profilesDirs: string[];
  worktreePath: string;
  taskPrompt: string;
  errorContext: string;
  additionalContext?: string;
  apiKeys?: Record<string, string>;
  profileId?: string;
  maxAttempts?: number;
}

const mockRunTooledFixup = mock(
  async (_opts: FixupCallOpts): Promise<{ success: boolean; attempts: number; lastError?: string }> => ({
    success: true,
    attempts: 1,
  }),
);

const mockIsGitRepo = mock(() => true);
const mockGetRepoRoot = mock(() => '/fake/repo/root');
const mockCreateWorktree = mock(() => {});
const mockRemoveWorktree = mock(() => {});
const mockListConflictedFiles = mock(() => []);
const mockStageAll = mock(() => {});
const mockStageFiles = mock(() => {});
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
const mockSanitizeBranchSlug = mock((text: string): string => text);

// ─── generateTitleAndBranch mock ────────────────────────────────────────────

interface TitleGeneratorCallOpts {
  profilesDirs: string[];
  taskPrompt: string;
  cwd: string;
  apiKeys?: Record<string, string>;
}

const mockGenerateTitleAndBranch = mock(
  async (_opts: TitleGeneratorCallOpts): Promise<{ title: string; branchName: string }> => ({
    title: 'Test Task',
    branchName: 'test-task',
  }),
);

// ─── WorktreeManager mock ───────────────────────────────────────────────────
//
// setupWorktree must delegate ALL worktree creation to a WorktreeManager. We
// mock the class so we can assert the construction options, that
// setupMainWorktree() is called, and that cleanup delegates to the manager.

const mockSetupMainWorktree = mock(async (): Promise<void> => {});
const mockManagerCleanup = mock(async (): Promise<{ cleanupError?: string }> => ({}));
const mockManagerGetWorktreeInfo = mock(
  (): WorktreeInfo => ({
    worktreePath: '',
    branchName: '',
    originalCwd: '',
  }),
);

/** Options passed to the most recent `new WorktreeManager(...)` call. */
let lastManagerOpts: WorktreeManagerOptions | null = null;
/** All constructor option objects captured, in call order. */
const managerOptsCalls: WorktreeManagerOptions[] = [];

class MockWorktreeManager {
  readonly mainBranch: string;
  readonly mainWorktreePath: string;
  readonly repoRoot: string;
  readonly sourceCwd: string;

  constructor(opts: WorktreeManagerOptions) {
    lastManagerOpts = opts;
    managerOptsCalls.push(opts);
    this.mainBranch = opts.mainBranch;
    this.mainWorktreePath = opts.mainWorktreePath;
    this.repoRoot = opts.repoRoot;
    this.sourceCwd = opts.sourceCwd;
  }

  setupMainWorktree = mockSetupMainWorktree;
  cleanup = mockManagerCleanup;
  getWorktreeInfo = mockManagerGetWorktreeInfo;
}

// ─── Mock module setup ──────────────────────────────────────────────────────

mock.module('../../packages/engine/src/core/profile.ts', () => ({
  loadProfilesFromDirs: mockLoadProfilesFromDirs,
}));

mock.module('../../packages/engine/src/core/agent-registry.ts', () => ({
  requireAgentPlugin: mockRequireAgentPlugin,
}));

mock.module('../../packages/engine/src/core/structured-output.ts', () => ({
  promptForStructured: mockPromptForStructured,
}));

mock.module('../../packages/engine/src/core/worktree-fixup.ts', () => ({
  runTooledFixup: mockRunTooledFixup,
}));

mock.module('../../packages/engine/src/core/title-generator.ts', () => ({
  generateTitleAndBranch: mockGenerateTitleAndBranch,
}));

mock.module('../../packages/engine/src/core/worktree-manager.ts', () => ({
  WorktreeManager: MockWorktreeManager,
}));

mock.module('../../packages/engine/src/core/git.ts', () => ({
  isGitRepo: mockIsGitRepo,
  getRepoRoot: mockGetRepoRoot,
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  listConflictedFiles: mockListConflictedFiles,
  stageAll: mockStageAll,
  stageFiles: mockStageFiles,
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
  sanitizeBranchSlug: mockSanitizeBranchSlug,
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
  lastManagerOpts = null;
  managerOptsCalls.length = 0;
}

/** Mimics the real sanitizeBranchSlug so default integration tests are realistic. */
function realSanitize(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.length > 0 ? slug : `engin-worktree-${Date.now()}`;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetMocks();

  // Default: loadProfilesFromDirs returns a Map with the 'worker' profile
  mockLoadProfilesFromDirs.mockImplementation(async (_dirs: string[]) => {
    if (mockGetWorkerProfileError) {
      return new Map();
    }
    const profile = mockGetWorkerProfileResult ?? makeProfile({ id: 'worker' });
    const map = new Map();
    map.set('worker', profile);
    return map;
  });

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

  // Default: requireAgentPlugin returns a plugin whose createSession produces
  // a session with a fresh dispose spy.
  mockCreateSession.mockImplementation(async () => ({
    prompt: mock(async () => {}),
    subscribe: mock(() => mock()),
    getLastAssistantText: mock(() => ''),
    getLastAssistantMessage: mock(() => undefined),
    abort: mock(async () => {}),
    sessionId: 'test-session-id',
    dispose: mockSessionDispose,
  }));
  mockRequireAgentPlugin.mockReturnValue(mockPlugin);

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
  mockStageFiles.mockReturnValue(undefined);
  mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });
  mockListConflictedFiles.mockReturnValue([]);
  mockGetMainBranch.mockReturnValue('main');
  mockGetCurrentBranch.mockReturnValue('main');

  // ── setupWorktree delegation defaults ────────────────────────────────────
  mockGenerateTitleAndBranch.mockResolvedValue({
    title: 'Test Task',
    branchName: 'test-task',
  });
  mockSanitizeBranchSlug.mockImplementation(realSanitize);
  mockSetupMainWorktree.mockResolvedValue(undefined);
  mockManagerCleanup.mockResolvedValue({});
  mockManagerGetWorktreeInfo.mockReturnValue({
    worktreePath: '',
    branchName: '',
    originalCwd: '',
  });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
  mock.module('../../packages/engine/src/core/profile.ts', () => realProfile);
  mock.module('../../packages/engine/src/core/agent-registry.ts', () => realAgentRegistry);
  mock.module('../../packages/engine/src/core/git.ts', () => realGit);
  mock.module('../../packages/engine/src/core/structured-output.ts', () => realStructuredOutput);
  mock.module('../../packages/engine/src/core/worktree-fixup.ts', () => realWorktreeFixup);
  mock.module('../../packages/engine/src/core/worktree-manager.ts', () => realWorktreeManager);
  mock.module('../../packages/engine/src/core/title-generator.ts', () => realTitleGenerator);
});

// ─── setupWorktree ──────────────────────────────────────────────────────────
//
// The refactored setupWorktree DELEGATES worktree creation to a WorktreeManager
// (calling setupMainWorktree) and uses generateTitleAndBranch instead of a
// bespoke promptForStructured branch-name call. This avoids the double-worktree
// bug where both setupWorktree and WorktreeManager tried to create the same
// worktree.

describe('setupWorktree', () => {
  // ─── Input validation ───────────────────────────────────────────────────────

  it('throws if cwd is not a git repository', async () => {
    mockIsGitRepo.mockReturnValue(false);

    await expect(setupWorktree('/not/a/repo', '/run/work', [], 'test task')).rejects.toThrow(
      'Not a git repository. --worktree requires a git repo.',
    );
  });

  it('calls isGitRepo with the provided cwd', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockIsGitRepo).toHaveBeenCalledWith('/my/project');
  });

  it('does not delegate to the manager when cwd is not a git repo', async () => {
    mockIsGitRepo.mockReturnValue(false);

    await expect(setupWorktree('/not/a/repo', '/run/work', [], 'test task')).rejects.toThrow();

    expect(mockGenerateTitleAndBranch).not.toHaveBeenCalled();
    expect(managerOptsCalls).toHaveLength(0);
    expect(mockSetupMainWorktree).not.toHaveBeenCalled();
  });

  it('gets repo root via getRepoRoot(cwd)', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockGetRepoRoot).toHaveBeenCalledWith('/my/project');
  });

  // ─── Branch name generation via generateTitleAndBranch ──────────────────────

  it('calls generateTitleAndBranch instead of promptForStructured for branch name generation', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'Implement login feature');

    expect(mockGenerateTitleAndBranch).toHaveBeenCalledTimes(1);
    // The old per-function promptForStructured branch-name call must be gone.
    expect(mockPromptForStructured).not.toHaveBeenCalled();
  });

  it('passes profilesDirs, taskPrompt, cwd, and apiKeys to generateTitleAndBranch', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'Build the API', {
      openai: 'sk-key',
    });

    expect(mockGenerateTitleAndBranch).toHaveBeenCalledWith({
      profilesDirs: ['/profiles'],
      taskPrompt: 'Build the API',
      cwd: '/my/project',
      apiKeys: { openai: 'sk-key' },
    });
  });

  it('passes undefined apiKeys to generateTitleAndBranch when omitted', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'Build the API');

    expect(mockGenerateTitleAndBranch).toHaveBeenCalledWith(expect.objectContaining({ apiKeys: undefined }));
  });

  it('does not create a harness directly (generateTitleAndBranch owns its own harness)', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockCreateHarness).not.toHaveBeenCalled();
  });

  it('does not load the worker profile directly (no longer needed for branch name)', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockLoadProfilesFromDirs).not.toHaveBeenCalled();
  });

  // ─── Slug + main branch computation ─────────────────────────────────────────

  it('sanitizes the raw branch name from generateTitleAndBranch via sanitizeBranchSlug', async () => {
    mockGenerateTitleAndBranch.mockResolvedValue({ title: 'T', branchName: 'My Feature!!!' });
    mockSanitizeBranchSlug.mockReturnValue('sanitized-slug');

    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockSanitizeBranchSlug).toHaveBeenCalledWith('My Feature!!!');
  });

  it('prefixes the sanitized slug with engin/ to form the main branch name', async () => {
    mockGenerateTitleAndBranch.mockResolvedValue({ title: 'T', branchName: 'raw' });
    mockSanitizeBranchSlug.mockReturnValue('my-feature');

    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(result.branchName).toBe('engin/my-feature');
  });

  it('pipes the raw branchName through real-style sanitization by default', async () => {
    // Default mockSanitizeBranchSlug mimics the real implementation.
    mockGenerateTitleAndBranch.mockResolvedValue({ title: 'T', branchName: 'Fix Bug #123!!!' });

    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    // spaces, '#', '!' become dashes; consecutive dashes collapse; edges trim.
    expect(result.branchName).toBe('engin/fix-bug-123');
  });

  it('passes the manager the engin/<slug> branch even when the raw name is empty', async () => {
    mockGenerateTitleAndBranch.mockResolvedValue({ title: 'T', branchName: '' });
    mockSanitizeBranchSlug.mockReturnValue('engin-worktree-1700000000000');

    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(managerOptsCalls[0]?.mainBranch).toBe('engin/engin-worktree-1700000000000');
  });

  // ─── WorktreeManager delegation (the double-worktree fix) ────────────────────

  it('constructs a WorktreeManager with repoRoot, sourceCwd, workDir, mainBranch, mainWorktreePath, profilesDirs, apiKeys', async () => {
    mockGenerateTitleAndBranch.mockResolvedValue({ title: 'T', branchName: 'raw' });
    mockSanitizeBranchSlug.mockReturnValue('my-feature');

    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task', {
      openai: 'sk-key',
    });

    expect(managerOptsCalls).toHaveLength(1);
    expect(managerOptsCalls[0]).toEqual({
      repoRoot: '/fake/repo/root',
      sourceCwd: '/my/project',
      workDir: '/run/work',
      mainBranch: 'engin/my-feature',
      mainWorktreePath: join('/run/work', 'worktree'),
      profilesDirs: ['/profiles'],
      apiKeys: { openai: 'sk-key' },
    });
  });

  it('constructs exactly one WorktreeManager', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(managerOptsCalls).toHaveLength(1);
  });

  it('calls manager.setupMainWorktree() after construction', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockSetupMainWorktree).toHaveBeenCalledTimes(1);
  });

  it('does NOT call createWorktree directly (delegates to WorktreeManager.setupMainWorktree)', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('does NOT call copyFilesToWorktree directly (delegates to WorktreeManager)', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockCopyFilesToWorktree).not.toHaveBeenCalled();
  });

  it('does NOT call readWorktreeCopyList directly (delegates to WorktreeManager)', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockReadWorktreeCopyList).not.toHaveBeenCalled();
  });

  it('does NOT call removeWorktree during setup (cleanup is deferred to the manager)', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  // ─── Path computation ───────────────────────────────────────────────────────

  it('computes the main worktree path as {workDir}/worktree', async () => {
    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(result.worktreePath).toBe(join('/run/work', 'worktree'));
    expect(managerOptsCalls[0]?.mainWorktreePath).toBe(join('/run/work', 'worktree'));
  });

  it('places the main worktree inside workDir, not in {repoRoot}/..', async () => {
    mockGetRepoRoot.mockReturnValue('/fake/repo/root');

    const result = await setupWorktree('/my/project', '/custom/run/dir', ['/profiles'], 'test task');

    expect(result.worktreePath).toBe(join('/custom/run/dir', 'worktree'));
    // Must NOT use the old {repoRoot}/../.engin-worktree-* location.
    expect(result.worktreePath).not.toContain('/fake/repo/root');
  });

  // ─── Result shape ───────────────────────────────────────────────────────────

  it('returns the manager instance in the result', async () => {
    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(result.manager).toBeDefined();
    expect(result.manager).toBeInstanceOf(MockWorktreeManager);
  });

  it('returns the same manager instance that setupMainWorktree was called on', async () => {
    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    // setupMainWorktree was invoked exactly once, on the returned manager.
    expect(mockSetupMainWorktree).toHaveBeenCalledTimes(1);
    expect(result.manager.setupMainWorktree).toBe(mockSetupMainWorktree);
  });

  it('returns worktreePath equal to the main worktree path', async () => {
    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(result.worktreePath).toBe(join('/run/work', 'worktree'));
  });

  it('returns branchName equal to the engin/<slug> main branch', async () => {
    mockGenerateTitleAndBranch.mockResolvedValue({ title: 'T', branchName: 'raw' });
    mockSanitizeBranchSlug.mockReturnValue('login-feature');

    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(result.branchName).toBe('engin/login-feature');
  });

  it('returns worktreeInfo with worktreePath, branchName, and originalCwd', async () => {
    mockGenerateTitleAndBranch.mockResolvedValue({ title: 'T', branchName: 'raw' });
    mockSanitizeBranchSlug.mockReturnValue('the-slug');

    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(result.worktreeInfo).toEqual({
      worktreePath: join('/run/work', 'worktree'),
      branchName: 'engin/the-slug',
      originalCwd: '/my/project',
    });
  });

  it('returns a cleanup function', async () => {
    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(typeof result.cleanup).toBe('function');
  });

  // ─── cleanup delegation ─────────────────────────────────────────────────────

  it('cleanup calls manager.cleanup()', async () => {
    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(mockManagerCleanup).not.toHaveBeenCalled();

    await result.cleanup();

    expect(mockManagerCleanup).toHaveBeenCalledTimes(1);
  });

  it('cleanup does NOT call removeWorktree directly (delegates to the manager)', async () => {
    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    await result.cleanup();

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('cleanup is best-effort and swallows manager.cleanup rejections', async () => {
    mockManagerCleanup.mockRejectedValue(new Error('cleanup boom'));
    const result = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  // ─── apiKeys forwarding ─────────────────────────────────────────────────────

  it('forwards apiKeys to the WorktreeManager constructor', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task', {
      anthropic: 'sk-ant',
    });

    expect(managerOptsCalls[0]?.apiKeys).toEqual({ anthropic: 'sk-ant' });
  });

  it('forwards undefined apiKeys to the WorktreeManager when omitted', async () => {
    await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task');

    expect(managerOptsCalls[0]?.apiKeys).toBeUndefined();
  });

  // ─── Error propagation ──────────────────────────────────────────────────────

  it('does not construct the manager when getRepoRoot throws', async () => {
    mockGetRepoRoot.mockImplementation(() => {
      throw new Error('not a repo');
    });

    await expect(setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task')).rejects.toThrow('not a repo');

    expect(managerOptsCalls).toHaveLength(0);
    expect(mockSetupMainWorktree).not.toHaveBeenCalled();
  });

  it('propagates errors from manager.setupMainWorktree', async () => {
    mockSetupMainWorktree.mockRejectedValue(new Error('worktree create failed'));

    await expect(setupWorktree('/my/project', '/run/work', ['/profiles'], 'test task')).rejects.toThrow(
      'worktree create failed',
    );
  });
});

// ─── generateCommitMessage ──────────────────────────────────────────────────

describe('generateCommitMessage', () => {
  it('resolves the session via requireAgentPlugin().createSession() instead of createHarness', async () => {
    await generateCommitMessage(['/profiles'], '/my/project', 'fix bug', 'diff content', {
      openai: 'sk-key',
    });

    // After migration, createHarness MUST NOT be called.
    expect(mockCreateHarness).not.toHaveBeenCalled();
    // requireAgentPlugin resolves the plugin for profile.agent.
    expect(mockRequireAgentPlugin).toHaveBeenCalledTimes(1);
    // createSession received { profile, cwd, apiKeys }.
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/my/project',
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

  it('disposes the session after successful prompt', async () => {
    const mockDispose = mock();
    mockCreateSession.mockResolvedValue({
      prompt: mock(async () => {}),
      subscribe: mock(() => mock()),
      getLastAssistantText: mock(() => ''),
      getLastAssistantMessage: mock(() => undefined),
      abort: mock(async () => {}),
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });

    await generateCommitMessage(['/profiles'], '/my/project', 'task', 'diff');

    expect(mockDispose).toHaveBeenCalled();
    expect(mockCreateHarness).not.toHaveBeenCalled();
  });

  it('disposes the session even when prompt fails', async () => {
    const mockDispose = mock();
    mockCreateSession.mockResolvedValue({
      prompt: mock(async () => {}),
      subscribe: mock(() => mock()),
      getLastAssistantText: mock(() => ''),
      getLastAssistantMessage: mock(() => undefined),
      abort: mock(async () => {}),
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });
    mockPromptForStructured.mockRejectedValue(new Error('Agent failed'));

    await generateCommitMessage(['/profiles'], '/my/project', 'task', 'diff');

    expect(mockDispose).toHaveBeenCalled();
    expect(mockCreateHarness).not.toHaveBeenCalled();
  });
});

// ─── resolveConflictsWithAgent ──────────────────────────────────────────────
//
// The hardened implementation delegates to the tooled fix-up primitive
// (`runTooledFixup`) instead of `promptForStructured`/`createHarness`. That
// primitive spawns its OWN self-verifying (tsc + eslint) agent with a retry
// budget and edits files directly via tools — so there is no manual
// `writeFileSync`, no silent catches, and `stageFiles` stages ONLY the
// conflicted files (never a sweeping `stageAll`).

describe('resolveConflictsWithAgent', () => {
  // Real temp dir so the implementation's readFileSync sees real conflict files
  // (avoids having to mock node:fs and lets us assert on the actual content that
  // gets fed into the fix-up prompt).
  const { getDir } = useTempDir();

  it('returns true immediately when the conflicts array is empty', async () => {
    const result = await resolveConflictsWithAgent(['/profiles'], getDir(), [], 'Fix conflicts');

    expect(result).toEqual({ resolved: true });
    // Short-circuits before spawning any agent or touching the index
    expect(mockRunTooledFixup).not.toHaveBeenCalled();
    expect(mockStageFiles).not.toHaveBeenCalled();
    expect(mockStageAll).not.toHaveBeenCalled();
  });

  it('returns true when fixup succeeds and stages only the conflicted files', async () => {
    await writeFile(join(getDir(), 'conflict.ts'), '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch\n');
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    const result = await resolveConflictsWithAgent(['/profiles'], getDir(), ['conflict.ts'], 'Fix conflicts');

    expect(result).toEqual({ resolved: true });
    // Weakness #4 fix: stage ONLY the conflicted files — never a sweeping stageAll
    expect(mockStageFiles).toHaveBeenCalledWith(getDir(), ['conflict.ts']);
    expect(mockStageAll).not.toHaveBeenCalled();
  });

  it('stages every conflicted file when there are multiple', async () => {
    await writeFile(join(getDir(), 'a.ts'), 'a conflict\n');
    await writeFile(join(getDir(), 'b.ts'), 'b conflict\n');
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 2 });

    const result = await resolveConflictsWithAgent(['/profiles'], getDir(), ['a.ts', 'b.ts'], 'Fix conflicts');

    expect(result).toEqual({ resolved: true });
    expect(mockStageFiles).toHaveBeenCalledWith(getDir(), ['a.ts', 'b.ts']);
    expect(mockStageAll).not.toHaveBeenCalled();
  });

  it('resolves the whole conflict set in a single fixup session (not one per file)', async () => {
    // Weakness #2 fix: resolve all conflicts together in one agent session
    await writeFile(join(getDir(), 'a.ts'), 'aaa\n');
    await writeFile(join(getDir(), 'b.ts'), 'bbb\n');
    await writeFile(join(getDir(), 'c.ts'), 'ccc\n');
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await resolveConflictsWithAgent(['/profiles'], getDir(), ['a.ts', 'b.ts', 'c.ts'], 'Fix conflicts');

    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
  });

  it('returns false when fixup reports failure and does not stage anything', async () => {
    await writeFile(join(getDir(), 'conflict.ts'), 'conflict content\n');
    mockRunTooledFixup.mockResolvedValue({ success: false, attempts: 3, lastError: 'tsc --noEmit failed' });

    const result = await resolveConflictsWithAgent(['/profiles'], getDir(), ['conflict.ts'], 'Fix conflicts');

    expect(result).toEqual({ resolved: false, error: 'tsc --noEmit failed' });
    expect(mockStageFiles).not.toHaveBeenCalled();
    expect(mockStageAll).not.toHaveBeenCalled();
  });

  it('does not use the old createHarness / promptForStructured path', async () => {
    // Weakness #3/#5 fix: verification + file edits are delegated entirely to the
    // tooled fix-up primitive; no manual writeFileSync or silent catches remain.
    await writeFile(join(getDir(), 'conflict.ts'), 'conflict content\n');
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await resolveConflictsWithAgent(['/profiles'], getDir(), ['conflict.ts'], 'Fix conflicts');

    expect(mockCreateHarness).not.toHaveBeenCalled();
    expect(mockPromptForStructured).not.toHaveBeenCalled();
  });

  it('passes repoRoot as worktreePath to runTooledFixup', async () => {
    await writeFile(join(getDir(), 'conflict.ts'), 'conflict content\n');
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await resolveConflictsWithAgent(['/profiles'], getDir(), ['conflict.ts'], 'Fix conflicts');

    expect(mockRunTooledFixup).toHaveBeenCalledWith(
      expect.objectContaining({
        profilesDirs: ['/profiles'],
        worktreePath: getDir(),
        taskPrompt: 'Fix conflicts',
      }),
    );
  });

  it('passes apiKeys through to runTooledFixup', async () => {
    await writeFile(join(getDir(), 'conflict.ts'), 'conflict content\n');
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await resolveConflictsWithAgent(['/profiles'], getDir(), ['conflict.ts'], 'Fix conflicts', {
      openai: 'sk-test',
    });

    expect(mockRunTooledFixup).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeys: { openai: 'sk-test' },
      }),
    );
  });

  it('feeds the conflicted file content and task into the error context', async () => {
    // Weakness #1 fix: give the agent real conflict context, not just the file name
    const content = '<<<<<<< HEAD\nmy change\n=======\ntheir change\n>>>>>>> branch\n';
    await writeFile(join(getDir(), 'conflict.ts'), content);
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await resolveConflictsWithAgent(['/profiles'], getDir(), ['conflict.ts'], 'Fix conflicts');

    const opts = mockRunTooledFixup.mock.calls[0][0];
    expect(opts.errorContext).toContain('conflict.ts');
    expect(opts.errorContext).toContain('my change');
    expect(opts.errorContext).toContain('their change');
    expect(opts.errorContext).toContain('Fix conflicts');
  });

  it('includes every conflicted file in the single error context', async () => {
    await writeFile(join(getDir(), 'a.ts'), 'aaa\n');
    await writeFile(join(getDir(), 'b.ts'), 'bbb\n');
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await resolveConflictsWithAgent(['/profiles'], getDir(), ['a.ts', 'b.ts'], 'Fix conflicts');

    const opts = mockRunTooledFixup.mock.calls[0][0];
    expect(opts.errorContext).toContain('a.ts');
    expect(opts.errorContext).toContain('b.ts');
    expect(opts.errorContext).toContain('aaa');
    expect(opts.errorContext).toContain('bbb');
  });

  it('caps the conflict context at 8000 characters', async () => {
    // Weakness #6 fix: cap total error context like generateCommitMessage
    await writeFile(join(getDir(), 'big.ts'), 'x'.repeat(20000));
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await resolveConflictsWithAgent(['/profiles'], getDir(), ['big.ts'], 'Fix conflicts');

    const opts = mockRunTooledFixup.mock.calls[0][0];
    // The content run must be capped at 8000 — not the full 20000
    const xRun = opts.errorContext.match(/x+/)?.[0] ?? '';
    expect(xRun.length).toBeLessThanOrEqual(8000);
    expect(opts.errorContext).toContain('... (truncated)');
  });

  it('does not truncate conflict content under the 8000 cap', async () => {
    await writeFile(join(getDir(), 'small.ts'), 'short content\n');
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await resolveConflictsWithAgent(['/profiles'], getDir(), ['small.ts'], 'Fix conflicts');

    const opts = mockRunTooledFixup.mock.calls[0][0];
    expect(opts.errorContext).not.toContain('... (truncated)');
    expect(opts.errorContext).toContain('short content');
  });
});

// ─── pushAndCreatePR ────────────────────────────────────────────────────────

describe('pushAndCreatePR', () => {
  it('pushes the branch before creating PR', async () => {
    await pushAndCreatePR(['/profiles'], '/my/project', 'feature-branch', 'task prompt', 'PR title');

    expect(mockPushBranch).toHaveBeenCalledWith('/my/project', 'feature-branch');
  });

  it('resolves the session via requireAgentPlugin().createSession() with apiKeys', async () => {
    await pushAndCreatePR(['/profiles'], '/my/project', 'feature-branch', 'task prompt', 'PR title', {
      openai: 'sk-key',
    });

    // After migration, createHarness MUST NOT be called.
    expect(mockCreateHarness).not.toHaveBeenCalled();
    expect(mockRequireAgentPlugin).toHaveBeenCalledTimes(1);
    // createSession received { profile, cwd: repoRoot, apiKeys }.
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/my/project',
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

  it('disposes the session after PR creation', async () => {
    const mockDispose = mock();
    mockCreateSession.mockResolvedValue({
      prompt: mock(async () => {}),
      subscribe: mock(() => mock()),
      getLastAssistantText: mock(() => ''),
      getLastAssistantMessage: mock(() => undefined),
      abort: mock(async () => {}),
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });

    await pushAndCreatePR(['/profiles'], '/my/project', 'feature-branch', 'task', 'title');

    expect(mockDispose).toHaveBeenCalled();
    expect(mockCreateHarness).not.toHaveBeenCalled();
  });

  it('disposes session even if gh pr create fails', async () => {
    const mockDispose = mock();
    mockCreateSession.mockResolvedValue({
      prompt: mock(async () => {}),
      subscribe: mock(() => mock()),
      getLastAssistantText: mock(() => ''),
      getLastAssistantMessage: mock(() => undefined),
      abort: mock(async () => {}),
      sessionId: 'test-session-id',
      dispose: mockDispose,
    });
    mockPromptForStructured.mockResolvedValue({
      result: { prTitle: 'Title', prBody: 'Body' },
      attempts: 1,
    });

    // Bun.spawnSync is used by the source for gh pr create - can't easily mock that
    // The test verifies dispose is called which is in the try/finally pattern
    expect(mockDispose).not.toHaveBeenCalled();

    try {
      await pushAndCreatePR(['/profiles'], '/my/project', 'feature-branch', 'task', 'title');
    } catch {
      // Expected: gh pr create will fail in test environment
    }

    expect(mockDispose).toHaveBeenCalled();
    expect(mockCreateHarness).not.toHaveBeenCalled();
  });
});

// ─── WorktreeSetupResult interface shape ────────────────────────────────────

describe('WorktreeSetupResult interface', () => {
  it('result has the expected shape including the manager field', async () => {
    const result: WorktreeSetupResult = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test');

    // Verify interface contract
    expect(typeof result.worktreePath).toBe('string');
    expect(typeof result.branchName).toBe('string');
    expect(typeof result.worktreeInfo).toBe('object');
    expect(typeof result.worktreeInfo.branchName).toBe('string');
    expect(typeof result.worktreeInfo.worktreePath).toBe('string');
    expect(result.manager).toBeDefined();
    expect(typeof result.cleanup).toBe('function');
  });

  it('result.manager exposes the WorktreeManager surface', async () => {
    const result: WorktreeSetupResult = await setupWorktree('/my/project', '/run/work', ['/profiles'], 'test');

    expect(typeof result.manager.setupMainWorktree).toBe('function');
    expect(typeof result.manager.cleanup).toBe('function');
    expect(typeof result.manager.getWorktreeInfo).toBe('function');
  });
});
