import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Capture real modules before mocking ─────────────────────────────────────

const realWorkflowLoader = Object.assign({}, await import('../../src/core/workflow-loader.js'));
const realUtils = Object.assign({}, await import('../../src/core/utils.js'));

// ─── Mock functions ──────────────────────────────────────────────────────────

const mockWorkflowRun = mock<(taskPrompt: string, options: Record<string, unknown>) => Promise<void>>();

// ─── Mock modules (hoisted before imports by Bun test runtime) ───────────────

mock.module('../../src/core/workflow-loader.js', () => ({
  loadWorkflow: () => Promise.resolve({ run: mockWorkflowRun }),
  clearWorkflowCache: () => {},
}));

mock.module('../../src/core/utils.js', () => ({
  validateWorkflowName: () => {},
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import { runCommand } from '../../src/cli.ts';

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../src/core/workflow-loader.js', () => realWorkflowLoader);
  mock.module('../../src/core/utils.js', () => realUtils);
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

    mockWorkflowRun.mockReset();
    mockWorkflowRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up any SIGINT listeners left on the process
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);

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

    it('does not call any workflow module when workflowName guard fires', async () => {
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

      try {
        await runCommand(options);
      } catch {
        // expected
      }

      // mockWorkflowRun should never be called because guard throws before loadWorkflow
      expect(mockWorkflowRun).not.toHaveBeenCalled();
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

    it('does not call workflow.run when taskPrompt guard fires', async () => {
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

      expect(mockWorkflowRun).not.toHaveBeenCalled();
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

  // ─── verbose flag pass-through (non-TUI path) ────────────────────────────

  describe('verbose flag pass-through (non-TUI)', () => {
    it('passes verbose:true to workflow.run when options.verbose is true', async () => {
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: 'some task',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: true,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      await runCommand(options);

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.verbose).toBe(true);
    });

    it('passes verbose:false to workflow.run when options.verbose is false (non-TUI)', async () => {
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: 'some task',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      await runCommand(options);

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.verbose).toBe(false);
    });

    it('passes onStatus with verbose callbacks when options.verbose is true', async () => {
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: 'some task',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: true,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      await runCommand(options);

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.onStatus).toBeDefined();
      // createStatusCallbacks(true) returns verbose callbacks with turn/tool methods
      const status = runOpts.onStatus as Record<string, unknown>;
      expect(typeof status.onTurnStart).toBe('function');
      expect(typeof status.onTurnEnd).toBe('function');
      expect(typeof status.onToolCallStart).toBe('function');
      expect(typeof status.onToolCallEnd).toBe('function');
    });

    it('passes onStatus with non-verbose callbacks when options.verbose is false', async () => {
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: 'some task',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: false,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      await runCommand(options);

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.onStatus).toBeDefined();
      // createStatusCallbacks(false) returns non-verbose callbacks without turn/tool methods
      const status = runOpts.onStatus as Record<string, unknown>;
      expect(status.onTurnStart).toBeUndefined();
      expect(status.onTurnEnd).toBeUndefined();
      expect(status.onToolCallStart).toBeUndefined();
      expect(status.onToolCallEnd).toBeUndefined();
    });
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  describe('when both workflowName and taskPrompt are provided', () => {
    it('proceeds to execute the workflow', async () => {
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: 'some task',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: true,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      mockWorkflowRun.mockResolvedValue(undefined);
      await runCommand(options);

      expect(mockWorkflowRun).toHaveBeenCalledTimes(1);
      expect(mockWorkflowRun.mock.calls[0][0]).toBe('some task');
    });

    it('passes correct runtime options to workflow.run', async () => {
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: 'some task',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: true,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      await runCommand(options);

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.cwd).toBe(options.cwd);
      expect(runOpts.maxConcurrentTasks).toBe(3);
      expect(runOpts.apiKeys).toBeUndefined();
      expect(runOpts.verbose).toBe(true);
      expect(runOpts.signal).toBeDefined();
      expect(runOpts.worktree).toBeUndefined();
    });

    it('passes apiKeys when provided', async () => {
      const apiKeys = { anthropic: 'sk-test' };
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: 'some task',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: true,
        worktree: false,
        apiKeys,
        warnings: [],
      };

      await runCommand(options);

      const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
      expect(runOpts.apiKeys).toEqual(apiKeys);
    });

    it('cleans up SIGINT handler after completion', async () => {
      const options = {
        command: 'run' as const,
        workflowName: 'test-workflow',
        taskPrompt: 'some task',
        cwd: '/tmp',
        maxConcurrent: 3,
        verbose: true,
        worktree: false,
        apiKeys: {},
        warnings: [],
      };

      await runCommand(options);

      expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    });
  });
});
