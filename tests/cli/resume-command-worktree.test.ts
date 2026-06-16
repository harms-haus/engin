import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── Capture real modules before mocking ────────────────────────────────────

const realWorkflowLoader = Object.assign({}, await import('../../packages/engine/src/core/workflow-loader.js'));
const realUtils = Object.assign({}, await import('../../packages/engine/src/core/utils.js'));
const realConfig = Object.assign({}, await import('../../packages/engine/src/core/config.js'));
const realPostWorktree = Object.assign({}, await import('../../packages/cli/src/cli/post-worktree.js'));

// ─── Mock functions ─────────────────────────────────────────────────────────

const mockWorkflowRun = mock<(taskPrompt: string, options: Record<string, unknown>) => Promise<void>>();

const mockPromptPostWorktreeAction = mock<(options: Record<string, unknown>) => Promise<void>>();

// composeStatusCallbacks spy — used to verify the EventStore callbacks are
// composed into the non-TUI status path. Returns the last element so the
// existing verbose/non-verbose structural assertions stay meaningful.
const mockComposeStatusCallbacks = mock<(callbacks: unknown[]) => unknown>();
mockComposeStatusCallbacks.mockImplementation((callbacks: unknown[]) => callbacks[callbacks.length - 1]);

const mockResolveProfilesDirs = mock<(cwd: string, workflowName?: string) => string[]>();

// ─── Mock modules (hoisted before imports by Bun test runtime) ──────────────

mock.module('../../packages/engine/src/core/workflow-loader.js', () => ({
  loadWorkflow: () => Promise.resolve({ run: mockWorkflowRun }),
  clearWorkflowCache: () => {},
}));

mock.module('../../packages/engine/src/core/utils.js', () => ({
  validateWorkflowName: () => {},
  composeStatusCallbacks: mockComposeStatusCallbacks,
}));

mock.module('../../packages/engine/src/core/config.js', () => ({
  ...realConfig,
  getDefaultWorkDir: realConfig.getDefaultWorkDir,
  getGlobalConfigDir: realConfig.getGlobalConfigDir,
  loadEnvFiles: realConfig.loadEnvFiles,
  resolveProfilesDirs: mockResolveProfilesDirs,
}));

mock.module('../../packages/cli/src/cli/post-worktree.js', () => ({
  promptPostWorktreeAction: mockPromptPostWorktreeAction,
}));

// ─── Import SUT after mocks ─────────────────────────────────────────────────

import { resumeCommand } from '../../packages/cli/src/cli.ts';

// ─── Restore original modules ───────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/engine/src/core/workflow-loader.js', () => realWorkflowLoader);
  mock.module('../../packages/engine/src/core/utils.js', () => realUtils);
  mock.module('../../packages/engine/src/core/config.js', () => realConfig);
  mock.module('../../packages/cli/src/cli/post-worktree.js', () => realPostWorktree);
});

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Create a past run directory with a state file under `.engin/work/<dirName>/`.
 */
function createPastRunDir(
  tempDir: string,
  dirName: string,
  state: { taskPrompt: string; worktree?: { worktreePath: string; branchName: string; originalCwd: string } },
) {
  const runDir = join(tempDir, '.engin', 'work', dirName);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, '.engin-state.json'), JSON.stringify(state));
}

/**
 * Build CliOptions for the resume command.
 */
function makeResumeOptions(overrides: {
  cwd: string;
  sessionName: string;
  apiKeys?: Record<string, string>;
  verbose?: boolean;
}) {
  return {
    command: 'resume' as const,
    sessionName: overrides.sessionName,
    cwd: overrides.cwd,
    maxConcurrent: 3,
    verbose: overrides.verbose ?? true, // default true ensures shouldUseTui() returns false → console.log is emitted
    apiKeys: overrides.apiKeys ?? {},
    warnings: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// resumeCommand — verbose flag pass-through (non-TUI path)
// ═══════════════════════════════════════════════════════════════════════════════

describe('resumeCommand — verbose flag pass-through (non-TUI)', () => {
  const { getDir } = useTempDir();

  let logSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    onSpy = spyOn(process, 'on');
    removeListenerSpy = spyOn(process, 'removeListener');

    mockWorkflowRun.mockReset();
    mockPromptPostWorktreeAction.mockReset();
    mockResolveProfilesDirs.mockReset();

    mockWorkflowRun.mockResolvedValue(undefined);
    mockPromptPostWorktreeAction.mockResolvedValue(undefined);
    mockResolveProfilesDirs.mockImplementation((_cwd: string, _workflowName?: string) => [
      '/local/profiles',
      '/global/profiles',
    ]);
  });

  afterEach(() => {
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);

    logSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it('passes verbose:true to workflow.run when options.verbose is true', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, { taskPrompt: 'resumed test prompt' });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName, verbose: true });
    await resumeCommand(options);

    const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOpts.verbose).toBe(true);
  });

  it('passes verbose:false to workflow.run when options.verbose is false', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, { taskPrompt: 'resumed test prompt' });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName, verbose: false });
    await resumeCommand(options);

    const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOpts.verbose).toBe(false);
  });

  it('passes onStatus with verbose callbacks when options.verbose is true', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, { taskPrompt: 'resumed test prompt' });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName, verbose: true });
    await resumeCommand(options);

    const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOpts.onStatus).toBeDefined();
    const status = runOpts.onStatus as Record<string, unknown>;
    expect(typeof status.onTurnStart).toBe('function');
    expect(typeof status.onTurnEnd).toBe('function');
    expect(typeof status.onToolCallStart).toBe('function');
    expect(typeof status.onToolCallEnd).toBe('function');
  });

  it('passes onStatus with non-verbose callbacks when options.verbose is false', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, { taskPrompt: 'resumed test prompt' });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName, verbose: false });
    await resumeCommand(options);

    const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOpts.onStatus).toBeDefined();
    const status = runOpts.onStatus as Record<string, unknown>;
    expect(status.onTurnStart).toBeUndefined();
    expect(status.onTurnEnd).toBeUndefined();
    expect(status.onToolCallStart).toBeUndefined();
    expect(status.onToolCallEnd).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// resumeCommand — non-worktree resume (worktreeInfo is undefined)
// ═══════════════════════════════════════════════════════════════════════════════

describe('resumeCommand — non-worktree resume', () => {
  const { getDir } = useTempDir();

  let logSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    onSpy = spyOn(process, 'on');
    removeListenerSpy = spyOn(process, 'removeListener');

    mockWorkflowRun.mockReset();
    mockPromptPostWorktreeAction.mockReset();
    mockResolveProfilesDirs.mockReset();

    mockWorkflowRun.mockResolvedValue(undefined);
    mockPromptPostWorktreeAction.mockResolvedValue(undefined);
    mockResolveProfilesDirs.mockImplementation((_cwd: string, _workflowName?: string) => [
      '/local/profiles',
      '/global/profiles',
    ]);
  });

  afterEach(() => {
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);

    logSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it('resumes a non-worktree run successfully', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, { taskPrompt: 'resumed test prompt' });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    expect(mockWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('does not pass worktree to workflow.run when state has no worktree', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, { taskPrompt: 'resumed test prompt' });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOpts.worktree).toBeUndefined();
  });

  it('passes options.cwd as cwd to workflow.run for non-worktree resume', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, { taskPrompt: 'resumed test prompt' });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOpts.cwd).toBe(options.cwd);
  });

  it('does not call promptPostWorktreeAction for non-worktree resume', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, { taskPrompt: 'resumed test prompt' });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    expect(mockPromptPostWorktreeAction).not.toHaveBeenCalled();
  });

  it('does not call resolveProfilesDirs for non-worktree resume', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, { taskPrompt: 'resumed test prompt' });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    expect(mockResolveProfilesDirs).not.toHaveBeenCalled();
  });

  it('passes the task prompt from the state file to workflow.run', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, { taskPrompt: 'my original task' });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    expect(mockWorkflowRun.mock.calls[0][0]).toBe('my original task');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// resumeCommand — worktree resume (worktreeInfo is present in state)
// ═══════════════════════════════════════════════════════════════════════════════

describe('resumeCommand — worktree resume', () => {
  const { getDir } = useTempDir();

  const mockWorktreeInfo = {
    worktreePath: '/tmp/worktree-path',
    branchName: 'engin/test-workflow-abc123',
    originalCwd: '/tmp/original-cwd',
  };

  let logSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    onSpy = spyOn(process, 'on');
    removeListenerSpy = spyOn(process, 'removeListener');

    mockWorkflowRun.mockReset();
    mockPromptPostWorktreeAction.mockReset();
    mockResolveProfilesDirs.mockReset();

    mockWorkflowRun.mockResolvedValue(undefined);
    mockPromptPostWorktreeAction.mockResolvedValue(undefined);
    mockResolveProfilesDirs.mockImplementation((_cwd: string, _workflowName?: string) => [
      '/local/profiles',
      '/global/profiles',
    ]);
  });

  afterEach(() => {
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);

    logSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  // ─── State file parsing ────────────────────────────────────────────────

  it('reads worktree info from the state file', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    // Should have called workflow.run, which proves parsing succeeded
    expect(mockWorkflowRun).toHaveBeenCalledTimes(1);
  });

  // ─── cwd override ──────────────────────────────────────────────────────

  it('overrides cwd to worktreePath when worktree info is present', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOpts.cwd).toBe(mockWorktreeInfo.worktreePath);
    expect(runOpts.cwd).not.toBe(options.cwd);
  });

  // ─── Logging ──────────────────────────────────────────────────────────

  it('logs resuming in worktree message with branch name', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Resuming in worktree');
    expect(logCalls).toContain(mockWorktreeInfo.branchName);
  });

  // ─── worktree info passed to workflow.run ─────────────────────────────

  it('passes worktree info to workflow.run', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOpts.worktree).toEqual(mockWorktreeInfo);
  });

  // ─── promptPostWorktreeAction ─────────────────────────────────────────

  it('calls promptPostWorktreeAction after workflow.run completes', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    expect(mockPromptPostWorktreeAction).toHaveBeenCalledTimes(1);
  });

  it('passes correct options to promptPostWorktreeAction', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    const promptOpts = mockPromptPostWorktreeAction.mock.calls[0][0] as Record<string, unknown>;

    expect(promptOpts.profilesDirs).toEqual(['/local/profiles', '/global/profiles']);
    expect(promptOpts.repoRoot).toBe(mockWorktreeInfo.originalCwd);
    expect(promptOpts.worktreePath).toBe(mockWorktreeInfo.worktreePath);
    expect(promptOpts.branchName).toBe(mockWorktreeInfo.branchName);
    expect(promptOpts.originalCwd).toBe(mockWorktreeInfo.originalCwd);
    expect(promptOpts.taskPrompt).toBe('resumed worktree task');
  });

  it('passes apiKeys to promptPostWorktreeAction when available', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const apiKeys = { anthropic: 'sk-xxx' };
    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName, apiKeys });
    await resumeCommand(options);

    const promptOpts = mockPromptPostWorktreeAction.mock.calls[0][0] as Record<string, unknown>;
    expect(promptOpts.apiKeys).toEqual(apiKeys);
  });

  it('does not pass apiKeys to promptPostWorktreeAction when empty', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName, apiKeys: {} });
    await resumeCommand(options);

    const promptOpts = mockPromptPostWorktreeAction.mock.calls[0][0] as Record<string, unknown>;
    expect(promptOpts.apiKeys).toBeUndefined();
  });

  // ─── resolveProfilesDirs ──────────────────────────────────────────────

  it('calls resolveProfilesDirs with originalCwd and workflowName for post-worktree prompt', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    expect(mockResolveProfilesDirs).toHaveBeenCalledWith(mockWorktreeInfo.originalCwd, 'my-workflow');
  });

  // ─── Error handling ──────────────────────────────────────────────────

  it('does not call promptPostWorktreeAction when workflow.run throws', async () => {
    mockWorkflowRun.mockRejectedValue(new Error('workflow failed'));

    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await expect(resumeCommand(options)).rejects.toThrow('workflow failed');

    expect(mockPromptPostWorktreeAction).not.toHaveBeenCalled();
  });

  it('still cleans up SIGINT handler when workflow.run throws with worktree', async () => {
    mockWorkflowRun.mockRejectedValue(new Error('workflow failed'));

    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    try {
      await resumeCommand(options);
    } catch {
      // expected
    }

    expect(removeListenerSpy).toHaveBeenCalled();
  });

  // ─── Task prompt propagation ──────────────────────────────────────────

  it('passes the task prompt from the state file to workflow.run for worktree resume', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'my worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName });
    await resumeCommand(options);

    expect(mockWorkflowRun.mock.calls[0][0]).toBe('my worktree task');
  });

  // ─── Other workflow.run options ───────────────────────────────────────

  it('passes apiKeys to workflow.run when available for worktree resume', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const apiKeys = { anthropic: 'sk-test' };
    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName, apiKeys });
    await resumeCommand(options);

    const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOpts.apiKeys).toEqual(apiKeys);
  });

  it('does not pass apiKeys to workflow.run when empty for worktree resume', async () => {
    const ts = Date.now();
    const dirName = `${ts}-my-workflow`;
    createPastRunDir(getDir(), dirName, {
      taskPrompt: 'resumed worktree task',
      worktree: mockWorktreeInfo,
    });

    const options = makeResumeOptions({ cwd: getDir(), sessionName: dirName, apiKeys: {} });
    await resumeCommand(options);

    const runOpts = mockWorkflowRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOpts.apiKeys).toBeUndefined();
  });
});
