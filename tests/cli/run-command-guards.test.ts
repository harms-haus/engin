import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Mock modules (hoisted before imports by Bun test runtime) ───────────────
//
// Only the input-validation guards are exercised here: they throw before any
// workflow loading or daemon interaction, so the mocks below exist purely to
// assert that NO workflow module is reached when a guard fires.
//
// NOTE: The previous "verbose flag pass-through (non-TUI)" and "happy path"
// describe blocks asserted that runCommand invokes workflow.run() in-process.
// That execution path was removed by the client/server refactor (runCommand now
// submits to the daemon via executeViaDaemon). The daemon-client run path is
// covered by run-command-tui.test.ts (T27), t33-worktree-lifecycle.test.ts, and
// t35-auth-token.test.ts.

// Capture the real modules before mocking so they can be restored in afterAll
// (prevents the mocks from leaking into later test files in the same process).
const realWorkflowLoader = Object.assign({}, await import('../../packages/engine/src/core/workflow-loader.js'));
const realUtils = Object.assign({}, await import('../../packages/engine/src/core/utils.js'));

mock.module('../../packages/engine/src/core/workflow-loader.js', () => ({
  loadWorkflow: () => Promise.resolve({ run: () => Promise.resolve() }),
  clearWorkflowCache: () => {},
}));

mock.module('../../packages/engine/src/core/utils.js', () => ({
  validateWorkflowName: () => {},
  composeStatusCallbacks: (callbacks: unknown[]) => callbacks[callbacks.length - 1],
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import { runCommand } from '../../packages/cli/src/cli.ts';

// ─── Restore original modules (prevent cross-file mock leakage) ──────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/workflow-loader.js', () => realWorkflowLoader);
  mock.module('../../packages/engine/src/core/utils.js', () => realUtils);
});

// ═══════════════════════════════════════════════════════════════════════════════
// runCommand — input validation guards
// ═══════════════════════════════════════════════════════════════════════════════

describe('runCommand — input validation guards', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    onSpy = spyOn(process, 'on');
    removeListenerSpy = spyOn(process, 'removeListener');
  });

  afterEach(() => {
    // Clean up any SIGINT listeners left on the process
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as unknown as (...a: unknown[]) => void);

    logSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  // ─── workflowName guards ──────────────────────────────────────────────────

  describe('workflowName guard', () => {
    it('throws descriptive error when workflowName is undefined', async () => {
      const options = {
        command: 'run' as const,
        workflowName: undefined as string | undefined,
        taskPrompt: 'some task',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      await expect(runCommand(options)).rejects.toThrow('workflow name is required for run command');
    });

    it('throws descriptive error when workflowName is empty string', async () => {
      const options = {
        command: 'run' as const,
        workflowName: '',
        taskPrompt: 'some task',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      await expect(runCommand(options)).rejects.toThrow('workflow name is required for run command');
    });
  });

  // ─── taskPrompt guards ────────────────────────────────────────────────────

  describe('taskPrompt guard', () => {
    it('throws descriptive error when taskPrompt is undefined', async () => {
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: undefined as string | undefined,
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      await expect(runCommand(options)).rejects.toThrow('task prompt is required for run command');
    });

    it('throws descriptive error when taskPrompt is empty string', async () => {
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: '',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      await expect(runCommand(options)).rejects.toThrow('task prompt is required for run command');
    });

    it('does not register SIGINT handler when taskPrompt guard fires', async () => {
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: undefined as string | undefined,
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      try {
        await runCommand(options);
      } catch {
        // expected
      }

      expect(onSpy).not.toHaveBeenCalled();
    });
  });
});
