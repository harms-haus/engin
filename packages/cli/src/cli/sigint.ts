import type { ClientMessage } from '@engin/shared';

import { formatTime } from './console-status.js';

// ─── Non-TTY SIGINT Handler ─────────────────────────────────────────────────
//
// Registers a process-level SIGINT listener for the NON-TUI (stdout-renderer)
// CLI path. TTY/TUI mode handles Ctrl+C via the TUI's own input handler (T31),
// NOT through this module — the raw-mode stdin loop intercepts \x03 before it
// ever becomes a process signal.
//
// Contract (T30):
//   - First SIGINT: send { type: 'cancel_run', runId } via the engine client
//     and print a cancellation message. Do NOT exit — the run keeps running on
//     the server; the client simply stops once the terminal event arrives
//     (or the user interrupts a second time to force-quit).
//   - Second SIGINT: print a force-exit message and process.exit(1).
//   - NO 5-second force-exit timer. The client does not own the run lifecycle
//     (unlike the old setupSigintHandler), so there is no safety-net timer.
//   - dispose(): removes the SIGINT listener so further interrupts are inert.

/** Minimal send-capable client shape accepted by the handler. */
export interface SigintEngineClient {
  send(msg: ClientMessage): void;
}

/** Return value of {@link setupNonTtySigintHandler}. */
export interface NonTtySigintHandle {
  /** Remove the registered SIGINT listener. Idempotent. */
  dispose: () => void;
}

/**
 * Register a cooperative SIGINT handler for the non-TUI CLI path.
 *
 * @param runId       The run to cancel on the first interrupt.
 * @param engineClient A client whose `send` carries the `cancel_run` message.
 * @returns A handle whose `dispose()` removes the listener.
 */
export function setupNonTtySigintHandler(runId: string, engineClient: SigintEngineClient): NonTtySigintHandle {
  let sigintCount = 0;
  let disposed = false;

  const handler = () => {
    if (disposed) return;
    sigintCount++;
    if (sigintCount === 1) {
      // Cooperative cancellation: tell the daemon to stop the run. The
      // client stays alive until the terminal event (run_complete /
      // run_failed) arrives — OR the user force-quits with a second Ctrl+C.
      engineClient.send({ type: 'cancel_run', runId });
      console.log(`\n${formatTime()} ⏹️  Interrupt received, cancelling run ${runId}... (Ctrl+C again to force quit)`);
    } else {
      console.log(`\n${formatTime()} ⏹️  Force quit.`);
      // In production `process.exit` terminates the process and never returns,
      // so this `try`/`catch` is unreachable dead code there. It exists so the
      // unit-test mock (which throws to prevent a real exit) doesn't propagate
      // the throw through `process.emit`'s listener boundary.
      try {
        process.exit(1);
      } catch {
        /* test mock throws; unreachable in production */
      }
    }
  };

  process.on('SIGINT', handler);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.removeListener('SIGINT', handler);
  };

  return { dispose };
}
