import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Capture real modules before mocking ────────────────────────────────────

const realWorkflowLoader = Object.assign({}, await import('../../packages/engine/src/core/workflow-loader.js'));
const realUtils = Object.assign({}, await import('../../packages/engine/src/core/utils.js'));
const realConfig = Object.assign({}, await import('../../packages/engine/src/core/config.js'));
const realWorktreeLifecycle = Object.assign({}, await import('../../packages/engine/src/core/worktree-lifecycle.js'));
const realPostWorktree = Object.assign({}, await import('../../packages/cli/src/cli/post-worktree.js'));

// ─── Mock functions ─────────────────────────────────────────────────────────

const mockWorkflowRun = mock<(taskPrompt: string, options: Record<string, unknown>) => Promise<void>>();

const mockSetupWorktree = mock<
  (
    cwd: string,
    profilesDirs: string[],
    taskPrompt: string,
    apiKeys?: Record<string, string>,
  ) => Promise<{
    worktreePath: string;
    branchName: string;
    worktreeInfo: { worktreePath: string; branchName: string; originalCwd: string };
    cleanup: () => Promise<void>;
  }>
>();

const mockPromptPostWorktreeAction = mock<(options: Record<string, unknown>) => Promise<void>>();

const mockResolveProfilesDirs = mock<(cwd: string, workflowName?: string) => string[]>();

// ─── Mock modules (hoisted before imports by Bun test runtime) ──────────────

mock.module('../../packages/engine/src/core/workflow-loader.js', () => ({
  loadWorkflow: () => Promise.resolve({ run: mockWorkflowRun }),
  clearWorkflowCache: () => {},
}));

mock.module('../../packages/engine/src/core/utils.js', () => ({
  validateWorkflowName: () => {},
}));

mock.module('../../packages/engine/src/core/config.js', () => ({
  ...realConfig,
  getDefaultWorkDir: realConfig.getDefaultWorkDir,
  getGlobalConfigDir: realConfig.getGlobalConfigDir,
  loadEnvFiles: realConfig.loadEnvFiles,
  resolveProfilesDirs: mockResolveProfilesDirs,
}));

mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => ({
  setupWorktree: mockSetupWorktree,
  generateCommitMessage: realWorktreeLifecycle.generateCommitMessage,
  resolveConflictsWithAgent: realWorktreeLifecycle.resolveConflictsWithAgent,
  pushAndCreatePR: realWorktreeLifecycle.pushAndCreatePR,
}));

mock.module('../../packages/cli/src/cli/post-worktree.js', () => ({
  promptPostWorktreeAction: mockPromptPostWorktreeAction,
}));

// ─── Import SUT after mocks ─────────────────────────────────────────────────

import { runCommand } from '../../packages/cli/src/cli.ts';

// ─── Restore original modules ───────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/workflow-loader.js', () => realWorkflowLoader);
  mock.module('../../packages/engine/src/core/utils.js', () => realUtils);
  mock.module('../../packages/engine/src/core/config.js', () => realConfig);
  mock.module('../../packages/engine/src/core/worktree-lifecycle.js', () => realWorktreeLifecycle);
  mock.module('../../packages/cli/src/cli/post-worktree.js', () => realPostWorktree);
});

// ─── Shared helpers ─────────────────────────────────────────────────────────

function makeRunOptions(overrides: { worktree?: boolean; apiKeys?: Record<string, string> } = {}) {
  return {
    command: 'run' as const,
    workflowName: 'test-workflow',
    taskPrompt: 'test prompt',
    cwd: '/tmp/test-cwd',
    maxConcurrent: 3,
    verbose: true,
    worktree: overrides.worktree ?? false,
    apiKeys: overrides.apiKeys ?? {},
    warnings: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// runCommand — worktree integration tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('runCommand — worktree integration', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    onSpy = spyOn(process, 'on');
    removeListenerSpy = spyOn(process, 'removeListener');

    mockWorkflowRun.mockReset();
    mockSetupWorktree.mockReset();
    mockPromptPostWorktreeAction.mockReset();
    mockResolveProfilesDirs.mockReset();

    // Default: resolveProfilesDirs returns a predictable array
    mockResolveProfilesDirs.mockImplementation((_cwd: string, _workflowName?: string) => [
      '/local/profiles',
      '/global/profiles',
    ]);

    // Default: workflow.run resolves immediately
    mockWorkflowRun.mockResolvedValue(undefined);

    // Default: promptPostWorktreeAction resolves immediately
    mockPromptPostWorktreeAction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up any SIGINT listeners left on the process
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);

    logSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  // ─── Without --worktree ──────────────────────────────────────────────────

  describe('without --worktree', () => {
    it('does not call setupWorktree', async () => {
      await runCommand(makeRunOptions({ worktree: false }));
      expect(mockSetupWorktree).not.toHaveBeenCalled();
    });

    it('does not call promptPostWorktreeAction', async () => {
      await runCommand(makeRunOptions({ worktree: false }));
      expect(mockPromptPostWorktreeAction).not.toHaveBeenCalled();
    });

    it('passes options.cwd as cwd to workflow.run', async () => {
      const options = makeRunOptions({ worktree: false });

      await runCommand(options);

      expect(mockWorkflowRun).toHaveBeenCalledTimes(1);
      const runCall = mockWorkflowRun.mock.calls[0];
      const runOpts = runCall[1] as Record<string, unknown>;
      expect(runOpts.cwd).toBe(options.cwd);
    });

    it('does not pass worktree field to workflow.run', async () => {
      await runCommand(makeRunOptions({ worktree: false }));

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.worktree).toBeUndefined();
    });

    it('does not call resolveProfilesDirs', async () => {
      await runCommand(makeRunOptions({ worktree: false }));
      expect(mockResolveProfilesDirs).not.toHaveBeenCalled();
    });
  });

  // ─── With --worktree ─────────────────────────────────────────────────────

  describe('with --worktree', () => {
    const mockWorktreeInfo = {
      worktreePath: '/tmp/worktree-path',
      branchName: 'engin/test-workflow-abc123',
      originalCwd: '/tmp/test-cwd',
    };

    beforeEach(() => {
      mockSetupWorktree.mockResolvedValue({
        worktreePath: mockWorktreeInfo.worktreePath,
        branchName: mockWorktreeInfo.branchName,
        worktreeInfo: mockWorktreeInfo,
        cleanup: async () => {},
      });
    });

    it('calls resolveProfilesDirs with cwd and workflowName', async () => {
      const options = makeRunOptions({ worktree: true });
      await runCommand(options);

      // resolveProfilesDirs should be called at least once (for setupWorktree)
      expect(mockResolveProfilesDirs).toHaveBeenCalledWith(options.cwd, options.workflowName);
    });

    it('calls setupWorktree with correct arguments', async () => {
      const options = makeRunOptions({ worktree: true });
      await runCommand(options);

      expect(mockSetupWorktree).toHaveBeenCalledTimes(1);
      const call = mockSetupWorktree.mock.calls[0];
      expect(call[0]).toBe(options.cwd); // cwd
      expect(call[1]).toEqual(['/local/profiles', '/global/profiles']); // profilesDirs from mock
      expect(call[2]).toBe(options.taskPrompt); // taskPrompt
      // apiKeys should be undefined when apiKeys object is empty
      expect(call[3]).toBeUndefined();
    });

    it('calls setupWorktree with apiKeys when provided', async () => {
      const apiKeys = { anthropic: 'sk-xxx' };
      const options = makeRunOptions({ worktree: true, apiKeys });
      await runCommand(options);

      expect(mockSetupWorktree).toHaveBeenCalledTimes(1);
      const call = mockSetupWorktree.mock.calls[0];
      expect(call[3]).toEqual(apiKeys);
    });

    it('passes worktree path as cwd to workflow.run (not original cwd)', async () => {
      const options = makeRunOptions({ worktree: true });
      await runCommand(options);

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.cwd).toBe(mockWorktreeInfo.worktreePath);
      expect(runOpts.cwd).not.toBe(options.cwd);
    });

    it('passes worktree info to workflow.run', async () => {
      await runCommand(makeRunOptions({ worktree: true }));

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.worktree).toEqual(mockWorktreeInfo);
    });

    it('logs worktree creation message', async () => {
      await runCommand(makeRunOptions({ worktree: true }));

      const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logCalls).toContain('Worktree created at /tmp/worktree-path');
      expect(logCalls).toContain('on branch engin/test-workflow-abc123');
    });

    it('calls promptPostWorktreeAction after workflow.run completes', async () => {
      const options = makeRunOptions({ worktree: true });
      await runCommand(options);

      expect(mockPromptPostWorktreeAction).toHaveBeenCalledTimes(1);
    });

    it('passes correct options to promptPostWorktreeAction', async () => {
      const options = makeRunOptions({ worktree: true });
      await runCommand(options);

      expect(mockPromptPostWorktreeAction).toHaveBeenCalledTimes(1);

      // promptPostWorktreeAction is called with a single options object
      const call = mockPromptPostWorktreeAction.mock.calls[0];
      const promptOpts = call[0] as Record<string, unknown>;

      expect(promptOpts.profilesDirs).toEqual(['/local/profiles', '/global/profiles']);
      expect(promptOpts.repoRoot).toBe(mockWorktreeInfo.originalCwd);
      expect(promptOpts.worktreePath).toBe(mockWorktreeInfo.worktreePath);
      expect(promptOpts.branchName).toBe(mockWorktreeInfo.branchName);
      expect(promptOpts.originalCwd).toBe(mockWorktreeInfo.originalCwd);
      expect(promptOpts.taskPrompt).toBe(options.taskPrompt);
    });

    it('passes apiKeys to promptPostWorktreeAction when available', async () => {
      const apiKeys = { anthropic: 'sk-xxx' };
      const options = makeRunOptions({ worktree: true, apiKeys });
      await runCommand(options);

      const promptOpts = mockPromptPostWorktreeAction.mock.calls[0][0] as Record<string, unknown>;
      expect(promptOpts.apiKeys).toEqual(apiKeys);
    });

    it('does not pass apiKeys to promptPostWorktreeAction when empty', async () => {
      const options = makeRunOptions({ worktree: true, apiKeys: {} });
      await runCommand(options);

      const promptOpts = mockPromptPostWorktreeAction.mock.calls[0][0] as Record<string, unknown>;
      expect(promptOpts.apiKeys).toBeUndefined();
    });

    it('calls resolveProfilesDirs twice (once for setup, once for prompt)', async () => {
      await runCommand(makeRunOptions({ worktree: true }));

      // Once before setupWorktree, once before promptPostWorktreeAction
      expect(mockResolveProfilesDirs).toHaveBeenCalledTimes(2);
    });

    it('does not call promptPostWorktreeAction when workflow.run throws', async () => {
      mockWorkflowRun.mockRejectedValue(new Error('workflow failed'));

      const options = makeRunOptions({ worktree: true });
      // runCommand should propagate the error; the finally block cleans up SIGINT
      await expect(runCommand(options)).rejects.toThrow('workflow failed');

      expect(mockPromptPostWorktreeAction).not.toHaveBeenCalled();
    });

    it('still cleans up SIGINT handler when workflow.run throws with worktree', async () => {
      mockWorkflowRun.mockRejectedValue(new Error('workflow failed'));

      const options = makeRunOptions({ worktree: true });
      try {
        await runCommand(options);
      } catch {
        // expected
      }

      // Verify cleanup was called (removeListener is called in finally)
      expect(removeListenerSpy).toHaveBeenCalled();
    });

    it('workflow.run receives the task prompt', async () => {
      const options = makeRunOptions({ worktree: true });
      await runCommand(options);

      expect(mockWorkflowRun.mock.calls[0][0]).toBe('test prompt');
    });
  });
});
