import {
  getServerLogPath,
  getServerPidfilePath,
  isServerAlive,
  readPidfile,
  startDaemon,
  stopDaemon,
  WILDCARD_HOSTS,
} from '@harms-haus/engin-engine';

import { formatTime } from '../console-status.js';
import type { CliOptions } from '../parse-args.js';
import { promptYesNo } from '../prompt.js';
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from '../server-defaults.js';

/**
 * Starts the engine server daemon.
 *
 * Calls `startDaemon({ port, host })` with sensible defaults (port 3619,
 * host 127.0.0.1). Refuses LAN bindings (`--lan` or `--host 0.0.0.0`) since
 * authentication is not yet supported — these bind to all interfaces and
 * would expose the server to the network without auth. Prints the server URL
 * on success.
 */
export async function serverUpCommand(options: CliOptions): Promise<void> {
  // Hard gate against wildcard/LAN bindings without authentication. --lan and
  // any wildcard host all bind to all network interfaces, which requires
  // authentication that is not yet supported. Refuse with a non-zero exit code
  // and a clear message — printed once to stderr (NOT also thrown), so
  // main().catch does not duplicate it.
  if (options.lan || (options.host !== undefined && WILDCARD_HOSTS.has(options.host))) {
    const message =
      'LAN binding (0.0.0.0 / --lan) requires authentication, which is not yet supported. The server is limited to localhost (127.0.0.1) bindings until auth is available.';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
    return;
  }

  const port = options.port ?? DEFAULT_SERVER_PORT;
  const host = options.host ?? DEFAULT_SERVER_HOST;

  const result = await startDaemon({ port, host });
  console.log(`Server running at http://${host}:${result.port} (pid ${result.pid})`);
}

/**
 * Stops the engine server daemon.
 *
 * If `--force` is not set and the server is alive with active runs, prompts
 * the user for confirmation. With `--force`, the prompt is skipped.
 */
export async function serverDownCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? DEFAULT_SERVER_PORT;

  if (!options.force) {
    const alive = await isServerAlive(port);
    if (alive) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/health`);
        if (resp.ok) {
          const health = (await resp.json()) as { activeRuns?: number };
          if (health.activeRuns && health.activeRuns > 0) {
            const confirmed = await promptYesNo(
              `${health.activeRuns} active run(s) in progress. Stop the server anyway?`,
              false,
            );
            if (!confirmed) {
              console.log('Server not stopped.');
              return;
            }
          }
        }
      } catch {
        // Health endpoint unreachable — proceed with shutdown.
      }
    }
  }

  await stopDaemon();
  console.log('Server stopped.');
}

/**
 * Shape of the daemon's `/health` JSON response.
 *
 * Defined loosely (all-optional) so a partial payload still type-checks
 * when {@link serverStatusCommand} reads it defensively.
 */
interface HealthResponse {
  pid?: number;
  port?: number;
  activeRuns?: number;
}

/**
 * Fetches `/health` from the running daemon and parses its JSON body.
 *
 * Tolerant of every failure mode: a network error, a non-200 status, or a
 * body that is not valid JSON all resolve to `undefined` so the caller can
 * still report "running" with the details it already knows.
 */
async function fetchHealth(host: string, port: number): Promise<HealthResponse | undefined> {
  try {
    const response = await fetch(`http://${host}:${port}/health`);
    if (!response.ok) return undefined;
    return (await response.json()) as HealthResponse;
  } catch {
    return undefined;
  }
}

/**
 * Shows the engine server status.
 *
 * Probes the daemon via {@link isServerAlive}. When it is up, fetches
 * `/health` for runtime details and prints a multi-line report. Tolerant of
 * `/health` being unreachable or non-JSON — it still reports "running" with
 * whatever it knows plus a note. When down, notes a stale pidfile if one is
 * present (never crashes on a missing/unreadable pidfile).
 */
export async function serverStatusCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const logPath = getServerLogPath();

  const alive = await isServerAlive(port);
  if (!alive) {
    console.log(`${formatTime()} 🔴 Server is not running.`);
    // Best-effort stale-pidfile notice. readPidfile() never throws — it
    // resolves `null` when the pidfile is absent, empty, or malformed.
    const pidfile = await readPidfile();
    if (pidfile) {
      console.log(
        `${formatTime()}    ⚠️ A pidfile exists at ${getServerPidfilePath()} (pid ${pidfile.pid}) — it may be stale.`,
      );
    }
    return;
  }

  const health = await fetchHealth(host, port);

  console.log(`${formatTime()} 🟢 Server is running`);
  console.log(`${formatTime()}    PID:          ${health?.pid ?? 'unknown'}`);
  console.log(`${formatTime()}    Port:         ${port}`);
  console.log(`${formatTime()}    Host:         ${host}`);
  console.log(`${formatTime()}    Active runs:  ${health?.activeRuns ?? 'unknown'}`);
  console.log(`${formatTime()}    Log:          ${logPath}`);
  console.log(`${formatTime()}    Web URL:      http://${host}:${port}/`);
  if (!health) {
    console.log(`${formatTime()}    ⚠️ Health endpoint unavailable; some details are unknown.`);
  }
}
