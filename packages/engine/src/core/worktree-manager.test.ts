// ─── Tests for WorktreeManager.cullOrPreserve ──────────────────────────────
//
// The separation-of-concerns refactor moves the worktree culling orchestration
// OUT of `fixLoop` (pool/fix-loop.ts) and INTO `WorktreeManager` as a new
// `cullOrPreserve(taskId, preserve)` method. This file pins the new method's
// contract so the refactor is provably safe:
//
//   1. `preserve=true` → the method returns immediately WITHOUT calling
//      `cullTaskWorktree` (the worktree is PRESERVED for inspection).
//   2. `preserve=false` → the method delegates to `cullTaskWorktree(taskId)`.
//   3. When `cullTaskWorktree` throws, the error is SWALLOWED (caught) and
//      logged via `console.warn` — the method MUST NOT re-throw (best-effort
//      cleanup never masks the original failure).
//   4. The method resolves (never rejects) regardless of cull outcome.
//   5. The error log message includes the taskId so a human can correlate the
//      warning with the failing task.
//
// `WorktreeManager`'s constructor performs NO side effects (it only stores
// options), so we instantiate it with dummy paths and spy on the instance's
// `cullTaskWorktree` method directly. This isolates `cullOrPreserve`'s
// delegation + error-handling logic from the real git operations inside
// `cullTaskWorktree` (which are tested via the integration suites).

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { WorktreeManagerOptions } from './worktree-manager.js';
import { WorktreeManager } from './worktree-manager.js';

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

// ─── console.warn spy (manual, version-safe) ───────────────────────────────

let warnCalls: unknown[][] = [];
let realWarn: typeof console.warn;

beforeEach(() => {
  warnCalls = [];
  realWarn = console.warn;
  console.warn = ((...args: unknown[]) => {
    warnCalls.push(args);
  }) as unknown as typeof console.warn;
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
