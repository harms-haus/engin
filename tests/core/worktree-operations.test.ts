// ─── Shared worktree operations module ──────────────────────────────────────
//
// Characterization tests for `packages/engine/src/core/worktree-operations.ts`.
//
// CONTEXT: The module now exports only the two functions that application code
// actually consumes:
//
//   - `commitWorktreeChanges` — used by WorktreeManager (worktree-manager.ts)
//     to stage + commit pending worktree changes (with a lint fix-up safety
//     net that retries the commit once when the pre-commit hook rejects it).
//   - `createLintValidationGate` — the PRIMARY lint defence used by runStepTask
//     validation; runs `prettier --write` + a single `eslint --fix` pass.
//
// The previously-exported `mergeWorktreeToMain`, `pushWorktreeAndCreatePR`, and
// `cleanupWorktree` were DEAD code: exported but never imported by any
// application module (only by this test file). The CLI and server now handle
// post-run worktree operations through WorktreeManager methods directly. They
// were removed in this task; the test sections that exercised them were removed
// alongside them.
//
// CONTRACT UNDER TEST (the module exports exactly these functions):
//
//   export async function commitWorktreeChanges(opts: {
//     profilesDirs: string[];
//     worktreePath: string;
//     taskPrompt: string;
//     apiKeys?: Record<string, string>;
//   }): Promise<void>
//     SAFETY NET: when commitChanges throws (lint-staged/eslint gate fails on
//     an unfixable-on-first-pass error), spawn runTooledFixup
//     (worktree-fixup.js) with the commit error as `errorContext`, then
//     re-stage (stageAll) and retry commitChanges ONCE. If the fix-up fails
//     OR the retry commit also throws, re-throw the ORIGINAL commit error.
//     Never passes --no-verify.
//
//   export function createLintValidationGate(worktreePath: string):
//     () => Promise<{ error?: string } | undefined>
//     PRIMARY lint defence: runs `prettier --write` + a single `eslint --fix`
//     pass in the worktree. Returns `{ error: 'Lint errors remain: ...' }`
//     when unfixable errors remain after the auto-fix pass, or `undefined`
//     when clean. The fix-up safety net above is the fallback for anything
//     this gate (or the commit hook) misses.
//
// These functions must be built from the existing git.ts primitives
// (stageAll, commitChanges, getDiff) and the worktree-lifecycle.ts /
// worktree-fixup.ts agent functions (generateCommitMessage, runTooledFixup).

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real modules before mocking ────────────────────────────────────

const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.js'));
const realWorktreeLifecycle = Object.assign({}, await import('../../packages/engine/src/core/worktree-lifecycle.js'));
const realWorktreeFixup = Object.assign({}, await import('../../packages/engine/src/core/worktree-fixup.js'));

// ─── Mock functions for git ─────────────────────────────────────────────────

const mockStageAll = mock((_dir: string): void => {});
const mockCommitChanges = mock((_dir: string, _message: string): void => {});
const mockGetDiff = mock((_dir: string): string => 'diff content');

// ─── Mock functions for worktree-lifecycle ──────────────────────────────────

const mockGenerateCommitMessage = mock(
  async (
    _profilesDirs: string[],
    _worktreePath: string,
    _taskPrompt: string,
    _diff: string,
    _apiKeys?: Record<string, string>,
  ): Promise<string> => 'feat: implement feature',
);

// ─── Mock functions for worktree-fixup ──────────────────────────────────────

/** Shape of the options object commitWorktreeChanges forwards to runTooledFixup. */
interface FixupCallOptions {
  profilesDirs: string[];
  worktreePath: string;
  taskPrompt: string;
  errorContext: string;
  apiKeys?: Record<string, string>;
}

const mockRunTooledFixup = mock(
  async (_opts: FixupCallOptions): Promise<{ success: boolean; attempts: number; lastError?: string }> => ({
    success: true,
    attempts: 1,
  }),
);

// ─── Mock modules ────────────────────────────────────────────────────────────
//
// Only the git.ts primitives consumed by commitWorktreeChanges are mocked.
// The merge/PR/cleanup functions (and the git primitives they used:
// getMainBranch, getCurrentBranch, checkoutBranch, mergeBranch, abortMerge,
// removeWorktree) were removed from the module, so their mocks are gone too.

mock.module('../../packages/engine/src/core/git.js', () => ({
  stageAll: mockStageAll,
  commitChanges: mockCommitChanges,
  getDiff: mockGetDiff,
}));

mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => ({
  generateCommitMessage: mockGenerateCommitMessage,
}));

mock.module('../../packages/engine/src/core/worktree-fixup.js', () => ({
  runTooledFixup: mockRunTooledFixup,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import { commitWorktreeChanges } from '../../packages/engine/src/core/worktree-operations.js';

// `createLintValidationGate` is imported via a namespace binding so a missing
// export does NOT break module linking — a named import of a non-existent
// export raises a SyntaxError that would fail the ENTIRE file. Accessed through
// the namespace, the property is simply `undefined` until implemented.
import * as WorktreeOperations from '../../packages/engine/src/core/worktree-operations.js';

const createLintValidationGate = (
  WorktreeOperations as unknown as {
    createLintValidationGate: (worktreePath: string) => () => Promise<{ error?: string } | undefined>;
  }
).createLintValidationGate;

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/git.js', () => realGit);
  mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => realWorktreeLifecycle);
  mock.module('../../packages/engine/src/core/worktree-fixup.js', () => realWorktreeFixup);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CommitOpts {
  profilesDirs: string[];
  worktreePath: string;
  taskPrompt: string;
  apiKeys?: Record<string, string>;
}

function makeCommitOpts(overrides?: Partial<CommitOpts>): CommitOpts {
  return {
    profilesDirs: ['/profiles'],
    worktreePath: '/fake/repo/.engin-worktree-feature-branch',
    taskPrompt: 'Implement the login feature',
    ...overrides,
  };
}

// ─── Reset mocks ─────────────────────────────────────────────────────────────

function resetMocks() {
  mock.clearAllMocks();
  mockGetDiff.mockReturnValue('diff content');
  mockGenerateCommitMessage.mockResolvedValue('feat: implement feature');
  // Bun's clearAllMocks() only clears call history — implementations set via
  // mockImplementation/mockReturnValue persist. Re-establish safe defaults so
  // a throwing implementation set by one test cannot leak into the next.
  mockStageAll.mockImplementation(() => {});
  mockCommitChanges.mockImplementation(() => {});
  mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// commitWorktreeChanges
// ═══════════════════════════════════════════════════════════════════════════════

describe('commitWorktreeChanges', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('commits when diff is non-empty', async () => {
    mockGetDiff.mockReturnValue('some diff content');
    mockGenerateCommitMessage.mockResolvedValue('fix: resolve bug');

    await commitWorktreeChanges(makeCommitOpts());

    expect(mockGetDiff).toHaveBeenCalledWith('/fake/repo/.engin-worktree-feature-branch');
    expect(mockStageAll).toHaveBeenCalledWith('/fake/repo/.engin-worktree-feature-branch');
    expect(mockGenerateCommitMessage).toHaveBeenCalledWith(
      ['/profiles'],
      '/fake/repo/.engin-worktree-feature-branch',
      'Implement the login feature',
      'some diff content',
      undefined,
    );
    expect(mockCommitChanges).toHaveBeenCalledWith('/fake/repo/.engin-worktree-feature-branch', 'fix: resolve bug');
  });

  it('does not commit when the diff is empty AFTER staging', async () => {
    mockGetDiff.mockReturnValue('');

    await commitWorktreeChanges(makeCommitOpts());

    // stageAll runs FIRST now (before the diff guard) so untracked files are
    // captured — it is a no-op when the tree is clean, but it IS invoked.
    expect(mockStageAll).toHaveBeenCalled();
    expect(mockGetDiff).toHaveBeenCalled();
    expect(mockGenerateCommitMessage).not.toHaveBeenCalled();
    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  it('resolves with void', async () => {
    mockGetDiff.mockReturnValue('diff');
    await expect(commitWorktreeChanges(makeCommitOpts())).resolves.toBeUndefined();
  });

  it('passes apiKeys to generateCommitMessage', async () => {
    mockGetDiff.mockReturnValue('diff');
    mockGenerateCommitMessage.mockResolvedValue('msg');

    await commitWorktreeChanges(makeCommitOpts({ apiKeys: { openai: 'sk-test' } }));

    expect(mockGenerateCommitMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { openai: 'sk-test' },
    );
  });

  it('passes undefined apiKeys when not provided', async () => {
    mockGetDiff.mockReturnValue('diff');

    await commitWorktreeChanges(makeCommitOpts());

    const callArgs = mockGenerateCommitMessage.mock.calls[0];
    expect(callArgs[4]).toBeUndefined();
  });

  // ─── Commit-failure fix-up safety net ────────────────────────────────────
  //
  // When the pre-commit hook (lint-staged/eslint gate) rejects the commit on
  // the first pass, commitWorktreeChanges must spawn the tooled fix-up agent
  // to repair the lint errors, re-stage, and retry the commit exactly once.
  // The fix-up primitive retries internally (up to 3 times); commitWorktreeChanges
  // itself only retries the COMMIT once.

  it('succeeds on the first commit attempt without invoking the fix-up agent', async () => {
    mockGetDiff.mockReturnValue('diff content');
    mockCommitChanges.mockImplementation(() => {}); // first attempt succeeds

    await expect(commitWorktreeChanges(makeCommitOpts())).resolves.toBeUndefined();

    expect(mockCommitChanges).toHaveBeenCalledTimes(1);
    expect(mockRunTooledFixup).not.toHaveBeenCalled();
  });

  it('runs the tooled fix-up and retries the commit when the first commit throws', async () => {
    mockGetDiff.mockReturnValue('diff content');
    mockGenerateCommitMessage.mockResolvedValue('feat: retry me');
    // First commit attempt throws (lint-staged gate failure); retry succeeds.
    // A counter-driven persistent implementation is used instead of
    // mockImplementationOnce: Bun's clearAllMocks()/mockImplementation() do NOT
    // clear the once-queue, so a queued-but-unconsumed once-impl would leak
    // into later tests. A persistent impl is cleanly replaced by
    // resetMocks() in the next test.
    let commitAttempts = 0;
    mockCommitChanges.mockImplementation(() => {
      commitAttempts++;
      if (commitAttempts === 1) {
        throw new Error('lint-staged: eslint reported 2 errors');
      }
      // subsequent attempts succeed
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await expect(commitWorktreeChanges(makeCommitOpts())).resolves.toBeUndefined();

    // The fix-up was spawned exactly once, scoped to the worktree, carrying the
    // commit error as context.
    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
    const fixupArgs = mockRunTooledFixup.mock.calls[0]![0];
    expect(fixupArgs.errorContext).toContain('lint-staged');
    expect(fixupArgs.errorContext).toContain('eslint');
    expect(fixupArgs.worktreePath).toBe('/fake/repo/.engin-worktree-feature-branch');
    expect(fixupArgs.profilesDirs).toEqual(['/profiles']);
    expect(fixupArgs.taskPrompt).toBe('Implement the login feature');

    // Re-staged after the fix, then retried the commit once.
    expect(mockStageAll).toHaveBeenCalledTimes(2);
    expect(mockCommitChanges).toHaveBeenCalledTimes(2);
    // Both commit attempts use the SAME generated message.
    expect(mockCommitChanges).toHaveBeenNthCalledWith(1, '/fake/repo/.engin-worktree-feature-branch', 'feat: retry me');
    expect(mockCommitChanges).toHaveBeenNthCalledWith(2, '/fake/repo/.engin-worktree-feature-branch', 'feat: retry me');
  });

  it('re-throws the ORIGINAL commit error when the fix-up agent fails', async () => {
    mockGetDiff.mockReturnValue('diff content');
    const originalError = new Error('eslint: unfixable type error');
    mockCommitChanges.mockImplementation(() => {
      throw originalError;
    });
    mockRunTooledFixup.mockResolvedValue({ success: false, attempts: 3, lastError: 'could not fix' });

    // The ORIGINAL commit error is propagated (not the fix-up lastError).
    await expect(commitWorktreeChanges(makeCommitOpts())).rejects.toBe(originalError);

    // The fix-up ran but did not succeed → no re-stage, no retry commit.
    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
    expect(mockStageAll).toHaveBeenCalledTimes(1);
    expect(mockCommitChanges).toHaveBeenCalledTimes(1);
  });

  it('re-throws the original commit error when the fix-up succeeds but the retry commit still throws', async () => {
    mockGetDiff.mockReturnValue('diff content');
    const originalError = new Error('original lint gate failure');
    // First call throws the original error (triggers the safety net); the
    // retry call throws a different error. Per the contract the ORIGINAL error
    // is re-thrown. Counter-driven persistent impl (see note above) avoids
    // once-queue leakage.
    let commitAttempts = 0;
    mockCommitChanges.mockImplementation(() => {
      commitAttempts++;
      if (commitAttempts === 1) throw originalError;
      throw new Error('retry also failed');
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    // Per the safety-net contract the ORIGINAL error is re-thrown, not the
    // retry's error.
    await expect(commitWorktreeChanges(makeCommitOpts())).rejects.toBe(originalError);

    // Fix-up ran, was re-staged, and the retry commit was attempted (and threw).
    expect(mockRunTooledFixup).toHaveBeenCalledTimes(1);
    expect(mockStageAll).toHaveBeenCalledTimes(2);
    expect(mockCommitChanges).toHaveBeenCalledTimes(2);
  });

  it('forwards apiKeys to the fix-up agent', async () => {
    mockGetDiff.mockReturnValue('diff content');
    let commitAttempts = 0;
    mockCommitChanges.mockImplementation(() => {
      commitAttempts++;
      if (commitAttempts === 1) throw new Error('gate failed');
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await commitWorktreeChanges(makeCommitOpts({ apiKeys: { openai: 'sk-net' } }));

    expect(mockRunTooledFixup.mock.calls[0]![0].apiKeys).toEqual({ openai: 'sk-net' });
  });

  it('never passes --no-verify to commitChanges (always exactly dir + message)', async () => {
    // Constraint: "Do not --no-verify; that hides real problems." The fix-up
    // safety net must fix the lint errors and retry through the REAL hook, not
    // bypass it. commitChanges(dir, message) takes exactly two positional
    // string args — no flags.
    mockGetDiff.mockReturnValue('diff content');
    let commitAttempts = 0;
    mockCommitChanges.mockImplementation(() => {
      commitAttempts++;
      if (commitAttempts === 1) throw new Error('gate failed');
    });
    mockRunTooledFixup.mockResolvedValue({ success: true, attempts: 1 });

    await commitWorktreeChanges(makeCommitOpts());

    expect(mockCommitChanges.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockCommitChanges.mock.calls) {
      expect(call).toHaveLength(2);
      expect(typeof call[0]).toBe('string');
      expect(typeof call[1]).toBe('string');
    }
  });

  it('does not run the fix-up agent when the diff is empty (nothing to commit)', async () => {
    mockGetDiff.mockReturnValue('');

    await commitWorktreeChanges(makeCommitOpts());

    expect(mockCommitChanges).not.toHaveBeenCalled();
    expect(mockRunTooledFixup).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createLintValidationGate
// ═══════════════════════════════════════════════════════════════════════════════
//
// `createLintValidationGate(worktreePath)` returns a `validateOutput` callback
// suitable for runStepTask's validateOutput option. It is the PRIMARY lint
// defence: it runs `prettier --write` + a single `eslint --fix` pass in the
// worktree (format, then auto-fix + report). Returns `{ error: 'Lint errors
// remain: ...' }` when unfixable errors remain after the auto-fix pass, or
// `undefined` when clean. The commit-failure fix-up safety net above is the
// fallback for anything this gate misses.
//
// These tests mock `Bun.spawn` (scoped to this describe block) so the gate
// never shells out to a real eslint/prettier. The gate uses async `Bun.spawn`
// (not `Bun.spawnSync`) so it does not block the server event loop, mirroring
// `verifyWorktree` in worktree-fixup.ts.

describe('createLintValidationGate', () => {
  // Capture the real Bun.spawn so we can restore it after each test in this
  // block. The gate uses async Bun.spawn (not spawnSync) so it does not block
  // the server event loop, mirroring verifyWorktree in worktree-fixup.ts.
  const realBunSpawn = Bun.spawn;

  interface CapturedCall {
    cmd: string[];
    cwd?: string;
  }
  const spawnCalls: CapturedCall[] = [];

  /** Scripted result for the authoritative eslint invocation (eslint --fix). */
  let eslintCheckResult: { exitCode: number; stderr: string };

  /** Build a fake Bun.spawn Subprocess result: an `exited` promise plus piped
   *  stdout/stderr ReadableStreams that the gate drains via
   *  `new Response(proc.stderr).text()` / `new Response(proc.stdout).text()`. */
  function spawnResult(exitCode: number, stderr = '', stdout = '') {
    const enc = new TextEncoder();
    const toStream = (s: string): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(s));
          controller.close();
        },
      });
    return {
      exited: Promise.resolve(exitCode),
      stdout: toStream(stdout),
      stderr: toStream(stderr),
    };
  }

  /** Identify the authoritative eslint invocation: the single eslint call
   *  that carries `--fix` (prettier --write is fire-and-forget). */
  function isLintCheck(cmd: string[]): boolean {
    return cmd.includes('eslint') && cmd.includes('--fix');
  }

  const mockSpawn = mock((options: { cmd?: string[]; cwd?: string }) => {
    const cmd = options.cmd ?? [];
    const cwd = options.cwd;
    spawnCalls.push({ cmd, cwd });

    if (isLintCheck(cmd)) {
      return spawnResult(eslintCheckResult.exitCode, eslintCheckResult.stderr);
    }
    // prettier --write (format) is fire-and-forget; its exit code does not
    // influence the return value.
    return spawnResult(0);
  });

  beforeEach(() => {
    resetMocks();
    spawnCalls.length = 0;
    eslintCheckResult = { exitCode: 0, stderr: '' };
    Bun.spawn = mockSpawn as unknown as typeof Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = realBunSpawn;
  });

  it('returns a validateOutput function', () => {
    const validate = createLintValidationGate('/wt/abc');
    expect(typeof validate).toBe('function');
  });

  it('returns undefined when no lint errors remain after the check', async () => {
    eslintCheckResult = { exitCode: 0, stderr: '' };
    const validate = createLintValidationGate('/wt/clean');

    await expect(validate()).resolves.toBeUndefined();

    // The check was an eslint invocation scoped to the worktree.
    const eslintCalls = spawnCalls.filter((c) => c.cmd.includes('eslint'));
    expect(eslintCalls.length).toBeGreaterThan(0);
    for (const c of eslintCalls) {
      expect(c.cwd).toBe('/wt/clean');
    }
  });

  it('returns { error } describing the remaining lint errors when the check fails', async () => {
    eslintCheckResult = { exitCode: 1, stderr: '  src/foo.ts:3:1  error  no-unused-vars\n' };
    const validate = createLintValidationGate('/wt/dirty');

    const result = await validate();

    expect(result).toBeDefined();
    expect(result!.error).toContain('Lint errors remain');
    expect(result!.error).toContain('no-unused-vars');
  });

  it('runs eslint --fix to autofix before checking', async () => {
    const validate = createLintValidationGate('/wt/fix');
    await validate();

    const autofix = spawnCalls.find((c) => c.cmd.includes('eslint') && c.cmd.includes('--fix'));
    expect(autofix).toBeDefined();
    expect(autofix!.cwd).toBe('/wt/fix');
  });

  it('runs prettier --write to format before checking', async () => {
    const validate = createLintValidationGate('/wt/fmt');
    await validate();

    const prettier = spawnCalls.find((c) => c.cmd.includes('prettier') && c.cmd.includes('--write'));
    expect(prettier).toBeDefined();
    expect(prettier!.cwd).toBe('/wt/fmt');
  });

  it('runs every command with cwd set to the worktree path', async () => {
    const validate = createLintValidationGate('/wt/cwd');
    await validate();

    expect(spawnCalls.length).toBeGreaterThan(0);
    for (const c of spawnCalls) {
      expect(c.cwd).toBe('/wt/cwd');
    }
  });

  it('re-runs the full validation on each invocation (stateless callback)', async () => {
    eslintCheckResult = { exitCode: 0, stderr: '' };
    const validate = createLintValidationGate('/wt/multi');

    await validate();
    await validate();

    // At least two full lint-check passes ran.
    const lintChecks = spawnCalls.filter((c) => isLintCheck(c.cmd));
    expect(lintChecks.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Module surface: exported function signatures
// ═══════════════════════════════════════════════════════════════════════════════
//
// Only the two LIVE exports are asserted. The dead functions
// (mergeWorktreeToMain, pushWorktreeAndCreatePR, cleanupWorktree) are no longer
// part of the module's public surface and are intentionally NOT checked here.

describe('worktree-operations module surface', () => {
  it('exports commitWorktreeChanges as a function', () => {
    expect(typeof commitWorktreeChanges).toBe('function');
  });

  it('exports createLintValidationGate as a function', () => {
    expect(typeof createLintValidationGate).toBe('function');
  });
});
