// ─── protocol-types tests — worktree UX protocol changes ────────────────────
//
// Pins the post-refactor contract of the web-facing protocol
// (packages/shared/src/protocol-types.ts):
//
//   1. `start_run` ClientMessage no longer carries a `worktree?: boolean` gate
//      — the worktree is now unconditional for git repos.
//   2. `worktree_action` ClientMessage uses actions `merge | resolve | decline`
//      only; the legacy `pr | discard | keep` actions are dropped.
//   3. A new `worktree_merge_result` ServerMessage variant reports merge
//      outcome to the client (clean | conflicts | resolved | failed | declined)
//      plus optional cleanupError / worktreePath / branchName.
//   4. `isServerMessage` recognizes the new `worktree_merge_result` discriminant.
//   5. `RunSummary.worktree` is UNCHANGED — it still carries display info.
//
// TDD NOTE ───────────────────────────────────────────────────────────────────
// This suite is the executable spec for the change and is written against the
// *target* (post-refactor) contract. Against the pre-refactor source it is
// intentionally RED:
//   - type-level assertions do not compile (`tsc --noEmit` reports errors), and
//   - the runtime `isServerMessage` checks return false (`bun test` fails).
// Once protocol-types.ts is updated per the task spec, every assertion turns
// green. The compile-time checks live inside `it(...)` bodies so they show up
// as documented test cases; at runtime they are no-ops (bun strips types) and
// the actual runtime verification is carried by the `isServerMessage` suite.
//
// The module is imported via the package subpath alias (canonical home):
//   import { ... } from '@engin/shared/protocol-types';

import type { ClientMessage, RunSummary, ServerMessage } from '@engin/shared/protocol-types';
import { isServerMessage } from '@engin/shared/protocol-types';
import { describe, expect, it } from 'bun:test';

// ────────────────────────────────────────────────────────────────────────────
// worktree_merge_result — new ServerMessage variant
// ────────────────────────────────────────────────────────────────────────────

describe('worktree_merge_result — ServerMessage variant', () => {
  it('is assignable to ServerMessage for every documented outcome', () => {
    // Compile-time: each literal must narrow to the worktree_merge_result arm.
    const clean: ServerMessage = { type: 'worktree_merge_result', runId: 'r1', outcome: 'clean' };
    const conflicts: ServerMessage = { type: 'worktree_merge_result', runId: 'r1', outcome: 'conflicts' };
    const resolved: ServerMessage = { type: 'worktree_merge_result', runId: 'r1', outcome: 'resolved' };
    const failed: ServerMessage = { type: 'worktree_merge_result', runId: 'r1', outcome: 'failed' };
    const declined: ServerMessage = { type: 'worktree_merge_result', runId: 'r1', outcome: 'declined' };
    void [clean, conflicts, resolved, failed, declined];
    // Compile-time type check — runtime verification is in the isServerMessage suite.
  });

  it('accepts the optional cleanupError / worktreePath / branchName fields', () => {
    const withExtras: ServerMessage = {
      type: 'worktree_merge_result',
      runId: 'r1',
      outcome: 'failed',
      cleanupError: 'git merge aborted',
      worktreePath: '/repo/.engin/wt/r1',
      branchName: 'engin/r1',
    };
    void withExtras;
    // Compile-time type check — runtime verification is in the isServerMessage suite.
  });

  it('treats runId and outcome as required fields', () => {
    // @ts-expect-error — runId is required on worktree_merge_result
    const noRunId: ServerMessage = { type: 'worktree_merge_result', outcome: 'clean' };
    // @ts-expect-error — outcome is required on worktree_merge_result
    const noOutcome: ServerMessage = { type: 'worktree_merge_result', runId: 'r1' };
    void [noRunId, noOutcome];
    // Compile-time type check — runtime verification is in the isServerMessage suite.
  });

  it('rejects an outcome value outside the documented union', () => {
    // Single-line so the @ts-expect-error reliably covers the reported error.
    // @ts-expect-error — 'merged' is not part of the outcome union
    const badOutcome: ServerMessage = { type: 'worktree_merge_result', runId: 'r1', outcome: 'merged' };
    void badOutcome;
    // Compile-time type check — runtime verification is in the isServerMessage suite.
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isServerMessage — runtime type guard (the executable part)
// ────────────────────────────────────────────────────────────────────────────

describe('isServerMessage — recognizes worktree_merge_result', () => {
  it.each(['clean', 'conflicts', 'resolved', 'failed', 'declined'] as const)(
    'returns true for outcome "%s"',
    (outcome) => {
      expect(isServerMessage({ type: 'worktree_merge_result', runId: 'r1', outcome })).toBe(true);
    },
  );

  it('returns true when optional preserved-fields are present', () => {
    expect(
      isServerMessage({
        type: 'worktree_merge_result',
        runId: 'r1',
        outcome: 'failed',
        cleanupError: 'boom',
        worktreePath: '/repo/.engin/wt/r1',
        branchName: 'engin/r1',
      }),
    ).toBe(true);
  });

  it('still recognizes the pre-existing server message discriminants (regression)', () => {
    expect(isServerMessage({ type: 'runs', runs: [] })).toBe(true);
    expect(isServerMessage({ type: 'run_started', runId: 'r1', summary: {} as RunSummary })).toBe(true);
    expect(isServerMessage({ type: 'snapshot', runId: 'r1', seq: 0, state: {} as never })).toBe(true);
    expect(isServerMessage({ type: 'events', runId: 'r1', seq: 0, events: [] })).toBe(true);
    expect(isServerMessage({ type: 'run_complete', runId: 'r1' })).toBe(true);
    expect(isServerMessage({ type: 'run_failed', runId: 'r1', error: 'e', phase: 'p' })).toBe(true);
    expect(isServerMessage({ type: 'log', runId: 'r1', level: 'info', message: 'hi', timestamp: 't' })).toBe(true);
    expect(isServerMessage({ type: 'auth_required' })).toBe(true);
    expect(isServerMessage({ type: 'error', code: 'x', message: 'm' })).toBe(true);
  });

  it('still rejects unknown / malformed inputs (regression)', () => {
    // Close-but-wrong discriminant must NOT be accepted as the new variant.
    expect(isServerMessage({ type: 'worktree_result' })).toBe(false);
    expect(isServerMessage({ type: 'worktree_merge' })).toBe(false);
    expect(isServerMessage({ type: 'definitely_not_real' })).toBe(false);
    expect(isServerMessage(null)).toBe(false);
    expect(isServerMessage({})).toBe(false);
    expect(isServerMessage(42)).toBe(false);
    expect(isServerMessage(undefined)).toBe(false);
    expect(isServerMessage('worktree_merge_result')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// worktree_action — ClientMessage actions updated
// ────────────────────────────────────────────────────────────────────────────

describe('worktree_action — ClientMessage actions', () => {
  it('accepts the new merge | resolve | decline actions', () => {
    const merge: ClientMessage = { type: 'worktree_action', runId: 'r1', action: 'merge' };
    const resolve: ClientMessage = { type: 'worktree_action', runId: 'r1', action: 'resolve' };
    const decline: ClientMessage = { type: 'worktree_action', runId: 'r1', action: 'decline' };
    void [merge, resolve, decline];
    // Compile-time type check — runtime verification is in the isServerMessage suite.
  });

  it('rejects the legacy pr / discard / keep actions', () => {
    // @ts-expect-error — 'pr' action was removed from worktree_action
    const pr: ClientMessage = { type: 'worktree_action', runId: 'r1', action: 'pr' };
    // @ts-expect-error — 'discard' action was removed from worktree_action
    const discard: ClientMessage = { type: 'worktree_action', runId: 'r1', action: 'discard' };
    // @ts-expect-error — 'keep' action was removed from worktree_action
    const keep: ClientMessage = { type: 'worktree_action', runId: 'r1', action: 'keep' };
    void [pr, discard, keep];
    // Compile-time type check — runtime verification is in the isServerMessage suite.
  });
});

// ────────────────────────────────────────────────────────────────────────────
// start_run — worktree gate removed
// ────────────────────────────────────────────────────────────────────────────

describe('start_run — worktree gate removed', () => {
  it('still accepts start_run carrying the other (unaffected) optional fields', () => {
    const sr: ClientMessage = {
      type: 'start_run',
      workflowName: 'develop',
      taskPrompt: 'do the thing',
      cwd: '/repo',
      workDir: '/repo/.engin/runs/123-develop',
      maxConcurrent: 3,
      apiKeys: { openai: 'sk-xxx' },
    };
    void sr;
    // Compile-time type check — runtime verification is in the isServerMessage suite.
  });

  it('rejects the removed worktree?: boolean field', () => {
    // TS reports excess-property errors on the offending property, so the
    // suppression directive must sit directly above it (not the declaration).
    const gated: ClientMessage = {
      type: 'start_run',
      workflowName: 'develop',
      taskPrompt: 'do the thing',
      cwd: '/repo',
      // @ts-expect-error — `worktree` was removed from start_run
      worktree: true,
    };
    void gated;
    // Compile-time type check — runtime verification is in the isServerMessage suite.
  });
});

// ────────────────────────────────────────────────────────────────────────────
// RunSummary — worktree display field must be PRESERVED
// ────────────────────────────────────────────────────────────────────────────

describe('RunSummary — worktree display field is preserved', () => {
  it('still accepts the worktree field (it must NOT be removed)', () => {
    const withWorktree: RunSummary = {
      runId: '123-develop',
      cwd: '/repo',
      workflowName: 'develop',
      taskPrompt: 'build it',
      status: 'running',
      startedAt: '2026-06-18T00:00:00Z',
      worktree: {
        worktreePath: '/repo/.engin/wt/123-develop',
        branchName: 'engin/123-develop',
        originalCwd: '/repo',
      },
    };
    void withWorktree;
    // Compile-time type check — runtime verification is in the isServerMessage suite.
  });

  it('still allows omitting the optional worktree field', () => {
    const withoutWorktree: RunSummary = {
      runId: '123-develop',
      cwd: '/repo',
      workflowName: 'develop',
      taskPrompt: 'build it',
      status: 'running',
      startedAt: '2026-06-18T00:00:00Z',
    };
    void withoutWorktree;
    // Compile-time type check — runtime verification is in the isServerMessage suite.
  });
});
