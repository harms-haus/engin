// ─── Two-prompt final merge UX (replaces the 3-option prompt) ──────────────
//
// Test-first specification for the post-worktree.ts refactor described in
// worktrees.prompt.md §8 flow step 5 and server-refactor.prompt.md §9.
//
// BEFORE this refactor:
//   - `promptPostWorktreeAction` shows a 3-option menu (keep/merge/PR) and
//     performs local git operations (checkout/merge/push/PR) via git.ts.
//   - `commitInWorktree`, `handleMergeToMain`, `handlePushAndPR` live in the
//     same module and call `@harms-haus/engin-engine` directly.
//
// AFTER this refactor:
//   - `promptFinalMerge(options, createRl?)` drives a two-prompt, yes/No,
//     human-in-the-loop final merge. It performs NO local git operations —
//     it delegates every action to the server via `options.sendAction` and
//     awaits each merge outcome via `options.waitForResult`.
//   - The git handlers (`commitInWorktree`/`handleMergeToMain`/
//     `handlePushAndPR`) and the `PostWorktreeAction`/`WorktreeDecision`
//     types are removed.
//   - `ReadlineQuestioner` is reused for both prompts.
//
// Flow under test:
//   Prompt 1: "Merge into main? yes/No: "
//     yes  → sendAction('merge') → waitForResult()
//            outcome 'clean'|'resolved' → ✅ success (+cleanup warning)
//            outcome 'conflicts'        → Prompt 2
//            outcome 'failed'           → ⚠️ merge-failed preservation
//            outcome 'declined'         → 📂 preservation (manual hint)
//     No   → sendAction('decline') → 📂 preservation (no waitForResult)
//
//   Prompt 2 (only after 'conflicts'):
//     "Conflicts exist on the merge. Should engin handle it? yes/No: "
//     yes  → sendAction('resolve') → waitForResult() → handle 2nd result
//     No   → sendAction('decline') → 📂 preservation (no 2nd waitForResult)
//
// STATUS: these tests are RED until the implement phase exports
// `promptFinalMerge` (and the `FinalMergeOptions` / `WorktreeMergeResult`
// types) from packages/cli/src/cli/post-worktree.ts. The protocol types
// (`worktree_action { action: 'merge'|'resolve'|'decline' }` and
// `worktree_merge_result`) already exist in packages/shared/protocol-types.ts.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Import SUT after mocks ──────────────────────────────────────────────────
//
// NOTE: these names do not exist in the source yet (write-tests phase). The
// module will fail to load with "Export named 'promptFinalMerge' not found"
// until the implement phase adds them. This is the expected RED state.

import {
  type FinalMergeOptions,
  type ReadlineQuestioner,
  type WorktreeMergeResult,
  promptFinalMerge,
} from '../../packages/cli/src/cli/post-worktree.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal, valid FinalMergeOptions with overridable fields. */
function makeOptions(overrides?: Partial<FinalMergeOptions>): FinalMergeOptions {
  return {
    worktreePath: '/fake/repo/.engin/work/run-1/worktree',
    branchName: 'engin/run-1',
    taskPrompt: 'Implement the login feature',
    runId: 'run-1',
    sendAction: mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {}),
    waitForResult: makeWaitForResult([{ outcome: 'clean' }]),
    ...overrides,
  };
}

/**
 * Build a `waitForResult` mock that returns the supplied results in order.
 * Throws if the queue is exhausted (a test bug — the impl called it more
 * times than expected).
 */
function makeWaitForResult(results: WorktreeMergeResult[]) {
  const queue = [...results];
  return mock(async (): Promise<WorktreeMergeResult> => {
    if (queue.length === 0) {
      throw new Error('makeWaitForResult: result queue exhausted');
    }
    return queue.shift()!;
  });
}

/**
 * A mock `ReadlineQuestioner` that captures the most-recently-asked
 * question's callback so a test can deliver an answer via `_answer(...)`.
 */
function createMockReadline(): ReadlineQuestioner & {
  _answer: (answer: string) => void;
  _close: ReturnType<typeof mock>;
  _question: ReturnType<typeof mock>;
} {
  let pendingCallback: ((answer: string) => void) | null = null;
  let closeListener: (() => void) | null = null;

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
    on(event: 'close', listener: () => void) {
      if (event === 'close') {
        closeListener = listener;
      }
    },
    close() {
      rl._close();
      // Real readline emits 'close' on stdin EOF or an explicit close().
      // Simulate that so the SUT's close guard is exercisable in tests.
      if (closeListener) {
        const listener = closeListener;
        closeListener = null;
        listener();
      }
    },
  };
  return rl;
}

/** Flush the microtask queue once so async continuations in the SUT settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ═══════════════════════════════════════════════════════════════════════════════
// promptFinalMerge
// ═══════════════════════════════════════════════════════════════════════════════

describe('promptFinalMerge', () => {
  let logSpy: ReturnType<typeof mock>;
  let originalLog: typeof console.log;

  beforeEach(() => {
    originalLog = console.log;
    logSpy = mock((..._args: unknown[]) => {});
    console.log = logSpy as unknown as typeof console.log;
  });

  afterEach(() => {
    console.log = originalLog;
    // Clean up any leftover SIGINT handlers registered by the SUT.
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as (...args: unknown[]) => void);
  });

  /** Join every console.log call into one string for substring assertions. */
  function logOutput(): string {
    return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  }

  // ─── Prompt 1 presentation ───────────────────────────────────────────────

  it('Prompt 1 asks "Merge into main?" with a yes/No (default-No) affordance', async () => {
    const rl = createMockReadline();
    const promise = promptFinalMerge(makeOptions(), () => rl);
    await flushMicrotasks();

    expect(rl._question).toHaveBeenCalledTimes(1);
    const promptText = rl._question.mock.calls[0][0] as string;
    expect(promptText).toMatch(/merge into main/i);
    // Capital "N" in "yes/No" advertises that No is the default.
    expect(promptText).toContain('yes/No');

    rl._answer('No');
    await promise;
  });

  // ─── Prompt 1 yes → merge → clean/resolved → success ─────────────────────

  it('Prompt 1 "yes" sends "merge", waits for a result, and a "clean" result prints success', async () => {
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
    const waitForResult = makeWaitForResult([{ outcome: 'clean' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(makeOptions({ sendAction, waitForResult }), () => rl);
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(sendAction).toHaveBeenCalledWith('merge');
    expect(waitForResult).toHaveBeenCalledTimes(1);

    const out = logOutput();
    expect(out).toContain('✅');
    expect(out).toMatch(/merged into main/i);
  });

  it('calls sendAction("merge") BEFORE waitForResult() (action precedes result)', async () => {
    const order: string[] = [];
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async (action) => {
      order.push(`action:${action}`);
    });
    const waitForResult = mock(async (): Promise<WorktreeMergeResult> => {
      order.push('result');
      return { outcome: 'clean' };
    });
    const rl = createMockReadline();

    const promise = promptFinalMerge(makeOptions({ sendAction, waitForResult }), () => rl);
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    expect(order).toEqual(['action:merge', 'result']);
  });

  it('a "resolved" result prints the success message', async () => {
    const waitForResult = makeWaitForResult([{ outcome: 'resolved' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(makeOptions({ waitForResult }), () => rl);
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    expect(logOutput()).toMatch(/merged into main/i);
  });

  it('prints a cleanup warning (with the cleanupError) when a clean result carries one', async () => {
    const waitForResult = makeWaitForResult([
      { outcome: 'clean', cleanupError: 'permission denied removing worktree dir' },
    ]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(makeOptions({ waitForResult }), () => rl);
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    const out = logOutput();
    // Merge still succeeded.
    expect(out).toMatch(/merged into main/i);
    // ...and the best-effort cleanup failure is surfaced to the user.
    expect(out).toContain('⚠️');
    expect(out).toContain('permission denied removing worktree dir');
  });

  // ─── Prompt 1 yes → merge → failed / declined → preservation ─────────────

  it('a "failed" result prints merge-failed preservation with worktree + branch', async () => {
    const waitForResult = makeWaitForResult([
      { outcome: 'failed', worktreePath: '/wt/failed', branchName: 'engin/broken' },
    ]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/failed', branchName: 'engin/broken', waitForResult }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    const out = logOutput();
    expect(out).toContain('⚠️');
    expect(out).toMatch(/merge failed/i);
    expect(out).toContain('/wt/failed');
    expect(out).toContain('engin/broken');
  });

  it('a "failed" result with an error reason surfaces it in the merge-failed message', async () => {
    const waitForResult = makeWaitForResult([
      {
        outcome: 'failed',
        worktreePath: '/wt/failed',
        branchName: 'engin/broken',
        error: 'agent could not resolve conflicts',
      },
    ]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/failed', branchName: 'engin/broken', waitForResult }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    const out = logOutput();
    expect(out).toMatch(/merge failed: agent could not resolve conflicts/i);
    // The re-attach hint is always present.
    expect(out).toMatch(/engin resume run-1/);
  });

  it('a "declined" result prints preservation with a manual-merge hint', async () => {
    const waitForResult = makeWaitForResult([
      { outcome: 'declined', worktreePath: '/wt/declined', branchName: 'engin/declined' },
    ]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/declined', branchName: 'engin/declined', waitForResult }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    const out = logOutput();
    expect(out).toMatch(/preserved/i);
    expect(out).toContain('/wt/declined');
    expect(out).toContain('engin/declined');
    expect(out).toMatch(/manual/i);
  });

  // ─── Prompt 1 yes → conflicts → Prompt 2 ─────────────────────────────────

  it('conflicts → Prompt 2 "yes" sends "resolve", and a "resolved" result prints success', async () => {
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
    const waitForResult = makeWaitForResult([{ outcome: 'conflicts' }, { outcome: 'resolved' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(makeOptions({ sendAction, waitForResult }), () => rl);
    await flushMicrotasks();
    rl._answer('yes'); // Prompt 1
    await flushMicrotasks();

    // The conflicts outcome must have triggered Prompt 2.
    expect(rl._question).toHaveBeenCalledTimes(2);
    const prompt2 = rl._question.mock.calls[1][0] as string;
    expect(prompt2).toMatch(/conflict/i);
    expect(prompt2).toMatch(/handle/i);
    expect(prompt2).toContain('yes/No');

    rl._answer('yes'); // Prompt 2
    await promise;

    expect(sendAction).toHaveBeenCalledWith('merge');
    expect(sendAction).toHaveBeenCalledWith('resolve');
    expect(sendAction).toHaveBeenCalledTimes(2);
    expect(waitForResult).toHaveBeenCalledTimes(2);
    expect(logOutput()).toMatch(/merged into main/i);
  });

  it('conflicts → Prompt 2 "yes" → resolve → "clean" also prints success', async () => {
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
    const waitForResult = makeWaitForResult([{ outcome: 'conflicts' }, { outcome: 'clean' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(makeOptions({ sendAction, waitForResult }), () => rl);
    await flushMicrotasks();
    rl._answer('yes');
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    expect(sendAction).toHaveBeenCalledWith('resolve');
    expect(logOutput()).toMatch(/merged into main/i);
  });

  it('conflicts → Prompt 2 "yes" → resolve → "failed" prints merge-failed preservation', async () => {
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
    const waitForResult = makeWaitForResult([
      { outcome: 'conflicts' },
      { outcome: 'failed', worktreePath: '/wt/x', branchName: 'engin/x' },
    ]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/x', branchName: 'engin/x', sendAction, waitForResult }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('yes');
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    expect(sendAction).toHaveBeenCalledWith('resolve');
    const out = logOutput();
    expect(out).toMatch(/merge failed/i);
    expect(out).toContain('/wt/x');
  });

  it('conflicts → Prompt 2 "No" sends "decline" and prints preservation (no 2nd waitForResult)', async () => {
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
    const waitForResult = makeWaitForResult([{ outcome: 'conflicts' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/preserve', branchName: 'engin/preserve', sendAction, waitForResult }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('yes'); // Prompt 1
    await flushMicrotasks();
    rl._answer('No'); // Prompt 2 — decline conflict resolution
    await promise;

    // 'merge' sent for Prompt 1, 'decline' sent for Prompt 2; no 'resolve'.
    expect(sendAction).toHaveBeenCalledWith('merge');
    expect(sendAction).toHaveBeenCalledWith('decline');
    expect(sendAction).not.toHaveBeenCalledWith('resolve');
    expect(sendAction).toHaveBeenCalledTimes(2);
    // Only the first result (conflicts) was awaited — declining does not
    // wait for a second merge result.
    expect(waitForResult).toHaveBeenCalledTimes(1);

    const out = logOutput();
    expect(out).toMatch(/preserved/i);
    expect(out).toContain('/wt/preserve');
  });

  // ─── Prompt 1 No / default-No ────────────────────────────────────────────

  it('Prompt 1 "No" sends "decline" and prints preservation (does not wait for a result)', async () => {
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
    const waitForResult = mock(async (): Promise<WorktreeMergeResult> => ({ outcome: 'declined' }));
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/keep', branchName: 'engin/keep', sendAction, waitForResult }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('No');
    await promise;

    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(sendAction).toHaveBeenCalledWith('decline');
    expect(sendAction).not.toHaveBeenCalledWith('merge');
    // Declining at Prompt 1 must NOT wait for a merge result.
    expect(waitForResult).not.toHaveBeenCalled();

    const out = logOutput();
    expect(out).toMatch(/preserved/i);
    expect(out).toContain('/wt/keep');
  });

  it('empty input defaults to No (sends "decline", prints preservation)', async () => {
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
    const waitForResult = mock(async (): Promise<WorktreeMergeResult> => ({ outcome: 'declined' }));
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/empty', branchName: 'engin/empty', sendAction, waitForResult }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('');
    await promise;

    expect(sendAction).toHaveBeenCalledWith('decline');
    expect(sendAction).not.toHaveBeenCalledWith('merge');
    expect(waitForResult).not.toHaveBeenCalled();
    expect(logOutput()).toMatch(/preserved/i);
  });

  // ─── yes/y case-insensitivity (Prompt 1) ─────────────────────────────────

  it('accepts "y" (lowercase) as yes', async () => {
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
    const rl = createMockReadline();
    const promise = promptFinalMerge(
      makeOptions({ sendAction, waitForResult: makeWaitForResult([{ outcome: 'clean' }]) }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('y');
    await promise;
    expect(sendAction).toHaveBeenCalledWith('merge');
  });

  it('accepts "YES" / "Y" (uppercase) as yes', async () => {
    for (const answer of ['YES', 'Y', 'Yes']) {
      const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
      const rl = createMockReadline();
      const promise = promptFinalMerge(
        makeOptions({ sendAction, waitForResult: makeWaitForResult([{ outcome: 'clean' }]) }),
        () => rl,
      );
      await flushMicrotasks();
      rl._answer(answer);
      await promise;
      expect(sendAction).toHaveBeenCalledWith('merge');
    }
  });

  it('treats "no" / "n" as No (sends decline)', async () => {
    for (const answer of ['no', 'n']) {
      const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
      const waitForResult = mock(async (): Promise<WorktreeMergeResult> => ({ outcome: 'declined' }));
      const rl = createMockReadline();
      const promise = promptFinalMerge(makeOptions({ sendAction, waitForResult }), () => rl);
      await flushMicrotasks();
      rl._answer(answer);
      await promise;
      expect(sendAction).toHaveBeenCalledWith('decline');
      expect(sendAction).not.toHaveBeenCalledWith('merge');
    }
  });

  // ─── SIGINT handling ─────────────────────────────────────────────────────

  it('SIGINT closes readline, prints preservation with the path, and resolves', async () => {
    const rl = createMockReadline();
    const promise = promptFinalMerge(makeOptions({ worktreePath: '/wt/sigint' }), () => rl);
    await flushMicrotasks();

    const listeners = process.listeners('SIGINT') as ((...args: unknown[]) => void)[];
    expect(listeners.length).toBeGreaterThan(0);
    // Invoke the most-recently-registered handler (the SUT's).
    listeners[listeners.length - 1]();

    await promise;

    expect(rl._close).toHaveBeenCalled();
    const out = logOutput();
    expect(out).toMatch(/preserved/i);
    expect(out).toContain('/wt/sigint');
  });

  // ─── stdin EOF / close guard (mirrors promptYesNo/confirmStop) ────────────

  it('resolves with preservation output (instead of hanging) when stdin closes before an answer is given', async () => {
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
    const waitForResult = mock(async (): Promise<WorktreeMergeResult> => ({ outcome: 'clean' }));
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/eof', branchName: 'engin/eof', sendAction, waitForResult }),
      () => rl,
    );
    await flushMicrotasks();

    // Simulate stdin closing (EOF, exhausted piped input, CI, closed terminal)
    // WITHOUT delivering an answer — the pending question callback never fires.
    rl.close();

    // The promise must resolve rather than hang; wrap in a timeout race so a
    // regression (forgotten close guard) fails the test instead of stalling it.
    await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('promise hung on stdin close')), 1000)),
    ]);

    // The worktree is preserved, and no action was sent (no answer arrived).
    const out = logOutput();
    expect(out).toMatch(/preserved/i);
    expect(out).toContain('/wt/eof');
    expect(out).toContain('engin/eof');
    expect(out).toMatch(/manual/i);
    expect(sendAction).not.toHaveBeenCalled();
    expect(waitForResult).not.toHaveBeenCalled();
  });

  it('a normal completion does not double-fire the close guard (no duplicate preservation output)', async () => {
    const sendAction = mock<(action: 'merge' | 'resolve' | 'decline') => Promise<void>>(async () => {});
    const waitForResult = mock(async (): Promise<WorktreeMergeResult> => ({ outcome: 'declined' }));
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/nodup', branchName: 'engin/nodup', sendAction, waitForResult }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('No'); // decline path → finish() calls rl.close() → 'close' fires
    await promise;

    // The decline path prints preservation exactly once; the close guard
    // (which would also print preservation) must NOT re-trigger.
    const preservationLines = logOutput()
      .split('\n')
      .filter((line) => /preserved/i.test(line));
    expect(preservationLines).toHaveLength(1);
  });

  // ─── Readline + handler lifecycle ────────────────────────────────────────

  it('closes the readline interface after the flow completes', async () => {
    const rl = createMockReadline();
    const promise = promptFinalMerge(makeOptions(), () => rl);
    await flushMicrotasks();
    rl._answer('No');
    await promise;

    expect(rl._close).toHaveBeenCalled();
  });

  it('removes its SIGINT handler after the flow completes', async () => {
    const rl = createMockReadline();
    const promise = promptFinalMerge(makeOptions(), () => rl);
    await flushMicrotasks();

    const beforeCount = process.listenerCount('SIGINT');
    rl._answer('No');
    await promise;

    const afterCount = process.listenerCount('SIGINT');
    expect(afterCount).toBe(beforeCount - 1);
  });

  // ─── Progress indicator (no silent terminal) ──────────────────────────

  it('Prompt 1 "yes" prints an in-progress line before awaiting the result', async () => {
    const waitForResult = makeWaitForResult([{ outcome: 'clean' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(makeOptions({ waitForResult }), () => rl);
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    const out = logOutput();
    expect(out).toMatch(/merging into main/i);
    expect(out).toContain('⏳');
  });

  it('Prompt 2 "yes" prints an in-progress "Resolving conflicts" line', async () => {
    const waitForResult = makeWaitForResult([{ outcome: 'conflicts' }, { outcome: 'resolved' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(makeOptions({ waitForResult }), () => rl);
    await flushMicrotasks();
    rl._answer('yes'); // Prompt 1
    await flushMicrotasks();
    rl._answer('yes'); // Prompt 2
    await promise;

    const out = logOutput();
    expect(out).toMatch(/resolving conflicts/i);
    expect(out).toContain('⏳');
  });

  // ─── Rejection paths (lost connection) ────────────────────────────────

  it('Prompt 1 "yes" with a rejecting sendAction prints a lost-connection message and resolves (no waitForResult)', async () => {
    const sendAction = mock(async () => {
      throw new Error('WS closed');
    });
    const waitForResult = makeWaitForResult([{ outcome: 'clean' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/rej', branchName: 'engin/rej', runId: 'run-rej', sendAction, waitForResult }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    // sendAction rejected before waitForResult was ever called.
    expect(waitForResult).not.toHaveBeenCalled();

    const out = logOutput();
    expect(out).toContain('⚠️');
    expect(out).toMatch(/lost connection to the server/i);
    expect(out).toContain('/wt/rej');
    expect(out).toContain('engin/rej');
    expect(out).toContain('engin resume run-rej');
  });

  it('Prompt 1 "yes" with a rejecting waitForResult prints a lost-connection message and resolves', async () => {
    const sendAction = mock(async () => {});
    const waitForResult = mock(async () => {
      throw new Error('WS dropped mid-result');
    });
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/rej2', branchName: 'engin/rej2', runId: 'run-rej2', sendAction, waitForResult }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    expect(sendAction).toHaveBeenCalledWith('merge');
    expect(waitForResult).toHaveBeenCalledTimes(1);

    const out = logOutput();
    expect(out).toMatch(/lost connection to the server/i);
    expect(out).toContain('/wt/rej2');
    expect(out).toContain('engin/rej2');
    expect(out).toContain('engin resume run-rej2');
  });

  it('Prompt 1 "No" with a rejecting decline sendAction prints a lost-connection message and resolves', async () => {
    const sendAction = mock(async () => {
      throw new Error('WS closed');
    });
    const waitForResult = mock(async (): Promise<WorktreeMergeResult> => ({ outcome: 'declined' }));
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({
        worktreePath: '/wt/decl-rej',
        branchName: 'engin/decl-rej',
        runId: 'decl-rej',
        sendAction,
        waitForResult,
      }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('No');
    await promise;

    // Declining at Prompt 1 must NOT wait for a result, even on rejection.
    expect(waitForResult).not.toHaveBeenCalled();
    expect(logOutput()).toMatch(/lost connection to the server/i);
    expect(logOutput()).toContain('engin resume decl-rej');
  });

  it('Prompt 2 "yes" with a rejecting resolve sendAction prints a lost-connection message', async () => {
    let call = 0;
    const sendAction = mock(async (action: 'merge' | 'resolve' | 'decline') => {
      call += 1;
      if (action === 'resolve') throw new Error('WS closed during resolve');
    });
    const waitForResult = makeWaitForResult([{ outcome: 'conflicts' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({
        worktreePath: '/wt/p2-rej',
        branchName: 'engin/p2-rej',
        runId: 'p2-rej',
        sendAction,
        waitForResult,
      }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('yes'); // Prompt 1 — merge → conflicts
    await flushMicrotasks();
    rl._answer('yes'); // Prompt 2 — resolve rejects
    await promise;

    expect(sendAction).toHaveBeenCalledWith('resolve');
    // Only the conflicts result was awaited; the resolve never reached waitForResult.
    expect(waitForResult).toHaveBeenCalledTimes(1);
    expect(logOutput()).toMatch(/lost connection to the server/i);
    expect(logOutput()).toContain('engin resume p2-rej');
  });

  it('Prompt 2 "No" with a rejecting decline sendAction prints a lost-connection message', async () => {
    let call = 0;
    const sendAction = mock(async (action: 'merge' | 'resolve' | 'decline') => {
      call += 1;
      if (call === 2) throw new Error('WS closed during decline');
    });
    const waitForResult = makeWaitForResult([{ outcome: 'conflicts' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({
        worktreePath: '/wt/p2-decl-rej',
        branchName: 'engin/p2-decl-rej',
        runId: 'p2-decl-rej',
        sendAction,
        waitForResult,
      }),
      () => rl,
    );
    await flushMicrotasks();
    rl._answer('yes'); // Prompt 1
    await flushMicrotasks();
    rl._answer('No'); // Prompt 2 — decline rejects
    await promise;

    expect(sendAction).toHaveBeenLastCalledWith('decline');
    expect(waitForResult).toHaveBeenCalledTimes(1);
    expect(logOutput()).toMatch(/lost connection to the server/i);
    expect(logOutput()).toContain('engin resume p2-decl-rej');
  });

  it('a rejection does not produce an unhandled-rejection (the prompt resolves cleanly)', async () => {
    // If the `.catch` were missing, bun:test would surface the rejection as a
    // test failure. This test asserts the prompt resolves normally instead.
    const sendAction = mock(async () => {
      throw new Error('boom');
    });
    const waitForResult = makeWaitForResult([{ outcome: 'clean' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(makeOptions({ sendAction, waitForResult }), () => rl);
    await flushMicrotasks();
    rl._answer('yes');
    // Resolves (no .catch would leave this hanging + emit an unhandled rejection).
    await expect(promise).resolves.toBeUndefined();
  });

  // ─── Timeout paths (silent server) ────────────────────────────────────
  //
  // `resultTimeoutMs` is injected (3rd arg) so we don't have to wait 60s.
  // A never-resolving `waitForResult` simulates a server that crashed, dropped
  // the WS, or failed to re-broadcast the single merge-result message after a
  // reconnect.

  it('Prompt 1 "yes" times out when the server never responds, prints a timeout message and resolves', async () => {
    const sendAction = mock(async () => {});
    const waitForResult = mock(() => new Promise<WorktreeMergeResult>(() => {})); // never resolves
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/to', branchName: 'engin/to', sendAction, waitForResult }),
      () => rl,
      10, // 10ms timeout
    );
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    const out = logOutput();
    expect(out).toContain('⚠️');
    expect(out).toMatch(/no response from the server within \d+s/i);
    expect(out).toContain('/wt/to');
    expect(out).toContain('engin/to');
  });

  it('Prompt 2 "yes" times out when the resolve result never arrives', async () => {
    const sendAction = mock(async () => {});
    // First result (conflicts) resolves; second (resolve) never does.
    let firstCall = true;
    const waitForResult = mock(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve<WorktreeMergeResult>({ outcome: 'conflicts' });
      }
      return new Promise<WorktreeMergeResult>(() => {});
    });
    const rl = createMockReadline();

    const promise = promptFinalMerge(
      makeOptions({ worktreePath: '/wt/p2-to', branchName: 'engin/p2-to', sendAction, waitForResult }),
      () => rl,
      10,
    );
    await flushMicrotasks();
    rl._answer('yes'); // Prompt 1 → conflicts
    await flushMicrotasks();
    rl._answer('yes'); // Prompt 2 → resolve hangs
    await promise;

    const out = logOutput();
    expect(out).toMatch(/no response from the server within \d+s/i);
    expect(out).toContain('/wt/p2-to');
    expect(out).toContain('engin/p2-to');
  });

  it('a normal result cancels the timeout timer (no late timeout fires after success)', async () => {
    // If the timer were not cleared in the racing `.finally`, it would fire
    // ~10ms later — long after `finish()` — and try to print again. `settled`
    // guards the call, but we assert the timer is cleared (no second warning).
    const sendAction = mock(async () => {});
    const waitForResult = makeWaitForResult([{ outcome: 'clean' }]);
    const rl = createMockReadline();

    const promise = promptFinalMerge(makeOptions({ sendAction, waitForResult }), () => rl, 10);
    await flushMicrotasks();
    rl._answer('yes');
    await promise;

    // Wait well past the (10ms) timeout to prove it never fired.
    await new Promise((r) => setTimeout(r, 30));

    const out = logOutput();
    expect(out).toMatch(/merged into main/i);
    expect(out).not.toMatch(/no response from the server/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FinalMergeOptions contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('FinalMergeOptions', () => {
  it('requires worktreePath, branchName, taskPrompt, runId, sendAction, waitForResult', () => {
    const opts: FinalMergeOptions = {
      worktreePath: '/wt',
      branchName: 'engin/x',
      taskPrompt: 'do the thing',
      runId: 'run-1',
      sendAction: async () => {},
      waitForResult: async () => ({ outcome: 'clean' }),
    };

    expect(opts.worktreePath).toBe('/wt');
    expect(opts.branchName).toBe('engin/x');
    expect(opts.taskPrompt).toBe('do the thing');
    expect(opts.runId).toBe('run-1');
    expect(typeof opts.sendAction).toBe('function');
    expect(typeof opts.waitForResult).toBe('function');
  });

  it('sendAction accepts the three documented actions: merge | resolve | decline', async () => {
    const sent: string[] = [];
    const opts: FinalMergeOptions = {
      worktreePath: '/wt',
      branchName: 'engin/x',
      taskPrompt: 't',
      runId: 'r',
      sendAction: async (action: 'merge' | 'resolve' | 'decline') => {
        sent.push(action);
      },
      waitForResult: async () => ({ outcome: 'clean' }),
    };

    await opts.sendAction('merge');
    await opts.sendAction('resolve');
    await opts.sendAction('decline');

    expect(sent).toEqual(['merge', 'resolve', 'decline']);
  });

  it('carries no git-operation fields (no profilesDirs / repoRoot / apiKeys)', () => {
    // The server performs all git operations; the client only sends decisions.
    // These fields must NOT exist on FinalMergeOptions — assigning one is a
    // compile error, verified here by constructing a minimal object.
    const opts: FinalMergeOptions = {
      worktreePath: '/wt',
      branchName: 'engin/x',
      taskPrompt: 't',
      runId: 'r',
      sendAction: async () => {},
      waitForResult: async () => ({ outcome: 'clean' }),
    };
    expect((opts as Record<string, unknown>).profilesDirs).toBeUndefined();
    expect((opts as Record<string, unknown>).repoRoot).toBeUndefined();
    expect((opts as Record<string, unknown>).apiKeys).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WorktreeMergeResult contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorktreeMergeResult', () => {
  it('outcome accepts all five documented values', () => {
    const outcomes: WorktreeMergeResult['outcome'][] = ['clean', 'conflicts', 'resolved', 'failed', 'declined'];
    expect(outcomes).toHaveLength(5);
    expect(new Set(outcomes).size).toBe(5);
  });

  it('cleanupError, worktreePath, branchName are all optional', () => {
    const minimal: WorktreeMergeResult = { outcome: 'clean' };
    expect(minimal.cleanupError).toBeUndefined();
    expect(minimal.worktreePath).toBeUndefined();
    expect(minimal.branchName).toBeUndefined();
  });

  it('survives a JSON round-trip', () => {
    const result: WorktreeMergeResult = {
      outcome: 'failed',
      cleanupError: 'worktree busy',
      worktreePath: '/wt',
      branchName: 'engin/x',
    };
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ReadlineQuestioner (reused primitive)
// ═══════════════════════════════════════════════════════════════════════════════

describe('ReadlineQuestioner', () => {
  it('exposes question(prompt, callback) and close()', () => {
    const rl: ReadlineQuestioner = createMockReadline();
    expect(typeof rl.question).toBe('function');
    expect(typeof rl.close).toBe('function');

    let captured = 'untouched';
    rl.question('prompt?', (answer) => {
      captured = answer;
    });
    (rl as any)._answer('the-answer');
    expect(captured).toBe('the-answer');

    rl.close();
    expect((rl as any)._close).toHaveBeenCalledTimes(1);
  });
});
