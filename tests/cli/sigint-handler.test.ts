// ─── T30: Non-TTY SIGINT handler contract tests ────────────────────────────
//
// Tests for the new `setupNonTtySigintHandler(runId, engineClient)` API that
// replaces the old `setupSigintHandler(useTui)` model.
//
// CONTRACT UNDER TEST (T30):
//
//   setupNonTtySigintHandler(runId: string, engineClient: { send(msg): void })
//     → { dispose: () => void }
//
//   - Registers a process.on('SIGINT', handler).
//   - First SIGINT:
//       1. engineClient.send({ type: 'cancel_run', runId }) is called.
//       2. A cancelling/abort message is printed (console.log or console.error).
//   - Second SIGINT:
//       1. process.exit(1) is called.
//       2. A force-exit message is printed.
//   - NO 5-second force-exit timer (client does not own the run lifecycle).
//     After first SIGINT, the process is NOT auto-killed after 5s.
//   - dispose() removes the SIGINT listener; emitting SIGINT after dispose
//     does NOT call engineClient.send or process.exit.
//
// TTY mode (TUI attached) is NOT handled by this module — the TUI input
// handler (T31) manages Ctrl+C/Ctrl+D in that path. `setupSigintHandler`
// (the old function) is removed by T30.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Import the SUT (will NOT exist until the implement phase) ─────────────
//
// Because `setupNonTtySigintHandler` doesn't exist yet, this import will fail.
// That failure is the expected RED state for TDD — the test must compile
// (no syntax errors) but the import resolution must fail.

import { setupNonTtySigintHandler } from '../../packages/cli/src/cli/sigint.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: create a mock engineClient with a send spy
// ═══════════════════════════════════════════════════════════════════════════════

function createMockEngineClient() {
  return {
    send: mock<(msg: Record<string, unknown>) => void>(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('setupNonTtySigintHandler', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Clean up any SIGINT listeners left on the process
    const listeners = process.listeners('SIGINT');
    for (const l of listeners) process.removeListener('SIGINT', l as any);

    exitSpy.mockRestore();
    logSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // ─── Return value shape ─────────────────────────────────────────────────

  it('returns an object with a dispose function', () => {
    const client = createMockEngineClient();
    const result = setupNonTtySigintHandler('run-abc', client);

    expect(result).toBeDefined();
    expect(typeof result.dispose).toBe('function');
  });

  // ─── First SIGINT ──────────────────────────────────────────────────────

  it('first SIGINT sends cancel_run via engineClient.send', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    process.emit('SIGINT');

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send).toHaveBeenCalledWith({
      type: 'cancel_run',
      runId: 'run-abc',
    });

    dispose();
  });

  it('first SIGINT prints a cancellation message', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    process.emit('SIGINT');

    const allOutput = [
      ...logSpy.mock.calls.map((c) => String(c[0])),
      ...stderrSpy.mock.calls.map((c) => String(c[0])),
    ].join('\n');
    // Match any variant of "cancelling" / "cancel" / "aborting"
    expect(allOutput.toLowerCase()).toMatch(/cancel|abort/);

    dispose();
  });

  it('first SIGINT does NOT call process.exit', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    process.emit('SIGINT');

    expect(exitSpy).not.toHaveBeenCalled();

    dispose();
  });

  // ─── Second SIGINT ─────────────────────────────────────────────────────

  it('second SIGINT calls process.exit(1)', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    process.emit('SIGINT'); // first
    process.emit('SIGINT'); // second

    expect(exitSpy).toHaveBeenCalledWith(1);

    dispose();
  });

  it('second SIGINT prints a force-exit message', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    process.emit('SIGINT'); // first
    logSpy.mockClear();
    stderrSpy.mockClear();

    try {
      process.emit('SIGINT'); // second — triggers process.exit(1) which throws
    } catch {
      /* expected */
    }

    const allOutput = [
      ...logSpy.mock.calls.map((c) => String(c[0])),
      ...stderrSpy.mock.calls.map((c) => String(c[0])),
    ].join('\n');
    // Match any variant of "force quit" / "force exit" / "forcefully"
    expect(allOutput.toLowerCase()).toMatch(/force/);

    dispose();
  });

  it('second SIGINT does NOT send cancel_run again', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    process.emit('SIGINT'); // first → sends cancel_run
    client.send.mockClear();

    try {
      process.emit('SIGINT'); // second → process.exit(1)
    } catch {
      /* expected */
    }

    expect(client.send).not.toHaveBeenCalled();

    dispose();
  });

  // ─── No 5-second force-exit timer ──────────────────────────────────────

  it('does NOT schedule a force-exit timer after first SIGINT', () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    process.emit('SIGINT');

    // No setTimeout should have been called with 5000ms
    const fiveSecondTimer = setTimeoutSpy.mock.calls.find((call) => call[1] === 5000);
    expect(fiveSecondTimer).toBeUndefined();

    // No setTimeout at all should have been called by the handler
    // (except possibly by unrelated code — we check the count is zero)
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
    dispose();
  });

  it('process does NOT auto-exit after the old 5-second window', async () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    process.emit('SIGINT'); // first

    // Wait longer than the old 5-second timer window
    await new Promise((r) => setTimeout(r, 100));

    // process.exit should NOT have been called (no auto-exit)
    expect(exitSpy).not.toHaveBeenCalled();

    dispose();
  });

  // ─── dispose() ─────────────────────────────────────────────────────────

  it('dispose removes the SIGINT listener', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    // Verify listener is registered
    const beforeDispose = process.listeners('SIGINT').length;

    dispose();

    const afterDispose = process.listeners('SIGINT').length;
    expect(afterDispose).toBeLessThan(beforeDispose);
  });

  it('SIGINT after dispose does NOT call engineClient.send', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    dispose();

    process.emit('SIGINT');

    expect(client.send).not.toHaveBeenCalled();
  });

  it('SIGINT after dispose does NOT call process.exit', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('run-abc', client);

    dispose();

    process.emit('SIGINT');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ─── runId forwarding ──────────────────────────────────────────────────

  it('forwards the correct runId in cancel_run', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('unique-run-id-123', client);

    process.emit('SIGINT');

    expect(client.send).toHaveBeenCalledWith({
      type: 'cancel_run',
      runId: 'unique-run-id-123',
    });

    dispose();
  });

  it('forwards a different runId correctly', () => {
    const client = createMockEngineClient();
    const { dispose } = setupNonTtySigintHandler('another-run-xyz', client);

    process.emit('SIGINT');

    expect(client.send).toHaveBeenCalledWith({
      type: 'cancel_run',
      runId: 'another-run-xyz',
    });

    dispose();
  });

  // ─── Multiple independent instances ─────────────────────────────────────

  it('supports multiple independent handler instances without interference', () => {
    const client1 = createMockEngineClient();
    const client2 = createMockEngineClient();

    const { dispose: dispose1 } = setupNonTtySigintHandler('run-1', client1);
    const { dispose: dispose2 } = setupNonTtySigintHandler('run-2', client2);

    process.emit('SIGINT');

    // Both clients receive cancel_run (two listeners registered)
    expect(client1.send).toHaveBeenCalledWith({ type: 'cancel_run', runId: 'run-1' });
    expect(client2.send).toHaveBeenCalledWith({ type: 'cancel_run', runId: 'run-2' });

    dispose1();
    dispose2();
  });
});
