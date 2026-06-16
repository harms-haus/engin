// ─── daemon lifecycle — test-first specification ─────────────────────────────
//
// Test-first specification for `src/server/daemon.ts`, the daemon lifecycle
// primitives that the engine server relies on for process coordination.
//
// Contract under test (see server-refactor.prompt.md §8 "Daemon lifecycle"):
//
//   getServerPidfilePath()   → <globalConfigDir>/server.pid
//   getServerLogPath()       → <globalConfigDir>/logs/server.log
//   getServerTokenPath()     → <globalConfigDir>/server.token
//   isPidAlive(pid)          → process.kill(pid, 0) liveness check;
//                              ESRCH (no such process) ⇒ false,
//                              EPERM (exists, permission denied) ⇒ true.
//   readPidfile()            → { pid, port } | null  (null = absent/invalid)
//   writePidfile(pid, port)  → atomic temp-then-rename; mkdir -p parent
//   removeStalePidfile()     → removes the pidfile when its PID is dead;
//                              returns true if it removed a stale file
//   isServerAlive(port)      → GET http://127.0.0.1:port/health with a 2s
//                              timeout; resolves true iff the response is 200
//
// `startDaemon`/`stopDaemon` spawn real detached processes and exercise
// signals; they are covered by separate integration tests. This file targets
// the deterministic, fast units: the pidfile read/write/stale-detect
// primitives, the isPidAlive liveness check, the path getters, and the
// /health probe.
//
// The global config dir is redirected into a per-test temp dir via
// XDG_CONFIG_HOME (mirrors tests/core/config.test.ts).

import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  getServerLogPath,
  getServerPidfilePath,
  getServerTokenPath,
  isPidAlive,
  isServerAlive,
  readPidfile,
  removeStalePidfile,
  writePidfile,
} from '../../packages/engine/src/server/daemon.js';
import { useEnvSandbox } from '../helpers/env-sandbox.js';
import { useTempDir } from '../helpers/use-temp-dir.js';

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Spawns a short-lived child and returns its pid AFTER it has exited, so the
 * pid is guaranteed (to a very high probability) to be dead within the test
 * window. Used to exercise the "dead pid" branches of isPidAlive and stale
 * detection without depending on a specific unused pid.
 */
async function spawnDeadPid(): Promise<number> {
  const proc = Bun.spawn(['sleep', '0.1']);
  const pid = proc.pid;
  await proc.exited;
  return pid;
}

/**
 * Starts a Bun HTTP server on an ephemeral port and returns the server handle
 * plus the OS-assigned port. The caller MUST stop the server (typically in a
 * `finally` block) so the port is released for subsequent tests.
 */
function startHealthServer(fetch: (req: Request) => Response | Promise<Response>): {
  server: ReturnType<typeof Bun.serve>;
  port: number;
} {
  const server = Bun.serve({ port: 0, fetch });
  const port = server.port;
  // We always bind a TCP port (0 = OS-assigned ephemeral), so the port is
  // defined at runtime; bun-types types it as `number | undefined` to also
  // cover Unix sockets. Throw to keep the test's port type narrow.
  if (port === undefined) throw new Error('test health server did not bind a port');
  return { server, port };
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('daemon lifecycle', () => {
  const { getDir } = useTempDir();
  useEnvSandbox();

  /** Points the global config dir at <temp>/xdg/engin and returns the xdg root. */
  function useTempXdg(): string {
    const xdg = join(getDir(), 'xdg');
    process.env.XDG_CONFIG_HOME = xdg;
    return xdg;
  }

  // ─── path getters ────────────────────────────────────────────────────────

  describe('path getters', () => {
    it('getServerPidfilePath returns <globalConfigDir>/server.pid', () => {
      const xdg = useTempXdg();
      expect(getServerPidfilePath()).toBe(join(xdg, 'engin', 'server.pid'));
    });

    it('getServerLogPath returns <globalConfigDir>/logs/server.log', () => {
      const xdg = useTempXdg();
      expect(getServerLogPath()).toBe(join(xdg, 'engin', 'logs', 'server.log'));
    });

    it('getServerTokenPath returns <globalConfigDir>/server.token', () => {
      const xdg = useTempXdg();
      expect(getServerTokenPath()).toBe(join(xdg, 'engin', 'server.token'));
    });

    it('paths follow XDG_CONFIG_HOME when it changes', () => {
      const first = useTempXdg();
      expect(getServerPidfilePath()).toBe(join(first, 'engin', 'server.pid'));

      const second = join(getDir(), 'other-xdg');
      process.env.XDG_CONFIG_HOME = second;
      expect(getServerPidfilePath()).toBe(join(second, 'engin', 'server.pid'));
      expect(getServerLogPath()).toBe(join(second, 'engin', 'logs', 'server.log'));
      expect(getServerTokenPath()).toBe(join(second, 'engin', 'server.token'));
    });
  });

  // ─── isPidAlive ──────────────────────────────────────────────────────────

  describe('isPidAlive', () => {
    it('returns true for the current process', () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it('returns true for a live child process', async () => {
      const proc = Bun.spawn(['sleep', '5']);
      try {
        expect(isPidAlive(proc.pid)).toBe(true);
      } finally {
        proc.kill();
        await proc.exited;
      }
    });

    it('returns false for a pid whose process has exited', async () => {
      const deadPid = await spawnDeadPid();
      expect(isPidAlive(deadPid)).toBe(false);
    });

    it('returns false for a pid that was never running (large unused pid)', () => {
      // A pid in the millions is effectively guaranteed not to exist on a
      // normal system; process.kill raises ESRCH, which the liveness check
      // treats as "not alive".
      expect(isPidAlive(4_000_003)).toBe(false);
    });

    it('treats a pid that exists but cannot be signalled (EPERM) as alive', () => {
      // pid 1 (init / launchd / systemd) always exists. A non-root caller gets
      // EPERM from process.kill(1, 0); a CORRECT liveness check must interpret
      // EPERM as "alive" (the process exists, we merely lack permission). As
      // root the call succeeds → also alive. Either way this is true.
      expect(isPidAlive(1)).toBe(true);
    });
  });

  // ─── readPidfile ─────────────────────────────────────────────────────────

  describe('readPidfile', () => {
    beforeEach(() => {
      useTempXdg();
    });

    /** Pre-create <xdg>/engin and write raw bytes to the pidfile path. */
    async function writeRawPidfile(contents: string): Promise<void> {
      await mkdir(join(getDir(), 'xdg', 'engin'), { recursive: true });
      await writeFile(getServerPidfilePath(), contents);
    }

    it('returns null when no pidfile exists', async () => {
      expect(await readPidfile()).toBeNull();
    });

    it('returns { pid, port } for a valid pidfile', async () => {
      await writeRawPidfile(JSON.stringify({ pid: 12345, port: 3619 }));
      expect(await readPidfile()).toEqual({ pid: 12345, port: 3619 });
    });

    it('returns only pid and port, ignoring any extra fields', async () => {
      await writeRawPidfile(JSON.stringify({ pid: 7, port: 9999, extra: 'ignored', host: '127.0.0.1' }));
      expect(await readPidfile()).toEqual({ pid: 7, port: 9999 });
    });

    it('returns null when the pid field is missing', async () => {
      await writeRawPidfile(JSON.stringify({ port: 3619 }));
      expect(await readPidfile()).toBeNull();
    });

    it('returns null when the port field is missing', async () => {
      await writeRawPidfile(JSON.stringify({ pid: 12345 }));
      expect(await readPidfile()).toBeNull();
    });

    it('returns null for malformed (non-JSON) pidfile contents', async () => {
      await writeRawPidfile('not-json{');
      expect(await readPidfile()).toBeNull();
    });

    it('returns null for an empty pidfile', async () => {
      await writeRawPidfile('');
      expect(await readPidfile()).toBeNull();
    });

    // ─── type-coercion / non-object edge cases ─────────────────────────────
    // The validator must reject any pid/port that is not strictly a number,
    // and any JSON value that is not a plain object. These guard against a
    // hand-edited or partially-corrupted pidfile being mistaken for a live
    // server (e.g. a stringified pid `"12345"`).

    it('returns null when pid is a string instead of a number', async () => {
      await writeRawPidfile(JSON.stringify({ pid: '12345', port: 3619 }));
      expect(await readPidfile()).toBeNull();
    });

    it('returns null when port is a string instead of a number', async () => {
      await writeRawPidfile(JSON.stringify({ pid: 12345, port: '3619' }));
      expect(await readPidfile()).toBeNull();
    });

    it('returns null when port is a boolean (non-number truthy value)', async () => {
      await writeRawPidfile(JSON.stringify({ pid: 12345, port: true }));
      expect(await readPidfile()).toBeNull();
    });

    it('returns null when the JSON value is an array', async () => {
      await writeRawPidfile(JSON.stringify([12345, 3619]));
      expect(await readPidfile()).toBeNull();
    });

    it('returns null when the JSON value is a bare number', async () => {
      await writeRawPidfile(JSON.stringify(12345));
      expect(await readPidfile()).toBeNull();
    });

    it('returns null when the JSON value is a bare string', async () => {
      await writeRawPidfile(JSON.stringify('hello'));
      expect(await readPidfile()).toBeNull();
    });

    it('returns null when the JSON value is a boolean', async () => {
      await writeRawPidfile(JSON.stringify(true));
      expect(await readPidfile()).toBeNull();
    });

    it('returns null when the JSON value is JSON null', async () => {
      await writeRawPidfile(JSON.stringify(null));
      expect(await readPidfile()).toBeNull();
    });
  });

  // ─── writePidfile ────────────────────────────────────────────────────────

  describe('writePidfile', () => {
    beforeEach(() => {
      useTempXdg();
    });

    it('writes a pidfile that readPidfile reads back (round trip)', async () => {
      await writePidfile(6789, 3619);
      expect(await readPidfile()).toEqual({ pid: 6789, port: 3619 });
    });

    it('writes valid JSON with pid and port to the canonical path', async () => {
      await writePidfile(42, 7000);
      const raw = await readFile(getServerPidfilePath(), 'utf-8');
      expect(JSON.parse(raw)).toEqual({ pid: 42, port: 7000 });
    });

    it('creates the parent config dir if it does not exist', async () => {
      // <xdg>/engin does not exist yet.
      expect(existsSync(join(getDir(), 'xdg', 'engin'))).toBe(false);
      await writePidfile(100, 1);
      expect(existsSync(getServerPidfilePath())).toBe(true);
    });

    it('overwrites an existing pidfile', async () => {
      await writePidfile(1, 10);
      await writePidfile(2, 20);
      expect(await readPidfile()).toEqual({ pid: 2, port: 20 });
    });

    it('does not leave a temporary file behind (atomic temp + rename)', async () => {
      await writePidfile(3, 30);
      // After a successful atomic write (temp file → rename), the global
      // config dir should contain exactly the pidfile — no stale .tmp.
      const entries = await readdir(join(getDir(), 'xdg', 'engin'));
      expect(entries).toEqual(['server.pid']);
    });
  });

  // ─── stale pidfile detection ─────────────────────────────────────────────

  describe('stale pidfile detection', () => {
    beforeEach(() => {
      useTempXdg();
    });

    it('returns false when no pidfile exists', async () => {
      expect(await removeStalePidfile()).toBe(false);
      expect(await readPidfile()).toBeNull();
    });

    it('removes a pidfile whose PID is dead and returns true', async () => {
      const deadPid = await spawnDeadPid();
      await writePidfile(deadPid, 3619);

      expect(await removeStalePidfile()).toBe(true);
      expect(await readPidfile()).toBeNull();
      expect(existsSync(getServerPidfilePath())).toBe(false);
    });

    it('does NOT remove a pidfile whose PID is alive', async () => {
      // The current process is, by definition, alive.
      await writePidfile(process.pid, 3619);

      expect(await removeStalePidfile()).toBe(false);
      expect(await readPidfile()).toEqual({ pid: process.pid, port: 3619 });
      expect(existsSync(getServerPidfilePath())).toBe(true);
    });

    it('does not throw on a malformed pidfile and leaves no live server recorded', async () => {
      await mkdir(join(getDir(), 'xdg', 'engin'), { recursive: true });
      await writeFile(getServerPidfilePath(), 'garbage');

      // A corrupt pidfile must not crash stale detection.
      await expect(removeStalePidfile()).resolves.toBeDefined();
      // No live PID is represented, so the pidfile must not be mistaken for a
      // running server afterwards.
      expect(await readPidfile()).toBeNull();
    });
  });

  // ─── isServerAlive ───────────────────────────────────────────────────────

  describe('isServerAlive', () => {
    it('returns true when /health responds 200', async () => {
      const { server, port } = startHealthServer(() => new Response('ok', { status: 200 }));
      try {
        expect(await isServerAlive(port)).toBe(true);
      } finally {
        server.stop(true);
      }
    });

    it('returns true when /health responds 200 with a JSON body (real server shape)', async () => {
      // Mirrors the actual response produced by server-entry.ts: a JSON object
      // with a body, served at status 200. The probe must key purely off the
      // status code and ignore the body.
      const { server, port } = startHealthServer(() =>
        Response.json({ pid: 123, port: 3619, status: 'ok' }, { status: 200 }),
      );
      try {
        expect(await isServerAlive(port)).toBe(true);
      } finally {
        server.stop(true);
      }
    });

    it('returns false when /health responds 500', async () => {
      const { server, port } = startHealthServer(() => new Response('err', { status: 500 }));
      try {
        expect(await isServerAlive(port)).toBe(false);
      } finally {
        server.stop(true);
      }
    });

    it('returns false when /health responds 404 (endpoint missing)', async () => {
      const { server, port } = startHealthServer(() => new Response('not found', { status: 404 }));
      try {
        expect(await isServerAlive(port)).toBe(false);
      } finally {
        server.stop(true);
      }
    });

    it('returns false when nothing is listening on the port', async () => {
      // Reserve then release an ephemeral port so the probe hits a closed socket.
      const { server, port } = startHealthServer(() => new Response('ok'));
      server.stop(true);
      expect(await isServerAlive(port)).toBe(false);
    });

    it('gives up within the 2-second timeout when /health hangs', async () => {
      // A handler that never resolves exercises the probe's timeout path.
      const { server, port } = startHealthServer(() => new Promise<Response>(() => {}));
      try {
        const start = Date.now();
        const result = await isServerAlive(port);
        const elapsed = Date.now() - start;
        expect(result).toBe(false);
        // The probe must abort around its 2s timeout, not hang indefinitely.
        expect(elapsed).toBeLessThan(5_000);
      } finally {
        server.stop(true);
      }
    });
  });
});
