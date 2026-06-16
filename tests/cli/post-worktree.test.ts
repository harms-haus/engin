import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real modules before mocking ────────────────────────────────────

const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.ts'));
const realWorktreeLifecycle = Object.assign({}, await import('../../packages/engine/src/core/worktree-lifecycle.ts'));

// ─── Mock functions for git ─────────────────────────────────────────────────

const mockGetRepoRoot = mock(() => '/fake/repo');
const mockGetMainBranch = mock(() => 'main');
const mockGetCurrentBranch = mock(() => 'feature-branch');
const mockCheckoutBranch = mock(() => {});
const mockMergeBranch = mock(() => ({ success: true }));
const mockAbortMerge = mock(() => {});
const mockRemoveWorktree = mock(() => {});
const mockStageAll = mock(() => {});
const mockCommitChanges = mock(() => {});
const mockGetDiff = mock(() => 'diff content');

const mockGenerateCommitMessage = mock(async () => 'feat: implement feature');
const mockResolveConflictsWithAgent = mock(async () => true);
const mockPushAndCreatePR = mock(async () => {});

// ─── Mock modules ────────────────────────────────────────────────────────────

mock.module('../../packages/engine/src/core/git.ts', () => ({
  getRepoRoot: mockGetRepoRoot,
  getMainBranch: mockGetMainBranch,
  getCurrentBranch: mockGetCurrentBranch,
  checkoutBranch: mockCheckoutBranch,
  mergeBranch: mockMergeBranch,
  abortMerge: mockAbortMerge,
  removeWorktree: mockRemoveWorktree,
  stageAll: mockStageAll,
  commitChanges: mockCommitChanges,
  getDiff: mockGetDiff,
}));

mock.module('../../packages/engine/src/core/worktree-lifecycle.ts', () => ({
  generateCommitMessage: mockGenerateCommitMessage,
  resolveConflictsWithAgent: mockResolveConflictsWithAgent,
  pushAndCreatePR: mockPushAndCreatePR,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import {
  type PostWorktreeAction,
  type PostWorktreeOptions,
  type ReadlineQuestioner,
  commitInWorktree,
  handleMergeToMain,
  handlePushAndPR,
  promptPostWorktreeAction,
} from '../../packages/cli/src/cli/post-worktree.js';

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/git.ts', () => realGit);
  mock.module('../../packages/engine/src/core/worktree-lifecycle.ts', () => realWorktreeLifecycle);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOptions(overrides?: Partial<PostWorktreeOptions>): PostWorktreeOptions {
  return {
    profilesDirs: ['/profiles'],
    repoRoot: '/fake/repo',
    worktreePath: '/fake/repo/.git/worktrees/feature-branch',
    branchName: 'feature-branch',
    originalCwd: '/fake/repo',
    taskPrompt: 'Implement the login feature',
    ...overrides,
  };
}

/**
 * Create a mock ReadlineQuestioner that captures question callbacks.
 */
function createMockReadline(): ReadlineQuestioner & {
  _answer: (answer: string) => void;
  _close: ReturnType<typeof mock>;
  _question: ReturnType<typeof mock>;
} {
  let pendingCallback: ((answer: string) => void) | null = null;

  const rl = {
    _close: mock(() => {}),
    _question: mock((_prompt: string, callback: (answer: string) => void) => {
      pendingCallback = callback;
    }),
    _answer: (answer: string) => {
      if (pendingCallback) {
        const cb = pendingCallback;
        pendingCallback = null;
        cb(answer);
      }
    },
    question(_prompt: string, callback: (answer: string) => void) {
      rl._question(_prompt, callback);
    },
    close() {
      rl._close();
    },
  };
  return rl;
}

// ─── Reset mocks ─────────────────────────────────────────────────────────────

function resetMocks() {
  mock.clearAllMocks();
  mockGetRepoRoot.mockReturnValue('/fake/repo');
  mockGetMainBranch.mockReturnValue('main');
  mockGetCurrentBranch.mockReturnValue('feature-branch');
  mockGetDiff.mockReturnValue('diff content');
  mockGenerateCommitMessage.mockResolvedValue('feat: implement feature');
  mockResolveConflictsWithAgent.mockResolvedValue(true);
  mockPushAndCreatePR.mockResolvedValue(undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════
// promptPostWorktreeAction
// ═══════════════════════════════════════════════════════════════════════════════

describe('promptPostWorktreeAction', () => {
  let logSpy: ReturnType<typeof mock>;
  let originalLog: typeof console.log;

  beforeEach(() => {
    resetMocks();
    originalLog = console.log;
    logSpy = mock((..._args: unknown[]) => {});
    console.log = logSpy as unknown as typeof console.log;
  });

  afterEach(() => {
    console.log = originalLog;
    // Clean up any leftover SIGINT handlers
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);
  });

  // ─── Menu display ────────────────────────────────────────────────────────

  it('prints the menu with all three options', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('1');
    await promise;

    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain('Workflow completed in worktree');
    expect(logOutput).toContain('Do nothing (keep worktree)');
    expect(logOutput).toContain('Merge to main');
    expect(logOutput).toContain('Push and create pull request');
  });

  it('prompts with "Choose (1-3): "', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('1');
    await promise;

    expect(rl._question).toHaveBeenCalledWith(expect.stringContaining('Choose (1-3)'), expect.any(Function));
  });

  // ─── Option 1: Do nothing ────────────────────────────────────────────────

  it('option 1 prints worktree preserved message with path', async () => {
    const rl = createMockReadline();
    const options = makeOptions({ worktreePath: '/tmp/worktree-test' });
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('1');
    await promise;

    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain('Worktree preserved');
    expect(logOutput).toContain('/tmp/worktree-test');
  });

  it('option 1 does not call any git operations', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('1');
    await promise;

    expect(mockCheckoutBranch).not.toHaveBeenCalled();
    expect(mockMergeBranch).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockPushAndCreatePR).not.toHaveBeenCalled();
  });

  // ─── Option 2: Merge to main ─────────────────────────────────────────────

  it('option 2 commits changes in worktree when diff is non-empty', async () => {
    mockGetDiff.mockReturnValue('some diff content');
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    expect(mockGetDiff).toHaveBeenCalledWith('/fake/repo/.git/worktrees/feature-branch');
    expect(mockStageAll).toHaveBeenCalledWith('/fake/repo/.git/worktrees/feature-branch');
    expect(mockGenerateCommitMessage).toHaveBeenCalled();
    expect(mockCommitChanges).toHaveBeenCalledWith(
      '/fake/repo/.git/worktrees/feature-branch',
      'feat: implement feature',
    );
  });

  it('option 2 skips commit when diff is empty', async () => {
    mockGetDiff.mockReturnValue('');
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    expect(mockGetDiff).toHaveBeenCalled();
    expect(mockStageAll).not.toHaveBeenCalled();
    expect(mockGenerateCommitMessage).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('option 2 checks out main branch and merges', async () => {
    mockGetMainBranch.mockReturnValue('main');
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    expect(mockGetMainBranch).toHaveBeenCalledWith('/fake/repo');
    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'main');
    expect(mockMergeBranch).toHaveBeenCalledWith('/fake/repo', 'feature-branch');
  });

  it('option 2 on clean merge prints success message', async () => {
    mockMergeBranch.mockReturnValue({ success: true });
    mockGetMainBranch.mockReturnValue('main');
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions({ branchName: 'my-feature' }), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain('my-feature');
    expect(logOutput).toContain('main');
  });

  it('option 2 restores saved branch after merge', async () => {
    mockGetCurrentBranch.mockReturnValue('previous-branch');
    mockMergeBranch.mockReturnValue({ success: true });
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    // After merge, should try to restore the previously saved branch
    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'previous-branch');
  });

  it('option 2 ignores errors when restoring branch (detached HEAD)', async () => {
    mockGetCurrentBranch.mockReturnValue('previous-branch');
    mockMergeBranch.mockReturnValue({ success: true });
    // checkout main succeeds, restore previous branch fails
    mockCheckoutBranch
      .mockImplementationOnce(() => {}) // checkout main
      .mockImplementationOnce(() => {
        throw new Error('detached HEAD');
      }); // restore previous branch

    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');

    // Should not throw
    await expect(promise).resolves.toBeUndefined();
  });

  it('option 2 tries to remove worktree after successful merge', async () => {
    mockMergeBranch.mockReturnValue({ success: true });
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/fake/repo/.git/worktrees/feature-branch');
  });

  it('option 2 prints warning when worktree removal fails', async () => {
    mockMergeBranch.mockReturnValue({ success: true });
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('worktree busy');
    });
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toMatch(/warning/i);
  });

  // ─── Option 2: Merge conflicts ───────────────────────────────────────────

  it('option 2 resolves conflicts with agent when merge has conflicts', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts', 'file2.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    expect(mockResolveConflictsWithAgent).toHaveBeenCalled();
  });

  it('option 2 commits with merge resolution message after successful conflict resolution', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    // After resolving conflicts, should commit with a merge resolution message
    const commitCalls = mockCommitChanges.mock.calls;
    const lastCommit = commitCalls[commitCalls.length - 1];
    expect(lastCommit).toBeDefined();
    expect(lastCommit[1]).toMatch(/merge/i);
  });

  it('option 2 aborts merge and warns when conflict resolution fails', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(false);
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    expect(mockAbortMerge).toHaveBeenCalledWith('/fake/repo');
    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toMatch(/conflict/i);
    expect(logOutput).toMatch(/could not be resolved/i);
  });

  it('option 2 preserves worktree when conflicts cannot be resolved', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(false);
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('2');
    await promise;

    // Should NOT remove worktree when conflict resolution fails
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toMatch(/preserved/i);
  });

  // ─── Option 3: Push and create PR ─────────────────────────────────────────

  it('option 3 commits changes in worktree when diff is non-empty', async () => {
    mockGetDiff.mockReturnValue('some diff content');
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    expect(mockGetDiff).toHaveBeenCalledWith('/fake/repo/.git/worktrees/feature-branch');
    expect(mockStageAll).toHaveBeenCalledWith('/fake/repo/.git/worktrees/feature-branch');
    expect(mockGenerateCommitMessage).toHaveBeenCalled();
    expect(mockCommitChanges).toHaveBeenCalled();
  });

  it('option 3 skips commit when diff is empty', async () => {
    mockGetDiff.mockReturnValue('');
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    expect(mockStageAll).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('option 3 derives title from task prompt', async () => {
    const rl = createMockReadline();
    const options = makeOptions({ taskPrompt: 'Implement the login feature' });
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    const callArgs = mockPushAndCreatePR.mock.calls[0];
    const title = callArgs[4] as string;
    expect(title).toBe('Implement the login feature');
  });

  it('option 3 truncates long task prompt title to 57 chars with ellipsis', async () => {
    const longPrompt = 'A'.repeat(100);
    const rl = createMockReadline();
    const options = makeOptions({ taskPrompt: longPrompt });
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    const titleArg = mockPushAndCreatePR.mock.calls[0][4] as string;
    // Title should be truncated: 57 chars + "..." = 60 chars total
    expect(titleArg.length).toBeLessThanOrEqual(60);
    expect(titleArg).toMatch(/\.\.\.$/);
    expect(titleArg.length).toBe(60); // 57 + 3 for ellipsis
  });

  it('option 3 does not truncate short task prompt', async () => {
    const shortPrompt = 'Fix the bug';
    const rl = createMockReadline();
    const options = makeOptions({ taskPrompt: shortPrompt });
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    const titleArg = mockPushAndCreatePR.mock.calls[0][4] as string;
    expect(titleArg).toBe(shortPrompt);
    expect(titleArg).not.toContain('...');
  });

  it('option 3 passes apiKeys to pushAndCreatePR', async () => {
    const rl = createMockReadline();
    const options = makeOptions({ apiKeys: { openai: 'sk-test' } });
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    expect(mockPushAndCreatePR).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ openai: 'sk-test' }),
    );
  });

  it('option 3 tries to remove worktree after PR creation', async () => {
    const rl = createMockReadline();
    const options = makeOptions({ worktreePath: '/fake/repo/.git/worktrees/pr-branch' });
    const promise = promptPostWorktreeAction(options, () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/fake/repo/.git/worktrees/pr-branch');
  });

  it('option 3 prints warning when worktree removal fails', async () => {
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('worktree in use');
    });
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toMatch(/warning/i);
  });

  it('option 3 prints success message after PR creation', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));
    rl._answer('3');
    await promise;

    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toMatch(/success/i);
  });

  // ─── Input validation ────────────────────────────────────────────────────

  it('re-prompts on invalid input then accepts valid input', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));

    // First invalid answer
    rl._answer('abc');
    await new Promise((r) => setTimeout(r, 0));

    // Second valid answer
    rl._answer('1');
    await promise;

    expect(rl._question).toHaveBeenCalledTimes(2);
  });

  it('re-prompts on out-of-range input (4)', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));

    rl._answer('4');
    await new Promise((r) => setTimeout(r, 0));

    rl._answer('1');
    await promise;

    expect(rl._question).toHaveBeenCalledTimes(2);
  });

  it('re-prompts on zero input', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));

    rl._answer('0');
    await new Promise((r) => setTimeout(r, 0));

    rl._answer('1');
    await promise;

    expect(rl._question).toHaveBeenCalledTimes(2);
  });

  it('re-prompts on empty input', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));

    rl._answer('');
    await new Promise((r) => setTimeout(r, 0));

    rl._answer('1');
    await promise;

    expect(rl._question).toHaveBeenCalledTimes(2);
  });

  // ─── SIGINT handling ─────────────────────────────────────────────────────

  it('SIGINT closes readline and resolves as nothing', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));

    // The module registers process.once('SIGINT', handler)
    // Find it and invoke it
    const sigintListeners = process.listeners('SIGINT') as (() => void)[];
    expect(sigintListeners.length).toBeGreaterThan(0);

    const handler = sigintListeners[sigintListeners.length - 1];
    handler();

    await promise;

    // Should close the readline interface
    expect(rl._close).toHaveBeenCalled();
    // Should treat as "nothing" action - just print preserved message
    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain('Worktree preserved');
  });

  it('SIGINT handler does not call git operations', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));

    const sigintListeners = process.listeners('SIGINT') as (() => void)[];
    const handler = sigintListeners[sigintListeners.length - 1];
    handler();

    await promise;

    expect(mockCheckoutBranch).not.toHaveBeenCalled();
    expect(mockMergeBranch).not.toHaveBeenCalled();
    expect(mockPushAndCreatePR).not.toHaveBeenCalled();
  });

  // ─── Readline interface ──────────────────────────────────────────────────

  it('closes readline interface after valid input', async () => {
    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));

    rl._answer('1');
    await promise;

    expect(rl._close).toHaveBeenCalled();
  });

  it('removes SIGINT handler after valid input', async () => {
    const removeSpy = mock((_event: string, _handler: () => void) => {});
    const originalRemoveListener = process.removeListener.bind(process);
    process.removeListener = removeSpy as unknown as typeof process.removeListener;

    const rl = createMockReadline();
    const promise = promptPostWorktreeAction(makeOptions(), () => rl);
    await new Promise((r) => setTimeout(r, 0));

    rl._answer('1');
    await promise;

    // Should have called removeListener for SIGINT
    expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    process.removeListener = originalRemoveListener;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// commitInWorktree (unit tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('commitInWorktree', () => {
  let originalLog: typeof console.log;

  beforeEach(() => {
    resetMocks();
    originalLog = console.log;
    console.log = mock((..._args: unknown[]) => {}) as unknown as typeof console.log;
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it('commits when diff is non-empty', async () => {
    mockGetDiff.mockReturnValue('some diff');
    mockGenerateCommitMessage.mockResolvedValue('fix: resolve bug');

    await commitInWorktree(makeOptions());

    expect(mockGetDiff).toHaveBeenCalledWith('/fake/repo/.git/worktrees/feature-branch');
    expect(mockStageAll).toHaveBeenCalledWith('/fake/repo/.git/worktrees/feature-branch');
    expect(mockGenerateCommitMessage).toHaveBeenCalledWith(
      ['/profiles'],
      '/fake/repo/.git/worktrees/feature-branch',
      'Implement the login feature',
      'some diff',
      undefined,
    );
    expect(mockCommitChanges).toHaveBeenCalledWith('/fake/repo/.git/worktrees/feature-branch', 'fix: resolve bug');
  });

  it('does nothing when diff is empty', async () => {
    mockGetDiff.mockReturnValue('');

    await commitInWorktree(makeOptions());

    expect(mockStageAll).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('passes apiKeys to generateCommitMessage', async () => {
    mockGetDiff.mockReturnValue('diff');
    mockGenerateCommitMessage.mockResolvedValue('msg');

    await commitInWorktree(makeOptions({ apiKeys: { openai: 'sk-test' } }));

    expect(mockGenerateCommitMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { openai: 'sk-test' },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleMergeToMain (unit tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleMergeToMain', () => {
  let originalLog: typeof console.log;

  beforeEach(() => {
    resetMocks();
    originalLog = console.log;
    console.log = mock((..._args: unknown[]) => {}) as unknown as typeof console.log;
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it('saves current branch before starting', async () => {
    mockGetCurrentBranch.mockReturnValue('saved-branch');
    mockMergeBranch.mockReturnValue({ success: true });

    await handleMergeToMain(makeOptions());

    expect(mockGetCurrentBranch).toHaveBeenCalledWith('/fake/repo');
  });

  it('commits in worktree before merging', async () => {
    mockGetDiff.mockReturnValue('diff content');

    await handleMergeToMain(makeOptions());

    expect(mockGetDiff).toHaveBeenCalled();
    expect(mockStageAll).toHaveBeenCalled();
  });

  it('checks out main branch and merges feature branch', async () => {
    mockGetMainBranch.mockReturnValue('main');

    await handleMergeToMain(makeOptions({ branchName: 'my-feature' }));

    expect(mockGetMainBranch).toHaveBeenCalledWith('/fake/repo');
    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'main');
    expect(mockMergeBranch).toHaveBeenCalledWith('/fake/repo', 'my-feature');
  });

  it('on conflict calls resolveConflictsWithAgent', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['file1.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);

    await handleMergeToMain(makeOptions());

    expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
      ['/profiles'],
      '/fake/repo',
      ['file1.ts'],
      'Implement the login feature',
      undefined,
    );
  });

  it('on successful conflict resolution commits with merge message', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['a.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(true);
    mockGetMainBranch.mockReturnValue('main');

    await handleMergeToMain(makeOptions({ branchName: 'feat-x' }));

    // Find the merge resolution commit
    const commitCalls = mockCommitChanges.mock.calls;
    const mergeCommit = commitCalls.find((c) => (c[1] as string).includes('Merge resolution'));
    expect(mergeCommit).toBeDefined();
    expect(mergeCommit![0]).toBe('/fake/repo');
  });

  it('on failed conflict resolution aborts merge and warns', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['a.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(false);

    const logFn = mock((..._args: unknown[]) => {});
    const orig = console.log;
    console.log = logFn as unknown as typeof console.log;

    await handleMergeToMain(makeOptions());

    console.log = orig;

    expect(mockAbortMerge).toHaveBeenCalledWith('/fake/repo');
    const logOutput = logFn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toMatch(/conflict/i);
    expect(logOutput).toMatch(/could not be resolved/i);
  });

  it('on failed conflict resolution does not remove worktree', async () => {
    mockMergeBranch.mockReturnValue({ success: false, conflicts: ['a.ts'] });
    mockResolveConflictsWithAgent.mockResolvedValue(false);

    await handleMergeToMain(makeOptions());

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('restores saved branch after successful merge', async () => {
    mockGetCurrentBranch.mockReturnValue('previous');
    mockMergeBranch.mockReturnValue({ success: true });

    await handleMergeToMain(makeOptions());

    expect(mockCheckoutBranch).toHaveBeenCalledWith('/fake/repo', 'previous');
  });

  it('ignores error when restoring saved branch', async () => {
    mockGetCurrentBranch.mockReturnValue('previous');
    mockMergeBranch.mockReturnValue({ success: true });
    mockCheckoutBranch
      .mockImplementationOnce(() => {}) // checkout main
      .mockImplementationOnce(() => {
        throw new Error('detached HEAD');
      });

    // Should not throw
    await expect(handleMergeToMain(makeOptions())).resolves.toBeUndefined();
  });

  it('removes worktree on success', async () => {
    mockMergeBranch.mockReturnValue({ success: true });

    await handleMergeToMain(makeOptions({ worktreePath: '/path/to/wt' }));

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/path/to/wt');
  });

  it('warns on worktree removal failure', async () => {
    mockMergeBranch.mockReturnValue({ success: true });
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('busy');
    });

    const logFn = mock((..._args: unknown[]) => {});
    const orig = console.log;
    console.log = logFn as unknown as typeof console.log;

    await handleMergeToMain(makeOptions());

    console.log = orig;

    const logOutput = logFn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toMatch(/warning/i);
  });

  it('prints success message with branch names', async () => {
    mockMergeBranch.mockReturnValue({ success: true });
    mockGetMainBranch.mockReturnValue('main');

    const logFn = mock((..._args: unknown[]) => {});
    const orig = console.log;
    console.log = logFn as unknown as typeof console.log;

    await handleMergeToMain(makeOptions({ branchName: 'cool-feature' }));

    console.log = orig;

    const logOutput = logFn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain('cool-feature');
    expect(logOutput).toContain('main');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handlePushAndPR (unit tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('handlePushAndPR', () => {
  let originalLog: typeof console.log;

  beforeEach(() => {
    resetMocks();
    originalLog = console.log;
    console.log = mock((..._args: unknown[]) => {}) as unknown as typeof console.log;
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it('commits in worktree before pushing', async () => {
    mockGetDiff.mockReturnValue('diff content');

    await handlePushAndPR(makeOptions());

    expect(mockGetDiff).toHaveBeenCalled();
    expect(mockStageAll).toHaveBeenCalled();
  });

  it('skips commit when diff is empty', async () => {
    mockGetDiff.mockReturnValue('');

    await handlePushAndPR(makeOptions());

    expect(mockStageAll).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('passes title derived from task prompt to pushAndCreatePR', async () => {
    await handlePushAndPR(makeOptions({ taskPrompt: 'Add login page' }));

    expect(mockPushAndCreatePR).toHaveBeenCalledWith(
      ['/profiles'],
      '/fake/repo',
      'feature-branch',
      'Add login page',
      'Add login page',
      undefined,
    );
  });

  it('truncates title over 60 chars to 57 + ellipsis', async () => {
    const longPrompt = 'B'.repeat(80);
    await handlePushAndPR(makeOptions({ taskPrompt: longPrompt }));

    const callArgs = mockPushAndCreatePR.mock.calls[0];
    const title = callArgs[4] as string;
    expect(title.length).toBe(60);
    expect(title).toBe('B'.repeat(57) + '...');
  });

  it('does not truncate title at exactly 60 chars', async () => {
    const exactPrompt = 'C'.repeat(60);
    await handlePushAndPR(makeOptions({ taskPrompt: exactPrompt }));

    const callArgs = mockPushAndCreatePR.mock.calls[0];
    const title = callArgs[4] as string;
    expect(title).toBe(exactPrompt);
    expect(title).not.toContain('...');
  });

  it('truncates title at 61 chars', async () => {
    const prompt61 = 'D'.repeat(61);
    await handlePushAndPR(makeOptions({ taskPrompt: prompt61 }));

    const callArgs = mockPushAndCreatePR.mock.calls[0];
    const title = callArgs[4] as string;
    expect(title.length).toBe(60);
    expect(title.endsWith('...')).toBe(true);
  });

  it('passes apiKeys to pushAndCreatePR', async () => {
    await handlePushAndPR(makeOptions({ apiKeys: { anthropic: 'sk-ant' } }));

    expect(mockPushAndCreatePR).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { anthropic: 'sk-ant' },
    );
  });

  it('removes worktree after PR creation', async () => {
    await handlePushAndPR(makeOptions({ worktreePath: '/path/to/wt' }));

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/fake/repo', '/path/to/wt');
  });

  it('warns on worktree removal failure', async () => {
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('busy');
    });

    const logFn = mock((..._args: unknown[]) => {});
    const orig = console.log;
    console.log = logFn as unknown as typeof console.log;

    await handlePushAndPR(makeOptions());

    console.log = orig;

    const logOutput = logFn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toMatch(/warning/i);
  });

  it('prints success message', async () => {
    const logFn = mock((..._args: unknown[]) => {});
    const orig = console.log;
    console.log = logFn as unknown as typeof console.log;

    await handlePushAndPR(makeOptions({ branchName: 'pr-branch' }));

    console.log = orig;

    const logOutput = logFn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toMatch(/success/i);
    expect(logOutput).toContain('pr-branch');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Type exports
// ═══════════════════════════════════════════════════════════════════════════════

describe('PostWorktreeAction type', () => {
  it('accepts the three valid action values', () => {
    const actions: PostWorktreeAction[] = ['nothing', 'merge', 'pr'];
    expect(actions).toHaveLength(3);
    expect(actions).toContain('nothing');
    expect(actions).toContain('merge');
    expect(actions).toContain('pr');
  });
});

describe('PostWorktreeOptions interface', () => {
  it('has all required fields', () => {
    const opts: PostWorktreeOptions = {
      profilesDirs: ['/profiles'],
      repoRoot: '/repo',
      worktreePath: '/repo/.git/worktrees/branch',
      branchName: 'branch',
      originalCwd: '/repo',
      taskPrompt: 'do the thing',
    };
    expect(opts.profilesDirs).toEqual(['/profiles']);
    expect(opts.repoRoot).toBe('/repo');
    expect(opts.worktreePath).toBe('/repo/.git/worktrees/branch');
    expect(opts.branchName).toBe('branch');
    expect(opts.originalCwd).toBe('/repo');
    expect(opts.taskPrompt).toBe('do the thing');
  });

  it('accepts optional apiKeys', () => {
    const opts: PostWorktreeOptions = {
      profilesDirs: ['/profiles'],
      repoRoot: '/repo',
      worktreePath: '/repo/.git/worktrees/branch',
      branchName: 'branch',
      originalCwd: '/repo',
      taskPrompt: 'do the thing',
      apiKeys: { openai: 'sk-test' },
    };
    expect(opts.apiKeys).toEqual({ openai: 'sk-test' });
  });

  it('allows apiKeys to be undefined', () => {
    const opts: PostWorktreeOptions = {
      profilesDirs: ['/profiles'],
      repoRoot: '/repo',
      worktreePath: '/repo/.git/worktrees/branch',
      branchName: 'branch',
      originalCwd: '/repo',
      taskPrompt: 'do the thing',
    };
    expect(opts.apiKeys).toBeUndefined();
  });
});
