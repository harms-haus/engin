// ─── Tests for WorktreeManager ──────────────────────────────────────────────
//
// This file covers:
//
//   1. `cullOrPreserve` — the culling-orchestration delegation + error
//      handling contract (characterization: pins current behavior so the
//      refactor is provably safe).
//   2. `commitMergeWithRetry` — DELEGATION to the newly-extracted shared
//      `commitWithFixupRetry` helper + the call-site-specific rollback
//      (`safeResetMainWorktree`) on exhaustion. These drive the extraction
//      (FAIL until the helper is wired in) and pin the preserved rollback
//      behavior.
//   3. Structural + JSDoc source inspections — verify the duplicated retry
//      logic was actually extracted out of this file (the helper is
//      referenced; `runTooledFixup` is no longer called inline) and that the
//      verbose ~24-line JSDoc was trimmed to a concise docstring.
//
// `WorktreeManager`'s constructor performs NO side effects (it only stores
// options), so we instantiate it with dummy paths and spy on the instance's
// private methods directly. The git / fix-up / worktree-operations modules are
// mocked at the module level so driving `commitMergeWithRetry` never reaches
// real git or spawns a real agent.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Capture real modules before mocking ──────────────────────────────────

const realGit = Object.assign({}, await import('./git.js'));
const realWorktreeFixup = Object.assign({}, await import('./worktree-fixup.js'));
const realWorktreeOperations = Object.assign({}, await import('./worktree-operations.js'));

// ─── Mock functions ─────────────────────────────────────────────────────────

const mockCommitChanges = mock((_dir: string, _message: string): void => {});
const mockStageAll = mock((_dir: string): void => {});
const mockRunTooledFixup = mock(
  async (): Promise<{ success: boolean; attempts: number; lastError?: string }> => ({
    success: true,
    attempts: 1,
  }),
);
// The shared helper that commitMergeWithRetry must delegate to after the
// extraction. Faked here so we can assert delegation without depending on the
// helper's internals (those are unit-tested in worktree-operations.test.ts).
const fakeCommitWithFixupRetry = mock(async (_opts: unknown): Promise<void> => {});
const fakeCommitWorktreeChanges = mock(async (_opts: unknown): Promise<void> => {});

// ─── Mock modules ──────────────────────────────────────────────────────────

mock.module('./git.js', () => ({
  ...realGit,
  commitChanges: mockCommitChanges,
  stageAll: mockStageAll,
}));

mock.module('./worktree-fixup.js', () => ({
  ...realWorktreeFixup,
  runTooledFixup: mockRunTooledFixup,
}));

mock.module('./worktree-operations.js', () => ({
  ...realWorktreeOperations,
  commitWorktreeChanges: fakeCommitWorktreeChanges,
  commitWithFixupRetry: fakeCommitWithFixupRetry,
}));

// ─── Import SUT after mocks ─────────────────────────────────────────────────

import type { WorktreeManagerOptions } from './worktree-manager.js';
import { WorktreeManager } from './worktree-manager.js';

// ─── Restore original modules ──────────────────────────────────────────────

afterAll(() => {
  mock.module('./git.js', () => realGit);
  mock.module('./worktree-fixup.js', () => realWorktreeFixup);
  mock.module('./worktree-operations.js', () => realWorktreeOperations);
});

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeManagerOptions(overrides: Partial<WorktreeManagerOptions> = {}): WorktreeManagerOptions {
  return {
    repoRoot: '/fake/repo',
    sourceCwd: '/fake/source',
    workDir: '/fake/work',
    mainBranch: 'engin/main-slug',
    mainWorktreePath: '/fake/work/worktree',
    profilesDirs: ['/fake/profiles'],
    ...overrides,
  };
}

/** Instantiate a real WorktreeManager with dummy opts; no git side effects. */
function makeManager(): WorktreeManager {
  return new WorktreeManager(makeManagerOptions());
}

/** Type-safe accessor for the private `commitMergeWithRetry` method. */
function callCommitMergeWithRetry(mgr: WorktreeManager, message: string, taskPrompt: string): Promise<void> {
  return (
    mgr as unknown as {
      commitMergeWithRetry: (message: string, taskPrompt: string) => Promise<void>;
    }
  ).commitMergeWithRetry(message, taskPrompt);
}

// Replaces the private `safeResetMainWorktree` with a spy and returns it.
function spySafeResetMainWorktree(mgr: WorktreeManager) {
  const spy = mock((): void => {});
  (mgr as unknown as { safeResetMainWorktree: () => void }).safeResetMainWorktree = spy;
  return spy;
}

// ─── console.warn spy (manual, version-safe) ───────────────────────────────

let warnCalls: unknown[][] = [];
let realWarn: typeof console.warn;

beforeEach(() => {
  warnCalls = [];
  realWarn = console.warn;
  console.warn = ((...args: unknown[]) => {
    warnCalls.push(args);
  }) as unknown as typeof console.warn;

  mockCommitChanges.mockReset();
  mockStageAll.mockReset();
  mockRunTooledFixup.mockReset();
  fakeCommitWithFixupRetry.mockReset();
  fakeCommitWorktreeChanges.mockReset();
});

afterEach(() => {
  console.warn = realWarn;
});

// ─── cullOrPreserve ────────────────────────────────────────────────────────

describe('WorktreeManager.cullOrPreserve', () => {
  it('preserve=true → does NOT call cullTaskWorktree', async () => {
    const mgr = makeManager();
    const cullSpy = mock(async (_taskId: string) => {});
    mgr.cullTaskWorktree = cullSpy;

    await mgr.cullOrPreserve('task-1', true);

    expect(cullSpy).not.toHaveBeenCalled();
  });

  it('preserve=true → resolves without throwing', async () => {
    const mgr = makeManager();
    mgr.cullTaskWorktree = mock(async () => {});

    await expect(mgr.cullOrPreserve('task-1', true)).resolves.toBeUndefined();
  });

  it('preserve=false → delegates to cullTaskWorktree with the taskId', async () => {
    const mgr = makeManager();
    const cullSpy = mock(async (_taskId: string) => {});
    mgr.cullTaskWorktree = cullSpy;

    await mgr.cullOrPreserve('task-1', false);

    expect(cullSpy).toHaveBeenCalledTimes(1);
    expect(cullSpy).toHaveBeenCalledWith('task-1');
  });

  it('preserve=false → delegates even when taskId is an unfamiliar value', async () => {
    const mgr = makeManager();
    const cullSpy = mock(async (_taskId: string) => {});
    mgr.cullTaskWorktree = cullSpy;

    await mgr.cullOrPreserve('unknown-task-xyz', false);

    expect(cullSpy).toHaveBeenCalledWith('unknown-task-xyz');
  });

  it('swallows a cullTaskWorktree error (does NOT re-throw)', async () => {
    const mgr = makeManager();
    const cullError = new Error('git remove failed');
    mgr.cullTaskWorktree = mock(async () => {
      throw cullError;
    });

    // Must not reject — best-effort cleanup never masks the original failure.
    await expect(mgr.cullOrPreserve('task-1', false)).resolves.toBeUndefined();
  });

  it('logs the cull failure via console.warn', async () => {
    const mgr = makeManager();
    mgr.cullTaskWorktree = mock(async () => {
      throw new Error('branch deletion refused');
    });

    await mgr.cullOrPreserve('task-99', false);

    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    const flat = String(warnCalls[0]);
    expect(flat).toContain('branch deletion refused');
  });

  it('the warning message includes the taskId', async () => {
    const mgr = makeManager();
    mgr.cullTaskWorktree = mock(async () => {
      throw new Error('boom');
    });

    await mgr.cullOrPreserve('task-correlate-me', false);

    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(warnCalls[0])).toContain('task-correlate-me');
  });

  it('handles a non-Error throw from cullTaskWorktree (stringifies it)', async () => {
    const mgr = makeManager();
    mgr.cullTaskWorktree = mock(async () => {
      // A non-Error rejection (e.g. a bare string) — the catch must still
      // stringify it without throwing.
      throw 'bare string error';
    });

    await expect(mgr.cullOrPreserve('task-1', false)).resolves.toBeUndefined();
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(warnCalls[0])).toContain('bare string error');
  });

  it('preserve=false with a non-throwing cull → does NOT emit a warning', async () => {
    const mgr = makeManager();
    mgr.cullTaskWorktree = mock(async () => {});

    await mgr.cullOrPreserve('task-1', false);

    expect(warnCalls).toHaveLength(0);
  });

  it('preserve=true does NOT emit a warning even when cullTaskWorktree would throw', async () => {
    // When preserving, cullTaskWorktree is never reached, so even a broken
    // implementation cannot surface a spurious warning.
    const mgr = makeManager();
    mgr.cullTaskWorktree = mock(async () => {
      throw new Error('should not be called');
    });

    await mgr.cullOrPreserve('task-1', true);

    expect(warnCalls).toHaveLength(0);
  });

  it('called multiple times (different tasks) — each delegates independently', async () => {
    const mgr = makeManager();
    const cullSpy = mock(async (_taskId: string) => {});
    mgr.cullTaskWorktree = cullSpy;

    await mgr.cullOrPreserve('task-a', false);
    await mgr.cullOrPreserve('task-b', true);
    await mgr.cullOrPreserve('task-c', false);

    expect(cullSpy).toHaveBeenCalledTimes(2);
    expect(cullSpy).toHaveBeenNthCalledWith(1, 'task-a');
    expect(cullSpy).toHaveBeenNthCalledWith(2, 'task-c');
  });
});

// ─── commitMergeWithRetry — delegation to the shared helper ────────────────
//
// After the extraction, `commitMergeWithRetry` must DELEGATE the retry/fix-up
// loop to the shared `commitWithFixupRetry` helper. Its ONLY remaining duty is
// the call-site-specific rollback: on helper failure it rolls the shared main
// worktree back to a clean HEAD (`safeResetMainWorktree`) and re-throws the
// ORIGINAL commit error. The public signature `(message, taskPrompt)` is
// unchanged. These tests FAIL until delegation is wired in.

describe('WorktreeManager.commitMergeWithRetry — delegation to shared helper', () => {
  it('delegates to commitWithFixupRetry forwarding worktree/message/profiles/prompt/keys', async () => {
    const mgr = new WorktreeManager(makeManagerOptions({ profilesDirs: ['/p1', '/p2'], apiKeys: { ANTHROPIC: 'k' } }));
    fakeCommitWithFixupRetry.mockResolvedValue(undefined);

    await callCommitMergeWithRetry(mgr, 'Merge task: t-1', 'do the thing');

    expect(fakeCommitWithFixupRetry).toHaveBeenCalledTimes(1);
    expect(fakeCommitWithFixupRetry).toHaveBeenCalledWith({
      worktreePath: '/fake/work/worktree',
      message: 'Merge task: t-1',
      profilesDirs: ['/p1', '/p2'],
      taskPrompt: 'do the thing',
      apiKeys: { ANTHROPIC: 'k' },
    });
  });

  it('does NOT call git primitives directly on the success path (fully delegated)', async () => {
    const mgr = makeManager();
    fakeCommitWithFixupRetry.mockResolvedValue(undefined);

    await callCommitMergeWithRetry(mgr, 'm', 'p');

    // The retry/fix-up logic lives in the helper now — commitMergeWithRetry
    // must not reach commitChanges / stageAll / runTooledFixup itself.
    expect(mockCommitChanges).not.toHaveBeenCalled();
    expect(mockStageAll).not.toHaveBeenCalled();
    expect(mockRunTooledFixup).not.toHaveBeenCalled();
  });

  it('does NOT roll back the main worktree when the helper succeeds', async () => {
    const mgr = makeManager();
    const resetSpy = spySafeResetMainWorktree(mgr);
    fakeCommitWithFixupRetry.mockResolvedValue(undefined);

    await callCommitMergeWithRetry(mgr, 'm', 'p');

    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('rolls back the main worktree (safeResetMainWorktree) when the helper throws', async () => {
    const mgr = makeManager();
    const resetSpy = spySafeResetMainWorktree(mgr);
    const commitError = new Error('pre-commit hook rejected the merge commit');
    fakeCommitWithFixupRetry.mockRejectedValue(commitError);

    await expect(callCommitMergeWithRetry(mgr, 'Merge task: t-9', 'prompt')).rejects.toBe(commitError);

    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  it('re-throws the ORIGINAL helper error (does not swallow or wrap it)', async () => {
    const mgr = makeManager();
    spySafeResetMainWorktree(mgr);
    const original = new Error('the real failure');
    fakeCommitWithFixupRetry.mockRejectedValue(original);

    await expect(callCommitMergeWithRetry(mgr, 'm', 'p')).rejects.toBe(original);
  });

  it('preserves the (message, taskPrompt) public signature', async () => {
    // The method must remain callable with exactly two string args. This is a
    // compile-time + runtime contract: renaming/reordering args would break
    // the internal callers in mergeTaskBranch.
    const mgr = makeManager();
    fakeCommitWithFixupRetry.mockResolvedValue(undefined);

    await expect(callCommitMergeWithRetry(mgr, 'a message', 'a prompt')).resolves.toBeUndefined();
    expect(fakeCommitWithFixupRetry.mock.calls[0][0]).toMatchObject({
      message: 'a message',
      taskPrompt: 'a prompt',
    });
  });
});

// ─── commitMergeWithRetry — structural extraction (source inspection) ──────
//
// Behavior tests above prove delegation works; these source inspections prove
// the DUPLICATION was actually removed (not just hidden behind a second copy).
// They read worktree-manager.ts and assert:
//   • the shared `commitWithFixupRetry` helper is referenced (delegation), and
//   • the tooled fix-up is no longer invoked inline in this file (the retry
//     logic now lives in the helper).
// They FAIL against the current (pre-refactor) source.

const MANAGER_SRC = readFileSync(join(import.meta.dir, 'worktree-manager.ts'), 'utf8');

describe('WorktreeManager.commitMergeWithRetry — structural extraction', () => {
  it('references the shared commitWithFixupRetry helper', () => {
    expect(MANAGER_SRC).toContain('commitWithFixupRetry');
  });

  it('no longer calls runTooledFixup directly (fix-up delegated to the helper)', () => {
    // `runTooledFixup(` (with the call paren) matches invocations, not a
    // leftover import. Currently this file calls it inline in
    // commitMergeWithRetry; after extraction it must not.
    expect(MANAGER_SRC.includes('runTooledFixup(')).toBe(false);
  });

  it('no longer calls commitChanges / stageAll directly for the retry (delegated)', () => {
    // Both primitives were used ONLY inside commitMergeWithRetry in this file.
    // After extraction they are invoked by the helper, not here.
    expect(MANAGER_SRC.includes('commitChanges(')).toBe(false);
    expect(MANAGER_SRC.includes('stageAll(')).toBe(false);
  });

  it('JSDoc is concise (≤ 8 lines; previously ~24 lines)', () => {
    const doc = jsdocPreceding(MANAGER_SRC, 'commitMergeWithRetry');
    // A doc block must still exist (concise docstring, not deleted entirely).
    expect(doc.length).toBeGreaterThan(0);
    expect(doc[0].trim().startsWith('/**')).toBe(true);
    expect(doc[doc.length - 1].trim()).toBe('*/');
    // Target ~5 lines; allow a little headroom.
    expect(doc.length).toBeLessThanOrEqual(8);
  });

  it('still documents the exhaustion contract (rollback + re-throw original error)', () => {
    const doc = jsdocPreceding(MANAGER_SRC, 'commitMergeWithRetry').join(' ');
    // The concise docstring should still mention the key safety behavior so
    // the contract is not lost when the verbose block is trimmed.
    expect(doc.toLowerCase()).toContain('original');
  });
});

// ─── Source-inspection helpers ─────────────────────────────────────────────

// Returns the JSDoc comment block (array of source lines, including the
// opening /** and closing */) immediately preceding the first source line
// containing memberMarker. Returns an empty array when no JSDoc precedes it.
function jsdocPreceding(src: string, memberMarker: string): string[] {
  const lines = src.split('\n');
  const idx = lines.findIndex((l) => l.includes(memberMarker));
  if (idx === -1) return [];

  // Walk back over trailing blank lines to the closing `*/`.
  let end = idx - 1;
  while (end >= 0 && lines[end].trim() === '') end--;
  if (end < 0 || !lines[end].includes('*/')) return [];

  // Walk back to the opening `/**`.
  let start = end;
  while (start >= 0 && !lines[start].trim().startsWith('/**')) start--;
  if (start < 0) return [];

  return lines.slice(start, end + 1);
}
