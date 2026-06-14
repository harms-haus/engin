import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDir } from '../helpers/use-temp-dir.js';

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

import { resumeCommand, runCommand } from '../../src/cli.ts';

// ─── Restore original modules ────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../src/core/workflow-loader.js', () => realWorkflowLoader);
  mock.module('../../src/core/utils.js', () => realUtils);
});

// ─── Shared helpers ──────────────────────────────────────────────────────────

function makeRunOptions() {
  return {
    command: 'run' as const,
    workflowName: 'test-workflow',
    taskPrompt: 'test prompt',
    cwd: '/tmp',
    maxConcurrent: 3,
    verbose: true, // ensures shouldUseTui() returns false → console.log is emitted
    apiKeys: {},
    warnings: [],
  };
}

function createPastRunDir(tempDir: string, dirName: string) {
  const runDir = join(tempDir, '.engin', 'work', dirName);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, '.engin-state.json'), JSON.stringify({ taskPrompt: 'resumed test prompt' }));
}

/**
 * Poll until the SIGINT handler is registered on the `process.on` spy.
 *
 * The async chain runCommand/resumeCommand → loadWorkflow → setupSigintHandler
 * → process.on('SIGINT', …) may take more than a single event-loop tick under
 * load or in CI, so a fixed `setTimeout(0)` wait is flaky. Polling (with a
 * timeout) makes handler capture deterministic.
 */
async function waitForSigintHandler(
  onSpy: ReturnType<typeof spyOn>,
  timeoutMs = 2000,
): Promise<(() => void) | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sigintCall = onSpy.mock.calls.find((call) => call[0] === 'SIGINT');
    if (sigintCall) return sigintCall[1] as (() => void) | undefined;
    await new Promise((r) => setTimeout(r, 0));
  }
  return onSpy.mock.calls.find((call) => call[0] === 'SIGINT')?.[1] as (() => void) | undefined;
}

/**
 * Starts runCommand and waits for the SIGINT handler to be registered.
 * Returns the inner promise, captured handler, resolve function, and signal.
 */
async function startRunCommand(
  onSpy: ReturnType<typeof spyOn>,
  mockFn: typeof mockWorkflowRun,
): Promise<{
  runPromise: Promise<void>;
  handler: () => void;
  resolveRun: () => void;
  signal: AbortSignal | undefined;
}> {
  let resolveRun: (() => void) | undefined;
  let capturedSignal: AbortSignal | undefined;

  mockFn.mockImplementation((_taskPrompt: string, opts: Record<string, unknown>) => {
    capturedSignal = opts?.signal as AbortSignal | undefined;
    return new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
  });

  const promise = runCommand(makeRunOptions());
  const handler = await waitForSigintHandler(onSpy);

  return {
    runPromise: promise,
    handler: handler!,
    resolveRun: resolveRun!,
    signal: capturedSignal,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGINT handler tests through runCommand
// ═══════════════════════════════════════════════════════════════════════════════

describe('SIGINT handler (runCommand)', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    onSpy = spyOn(process, 'on');
    removeListenerSpy = spyOn(process, 'removeListener');
  });

  afterEach(() => {
    // Clean up any SIGINT listeners left on the process
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);

    exitSpy.mockRestore();
    logSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  // ─── Registration ────────────────────────────────────────────────────────

  it('registers a SIGINT handler via process.on', async () => {
    const { runPromise, handler, resolveRun } = await startRunCommand(onSpy, mockWorkflowRun);

    expect(handler).toBeDefined();
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    resolveRun();
    await runPromise;
  });

  // ─── First SIGINT ────────────────────────────────────────────────────────

  it('first SIGINT aborts the AbortController signal', async () => {
    const { runPromise, handler, resolveRun, signal } = await startRunCommand(onSpy, mockWorkflowRun);

    handler();

    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);

    resolveRun();
    await runPromise;
  });

  it('first SIGINT logs graceful shutdown message', async () => {
    const { runPromise, handler, resolveRun } = await startRunCommand(onSpy, mockWorkflowRun);

    handler();

    const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Interrupt received');
    expect(logCalls).toContain('stopping workflow gracefully');
    expect(logCalls).toContain('Ctrl+C again to force quit');

    resolveRun();
    await runPromise;
  });

  it('first SIGINT schedules a 5-second force-exit safety timer', async () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    const { runPromise, handler, resolveRun } = await startRunCommand(onSpy, mockWorkflowRun);

    handler();

    const timerCall = setTimeoutSpy.mock.calls.find((call) => call[1] === 5000);
    expect(timerCall).toBeDefined();
    expect(typeof timerCall![0]).toBe('function'); // callback

    // Clear the actual real timer so it doesn't fire after the test
    const timerCallIdx = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 5000);
    const timerResult = setTimeoutSpy.mock.results[timerCallIdx];
    if (timerResult?.type === 'return') {
      clearTimeout(timerResult.value as ReturnType<typeof setTimeout>);
    }

    setTimeoutSpy.mockRestore();
    resolveRun();
    await runPromise;
  });

  // ─── Second SIGINT ───────────────────────────────────────────────────────

  it('second SIGINT calls process.exit(1)', async () => {
    const { runPromise, handler, resolveRun } = await startRunCommand(onSpy, mockWorkflowRun);

    handler(); // first

    expect(() => handler()).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);

    resolveRun();
    await runPromise.catch(() => {});
  });

  it('second SIGINT logs force quit message', async () => {
    const { runPromise, handler, resolveRun } = await startRunCommand(onSpy, mockWorkflowRun);

    handler(); // first
    logSpy.mockClear();

    try {
      handler(); // second
    } catch {
      /* expected – process.exit mock throws */
    }

    const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Force quit');

    resolveRun();
    await runPromise.catch(() => {});
  });

  it('second SIGINT clears the force-exit timer via clearTimeout', async () => {
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

    const { runPromise, handler, resolveRun } = await startRunCommand(onSpy, mockWorkflowRun);

    handler(); // first

    try {
      handler(); // second
    } catch {
      /* expected */
    }

    // The second SIGINT handler should clear the force-exit timer
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
    resolveRun();
    await runPromise.catch(() => {});
  });

  // ─── Force-exit timer callback ───────────────────────────────────────────

  it('force-exit timer callback calls process.exit(1) and logs timeout message', async () => {
    // Use spyOn (which calls through) to capture the timer callback + id
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    const { runPromise, handler, resolveRun } = await startRunCommand(onSpy, mockWorkflowRun);

    handler(); // first SIGINT → schedules timer via real setTimeout

    // Find the 5000ms setTimeout call
    const timerCallIdx = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 5000);
    expect(timerCallIdx).toBeGreaterThanOrEqual(0);

    const timerCallback = setTimeoutSpy.mock.calls[timerCallIdx][0] as () => void;
    const timerResult = setTimeoutSpy.mock.results[timerCallIdx];

    // Cancel the real timer so it doesn't fire after the test
    if (timerResult?.type === 'return') {
      clearTimeout(timerResult.value as ReturnType<typeof setTimeout>);
    }

    setTimeoutSpy.mockRestore();

    // Invoke the captured callback directly to test its behavior
    logSpy.mockClear();
    try {
      timerCallback();
    } catch {
      /* expected – process.exit mock throws */
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Graceful shutdown timed out');

    resolveRun();
    await runPromise.catch(() => {});
  });

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  it('cleanup removes SIGINT handler after workflow completes normally', async () => {
    const { runPromise, handler, resolveRun } = await startRunCommand(onSpy, mockWorkflowRun);

    resolveRun();
    await runPromise;

    expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', handler);
  });

  it('cleanup clears force-exit timer when workflow completes after first SIGINT', async () => {
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

    const { runPromise, handler, resolveRun } = await startRunCommand(onSpy, mockWorkflowRun);

    handler(); // first SIGINT → sets force-exit timer
    resolveRun(); // complete the workflow → triggers finally { cleanup }
    await runPromise;

    // The finally block should clear the force-exit timer
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIGINT handler tests through resumeCommand
// ═══════════════════════════════════════════════════════════════════════════════

describe('SIGINT handler (resumeCommand)', () => {
  const { getDir } = useTempDir();

  let exitSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    onSpy = spyOn(process, 'on');
    removeListenerSpy = spyOn(process, 'removeListener');
  });

  afterEach(() => {
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);

    exitSpy.mockRestore();
    logSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  async function startResumeCommand(sessionName: string) {
    let resolveRun: (() => void) | undefined;
    let capturedSignal: AbortSignal | undefined;

    mockWorkflowRun.mockImplementation((_taskPrompt: string, opts: Record<string, unknown>) => {
      capturedSignal = opts?.signal as AbortSignal | undefined;
      return new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
    });

    const options = {
      command: 'resume' as const,
      sessionName,
      cwd: getDir(),
      maxConcurrent: 3,
      verbose: true,
      apiKeys: {},
      warnings: [],
    };

    const promise = resumeCommand(options);
    const handler = await waitForSigintHandler(onSpy);

    return {
      runPromise: promise,
      handler: handler!,
      resolveRun: resolveRun!,
      signal: capturedSignal,
    };
  }

  // ─── Registration ────────────────────────────────────────────────────────

  it('registers a SIGINT handler', async () => {
    const ts = Date.now();
    createPastRunDir(getDir(), `${ts}-my-workflow`);

    const { runPromise, handler, resolveRun } = await startResumeCommand(`${ts}-my-workflow`);

    expect(handler).toBeDefined();
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    resolveRun();
    await runPromise;
  });

  // ─── First SIGINT ────────────────────────────────────────────────────────

  it('first SIGINT aborts the AbortController signal', async () => {
    const ts = Date.now();
    createPastRunDir(getDir(), `${ts}-my-workflow`);

    const { runPromise, handler, resolveRun, signal } = await startResumeCommand(`${ts}-my-workflow`);

    handler();

    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);

    resolveRun();
    await runPromise;
  });

  it('first SIGINT logs graceful shutdown message', async () => {
    const ts = Date.now();
    createPastRunDir(getDir(), `${ts}-my-workflow`);

    const { runPromise, handler, resolveRun } = await startResumeCommand(`${ts}-my-workflow`);

    handler();

    const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Interrupt received');
    expect(logCalls).toContain('stopping workflow gracefully');

    resolveRun();
    await runPromise;
  });

  // ─── Second SIGINT ───────────────────────────────────────────────────────

  it('second SIGINT calls process.exit(1)', async () => {
    const ts = Date.now();
    createPastRunDir(getDir(), `${ts}-my-workflow`);

    const { runPromise, handler, resolveRun } = await startResumeCommand(`${ts}-my-workflow`);

    handler(); // first

    expect(() => handler()).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);

    resolveRun();
    await runPromise.catch(() => {});
  });

  it('second SIGINT logs force quit message', async () => {
    const ts = Date.now();
    createPastRunDir(getDir(), `${ts}-my-workflow`);

    const { runPromise, handler, resolveRun } = await startResumeCommand(`${ts}-my-workflow`);

    handler(); // first
    logSpy.mockClear();

    try {
      handler(); // second
    } catch {
      /* expected */
    }

    const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Force quit');

    resolveRun();
    await runPromise.catch(() => {});
  });

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  it('cleanup removes SIGINT handler after workflow completes normally', async () => {
    const ts = Date.now();
    createPastRunDir(getDir(), `${ts}-my-workflow`);

    const { runPromise, handler, resolveRun } = await startResumeCommand(`${ts}-my-workflow`);

    resolveRun();
    await runPromise;

    expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', handler);
  });

  // ─── Consistency with runCommand ─────────────────────────────────────────

  it('uses identical SIGINT handler behavior as runCommand', async () => {
    const ts = Date.now();
    createPastRunDir(getDir(), `${ts}-my-workflow`);

    const { runPromise, handler, resolveRun, signal } = await startResumeCommand(`${ts}-my-workflow`);

    // Verify handler was registered
    expect(handler).toBeDefined();

    // First SIGINT: abort + message + timer
    handler();
    expect(signal?.aborted).toBe(true);
    const afterFirst = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(afterFirst).toContain('Interrupt received');
    expect(afterFirst).toContain('Ctrl+C again to force quit');

    // Second SIGINT: force exit + message
    logSpy.mockClear();
    try {
      handler();
    } catch {
      /* expected */
    }
    const afterSecond = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(afterSecond).toContain('Force quit');
    expect(exitSpy).toHaveBeenCalledWith(1);

    resolveRun();
    await runPromise.catch(() => {});
  });
});
