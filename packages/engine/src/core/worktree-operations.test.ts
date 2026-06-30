// ─── Tests for worktree-operations.ts ──────────────────────────────────────
//
// Unit tests for the two exported functions of this module:
//   1. `commitWorktreeChanges` — verifies its clean-tree no-op behavior
//      (stage-all then early return when the diff is empty, with no commit
//      message generated and no commit made).
//   2. `createLintValidationGate` — verifies the prettier-then-eslint gate
//      returns `undefined` when clean and `{ error }` when lint errors remain
//      (Bun.spawn is stubbed so no real tooling runs).

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real modules before mocking ──────────────────────────────────

const realGit = Object.assign({}, await import('./git.js'));
const realWorktreeFixup = Object.assign({}, await import('./worktree-fixup.js'));
const realWorktreeLifecycle = Object.assign({}, await import('./worktree-lifecycle.js'));

// ─── Mock functions ─────────────────────────────────────────────────────────

const mockStageAll = mock((_dir: string): void => {});
const mockGetDiff = mock((_dir: string): string => '');
const mockCommitChanges = mock((_dir: string, _message: string): void => {});
const mockGenerateCommitMessage = mock(async (): Promise<string> => 'chore: update');
const mockRunTooledFixup = mock(
  async (): Promise<{ success: boolean; attempts: number; lastError?: string }> => ({
    success: true,
    attempts: 1,
  }),
);

// ─── Mock modules ──────────────────────────────────────────────────────────

mock.module('./git.js', () => ({
  ...realGit,
  stageAll: mockStageAll,
  getDiff: mockGetDiff,
  commitChanges: mockCommitChanges,
}));

mock.module('./worktree-lifecycle.js', () => ({
  ...realWorktreeLifecycle,
  generateCommitMessage: mockGenerateCommitMessage,
}));

mock.module('./worktree-fixup.js', () => ({
  ...realWorktreeFixup,
  runTooledFixup: mockRunTooledFixup,
}));

// ─── Import SUT after mocks ─────────────────────────────────────────────────

import * as WorktreeOperations from './worktree-operations.js';

// ─── Restore original modules ──────────────────────────────────────────────

afterAll(() => {
  mock.module('./git.js', () => realGit);
  mock.module('./worktree-lifecycle.js', () => realWorktreeLifecycle);
  mock.module('./worktree-fixup.js', () => realWorktreeFixup);
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockStageAll.mockReset();
  mockGetDiff.mockReset();
  mockCommitChanges.mockReset();
  mockGenerateCommitMessage.mockReset();
  mockRunTooledFixup.mockReset();
});

// ─── Tests: commitWorktreeChanges — clean-tree no-op ───────────────────────

describe('commitWorktreeChanges — clean tree (no-op)', () => {
  it('stages all then returns early when diff is empty', async () => {
    mockGetDiff.mockReturnValue('');

    await WorktreeOperations.commitWorktreeChanges({
      profilesDirs: ['/profiles'],
      worktreePath: '/worktree',
      taskPrompt: 'Do things',
    });

    // stageAll is called unconditionally (even for untracked-only changes).
    expect(mockStageAll).toHaveBeenCalledWith('/worktree');
    // No commit message generated, no commit made.
    expect(mockGenerateCommitMessage).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });
});

// ─── Tests: createLintValidationGate ────────────────────────────────────────
//
// The gate is the PRIMARY lint defence used by oneStepTask validation: it runs
// `prettier --write` (fire-and-forget, output discarded) THEN a single
// `eslint --fix` pass whose exit code is authoritative — non-zero means
// unfixable errors remain. We stub the global `Bun.spawn` so the tests never
// shell out to real tooling and can drive the eslint exit code / report
// deterministically. (Replacing the prior `typeof` export smoke test, which
// asserted nothing about this behaviour.)

function makeFakeProc(exitCode: number, stdout = '', stderr = '') {
  const enc = new TextEncoder();
  return {
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(stderr));
        controller.close();
      },
    }),
  };
}

describe('createLintValidationGate', () => {
  const realSpawn = Bun.spawn;
  const spawnCalls: { cmd: string[]; cwd?: string }[] = [];
  let eslintScenario: { exitCode: number; stdout: string; stderr: string };

  beforeEach(() => {
    spawnCalls.length = 0;
    eslintScenario = { exitCode: 0, stdout: '', stderr: '' };
    Bun.spawn = ((opts: { cmd: string[]; cwd?: string }) => {
      spawnCalls.push({ cmd: opts.cmd, cwd: opts.cwd });
      const cmd = opts.cmd.join(' ');
      if (cmd.includes('prettier')) return makeFakeProc(0);
      if (cmd.includes('eslint')) {
        return makeFakeProc(eslintScenario.exitCode, eslintScenario.stdout, eslintScenario.stderr);
      }
      return makeFakeProc(0);
    }) as typeof Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = realSpawn;
  });

  it('runs prettier --write before eslint --fix (in that order)', async () => {
    const gate = WorktreeOperations.createLintValidationGate('/wt');
    await gate();

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0].cmd.join(' ')).toContain('prettier');
    expect(spawnCalls[1].cmd.join(' ')).toContain('eslint');
  });

  it('spawns both processes with cwd set to the worktree path', async () => {
    const gate = WorktreeOperations.createLintValidationGate('/repo/.engin/wt-1');
    await gate();

    expect(spawnCalls.every((c) => c.cwd === '/repo/.engin/wt-1')).toBe(true);
  });

  it('returns undefined when eslint exits clean (exit code 0)', async () => {
    eslintScenario.exitCode = 0;
    const gate = WorktreeOperations.createLintValidationGate('/wt');
    await expect(gate()).resolves.toBeUndefined();
  });

  it('returns { error } containing the eslint report when unfixable errors remain', async () => {
    eslintScenario.exitCode = 1;
    eslintScenario.stdout = '  5:10  error  Missing semicolon  semi';
    eslintScenario.stderr = '';
    const gate = WorktreeOperations.createLintValidationGate('/wt');
    const result = await gate();

    expect(result).toEqual({ error: expect.stringContaining('Lint errors remain') });
    expect(result?.error).toContain('Missing semicolon');
  });

  it('joins both stdout and stderr into the error message', async () => {
    eslintScenario.exitCode = 2;
    eslintScenario.stdout = 'stdout-issue';
    eslintScenario.stderr = 'stderr-issue';
    const gate = WorktreeOperations.createLintValidationGate('/wt');
    const result = await gate();

    expect(result?.error).toContain('stdout-issue');
    expect(result?.error).toContain('stderr-issue');
  });

  it('re-runs the full format + auto-fix sequence on every invocation (stateless)', async () => {
    const gate = WorktreeOperations.createLintValidationGate('/wt');
    await gate();
    await gate();

    // Two invocations → four spawns (prettier + eslint each time).
    expect(spawnCalls).toHaveLength(4);
    expect(spawnCalls.filter((c) => c.cmd.join(' ').includes('prettier'))).toHaveLength(2);
    expect(spawnCalls.filter((c) => c.cmd.join(' ').includes('eslint'))).toHaveLength(2);
  });
});

// ─── Tests: commitWorktreeChanges — staging/diff ordering (pinned by design) ─
//
// The current order (stage FIRST, then check diff) is correct BY DESIGN and
// MUST survive the extraction refactor: `getDiff` only inspects tracked
// modifications + the staged set, so staging up front is required to detect
// untracked-only changes. These tests pin that ordering so a regression
// (e.g. moving the diff guard before stageAll) is caught immediately.

describe('commitWorktreeChanges — staging/diff ordering (must not change)', () => {
  it('calls stageAll BEFORE getDiff (stage-first is required for untracked detection)', async () => {
    const order: string[] = [];
    mockStageAll.mockImplementation(() => {
      order.push('stageAll');
    });
    mockGetDiff.mockImplementation(() => {
      order.push('getDiff');
      return 'some diff';
    });
    mockGenerateCommitMessage.mockResolvedValue('chore: update');
    mockCommitChanges.mockImplementation(() => {
      order.push('commitChanges');
    });

    await WorktreeOperations.commitWorktreeChanges({
      profilesDirs: ['/profiles'],
      worktreePath: '/worktree',
      taskPrompt: 'Do things',
    });

    expect(order.indexOf('stageAll')).toBeLessThan(order.indexOf('getDiff'));
    // Full observable sequence for the happy path.
    expect(order).toEqual(['stageAll', 'getDiff', 'commitChanges']);
  });

  it('still stages unconditionally even when the tree turns out clean', async () => {
    mockGetDiff.mockReturnValue('');

    await WorktreeOperations.commitWorktreeChanges({
      profilesDirs: ['/profiles'],
      worktreePath: '/worktree',
      taskPrompt: 'p',
    });

    expect(mockStageAll).toHaveBeenCalledTimes(1);
    expect(mockStageAll).toHaveBeenCalledWith('/worktree');
  });
});

// ─── Tests: commitWorktreeChanges — fix-up retry safety net (characterization) ─
//
// These pin the OBSERVABLE retry behavior of `commitWorktreeChanges` so the
// extraction into the shared helper cannot change it: on a pre-commit-hook
// rejection, the tooled fix-up runs, changes are re-staged, and the commit is
// retried exactly once through the REAL hook; the ORIGINAL commit error is
// re-thrown on exhaustion.

describe('commitWorktreeChanges — fix-up retry safety net', () => {
  it('on commit failure: runs fix-up, re-stages, retries the commit (succeeds)', async () => {
    let calls = 0;
    mockGetDiff.mockReturnValue('diff');
    mockGenerateCommitMessage.mockResolvedValue('chore: msg');
    mockCommitChanges.mockImplementation(() => {
      calls++;
      if (calls === 1) throw new Error('lint-staged rejected');
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await WorktreeOperations.commitWorktreeChanges({
      profilesDirs: ['/profiles'],
      worktreePath: '/worktree',
      taskPrompt: 'p',
    });

    // Initial commit + exactly one retry.
    expect(mockCommitChanges).toHaveBeenCalledTimes(2);
    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
    // stageAll is called once up-front (for the diff) and once after the fix-up
    // (before the retry) — never more.
    expect(mockStageAll).toHaveBeenCalledTimes(2);
  });

  it('passes the commit error as the fix-up errorContext', async () => {
    mockGetDiff.mockReturnValue('diff');
    mockGenerateCommitMessage.mockResolvedValue('chore: msg');
    mockCommitChanges.mockImplementation(() => {
      throw new Error('eslint: no-unused-vars');
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });
    // Allow the retry to succeed so the function resolves.
    let calls = 0;
    mockCommitChanges.mockImplementation(() => {
      calls++;
      if (calls === 1) throw new Error('eslint: no-unused-vars');
    });

    await WorktreeOperations.commitWorktreeChanges({
      profilesDirs: ['/profiles'],
      worktreePath: '/worktree',
      taskPrompt: 'p',
    });

    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
    expect(mockRunTooledFixup.mock.calls[0][0].errorContext).toContain('eslint: no-unused-vars');
  });

  it('re-throws the ORIGINAL commit error when the fix-up fails (not lastError)', async () => {
    const original = new Error('pre-commit hook failed');
    mockGetDiff.mockReturnValue('diff');
    mockGenerateCommitMessage.mockResolvedValue('chore: msg');
    mockCommitChanges.mockImplementation(() => {
      throw original;
    });
    mockRunTooledFixup.mockResolvedValue({
      success: false,
      attempts: 3,
      lastError: 'tsc: unrelated type error',
    });

    await expect(
      WorktreeOperations.commitWorktreeChanges({
        profilesDirs: ['/profiles'],
        worktreePath: '/worktree',
        taskPrompt: 'p',
      }),
    ).rejects.toBe(original);

    // Only the initial commit attempt — the retry never runs when fix-up failed.
    expect(mockCommitChanges).toHaveBeenCalledTimes(1);
  });

  it('re-throws the ORIGINAL commit error when the retry commit also fails', async () => {
    const original = new Error('oxlint rejected');
    mockGetDiff.mockReturnValue('diff');
    mockGenerateCommitMessage.mockResolvedValue('chore: msg');
    mockCommitChanges.mockImplementation(() => {
      throw original;
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await expect(
      WorktreeOperations.commitWorktreeChanges({
        profilesDirs: ['/profiles'],
        worktreePath: '/worktree',
        taskPrompt: 'p',
      }),
    ).rejects.toBe(original);

    expect(mockCommitChanges).toHaveBeenCalledTimes(2);
  });

  it('forwards the diff + task prompt to generateCommitMessage', async () => {
    mockGetDiff.mockReturnValue('THE-DIFF');
    mockGenerateCommitMessage.mockResolvedValue('chore: msg');
    mockCommitChanges.mockImplementation(() => {});

    await WorktreeOperations.commitWorktreeChanges({
      profilesDirs: ['/profiles'],
      worktreePath: '/worktree',
      taskPrompt: 'the prompt',
      apiKeys: { ANTHROPIC: 'k' },
    });

    expect(mockGenerateCommitMessage).toHaveBeenCalledWith(['/profiles'], '/worktree', 'the prompt', 'THE-DIFF', {
      ANTHROPIC: 'k',
    });
  });
});

// ─── Tests: commitWithFixupRetry — shared fix-up-retry helper (NEW) ──────────
//
// The fix-up retry logic was previously duplicated between
// `WorktreeManager.commitMergeWithRetry` and `commitWorktreeChanges`. These
// tests specify the EXTRACTED shared helper `commitWithFixupRetry` that both
// call sites must delegate to. The helper owns: attempt commit → on failure
// run tooled fix-up → re-stage → retry commit → re-throw the ORIGINAL commit
// error on exhaustion. These tests FAIL until the helper exists.
//
// NOTE on location: the task permits the helper to live in `worktree-operations.ts`
// OR a new `worktree-commit.ts`; either way it MUST be re-exported from
// `worktree-operations.ts` (the natural home of `commitWorktreeChanges`) so
// both call sites import it from one place.

describe('commitWithFixupRetry — shared fix-up-retry helper', () => {
  it('is exported from the module', () => {
    expect(typeof WorktreeOperations.commitWithFixupRetry).toBe('function');
  });

  it('commits on the first attempt without invoking the fix-up agent', async () => {
    mockCommitChanges.mockImplementation(() => {});

    await WorktreeOperations.commitWithFixupRetry({
      worktreePath: '/worktree',
      message: 'feat: thing',
      profilesDirs: ['/profiles'],
      taskPrompt: 'Do thing',
    });

    expect(mockCommitChanges).toHaveBeenCalledTimes(1);
    expect(mockCommitChanges).toHaveBeenCalledWith('/worktree', 'feat: thing');
    // Success path never spawns the fix-up agent or re-stages.
    expect(mockRunTooledFixup).not.toHaveBeenCalled();
    expect(mockStageAll).not.toHaveBeenCalled();
  });

  it('does NOT touch the diff or generate a commit message (out of scope for the helper)', async () => {
    mockCommitChanges.mockImplementation(() => {});

    await WorktreeOperations.commitWithFixupRetry({
      worktreePath: '/worktree',
      message: 'm',
      profilesDirs: ['/profiles'],
      taskPrompt: 'p',
    });

    expect(mockGetDiff).not.toHaveBeenCalled();
    expect(mockGenerateCommitMessage).not.toHaveBeenCalled();
  });

  it('on commit failure: runs fix-up, re-stages, retries the commit through the real hook', async () => {
    let calls = 0;
    mockCommitChanges.mockImplementation(() => {
      calls++;
      if (calls === 1) throw new Error('lint-staged rejected: semicolon');
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await WorktreeOperations.commitWithFixupRetry({
      worktreePath: '/worktree',
      message: 'feat: thing',
      profilesDirs: ['/profiles'],
      taskPrompt: 'Do thing',
      apiKeys: { ANTHROPIC: 'secret' },
    });

    // commit attempted twice (initial + one retry).
    expect(mockCommitChanges).toHaveBeenCalledTimes(2);
    expect(mockCommitChanges).toHaveBeenNthCalledWith(1, '/worktree', 'feat: thing');
    expect(mockCommitChanges).toHaveBeenNthCalledWith(2, '/worktree', 'feat: thing');

    // fix-up invoked exactly once with the commit error as errorContext.
    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
    const fixupArg = mockRunTooledFixup.mock.calls[0][0];
    expect(fixupArg.errorContext).toContain('lint-staged rejected: semicolon');
    expect(fixupArg.worktreePath).toBe('/worktree');
    expect(fixupArg.taskPrompt).toBe('Do thing');
    expect(fixupArg.profilesDirs).toEqual(['/profiles']);
    expect(fixupArg.apiKeys).toEqual({ ANTHROPIC: 'secret' });

    // re-stage happens exactly once, between the fix-up and the retry.
    expect(mockStageAll).toHaveBeenCalledTimes(1);
    expect(mockStageAll).toHaveBeenCalledWith('/worktree');
  });

  it('retries the commit exactly ONCE (no second fix-up loop)', async () => {
    let calls = 0;
    mockCommitChanges.mockImplementation(() => {
      calls++;
      if (calls === 1) throw new Error('first failure');
      // second call (retry) succeeds
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await WorktreeOperations.commitWithFixupRetry({
      worktreePath: '/worktree',
      message: 'm',
      profilesDirs: ['/profiles'],
      taskPrompt: 'p',
    });

    expect(mockCommitChanges).toHaveBeenCalledTimes(2);
    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
  });

  it('re-throws the ORIGINAL commit error when the fix-up agent fails', async () => {
    const original = new Error('pre-commit hook failed: eslint');
    mockCommitChanges.mockImplementation(() => {
      throw original;
    });
    mockRunTooledFixup.mockResolvedValue({
      success: false,
      attempts: 3,
      lastError: 'tsc: type error elsewhere',
    });

    await expect(
      WorktreeOperations.commitWithFixupRetry({
        worktreePath: '/worktree',
        message: 'm',
        profilesDirs: ['/profiles'],
        taskPrompt: 'p',
      }),
    ).rejects.toBe(original); // identity: the SAME error object re-thrown.

    // Only ONE commit attempt — the retry never runs because the fix-up failed.
    expect(mockCommitChanges).toHaveBeenCalledTimes(1);
    // No re-stage when the fix-up failed.
    expect(mockStageAll).not.toHaveBeenCalled();
  });

  it('re-throws the ORIGINAL error (not the fix-up lastError) when the retry commit also fails', async () => {
    const original = new Error('commit rejected: oxlint');
    mockCommitChanges.mockImplementation(() => {
      throw original;
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1, lastError: undefined });

    await expect(
      WorktreeOperations.commitWithFixupRetry({
        worktreePath: '/worktree',
        message: 'm',
        profilesDirs: ['/profiles'],
        taskPrompt: 'p',
      }),
    ).rejects.toBe(original);

    expect(mockCommitChanges).toHaveBeenCalledTimes(2);
    expect(mockStageAll).toHaveBeenCalledTimes(1);
  });

  it('stringifies a non-Error throw for the fix-up errorContext', async () => {
    let calls = 0;
    mockCommitChanges.mockImplementation(() => {
      calls++;
      if (calls === 1) throw 'bare lint failure'; // non-Error rejection
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await WorktreeOperations.commitWithFixupRetry({
      worktreePath: '/worktree',
      message: 'm',
      profilesDirs: ['/profiles'],
      taskPrompt: 'p',
    });

    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
    expect(mockRunTooledFixup.mock.calls[0][0].errorContext).toBe('bare lint failure');
  });
});
