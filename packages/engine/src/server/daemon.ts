// ─── daemon lifecycle ──────────────────────────────────────────────────────
//
// Daemon lifecycle primitives that the engine server relies on for process
// coordination. See server-refactor.prompt.md §8 "Daemon lifecycle".
//
// Two layers live here:
//
//   1. Fast, deterministic units used by every caller (CLI `server up/down`,
//      `engin run` auto-start): path getters, the pidfile read/write/stale
//      primitives, the `isPidAlive` liveness check, and the `/health` probe.
//   2. `startDaemon` / `stopDaemon`, which spawn a detached daemon process
//      and exercise real signals. These are exercised by integration tests.

import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getGlobalConfigDir } from '../core/config.js';
import { isEnoentError } from '../core/utils.js';
import { isWildcardHost } from './bind-guard.js';

// ─── Path getters ───────────────────────────────────────────────────────────

/**
 * Returns the canonical pidfile path: `<globalConfigDir>/server.pid`.
 *
 * Re-reads `XDG_CONFIG_HOME` on every call so the path tracks the env var
 * (the CLI and tests redirect the global config dir via `XDG_CONFIG_HOME`).
 */
export function getServerPidfilePath(): string {
  return join(getGlobalConfigDir(), 'server.pid');
}

/**
 * Returns the canonical server log path: `<globalConfigDir>/logs/server.log`.
 */
export function getServerLogPath(): string {
  return join(getGlobalConfigDir(), 'logs', 'server.log');
}

/**
 * Returns the canonical capability-token path: `<globalConfigDir>/server.token`.
 */
export function getServerTokenPath(): string {
  return join(getGlobalConfigDir(), 'server.token');
}

// ─── PID liveness ───────────────────────────────────────────────────────────

/**
 * Returns `true` when a process with the given `pid` currently exists.
 *
 * Implemented with `process.kill(pid, 0)` (signal 0 = liveness check, no
 * actual signal delivered):
 *   - success          ⇒ `true`  (the process exists and we may signal it)
 *   - `ESRCH`          ⇒ `false` (no such process — the pid is dead/reused)
 *   - `EPERM`          ⇒ `true`  (the process exists but we lack permission
 *                                 to signal it; it is still alive)
 *   - any other error  ⇒ `false`
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      const code = (err as { code: string }).code;
      if (code === 'EPERM') {
        // Process exists; we just can't signal it.
        return true;
      }
    }
    // ESRCH (no such process) or any other failure ⇒ not alive.
    return false;
  }
}

// ─── Pidfile read/write ─────────────────────────────────────────────────────

/** Shape persisted in the pidfile (and nothing else). */
export interface PidfileEntry {
  pid: number;
  port: number;
}

/**
 * Reads and validates the pidfile.
 *
 * @returns `{ pid, port }` for a well-formed pidfile, or `null` when the
 * pidfile is absent, empty, malformed (non-JSON), or missing either the
 * `pid` or `port` field. Extra fields are ignored.
 */
export async function readPidfile(): Promise<PidfileEntry | null> {
  let content: string;
  try {
    content = await readFile(getServerPidfilePath(), 'utf-8');
  } catch (err: unknown) {
    if (isEnoentError(err)) {
      return null;
    }
    // Unexpected read error — treat as unreadable.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Empty file or non-JSON contents.
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).pid !== 'number' ||
    typeof (parsed as Record<string, unknown>).port !== 'number'
  ) {
    return null;
  }

  const obj = parsed as { pid: number; port: number };
  return { pid: obj.pid, port: obj.port };
}

/**
 * Atomically writes the pidfile with `{ pid, port }`.
 *
 * "Atomic" means: the bytes are written to a sibling temp file first, then
 * `rename`d over the final path. A crash mid-write therefore leaves either
 * the old pidfile or no pidfile — never a truncated one. The parent config
 * directory is created (`mkdir -p`) if necessary.
 */
export async function writePidfile(pid: number, port: number): Promise<void> {
  const pidfilePath = getServerPidfilePath();
  const parentDir = dirname(pidfilePath);
  await mkdir(parentDir, { recursive: true });

  const content = JSON.stringify({ pid, port });
  const tmpPath = `${pidfilePath}.tmp`;

  // Write to temp, fsync-equivalent (writeFile flushes), then atomic rename.
  await writeFile(tmpPath, content);
  await rename(tmpPath, pidfilePath);
}

/**
 * Removes the pidfile when its recorded PID is no longer alive.
 *
 * @returns `true` if a stale pidfile was found and removed; `false` if there
 * was no pidfile, the pidfile was unreadable, or the recorded PID is still
 * alive (in which case the pidfile is left untouched). Never throws on a
 * malformed pidfile.
 */
export async function removeStalePidfile(): Promise<boolean> {
  const entry = await readPidfile();
  if (entry === null) {
    // No pidfile, or unreadable/malformed (no live PID to check).
    return false;
  }
  if (isPidAlive(entry.pid)) {
    return false;
  }
  // PID is dead — remove the stale pidfile.
  try {
    await unlink(getServerPidfilePath());
  } catch (err: unknown) {
    if (isEnoentError(err)) {
      return false;
    }
    throw err;
  }
  return true;
}

// ─── /health probe ──────────────────────────────────────────────────────────

/** Timeout for a single `/health` probe (ms). */
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

/**
 * Probes the server's readiness endpoint at `http://127.0.0.1:<port>/health`.
 *
 * Resolves `true` iff the response status is `200`; resolves `false` on any
 * non-200 status, on connection refusal (nothing listening), and on a 2-second
 * timeout (so a hung server does not block the caller indefinitely).
 */
export async function isServerAlive(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    return response.status === 200;
  } catch {
    // Connection refused, abort due to timeout, DNS failure, etc.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ─── startDaemon / stopDaemon ───────────────────────────────────────────────

/** Options accepted by {@link startDaemon}. */
export interface StartDaemonOptions {
  /** TCP port the daemon should listen on. */
  port: number;
  /** Bind host (default `127.0.0.1`). */
  host?: string;
}

/** The result of a successful {@link startDaemon}. */
export interface StartDaemonResult {
  pid: number;
  port: number;
}

/** Polling interval (ms) for the `/health` readiness probe after spawn. */
const STARTUP_PROBE_INTERVAL_MS = 500;

/** Total budget (ms) for the `/health` readiness probe after spawn. */
const STARTUP_PROBE_BUDGET_MS = 10_000;

/** How long `stopDaemon` waits (ms) for a SIGTERM'd process to exit. */
const SHUTDOWN_GRACE_MS = 10_000;

/** Polling interval (ms) for the post-SIGTERM exit wait. */
const SHUTDOWN_POLL_INTERVAL_MS = 100;

/** Returns the absolute path to the daemon entrypoint source file. */
function getDaemonEntrypointPath(): string {
  // daemon.ts and server-entry.ts are siblings in src/server/.
  return join(import.meta.dir, 'server-entry.js');
}

/** Sleep helper that resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawns the engine server as a detached daemon process and waits for it to
 * become ready.
 *
 * Steps:
 *   1. If the server is already alive on `port`, this is a no-op: returns the
 *      pid/port from the existing pidfile (or `{ port }` without a pid if the
 *      pidfile is missing).
 *   2. Remove a stale pidfile (recorded PID dead) so a fresh start is clean.
 *   3. Spawn the daemon entrypoint with `Bun.spawn({ detached: true })`,
 *      redirecting stdout+stderr to the log file. The child is `unref()`'d so
 *      it survives the parent CLI exiting.
 *   4. Atomically write `{ pid, port }` to the pidfile.
 *   5. Probe `/health` every 500ms for up to 10s. Resolve once it returns 200.
 *
 * @throws if the server fails to become ready within the startup budget.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<StartDaemonResult> {
  const port = options.port;

  // (0) Security gate: refuse wildcard hosts before any bind attempt.
  // This is the single chokepoint that covers EVERY caller (CLI `server up`,
  // `engin run` auto-start, `engin resume` auto-start). Wildcard hosts bind
  // to all network interfaces, which requires authentication that is not yet
  // implemented. The CLI `serverUpCommand` also keeps a redundant fast-fail.
  if (isWildcardHost(options.host)) {
    throw new Error(
      `Refusing to bind wildcard host '${options.host}': LAN binding requires authentication, which is not yet implemented. Use a specific interface (e.g. 127.0.0.1).`,
    );
  }

  // (1) Idempotent: if a server is already responding on the port, no-op.
  if (await isServerAlive(port)) {
    const existing = await readPidfile();
    return { pid: existing?.pid ?? 0, port };
  }

  // (2) Clear any stale pidfile so we don't confuse it with the new daemon.
  await removeStalePidfile();

  // (3) Spawn the daemon, detached, with stdio redirected to the log file.
  const logPath = getServerLogPath();
  await mkdir(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');

  const entrypoint = getDaemonEntrypointPath();
  const host = options.host ?? '127.0.0.1';
  const child = Bun.spawn({
    cmd: [process.execPath, entrypoint, '--port', String(port), '--host', host],
    stdio: ['ignore', logFd, logFd],
    detached: true,
    env: process.env,
  });
  closeSync(logFd);

  // Allow the parent process to exit independently of the child.
  child.unref();

  const pid = child.pid;

  // (4) Write the pidfile atomically.
  await writePidfile(pid, port);

  // (5) Probe /health with retries up to the startup budget.
  const deadline = Date.now() + STARTUP_PROBE_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await isServerAlive(port)) {
      return { pid, port };
    }
    await sleep(STARTUP_PROBE_INTERVAL_MS);
  }

  throw new Error(
    `Server failed to become ready within ${STARTUP_PROBE_BUDGET_MS / 1000}s on port ${port}. Check logs: ${logPath}`,
  );
}

/**
 * Stops the engine server daemon: reads the pidfile, sends `SIGTERM`, waits
 * up to 10s for the process to exit, removes the pidfile, and escalates to
 * `SIGKILL` if the process is still alive after the grace period.
 *
 * @throws if no pidfile exists (there is nothing to stop).
 */
export async function stopDaemon(): Promise<void> {
  const entry = await readPidfile();
  if (entry === null) {
    throw new Error('No server pidfile found. Is the server running?');
  }

  const { pid } = entry;

  // Already dead — just clean up the stale pidfile.
  if (!isPidAlive(pid)) {
    await removeStalePidfile();
    return;
  }

  // Send SIGTERM for graceful shutdown.
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: unknown) {
    // If the process vanished between the liveness check and the signal,
    // treat it as stopped.
    if (!isPidAlive(pid)) {
      await removeStalePidfile();
      return;
    }
    throw err;
  }

  // Wait for exit, polling isPidAlive.
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      break;
    }
    await sleep(SHUTDOWN_POLL_INTERVAL_MS);
  }

  // Escalate to SIGKILL if still alive.
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Best effort — the process may have exited between checks.
    }
  }

  // Remove the pidfile regardless (the daemon should have done this on graceful
  // shutdown; this is the fallback for a crashed/killed daemon).
  await removeStalePidfile();
}
