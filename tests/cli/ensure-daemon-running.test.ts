// ─── ensureDaemonRunning — daemon probe + auto-start helper ────────────────
//
// Tests for the `ensureDaemonRunning(port, host)` helper extracted from the
// inline daemon-probe block in commands.ts's former `executeViaDaemon`.
//
// CONTRACT UNDER TEST:
//
//   export async function ensureDaemonRunning(port: number, host: string): Promise<void>
//
//   1. Probe `isServerAlive(port)`.
//   2. If alive → no-op (do NOT call startDaemon).
//   3. If down → call `startDaemon({ port, host })`, then probe again to
//      confirm readiness. If still down after start, warn (best-effort) but
//      do NOT throw — the run path is tolerant of a not-yet-ready server.
//
// This helper is imported from run-session-client.ts (the task allows it to
// live there OR in a small daemon-lifecycle.ts). If the implementer chooses
// daemon-lifecycle.ts, only the import path below needs adjusting.
//
// RED state: the export does not exist yet — these tests define the contract.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// ─── Capture real modules before mocking ──────────────────────────────────

const realConsoleStatus = Object.assign({}, await import('../../packages/cli/src/cli/console-status.js'));
const realDaemon = Object.assign({}, await import('../../packages/engine/src/server/daemon.js'));

// ─── Mock functions ──────────────────────────────────────────────────────

const mockIsServerAlive = mock<(port: number) => Promise<boolean>>();
const mockStartDaemon = mock<(opts: { port: number; host?: string }) => Promise<{ pid: number; port: number }>>();

// ─── Mock modules (hoisted before imports by Bun) ─────────────────────────

mock.module('../../packages/cli/src/cli/console-status.js', () => ({
  formatTime: () => '[00:00:00]',
  shouldUseTui: () => false,
}));

mock.module('../../packages/engine/src/server/daemon.js', () => ({
  ...realDaemon,
  isServerAlive: mockIsServerAlive,
  startDaemon: mockStartDaemon,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────

import { ensureDaemonRunning } from '../../packages/cli/src/cli/run-session-client.js';

// ─── Restore original modules ────────────────────────────────────────────

afterAll(() => {
  mock.module('../../packages/cli/src/cli/console-status.js', () => realConsoleStatus);
  mock.module('../../packages/engine/src/server/daemon.js', () => realDaemon);
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ensureDaemonRunning', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    mockIsServerAlive.mockReset();
    mockStartDaemon.mockReset();

    // Defaults
    mockIsServerAlive.mockResolvedValue(true);
    mockStartDaemon.mockResolvedValue({ pid: 12345, port: 3619 });
  });

  afterEach(() => {
    process.exitCode = 0;
    warnSpy.mockRestore();
  });

  // ─── Probe ────────────────────────────────────────────────────────────

  it('probes isServerAlive with the given port', async () => {
    await ensureDaemonRunning(3619, '127.0.0.1');

    expect(mockIsServerAlive).toHaveBeenCalledTimes(1);
    expect(mockIsServerAlive).toHaveBeenCalledWith(3619);
  });

  it('probes with a custom port', async () => {
    await ensureDaemonRunning(8080, '127.0.0.1');

    expect(mockIsServerAlive).toHaveBeenCalledWith(8080);
  });

  // ─── Already alive → no-op ────────────────────────────────────────────

  it('does NOT call startDaemon when the server is already alive', async () => {
    mockIsServerAlive.mockResolvedValue(true);

    await ensureDaemonRunning(3619, '127.0.0.1');

    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('probes exactly once when the server is already alive', async () => {
    mockIsServerAlive.mockResolvedValue(true);

    await ensureDaemonRunning(3619, '127.0.0.1');

    expect(mockIsServerAlive).toHaveBeenCalledTimes(1);
  });

  // ─── Down → auto-start ────────────────────────────────────────────────

  it('calls startDaemon when the server is down', async () => {
    mockIsServerAlive.mockResolvedValue(false);

    await ensureDaemonRunning(3619, '127.0.0.1');

    expect(mockStartDaemon).toHaveBeenCalledTimes(1);
  });

  it('passes port and host to startDaemon', async () => {
    mockIsServerAlive.mockResolvedValue(false);

    await ensureDaemonRunning(9090, '0.0.0.0');

    expect(mockStartDaemon).toHaveBeenCalledWith({ port: 9090, host: '0.0.0.0' });
  });

  it('passes the default localhost host when given 127.0.0.1', async () => {
    mockIsServerAlive.mockResolvedValue(false);

    await ensureDaemonRunning(3619, '127.0.0.1');

    expect(mockStartDaemon).toHaveBeenCalledWith({ port: 3619, host: '127.0.0.1' });
  });

  it('probes again after startDaemon to confirm readiness', async () => {
    mockIsServerAlive
      .mockResolvedValueOnce(false) // initial probe: down
      .mockResolvedValueOnce(true); // post-start probe: up

    await ensureDaemonRunning(3619, '127.0.0.1');

    expect(mockIsServerAlive).toHaveBeenCalledTimes(2);
    expect(mockStartDaemon).toHaveBeenCalledTimes(1);
  });

  // ─── Best-effort readiness ────────────────────────────────────────────

  it('warns when the server is still not alive after startDaemon', async () => {
    mockIsServerAlive.mockResolvedValue(false); // down before AND after

    await ensureDaemonRunning(3619, '127.0.0.1');

    expect(warnSpy).toHaveBeenCalled();
  });

  it('does NOT warn when the server becomes alive after startDaemon', async () => {
    mockIsServerAlive
      .mockResolvedValueOnce(false) // down
      .mockResolvedValueOnce(true); // up after start

    await ensureDaemonRunning(3619, '127.0.0.1');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT throw when the server fails to become ready', async () => {
    // The run path must tolerate a not-yet-ready server (attach mode, etc.).
    mockIsServerAlive.mockResolvedValue(false);

    await expect(ensureDaemonRunning(3619, '127.0.0.1')).resolves.toBeUndefined();
  });

  it('returns void (Promise<void>)', async () => {
    const result = await ensureDaemonRunning(3619, '127.0.0.1');
    expect(result).toBeUndefined();
  });
});
