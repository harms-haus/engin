// ─── Tests for core/worktree-final-merge.ts ────────────────────────────────
//
// Characterization tests for the final-merge-to-main functions extracted OUT
// of `WorktreeManager` into standalone functions in `worktree-final-merge.ts`:
//
//   • `finalMergeToMain(ctx, holder)` — squash-merges the main-wt branch into
//     the REAL repo main branch.
//   • `resolveFinalMergeConflicts(ctx, conflicts, taskPrompt)` — resolves a
//     conflicted final merge via the agent, then stages + commits.
//   • `abortFinalMerge(ctx)` — aborts an in-progress final merge.
//
// These functions are added by the implementer's extraction refactor. Until
// then, the dynamic import resolves to `undefined` and the contract tests
// below are skipped via `it.skipIf` — the SAME pattern used by `core/git.test.ts`
// for `restoreSavedBranch`. After the refactor they run for real.
//
// Approach: uses REAL temp git repos (via `git init`) so the squash-merge /
// checkout / branch / commit logic is exercised end-to-end — NO mocking of
// the git primitives. The two AGENT-based dependencies (`commitWorktreeChanges`
// and `resolveConflictsWithAgent`) ARE mocked (via `mock.module`, same pattern
// as `hooks/defaults/worktree-integration.test.ts`) so the tests are
// deterministic and do not require a real agent profile. The `withGitLock`
// callback is a simple passthrough (single-threaded tests).

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Real git primitives (NOT mocked — exercised end-to-end) ───────────────

import { getCurrentBranch, listConflictedFiles } from './git.js';

// ─── Capture real modules BEFORE mocking ───────────────────────────────────

const realWorktreeOps = Object.assign({}, await import('./worktree-operations.js'));
const realWorktreeLifecycle = Object.assign({}, await import('./worktree-lifecycle.js'));

// ─── Mock functions for the agent-based dependencies ───────────────────────

const mockCommitWorktreeChanges = mock(async (_opts: unknown): Promise<void> => {});

const mockResolveConflictsWithAgent = mock(
  async (
    _profilesDirs: string[],
    _repoRoot: string,
    _conflicts: string[],
    _taskPrompt: string,
    _apiKeys?: Record<string, string>,
  ): Promise<{ resolved: boolean; error?: string }> => ({ resolved: true }),
);

// ─── Mock modules ───────────────────────────────────────────────────────────
//
// Mock worktree-operations.js and worktree-lifecycle.js so the extracted
// functions get controlled versions of commitWorktreeChanges /
// resolveConflictsWithAgent. The real git.js primitives are NOT mocked — the
// squash-merge / checkout / commit / abort logic runs against a real repo.

mock.module('./worktree-operations.js', () => ({
  ...realWorktreeOps,
  commitWorktreeChanges: mockCommitWorktreeChanges,
}));

mock.module('./worktree-lifecycle.js', () => ({
  ...realWorktreeLifecycle,
  resolveConflictsWithAgent: mockResolveConflictsWithAgent,
}));

// ─── Dynamic import: worktree-final-merge (added by the refactor) ──────────
//
// The module is created by the implementer's extraction step. We load it
// dynamically (using a variable path so TypeScript does not statically
// resolve a not-yet-existent file) so this test file compiles both BEFORE
// (functions absent → skipped) and AFTER (functions present → run) the change.

/** Shared type for the context object passed to every extracted function. */
interface FinalMergeContext {
  repoRoot: string;
  mainBranch: string;
  mainWorktreePath: string;
  profilesDirs: string[];
  apiKeys?: Record<string, string>;
  withGitLock: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** Mutable holder for the saved-branch field shared across calls. */
interface SavedBranchHolder {
  savedBranch?: string;
}

type FinalMergeResult = { success: boolean; conflicts: string[]; conflictsResolved: boolean; error?: string };
type ResolveResult = { resolved: boolean; error?: string };

interface FinalMergeModule {
  finalMergeToMain?: (ctx: FinalMergeContext, holder: SavedBranchHolder) => Promise<FinalMergeResult>;
  resolveFinalMergeConflicts?: (
    ctx: FinalMergeContext,
    conflicts: string[],
    taskPrompt: string,
  ) => Promise<ResolveResult>;
  abortFinalMerge?: (ctx: FinalMergeContext) => Promise<void>;
  FinalMergeContext?: unknown;
  SavedBranchHolder?: unknown;
}

// A variable path defeats TypeScript's static `import()` resolution, so the
// file compiles even though worktree-final-merge.js does not exist yet.
const finalMergeModulePath = './worktree-final-merge.js';
const finalMergeMod: FinalMergeModule = await import(finalMergeModulePath).then(
  (mod) => mod as FinalMergeModule,
  () => ({}) as FinalMergeModule,
);

const finalMergeToMain = finalMergeMod.finalMergeToMain;
const resolveFinalMergeConflicts = finalMergeMod.resolveFinalMergeConflicts;
const abortFinalMerge = finalMergeMod.abortFinalMerge;

// ─── Restore real modules ───────────────────────────────────────────────────

afterAll(() => {
  mock.module('./worktree-operations.js', () => realWorktreeOps);
  mock.module('./worktree-lifecycle.js', () => realWorktreeLifecycle);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engin-final-merge-'));
  tempDirs.push(dir);
  return dir;
}

/** Runs git in `cwd`; throws on non-zero exit. Returns trimmed stdout. */
function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${args.join(' ')} failed (exit ${result.exitCode}) in ${cwd}: ${stderr}`);
  }
  return stdout;
}

/** Runs git in `cwd`; returns the exit code WITHOUT throwing. Used for merge
 *  commands that are EXPECTED to conflict (non-zero exit). */
function gitAllowFail(args: string[], cwd: string): number {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.exitCode;
}

/** File content present in the repo after init — both branches diverge from it. */
const CONFLICT_FILE = 'app.txt';

/**
 * Creates a temp git repo where `main` and `engin/main-slug` have DIVERGED:
 * both modify the first line of `app.txt` differently. Ends on `main`.
 * A squash-merge of `engin/main-slug` into `main` will CONFLICT.
 */
function createRepoWithConflict(): string {
  const repo = makeTempDir();
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'engin-test@example.com'], repo);
  git(['config', 'user.name', 'Engin Test'], repo);
  writeFileSync(join(repo, CONFLICT_FILE), 'line1\ncommon base\n');
  git(['add', CONFLICT_FILE], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  // engin/main-slug diverges: changes line 1.
  git(['branch', 'engin/main-slug'], repo);
  git(['checkout', '-q', 'engin/main-slug'], repo);
  writeFileSync(join(repo, CONFLICT_FILE), 'ENGIN-line1\ncommon base\n');
  git(['add', CONFLICT_FILE], repo);
  git(['commit', '-q', '-m', 'engin change'], repo);
  // main diverges: changes line 1 differently.
  git(['checkout', '-q', 'main'], repo);
  writeFileSync(join(repo, CONFLICT_FILE), 'MAIN-line1\ncommon base\n');
  git(['add', CONFLICT_FILE], repo);
  git(['commit', '-q', '-m', 'main change'], repo);
  return repo;
}

/**
 * Creates a temp git repo where `engin/main-slug` adds a NEW file relative to
 * `main` (no overlapping changes). Ends on `main`. A squash-merge of
 * `engin/main-slug` into `main` is a CLEAN (fast-forward) merge.
 */
function createRepoWithCleanMerge(): string {
  const repo = makeTempDir();
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'engin-test@example.com'], repo);
  git(['config', 'user.name', 'Engin Test'], repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(['add', 'base.txt'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  git(['branch', 'engin/main-slug'], repo);
  git(['checkout', '-q', 'engin/main-slug'], repo);
  writeFileSync(join(repo, 'feature.txt'), 'engin feature\n');
  git(['add', 'feature.txt'], repo);
  git(['commit', '-q', '-m', 'engin feature'], repo);
  git(['checkout', '-q', 'main'], repo);
  return repo;
}

/** Creates + checks out a branch off the current HEAD (the "saved branch"). */
function createSavedBranch(repo: string, name = 'feature'): void {
  git(['checkout', '-q', '-b', name], repo);
}

/** Installs a pre-commit hook that ALWAYS rejects (exit 1). Used to test the
 *  commit-failure rollback paths. */
function installFailingPreCommitHook(repo: string): void {
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook rejected" >&2\nexit 1\n');
  chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
}

/** Builds a FinalMergeContext for the given repo with a passthrough git lock. */
function makeCtx(repo: string, overrides: Partial<FinalMergeContext> = {}): FinalMergeContext {
  return {
    repoRoot: repo,
    mainBranch: 'engin/main-slug',
    mainWorktreePath: join(repo, '.dummy-main-wt'),
    profilesDirs: [],
    withGitLock: async (fn) => fn(),
    ...overrides,
  };
}

/** Leaves a repo in a SQUASH-merge conflict state on `main` (no MERGE_HEAD). */
function setupSquashConflictOnMain(repo: string): void {
  git(['checkout', '-q', 'main'], repo);
  gitAllowFail(['merge', '--squash', 'engin/main-slug'], repo);
}

/** Leaves a repo in a REGULAR-merge conflict state on `main` (MERGE_HEAD set). */
function setupRegularConflictOnMain(repo: string): void {
  git(['checkout', '-q', 'main'], repo);
  gitAllowFail(['merge', 'engin/main-slug'], repo);
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

beforeEach(() => {
  mock.clearAllMocks();
  // Restore default mock return values after clearing.
  mockCommitWorktreeChanges.mockResolvedValue(undefined);
  mockResolveConflictsWithAgent.mockResolvedValue({ resolved: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Module exports — verifies the extracted functions + types exist.
// ═══════════════════════════════════════════════════════════════════════════════

describe('worktree-final-merge module exports', () => {
  it('exports finalMergeToMain as a function', () => {
    expect(typeof finalMergeToMain).toBe('function');
  });

  it('exports resolveFinalMergeConflicts as a function', () => {
    expect(typeof resolveFinalMergeConflicts).toBe('function');
  });

  it('exports abortFinalMerge as a function', () => {
    expect(typeof abortFinalMerge).toBe('function');
  });

  it('exports the FinalMergeContext interface symbol', () => {
    // Interfaces are erased at runtime, but the module should still be a real
    // module object (not the empty fallback).
    expect(finalMergeMod).toBeDefined();
    expect(Object.keys(finalMergeMod).length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// finalMergeToMain
// ═══════════════════════════════════════════════════════════════════════════════

describe('finalMergeToMain', () => {
  // ── (a) Clean merge ──────────────────────────────────────────────────────

  it.skipIf(!finalMergeToMain)('on a clean merge: commits on real main and restores the saved branch', async () => {
    const repo = createRepoWithCleanMerge();
    createSavedBranch(repo, 'feature'); // currently on 'feature' (the saved branch)
    const holder: SavedBranchHolder = {};
    const ctx = makeCtx(repo);

    const result = await finalMergeToMain!(ctx, holder);

    // Clean merge succeeds with no conflicts.
    expect(result).toEqual({ success: true, conflicts: [], conflictsResolved: false });
    expect(result.error).toBeUndefined();

    // The saved branch was captured into the holder.
    expect(holder.savedBranch).toBe('feature');

    // The repo is restored to the saved branch.
    expect(getCurrentBranch(repo)).toBe('feature');

    // Real main now carries the squash commit.
    const mainLog = git(['log', '--oneline', 'main'], repo);
    expect(mainLog).toContain('Merge engin run: engin/main-slug');

    // The saved branch does NOT carry the commit (it is only on main).
    const featureLog = git(['log', '--oneline', 'feature'], repo);
    expect(featureLog).not.toContain('Merge engin run');

    // The merged content is reachable on main.
    expect(git(['show', 'main:feature.txt'], repo)).toBe('engin feature');
  });

  it.skipIf(!finalMergeToMain)('on a clean merge: calls commitWorktreeChanges on the main worktree first', async () => {
    const repo = createRepoWithCleanMerge();
    createSavedBranch(repo, 'feature');
    const ctx = makeCtx(repo);

    await finalMergeToMain!(ctx, {});

    expect(mockCommitWorktreeChanges).toHaveBeenCalledTimes(1);
    expect(mockCommitWorktreeChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: ctx.mainWorktreePath,
        taskPrompt: 'Final merge',
        profilesDirs: ctx.profilesDirs,
      }),
    );
  });

  it.skipIf(!finalMergeToMain)('wraps the whole operation in withGitLock', async () => {
    const repo = createRepoWithCleanMerge();
    createSavedBranch(repo, 'feature');

    let lockCalls = 0;
    const ctx = makeCtx(repo, {
      withGitLock: async (fn) => {
        lockCalls++;
        return fn();
      },
    });

    await finalMergeToMain!(ctx, {});

    // The entire body runs inside a SINGLE withGitLock critical section.
    expect(lockCalls).toBe(1);
  });

  // ── (b) Conflict ─────────────────────────────────────────────────────────

  it.skipIf(!finalMergeToMain)(
    'on a conflict: returns { success: false, conflicts } and leaves repo on real main with the merge in progress',
    async () => {
      const repo = createRepoWithConflict();
      createSavedBranch(repo, 'feature');
      const holder: SavedBranchHolder = {};
      const ctx = makeCtx(repo);

      const result = await finalMergeToMain!(ctx, holder);

      // Conflict result.
      expect(result.success).toBe(false);
      expect(result.conflicts).toEqual([CONFLICT_FILE]);
      expect(result.conflictsResolved).toBe(false);
      expect(result.error).toBeUndefined();

      // The saved branch was still captured (before checkout).
      expect(holder.savedBranch).toBe('feature');

      // The repo is on REAL main — the saved branch is NOT restored (the
      // caller's next action operates on the conflicted merge state).
      expect(getCurrentBranch(repo)).toBe('main');

      // The merge is in progress: conflicted files are present.
      expect(listConflictedFiles(repo)).toEqual([CONFLICT_FILE]);
    },
  );

  // ── Commit-failure rollback ──────────────────────────────────────────────

  it.skipIf(!finalMergeToMain)(
    'on commit failure after a clean squash: rolls back, restores the saved branch, and rethrows',
    async () => {
      const repo = createRepoWithCleanMerge();
      createSavedBranch(repo, 'feature');
      installFailingPreCommitHook(repo); // git commit will be rejected
      const holder: SavedBranchHolder = {};
      const ctx = makeCtx(repo);

      await expect(finalMergeToMain!(ctx, holder)).rejects.toThrow();

      // The saved branch was captured before the commit attempt.
      expect(holder.savedBranch).toBe('feature');

      // The repo is restored to the saved branch despite the failure.
      expect(getCurrentBranch(repo)).toBe('feature');

      // Real main is clean — the staged squash was discarded (resetHard),
      // so NO merge commit landed.
      const mainLog = git(['log', '--oneline', 'main'], repo);
      expect(mainLog).not.toContain('Merge engin run');

      // The working tree is clean (no leftover staged changes).
      expect(git(['status', '--porcelain'], repo)).toBe('');
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveFinalMergeConflicts
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveFinalMergeConflicts', () => {
  // ── (c) After manual resolution → stages and commits ─────────────────────

  it.skipIf(!resolveFinalMergeConflicts)(
    'after resolution: stages the conflicted files and commits on real main',
    async () => {
      const repo = createRepoWithConflict();
      setupSquashConflictOnMain(repo); // repo on main, app.txt conflicted
      expect(listConflictedFiles(repo)).toEqual([CONFLICT_FILE]);

      // Simulate the agent resolving the conflict (remove conflict markers).
      writeFileSync(join(repo, CONFLICT_FILE), 'RESOLVED-line1\ncommon base\n');
      mockResolveConflictsWithAgent.mockResolvedValueOnce({ resolved: true });

      const ctx = makeCtx(repo);
      const result = await resolveFinalMergeConflicts!(ctx, [CONFLICT_FILE], 'Fix the conflict');

      expect(result).toEqual({ resolved: true });

      // The agent was invoked with the context's params.
      expect(mockResolveConflictsWithAgent).toHaveBeenCalledWith(
        ctx.profilesDirs,
        repo,
        [CONFLICT_FILE],
        'Fix the conflict',
        ctx.apiKeys,
      );

      // A commit was created with the resolution message.
      const log = git(['log', '--oneline'], repo);
      expect(log).toContain('Merge resolution: engin/main-slug');

      // The committed content reflects the resolution.
      expect(git(['show', `HEAD:${CONFLICT_FILE}`], repo)).toBe('RESOLVED-line1\ncommon base');

      // No conflicts remain — the merge is complete.
      expect(listConflictedFiles(repo)).toEqual([]);
    },
  );

  it.skipIf(!resolveFinalMergeConflicts)(
    'when the agent cannot resolve: returns { resolved: false } without staging or committing',
    async () => {
      const repo = createRepoWithConflict();
      setupSquashConflictOnMain(repo);
      mockResolveConflictsWithAgent.mockResolvedValueOnce({ resolved: false, error: 'agent gave up' });

      const ctx = makeCtx(repo);
      const result = await resolveFinalMergeConflicts!(ctx, [CONFLICT_FILE], 'Fix');

      expect(result).toEqual({ resolved: false, error: 'agent gave up' });

      // The conflicted state is untouched — still in conflict.
      expect(listConflictedFiles(repo)).toEqual([CONFLICT_FILE]);

      // No resolution commit was created.
      const log = git(['log', '--oneline'], repo);
      expect(log).not.toContain('Merge resolution');
    },
  );

  it.skipIf(!resolveFinalMergeConflicts)(
    'when the agent resolves but the commit fails: rolls back and rethrows',
    async () => {
      const repo = createRepoWithConflict();
      setupSquashConflictOnMain(repo);
      writeFileSync(join(repo, CONFLICT_FILE), 'RESOLVED-line1\ncommon base\n');
      installFailingPreCommitHook(repo); // commit will be rejected
      mockResolveConflictsWithAgent.mockResolvedValueOnce({ resolved: true });

      const ctx = makeCtx(repo);
      await expect(resolveFinalMergeConflicts!(ctx, [CONFLICT_FILE], 'Fix')).rejects.toThrow();

      // Reset to HEAD — conflicts cleared, no resolution commit.
      expect(listConflictedFiles(repo)).toEqual([]);
      const log = git(['log', '--oneline'], repo);
      expect(log).not.toContain('Merge resolution');
    },
  );

  it.skipIf(!resolveFinalMergeConflicts)('wraps the operation in withGitLock', async () => {
    const repo = createRepoWithConflict();
    setupSquashConflictOnMain(repo);
    mockResolveConflictsWithAgent.mockResolvedValueOnce({ resolved: false });

    let lockCalls = 0;
    const ctx = makeCtx(repo, {
      withGitLock: async (fn) => {
        lockCalls++;
        return fn();
      },
    });

    await resolveFinalMergeConflicts!(ctx, [CONFLICT_FILE], 'Fix');

    expect(lockCalls).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// abortFinalMerge
// ═══════════════════════════════════════════════════════════════════════════════

describe('abortFinalMerge', () => {
  // ── (d) Aborts an in-progress merge ──────────────────────────────────────

  it.skipIf(!abortFinalMerge)('aborts an in-progress merge, clearing conflicts and MERGE_HEAD', async () => {
    const repo = createRepoWithConflict();
    // Use a REGULAR merge (sets MERGE_HEAD) so `git merge --abort` succeeds.
    setupRegularConflictOnMain(repo);
    expect(listConflictedFiles(repo)).toEqual([CONFLICT_FILE]);
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true);

    await abortFinalMerge!(makeCtx(repo));

    // Conflicts cleared.
    expect(listConflictedFiles(repo)).toEqual([]);
    // MERGE_HEAD gone — the merge is no longer in progress.
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    // The conflicted file reverted to main's version.
    expect(git(['show', `HEAD:${CONFLICT_FILE}`], repo)).toContain('MAIN-line1');
  });

  it.skipIf(!abortFinalMerge)('wraps the abort in withGitLock', async () => {
    const repo = createRepoWithConflict();
    setupRegularConflictOnMain(repo);

    let lockCalls = 0;
    const ctx = makeCtx(repo, {
      withGitLock: async (fn) => {
        lockCalls++;
        return fn();
      },
    });

    await abortFinalMerge!(ctx);

    expect(lockCalls).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Package entrypoint — the functions must be reachable from the engine index.
// ═══════════════════════════════════════════════════════════════════════════════

describe('package entrypoint exports', () => {
  // These do NOT use skipIf — they genuinely FAIL until the implementer adds
  // `export * from './core/worktree-final-merge.js'` to index.ts.
  it('finalMergeToMain is reachable from the engine package entrypoint', async () => {
    const engine: Record<string, unknown> = await import('../index.js');
    expect(typeof engine.finalMergeToMain).toBe('function');
  });

  it('resolveFinalMergeConflicts is reachable from the engine package entrypoint', async () => {
    const engine: Record<string, unknown> = await import('../index.js');
    expect(typeof engine.resolveFinalMergeConflicts).toBe('function');
  });

  it('abortFinalMerge is reachable from the engine package entrypoint', async () => {
    const engine: Record<string, unknown> = await import('../index.js');
    expect(typeof engine.abortFinalMerge).toBe('function');
  });
});
