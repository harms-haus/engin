import readline from 'node:readline';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Simplified post-worktree options. The server performs every git operation;
 * the client only collects the worktree/branch identity and the task prompt.
 *
 * The legacy git-operation fields (`profilesDirs`, `repoRoot`, `originalCwd`,
 * `apiKeys`) were removed when the merge/PR logic moved server-side. The
 * interactive prompt itself is driven by {@link FinalMergeOptions}, which
 * extends this shape with the `sendAction` / `waitForResult` callbacks needed
 * to talk to the server.
 */
export interface PostWorktreeOptions {
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Name of the branch checked out in the worktree. */
  branchName: string;
  /** The task prompt that seeded the run. */
  taskPrompt: string;
  /** T33: The run ID associated with this worktree. */
  runId: string;
}

/**
 * Options for {@link promptFinalMerge} — the two-prompt, yes/No, human-in-the-loop
 * final merge UX.
 *
 * The prompt performs NO local git operations. Every action is delegated to the
 * server via {@link sendAction}, and each merge outcome is awaited via
 * {@link waitForResult}.
 */
export type FinalMergeOptions = PostWorktreeOptions & {
  /**
   * Sends a `worktree_action` ClientMessage to the server.
   *
   * - `'merge'`    — request a squash-merge into main (Prompt 1 "yes").
   * - `'resolve'`  — request conflict resolution (Prompt 2 "yes").
   * - `'decline'`  — the user declined; preserve everything for manual merge.
   */
  sendAction: (action: 'merge' | 'resolve' | 'decline') => Promise<void>;
  /**
   * Waits for the next `worktree_merge_result` ServerMessage from the server.
   * Called exactly once per issued `merge`/`resolve` action; never called on
   * `decline`.
   */
  waitForResult: () => Promise<WorktreeMergeResult>;
};

/**
 * The outcome of a `merge` or `resolve` action, mirrored from the server's
 * `worktree_merge_result` ServerMessage (minus the wire `type`/`runId` fields).
 */
export interface WorktreeMergeResult {
  /**
   * - `'clean'`     — the merge applied with no conflicts.
   * - `'conflicts'` — conflicts arose; Prompt 2 offers to resolve them.
   * - `'resolved'`  — conflicts arose and were resolved by the server.
   * - `'failed'`    — the merge or resolution failed; preserve everything.
   * - `'declined'`  — the server declined (e.g. policy guard); preserve everything.
   */
  outcome: 'clean' | 'conflicts' | 'resolved' | 'failed' | 'declined';
  /** Best-effort cleanup failure message (worktree directory could not be removed). */
  cleanupError?: string;
  /** Server-reported worktree path (falls back to the options path when omitted). */
  worktreePath?: string;
  /** Server-reported branch name (falls back to the options branch when omitted). */
  branchName?: string;
  /** Short diagnostic carried on a 'failed' outcome (e.g. git stderr or agent
   *  resolution failure reason). */
  error?: string;
}

// ─── Readline interface for testing ──────────────────────────────────────────

export interface ReadlineQuestioner {
  question(prompt: string, callback: (answer: string) => void): void;
  close(): void;
  /**
   * Subscribe to the `'close'` event, emitted when the input stream ends
   * (EOF, exhausted piped input, CI, closed terminal) or `close()` is called.
   * Mirrors `readline.Interface`'s inherited `EventEmitter.on('close', ...)`.
   */
  on(event: 'close', listener: () => void): void;
}

function createReadlineInterface(): ReadlineQuestioner {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

// ─── Main prompt ─────────────────────────────────────────────────────────────

/**
 * Normalize a yes/No answer. Accepts `'yes'`/`'y'` (case-insensitive) as
 * affirmative; anything else — including empty input — is treated as No
 * (the default).
 */
function isYes(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'y';
}

/**
 * Drive the two-prompt, yes/No, human-in-the-loop final merge.
 *
 * Flow (§8 flow step 5):
 *
 *   Prompt 1: "Merge into main? yes/No"
 *     yes  → sendAction('merge') → waitForResult()
 *            outcome 'clean'|'resolved' → ✅ success (+cleanup warning)
 *            outcome 'conflicts'        → Prompt 2
 *            outcome 'failed'           → ⚠️ merge-failed preservation
 *            outcome 'declined'         → 📂 preservation (manual hint)
 *     No   → sendAction('decline') → 📂 preservation (no waitForResult)
 *
 *   Prompt 2 (only after 'conflicts'):
 *     "Conflicts exist on the merge. Should engin handle it? yes/No"
 *     yes  → sendAction('resolve') → waitForResult() → handle 2nd result
 *     No   → sendAction('decline') → 📂 preservation (no 2nd waitForResult)
 *
 * SIGINT at any prompt preserves the worktree and resolves the promise.
 *
 * Hardening: every `sendAction(...).then(waitForResult())` chain carries a
 * `.catch()` so a rejected send/wait surfaces a clear "lost connection"
 * message (instead of an unhandled rejection + a never-settling prompt);
 * `waitForResult()` is raced against `resultTimeoutMs` (default 60s) so a
 * silent server (crash, transient WS drop, lost result broadcast) cannot
 * hang the terminal indefinitely; and an in-progress line is printed after
 * each "yes" so the terminal is not silent while the server works.
 */
export async function promptFinalMerge(
  options: FinalMergeOptions,
  createRl: () => ReadlineQuestioner = createReadlineInterface,
  /** Per-call timeout (ms) for `waitForResult`; exposed for tests. */
  resultTimeoutMs = 60_000,
): Promise<void> {
  const rl = createRl();

  return new Promise<void>((resolve) => {
    // Guards against double-resolution: once any exit path runs (SIGINT,
    // stdin EOF/close, or a normal finish), the others must no-op. Without
    // this, the `rl.close()` call inside finish()/sigintHandler would
    // re-emit 'close' and re-run the close handler (duplicate output).
    let settled = false;

    // ── SIGINT: preserve the worktree and bail out ──────────────────────
    const sigintHandler = (): void => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', sigintHandler);
      rl.close();
      console.log(`📂 Worktree preserved at ${options.worktreePath}`);
      resolve();
    };
    process.once('SIGINT', sigintHandler);

    // ── stdin EOF / close guard ───────────────────────────────────────────
    // If stdin closes before/while a question is pending (EOF, exhausted
    // piped input, CI, closed terminal), the question callback never fires.
    // Resolve with preservation so the process never deadlocks — mirrors
    // the defensive `rl.on('close', ...)` guard in promptYesNo/confirmStop
    // (commands.ts). Only acts when no other exit path has settled first.
    rl.on('close', () => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', sigintHandler);
      printPreservation();
      resolve();
    });

    // ── Helpers ─────────────────────────────────────────────────────────
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', sigintHandler);
      rl.close();
      resolve();
    };

    /** Resolve the worktree path/branch for a preservation message, preferring
     *  the server-reported values when present. */
    const preservationTarget = (result?: WorktreeMergeResult): { path: string; branch: string } => ({
      path: result?.worktreePath ?? options.worktreePath,
      branch: result?.branchName ?? options.branchName,
    });

    const printPreservation = (result?: WorktreeMergeResult): void => {
      const { path, branch } = preservationTarget(result);
      console.log(`📂 Worktree preserved at ${path} (branch: ${branch}). You can merge manually.`);
    };

    const handleMergeFailure = (result: WorktreeMergeResult): void => {
      const { path, branch } = preservationTarget(result);
      console.log(
        `⚠️ Merge failed${result.error ? ': ' + result.error : ''}. Worktree preserved at ${path} (branch: ${branch}). You can merge manually or re-attach with: engin resume ${options.runId}`,
      );
    };

    /** Printed when a `sendAction`/`waitForResult` chain rejects — surface a
     *  clear failure (and a re-attach hint) instead of hanging silently on a
     *  lost connection or unhandled rejection. */
    const handleConnectionError = (): void => {
      const { path, branch } = preservationTarget();
      console.log(
        `⚠️ Lost connection to the server while merging. Worktree preserved at ${path} (branch: ${branch}). Re-attach with: engin resume ${options.runId}`,
      );
      finish();
    };

    /** Printed when `waitForResult` does not resolve within the timeout — the
     *  server may have crashed, dropped the WS, or failed to re-broadcast the
     *  single merge-result message after a reconnect. */
    const handleTimeout = (): void => {
      const { path, branch } = preservationTarget();
      console.log(
        `⚠️ No response from the server within ${Math.round(resultTimeoutMs / 1000)}s. Worktree preserved at ${path} (branch: ${branch}).`,
      );
      finish();
    };

    /** Race the next merge result against `resultTimeoutMs` so the prompt
     *  cannot hang indefinitely when the server goes silent. Resolves with
     *  either the {@link WorktreeMergeResult} or the sentinel `'timeout'`. */
    const awaitResult = (): Promise<WorktreeMergeResult | 'timeout'> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout('timeout'), resultTimeoutMs);
      });
      return Promise.race<Promise<WorktreeMergeResult | 'timeout'>>([options.waitForResult(), timeoutPromise]).finally(
        () => {
          // Clear the losing timer so it does not leak across prompt turns.
          if (timer) clearTimeout(timer);
        },
      );
    };

    /** Dispatch a raced result: `'timeout'` → timeout message, otherwise the
     *  normal outcome switch. */
    const onResult = (result: WorktreeMergeResult | 'timeout'): void => {
      if (result === 'timeout') {
        handleTimeout();
        return;
      }
      handleResult(result);
    };

    /** Handle a `worktree_merge_result` outcome following a merge or resolve. */
    const handleResult = (result: WorktreeMergeResult): void => {
      switch (result.outcome) {
        case 'clean':
        case 'resolved':
          if (result.cleanupError) {
            console.log(`⚠️ Warning: ${result.cleanupError}`);
          }
          console.log('✅ Merged into main');
          finish();
          break;
        case 'failed':
          handleMergeFailure(result);
          finish();
          break;
        case 'declined':
          printPreservation(result);
          finish();
          break;
        case 'conflicts':
          askConflictPrompt();
          break;
      }
    };

    // ── Prompt 2: conflict resolution ───────────────────────────────────
    const askConflictPrompt = (): void => {
      rl.question('Conflicts exist on the merge. Should engin handle it? yes/No: ', (answer) => {
        if (isYes(answer)) {
          // Print a progress line so the terminal is not silent while the
          // server's conflict resolver runs (it may take minutes).
          console.log('⏳ Resolving conflicts…');
          // Send 'resolve', then await the second merge result (raced against
          // the timeout). The `.catch` surfaces a lost connection instead of
          // hanging silently or producing an unhandled rejection.
          options
            .sendAction('resolve')
            .then(() => awaitResult())
            .then(onResult)
            .catch(handleConnectionError);
        } else {
          // Decline conflict resolution — preserve everything, no second result.
          options
            .sendAction('decline')
            .then(() => {
              printPreservation();
              finish();
            })
            .catch(handleConnectionError);
        }
      });
    };

    // ── Prompt 1: final merge ───────────────────────────────────────────
    rl.question('Merge into main? yes/No: ', (answer) => {
      if (isYes(answer)) {
        // Print a progress line so the terminal is not silent while the
        // server performs the squash-merge.
        console.log('⏳ Merging into main…');
        // action precedes result — sendAction must settle before waitForResult.
        // The result is raced against the timeout; the `.catch` surfaces a
        // lost connection instead of hanging silently.
        options
          .sendAction('merge')
          .then(() => awaitResult())
          .then(onResult)
          .catch(handleConnectionError);
      } else {
        // Decline the merge — preserve everything, no result awaited.
        options
          .sendAction('decline')
          .then(() => {
            printPreservation();
            finish();
          })
          .catch(handleConnectionError);
      }
    });
  });
}
