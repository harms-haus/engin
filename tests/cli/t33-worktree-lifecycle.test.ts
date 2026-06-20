// ─── Worktree lifecycle: two-prompt final-merge UX (no --worktree flag) ─────
//
// This file was rewritten for the worktree UX refactor described in
// worktrees.prompt.md §8 / server-refactor.prompt.md §9.
//
// BEFORE (the old T33 contract this file used to assert):
//   - A `--worktree` CLI flag opted into worktrees; `CliOptions.worktree`
//     gated the post-run prompt.
//   - `worktree_action` ClientMessage actions were keep/discard/merge/pr.
//   - `start_run` carried a `worktree: true` field.
//   - The post-run prompt was `promptPostWorktreeAction` (fire-and-forget).
//
// AFTER (what these tests assert):
//   - No `--worktree` flag. Worktrees are AUTOMATIC for git repos: the server
//     decides, and the client learns the worktree identity from the
//     `run_complete` / `run_failed` TERMINAL broadcast (`capturedWorktree`).
//     (run_started carries no worktree — it is sent before the async
//     worktree setup completes.)
//   - `worktree_action` actions are merge | resolve | decline.
//   - `start_run` carries NO `worktree` field.
//   - The post-run prompt is `promptFinalMerge` (two-prompt, yes/No,
//     human-in-the-loop) which delegates every action to the server via
//     `sendAction` and awaits each outcome via `waitForResult`.
//   - `runCommand` ALWAYS wires a `postTerminalAction`; the action itself
//     no-ops when no worktree was captured (non-git run).
//
// Coverage split (these tests own the CLI/commands.ts layer + protocol
// contract; the server-side routing/RunManager behavior is covered by
// tests/server/message-router.test.ts and tests/server/run-manager.test.ts;
// the promptFinalMerge two-prompt flow itself is covered by
// tests/cli/post-worktree.test.ts).

import type { ClientMessage, ServerMessage } from '@engin/shared/protocol-types';
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Capture real modules before mocking ────────────────────────────────────

const realGit = Object.assign({}, await import('../../packages/engine/src/core/git.js'));
const realUtils = Object.assign({}, await import('../../packages/engine/src/core/utils.js'));
const realRunSessionClient = Object.assign({}, await import('../../packages/cli/src/cli/run-session-client.js'));
const realPostWorktree = Object.assign({}, await import('../../packages/cli/src/cli/post-worktree.js'));

// ─── Mock functions ─────────────────────────────────────────────────────────

// The non-git fallback prompt (added by this refactor) probes isGitRepo(cwd).
// Default to true so runCommand proceeds past the prompt without blocking on
// stdin; the dedicated run-command-non-git.test.ts exercises the false branch.
const mockIsGitRepo = mock<(dir: string) => boolean>(() => true);

// promptFinalMerge spy — captures the FinalMergeOptions passed by runCommand's
// postTerminalAction so the wiring (worktreePath/branchName/sendAction/...) can
// be asserted without driving the real interactive prompt.
const mockPromptFinalMerge = mock<(opts: Record<string, unknown>) => Promise<void>>(async () => {});

// ─── Capturing RunSessionClient stand-in ────────────────────────────────────
//
// runCommand constructs `new RunSessionClient({ ..., setup })` and calls
// `.run()`. We replace it with a fake that records the constructor options
// (so tests can invoke the `setup` callback manually) and whose `run()` is a
// no-op. This isolates the commands.ts wiring from the daemon/WS/TUI stack
// (already covered by run-command-tui.test.ts).

interface CapturedSessionOpts {
  port: number;
  host: string;
  useTui: boolean;
  verbose: boolean;
  setup: (engineClient: unknown) => Promise<unknown>;
}

let capturedSessionOpts: CapturedSessionOpts | null = null;

class CapturingRunSessionClient {
  constructor(opts: CapturedSessionOpts) {
    capturedSessionOpts = opts;
  }
  async run(): Promise<void> {
    // no-op — tests drive `setup()` manually to inspect the SetupResult.
  }
}

// ─── Mock modules (hoisted before imports by Bun) ──────────────────────────

mock.module('../../packages/engine/src/core/git.js', () => ({
  ...realGit,
  isGitRepo: mockIsGitRepo,
}));

mock.module('../../packages/engine/src/core/utils.js', () => ({
  ...realUtils,
  validateWorkflowName: () => {},
}));

mock.module('../../packages/cli/src/cli/run-session-client.js', () => ({
  ...realRunSessionClient,
  RunSessionClient: CapturingRunSessionClient,
}));

mock.module('../../packages/cli/src/cli/post-worktree.js', () => ({
  ...realPostWorktree,
  promptFinalMerge: mockPromptFinalMerge,
}));

// ─── Import SUT after mocks ─────────────────────────────────────────────────

import { runCommand } from '../../packages/cli/src/cli.js';

// ─── Restore original modules (prevent cross-file mock leakage) ─────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/git.js', () => realGit);
  mock.module('../../packages/engine/src/core/utils.js', () => realUtils);
  mock.module('../../packages/cli/src/cli/run-session-client.js', () => realRunSessionClient);
  mock.module('../../packages/cli/src/cli/post-worktree.js', () => realPostWorktree);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a valid run CliOptions object (no worktree field — it was removed). */
function makeOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'run' as const,
    workflowName: 'develop',
    taskPrompt: 'Build the thing',
    cwd: '/tmp/project',
    maxConcurrent: 3,
    verbose: false,
    apiKeys: {},
    warnings: [],
    ...overrides,
  };
}

/** A minimal EngineClient stand-in whose `send` is a spy. */
function makeMockEngineClient() {
  const send = mock((_msg: ClientMessage) => {});
  return { send, _ws: { readyState: 1 } };
}

/**
 * Run `runCommand` and invoke the captured `setup` callback, returning the
 * SetupResult so a test can inspect `startRunMessage` / `postTerminalAction`.
 */
async function runAndCaptureSetup(
  options: Record<string, unknown>,
  engineClient = makeMockEngineClient(),
): Promise<{ mode: string; startRunMessage: ClientMessage; postTerminalAction?: (ctx: unknown) => Promise<void> }> {
  capturedSessionOpts = null;
  mockPromptFinalMerge.mockClear();
  await runCommand(options as never);
  const opts = capturedSessionOpts as CapturedSessionOpts | null;
  if (!opts) throw new Error('RunSessionClient was not constructed by runCommand');
  const result = (await opts.setup(engineClient)) as {
    mode: string;
    startRunMessage: ClientMessage;
    postTerminalAction?: (ctx: unknown) => Promise<void>;
  };
  if (result === null) throw new Error('setup() returned null');
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// §1. Protocol contract (already updated — these stay GREEN)
// ═══════════════════════════════════════════════════════════════════════════════

describe('worktree lifecycle: protocol contract', () => {
  describe('worktree_action ClientMessage', () => {
    it('accepts the three two-prompt actions: merge | resolve | decline', () => {
      const merge: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'merge' };
      const resolve: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'resolve' };
      const decline: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'decline' };
      expect(merge.action).toBe('merge');
      expect(resolve.action).toBe('resolve');
      expect(decline.action).toBe('decline');
    });

    it('rejects legacy "keep" at compile time', () => {
      // @ts-expect-error — "keep" was removed; only merge|resolve|decline remain
      const msg: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'keep' };
      expect(msg).toBeDefined();
    });

    it('rejects legacy "discard" at compile time', () => {
      // @ts-expect-error — "discard" was removed; only merge|resolve|decline remain
      const msg: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'discard' };
      expect(msg).toBeDefined();
    });

    it('rejects legacy "pr" at compile time', () => {
      // @ts-expect-error — "pr" was removed; only merge|resolve|decline remain
      const msg: ClientMessage = { type: 'worktree_action', runId: 'r', action: 'pr' };
      expect(msg).toBeDefined();
    });

    it('survives a JSON round-trip', () => {
      const msg: ClientMessage = { type: 'worktree_action', runId: 'run-42', action: 'merge' };
      expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
    });
  });

  describe('start_run ClientMessage', () => {
    it('carries NO worktree field', () => {
      // @ts-expect-error — the worktree flag was removed from start_run
      const msg: ClientMessage = { type: 'start_run', workflowName: 'w', taskPrompt: 't', cwd: '/p', worktree: true };
      expect(msg.type).toBe('start_run');
    });

    it('compiles with the documented fields only', () => {
      const msg: ClientMessage = {
        type: 'start_run',
        workflowName: 'w',
        taskPrompt: 't',
        cwd: '/p',
      };
      expect(msg.type).toBe('start_run');
    });
  });

  describe('worktree_merge_result ServerMessage', () => {
    it('accepts all five outcomes', () => {
      const outcomes = ['clean', 'conflicts', 'resolved', 'failed', 'declined'] as const;
      for (const outcome of outcomes) {
        const msg: ServerMessage = { type: 'worktree_merge_result', runId: 'r', outcome };
        expect(msg.outcome).toBe(outcome);
      }
    });

    it('carries optional cleanupError / worktreePath / branchName', () => {
      const msg: ServerMessage = {
        type: 'worktree_merge_result',
        runId: 'r',
        outcome: 'failed',
        cleanupError: 'worktree busy',
        worktreePath: '/wt',
        branchName: 'engin/x',
      };
      expect(msg.runId).toBe('r');
    });

    it('survives a JSON round-trip', () => {
      const msg: ServerMessage = {
        type: 'worktree_merge_result',
        runId: 'r1',
        outcome: 'clean',
      };
      expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §2. runCommand — start_run message no longer carries worktree
// ═══════════════════════════════════════════════════════════════════════════════

describe('runCommand — start_run message', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockIsGitRepo.mockImplementation(() => true);
  });
  afterEach(() => logSpy.mockRestore());

  it('does not set a worktree field on the start_run message', async () => {
    const result = await runAndCaptureSetup(makeOptions());
    const srm = result.startRunMessage as Record<string, unknown>;
    expect(srm.type).toBe('start_run');
    expect(srm.worktree).toBeUndefined();
    expect('worktree' in srm).toBe(false);
  });

  it('forwards workflowName, taskPrompt, cwd, and maxConcurrent', async () => {
    const result = await runAndCaptureSetup(makeOptions({ maxConcurrent: 7 }));
    const srm = result.startRunMessage as Record<string, unknown>;
    expect(srm.workflowName).toBe('develop');
    expect(srm.taskPrompt).toBe('Build the thing');
    expect(srm.cwd).toBe('/tmp/project');
    expect(srm.maxConcurrent).toBe(7);
  });

  it('resolves setup to a start-mode SetupResult', async () => {
    const result = await runAndCaptureSetup(makeOptions());
    expect(result.mode).toBe('start');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3. runCommand — postTerminalAction wiring (promptFinalMerge)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The postTerminalAction is NO LONGER conditional on a --worktree flag. It is
// always wired, and internally no-ops when no worktree was captured (non-git
// run). When a worktree WAS captured (from run_started), it invokes
// promptFinalMerge with the worktree identity + sendAction/waitForResult
// callbacks.

describe('runCommand — postTerminalAction (promptFinalMerge wiring)', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockIsGitRepo.mockImplementation(() => true);
  });
  afterEach(() => logSpy.mockRestore());

  it('always wires a postTerminalAction (independent of any --worktree flag)', async () => {
    // options carry no worktree field at all (the flag was removed).
    const result = await runAndCaptureSetup(makeOptions());
    expect(typeof result.postTerminalAction).toBe('function');
  });

  it('no-ops (skips promptFinalMerge) when no worktree was captured', async () => {
    const result = await runAndCaptureSetup(makeOptions());
    const action = result.postTerminalAction;
    expect(action).toBeDefined();

    await action!({
      runId: 'run-1',
      engineClient: makeMockEngineClient(),
      capturedWorktree: undefined,
      waitForResult: async () => ({ outcome: 'clean' }),
    });

    expect(mockPromptFinalMerge).not.toHaveBeenCalled();
  });

  it('calls promptFinalMerge with the captured worktree identity + task prompt + runId', async () => {
    const result = await runAndCaptureSetup(makeOptions({ taskPrompt: 'Ship the feature' }));
    const engineClient = makeMockEngineClient();
    const waitForResult = async () => ({ outcome: 'clean' as const });

    await result.postTerminalAction!({
      runId: 'run-42',
      engineClient,
      capturedWorktree: {
        worktreePath: '/project/.engin-worktree-run-42',
        branchName: 'engin/run-42',
        originalCwd: '/project',
      },
      waitForResult,
    });

    expect(mockPromptFinalMerge).toHaveBeenCalledTimes(1);
    const passed = mockPromptFinalMerge.mock.calls[0][0] as Record<string, unknown>;
    expect(passed.worktreePath).toBe('/project/.engin-worktree-run-42');
    expect(passed.branchName).toBe('engin/run-42');
    expect(passed.taskPrompt).toBe('Ship the feature');
    expect(passed.runId).toBe('run-42');
  });

  it('threads ctx.waitForResult through to promptFinalMerge', async () => {
    const result = await runAndCaptureSetup(makeOptions());
    const engineClient = makeMockEngineClient();
    const waitForResult = async () => ({ outcome: 'clean' as const });

    await result.postTerminalAction!({
      runId: 'run-9',
      engineClient,
      capturedWorktree: { worktreePath: '/wt', branchName: 'engin/run-9' },
      waitForResult,
    });

    const passed = mockPromptFinalMerge.mock.calls[0][0] as Record<string, unknown>;
    expect(passed.waitForResult).toBe(waitForResult);
  });

  describe('sendAction callback', () => {
    it("sends a worktree_action ClientMessage via the engine client for 'merge'", async () => {
      const result = await runAndCaptureSetup(makeOptions());
      const engineClient = makeMockEngineClient();

      await result.postTerminalAction!({
        runId: 'run-merge',
        engineClient,
        capturedWorktree: { worktreePath: '/wt', branchName: 'engin/run-merge' },
        waitForResult: async () => ({ outcome: 'clean' }),
      });

      const passed = mockPromptFinalMerge.mock.calls[0][0] as {
        sendAction: (action: 'merge' | 'resolve' | 'decline') => Promise<void>;
      };
      await passed.sendAction('merge');

      expect(engineClient.send).toHaveBeenCalledTimes(1);
      expect(engineClient.send).toHaveBeenCalledWith({
        type: 'worktree_action',
        runId: 'run-merge',
        action: 'merge',
      });
    });

    it("sends worktree_action for 'resolve' and 'decline'", async () => {
      const result = await runAndCaptureSetup(makeOptions());
      const engineClient = makeMockEngineClient();

      await result.postTerminalAction!({
        runId: 'run-x',
        engineClient,
        capturedWorktree: { worktreePath: '/wt', branchName: 'engin/run-x' },
        waitForResult: async () => ({ outcome: 'clean' }),
      });

      const passed = mockPromptFinalMerge.mock.calls[0][0] as {
        sendAction: (action: 'merge' | 'resolve' | 'decline') => Promise<void>;
      };
      await passed.sendAction('resolve');
      await passed.sendAction('decline');

      expect(engineClient.send).toHaveBeenCalledWith({
        type: 'worktree_action',
        runId: 'run-x',
        action: 'resolve',
      });
      expect(engineClient.send).toHaveBeenCalledWith({
        type: 'worktree_action',
        runId: 'run-x',
        action: 'decline',
      });
    });

    it('does NOT send the removed legacy actions (keep/discard/pr)', async () => {
      // The sendAction signature only accepts merge|resolve|decline. This is a
      // compile-time guarantee on the FinalMergeOptions.sendAction type.
      const result = await runAndCaptureSetup(makeOptions());
      const engineClient = makeMockEngineClient();

      await result.postTerminalAction!({
        runId: 'run-legacy',
        engineClient,
        capturedWorktree: { worktreePath: '/wt', branchName: 'engin/run-legacy' },
        waitForResult: async () => ({ outcome: 'clean' }),
      });

      const passed = mockPromptFinalMerge.mock.calls[0][0] as {
        sendAction: (action: 'merge' | 'resolve' | 'decline') => Promise<void>;
      };
      // Only the three valid actions are callable.
      await passed.sendAction('merge');
      await passed.sendAction('resolve');
      await passed.sendAction('decline');

      const sentActions = engineClient.send.mock.calls.map((c) => (c[0] as Record<string, unknown>).action);
      expect(sentActions).toEqual(['merge', 'resolve', 'decline']);
      expect(sentActions).not.toContain('keep');
      expect(sentActions).not.toContain('discard');
      expect(sentActions).not.toContain('pr');
    });
  });
});
