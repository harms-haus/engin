import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Capture real module before mocking ──────────────────────────────────────

const realServer = Object.assign({}, await import('../../src/web/server.js'));

// ─── Mock startWebServer to return a fake server ────────────────────────────

const mockServerStop = mock<(force?: boolean) => void>();

mock.module('../../src/web/server.js', () => ({
  startWebServer: () =>
    Promise.resolve({
      stop: mockServerStop,
      hostname: '127.0.0.1',
      port: 3619,
    }),
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

import { webCommand } from '../../src/cli.ts';

// ─── Restore original module ─────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../src/web/server.js', () => realServer);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWebOptions() {
  return {
    command: 'web' as const,
    cwd: '/tmp',
    maxConcurrent: 5,
    verbose: false,
    apiKeys: {},
    warnings: [],
    host: '127.0.0.1',
    port: 3619,
  };
}

/**
 * Starts webCommand and waits one tick so the SIGINT handler is registered.
 * Returns the captured handler registered via process.on('SIGINT', ...).
 *
 * After the fix, webCommand resolves immediately after registering the handler
 * (it no longer hangs waiting for SIGINT). We still use setTimeout(0) to ensure
 * the handler is captured from the spy before tests inspect it.
 */
async function startWebCommand(onSpy: ReturnType<typeof spyOn>): Promise<{
  handler: () => void;
}> {
  // webCommand awaits the dynamic import and registers SIGINT handler, then returns.
  // We intentionally don't await so we can capture the handler from the spy synchronously.
  void webCommand(makeWebOptions());
  // Give the event-loop a tick: dynamic import resolves → SIGINT handler is registered
  await new Promise((r) => setTimeout(r, 0));

  const sigintCall = onSpy.mock.calls.find((call) => call[0] === 'SIGINT');
  const handler = sigintCall?.[1] as (() => void) | undefined;

  return {
    handler: handler!,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGINT handler tests for webCommand
//
// These tests verify that webCommand uses setupSigintHandler (like runCommand
// and resumeCommand) instead of an anonymous process.on('SIGINT', ...) handler.
//
// Expected behavior after fix:
//   - First SIGINT: logs graceful message, aborts controller, schedules 5s timer
//   - Second SIGINT: logs force quit, calls process.exit(1)
//   - 5s timer callback: logs timeout, calls process.exit(1)
//
// Current (buggy) behavior:
//   - First SIGINT: logs "Shutting down web server...", calls server.stop(true),
//     calls process.exit(0) — no two-press pattern, no cleanup
// ═══════════════════════════════════════════════════════════════════════════════

describe('SIGINT handler (webCommand)', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let onSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockServerStop.mockClear();
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
    const { handler } = await startWebCommand(onSpy);

    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('uses setupSigintHandler (handler.name is "handler", not anonymous)', async () => {
    const { handler } = await startWebCommand(onSpy);

    // setupSigintHandler returns `const handler = () => { ... }` which gets
    // the inferred name "handler". An anonymous inline closure has name "".
    expect(handler.name).toBe('handler');
  });

  // ─── First SIGINT ────────────────────────────────────────────────────────

  it('first SIGINT does NOT call process.exit(0) immediately', async () => {
    const { handler } = await startWebCommand(onSpy);

    // The old buggy code calls process.exit(0) on first SIGINT.
    // The fixed code should NOT exit on first SIGINT.
    handler();

    // process.exit should NOT have been called on first SIGINT
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('first SIGINT logs the consistent "Interrupt received" message', async () => {
    const { handler } = await startWebCommand(onSpy);

    handler();

    const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Interrupt received');
    expect(logCalls).toContain('stopping workflow gracefully');
    expect(logCalls).toContain('Ctrl+C again to force quit');
  });

  it('first SIGINT does NOT log the old "Shutting down web server" message', async () => {
    const { handler } = await startWebCommand(onSpy);

    handler();

    const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // After the fix, the old anonymous handler message should be gone
    expect(logCalls).not.toContain('Shutting down web server');
  });

  it('first SIGINT schedules a 5-second force-exit safety timer', async () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    const { handler } = await startWebCommand(onSpy);

    handler();

    const timerCall = setTimeoutSpy.mock.calls.find((call) => call[1] === 5000);
    expect(timerCall).toBeDefined();
    expect(typeof timerCall![0]).toBe('function');

    // Clear the actual real timer so it doesn't fire after the test
    const timerCallIdx = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 5000);
    const timerResult = setTimeoutSpy.mock.results[timerCallIdx];
    if (timerResult?.type === 'return') {
      clearTimeout(timerResult.value as ReturnType<typeof setTimeout>);
    }

    setTimeoutSpy.mockRestore();
  });

  // ─── Second SIGINT ───────────────────────────────────────────────────────

  it('second SIGINT calls process.exit(1)', async () => {
    const { handler } = await startWebCommand(onSpy);

    handler(); // first

    expect(() => handler()).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('second SIGINT logs "Force quit" message', async () => {
    const { handler } = await startWebCommand(onSpy);

    handler(); // first
    logSpy.mockClear();

    try {
      handler(); // second
    } catch {
      /* expected – process.exit mock throws */
    }

    const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Force quit');
  });

  it('second SIGINT clears the force-exit timer via clearTimeout', async () => {
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

    const { handler } = await startWebCommand(onSpy);

    handler(); // first

    try {
      handler(); // second
    } catch {
      /* expected */
    }

    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });

  // ─── Force-exit timer callback ───────────────────────────────────────────

  it('force-exit timer callback calls process.exit(1) and logs timeout message', async () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    const { handler } = await startWebCommand(onSpy);

    handler(); // first SIGINT → schedules timer

    // Find the 5000ms setTimeout call
    const timerCallIdx = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 5000);
    expect(timerCallIdx).toBeGreaterThanOrEqual(0);

    const timerCallback = setTimeoutSpy.mock.calls[timerCallIdx][0] as () => void;
    const timerResult = setTimeoutSpy.mock.results[timerCallIdx];

    // Cancel the real timer
    if (timerResult?.type === 'return') {
      clearTimeout(timerResult.value as ReturnType<typeof setTimeout>);
    }

    setTimeoutSpy.mockRestore();

    // Invoke the captured callback directly
    logSpy.mockClear();
    exitSpy.mockClear();
    try {
      timerCallback();
    } catch {
      /* expected – process.exit mock throws */
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Graceful shutdown timed out');
  });

  // ─── Consistency with runCommand / resumeCommand ───────────────────────

  it('uses identical two-press SIGINT pattern as runCommand and resumeCommand', async () => {
    const { handler } = await startWebCommand(onSpy);

    // First SIGINT: graceful message + timer (NO exit)
    handler();
    expect(exitSpy).not.toHaveBeenCalled();
    let logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Interrupt received, stopping workflow gracefully');
    expect(logCalls).toContain('Ctrl+C again to force quit');

    // Second SIGINT: force exit(1) + force quit message
    logSpy.mockClear();
    exitSpy.mockClear();
    try {
      handler();
    } catch {
      /* expected */
    }
    logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logCalls).toContain('Force quit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ─── No server.stop call on first SIGINT ──────────────────────────────

  it('does not call server.stop on first SIGINT (handled by process exit)', async () => {
    const { handler } = await startWebCommand(onSpy);

    handler();

    // The old code called server.stop(true) + process.exit(0) on first SIGINT.
    // The fixed code uses setupSigintHandler which does NOT call server.stop.
    expect(mockServerStop).not.toHaveBeenCalled();
  });

  // ─── No cleanup (unlike runCommand/resumeCommand) ──────────────────────

  it('does not call process.removeListener after first SIGINT', async () => {
    const { handler } = await startWebCommand(onSpy);

    handler(); // first SIGINT

    // webCommand does not have a finally-cleanup block like runCommand/resumeCommand.
    // The handler persists for the process lifetime so the second SIGINT can be caught.
    expect(removeListenerSpy).not.toHaveBeenCalledWith('SIGINT', handler);
  });

  it('does not call process.removeListener even after second SIGINT', async () => {
    const { handler } = await startWebCommand(onSpy);

    handler(); // first
    try {
      handler(); // second → process.exit(1)
    } catch {
      /* expected */
    }

    // No cleanup is performed — the handler stays registered until process.exit kills the process.
    expect(removeListenerSpy).not.toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  // ─── Handler registration count ──────────────────────────────────────

  it('registers exactly one SIGINT handler (not multiple)', async () => {
    await startWebCommand(onSpy);

    const sigintCalls = onSpy.mock.calls.filter((call) => call[0] === 'SIGINT');
    expect(sigintCalls.length).toBe(1);
  });

  // ─── webCommand resolves after registering the handler ─────────────────

  it('webCommand resolves after registering the handler (does not hang)', async () => {
    // After the fix, webCommand registers setupSigintHandler and returns.
    // It should NOT hang indefinitely.
    const result = await webCommand(makeWebOptions());
    expect(result).toBeUndefined();
  });
});
