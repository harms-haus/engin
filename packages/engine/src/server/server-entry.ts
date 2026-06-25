#!/usr/bin/env bun
// ─── engine server daemon entrypoint ───────────────────────────────────────
//
// Invoked by `startDaemon` (see daemon.ts) as a detached process. This module
// is the in-daemon process: it parses its port/host from argv, starts the
// starts the control server (HTTP control + WebSocket multi-run protocol + static
// frontend serving) with a RunManager that owns concurrent workflow runs,
// writes its own pidfile, installs SIGTERM/SIGINT handlers for graceful
// shutdown, and keeps the process alive.

import { startControlServer } from './control-server.js';
import { removeStalePidfile, writePidfile } from './daemon.js';
import { RunManager } from './run-manager.js';

// ─── argv parsing ───────────────────────────────────────────────────────────

interface EntrypointOptions {
  port: number;
  host: string;
}

/**
 * Parses `--port <n>` and `--host <addr>` from `process.argv`.
 *
 * Defaults: `port = 3619`, `host = '127.0.0.1'`. Exits with a usage message
 * and non-zero status on an invalid `--port`.
 */
function parseEntrypointArgs(argv: string[]): EntrypointOptions {
  let port = 3619;
  let host = '127.0.0.1';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = argv[i + 1];
      const parsed = value !== undefined ? Number(value) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        process.stderr.write(`server-entry: invalid --port ${JSON.stringify(value)}\n`);
        process.exit(2);
      }
      port = parsed;
      i++;
    } else if (arg === '--host') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        process.stderr.write(`server-entry: --host requires a value\n`);
        process.exit(2);
      }
      host = value;
      i++;
    }
  }

  return { port, host };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { port, host } = parseEntrypointArgs(process.argv.slice(2));

  // Write the pidfile so the CLI/stopDaemon can find us. This OVERWRITES any
  // pidfile written by startDaemon (with the same pid), which is fine — the
  // daemon re-asserts ownership on startup.
  await writePidfile(process.pid, port);

  // ── RunManager + Control Server ─────────────────────────────────────────
  // The RunManager owns the lifecycle of concurrent workflow runs. The
  // onRunsChanged callback is wired to the control server's broadcast so
  // that all connected WS clients receive the updated active-run list
  // whenever a run starts, completes, fails, or is reaped.
  let broadcastRuns: () => void = () => {
    /* placeholder until the control server wires the real broadcast below */
  };
  const runManager = new RunManager(() => broadcastRuns());

  const controlServer = await startControlServer({
    host,
    port,
    runManager,
    // On graceful shutdown (SIGTERM/SIGINT): cooperatively cancel every active
    // run, flush its store, and dispose its bridge BEFORE the socket closes.
    onShutdown: () => runManager.shutdownAll(),
  });

  // Wire the runs-changed callback to the control server's broadcast so
  // connected clients are notified whenever the active-run set changes.
  broadcastRuns = () => {
    controlServer.broadcast({ type: 'runs', runs: runManager.listRuns() });
  };

  // The Bun.serve handle keeps the event loop alive on its own; this keepalive
  // interval is a belt-and-braces guard so a future refactor that stops the
  // server mid-shutdown cannot accidentally exit before the SIGTERM handler
  // runs. It is unref'd so it never blocks exit on its own.
  const keepalive = setInterval(() => undefined, 60_000);
  keepalive.unref();

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepalive);
    process.stderr.write(`server-entry: received ${signal}, shutting down\n`);
    // Stop the control server — its onShutdown hook cancels active runs,
    // flushes stores, and disposes bridges BEFORE closing the socket.
    try {
      await controlServer.stop();
    } catch {
      // Best effort — already stopped.
    }
    // Remove our own pidfile on graceful exit.
    await removeStalePidfile();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.stderr.write(`server-entry: listening on ${controlServer.url} (pid ${process.pid})\n`);
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`server-entry: fatal: ${msg}\n`);
    process.exit(1);
  });
}
