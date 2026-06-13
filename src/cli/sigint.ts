import { formatTime } from './console-status.js';

// ─── SIGINT Handler Helper ──────────────────────────────────────────────────

export function setupSigintHandler(useTui: boolean): {
  handler: () => void;
  cleanup: () => void;
  controller: AbortController;
} {
  const controller = new AbortController();
  let sigintCount = 0;
  let forceExitTimer: ReturnType<typeof setTimeout> | undefined;

  const handler = () => {
    sigintCount++;
    if (sigintCount === 1) {
      if (!useTui) {
        console.log(
          `\n${formatTime()} ⏹️  Interrupt received, stopping workflow gracefully... (Ctrl+C again to force quit)`,
        );
      }
      controller.abort();
      // Safety net: if graceful shutdown hasn't completed in 5s, force exit
      forceExitTimer = setTimeout(() => {
        if (!useTui) {
          console.log(`${formatTime()} ⏹️  Graceful shutdown timed out, forcing exit.`);
        }
        process.exit(1);
      }, 5000);
    } else {
      if (forceExitTimer) clearTimeout(forceExitTimer);
      if (!useTui) {
        console.log(`\n${formatTime()} ⏹️  Force quit.`);
      }
      process.exit(1);
    }
  };

  const cleanup = () => {
    if (forceExitTimer) clearTimeout(forceExitTimer);
    process.removeListener('SIGINT', handler);
  };

  return { handler, cleanup, controller };
}
