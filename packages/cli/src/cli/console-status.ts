// ─── Time Formatting ────────────────────────────────────────────────────────

export function formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `[${h}:${m}:${s}]`;
}

// ─── TUI Detection ─────────────────────────────────────────────────────────

/**
 * Determine whether to use the TUI dashboard instead of plain console output.
 * TUI is used when stdout is a TTY and verbose mode is not enabled.
 */
export function shouldUseTui(options: { verbose: boolean; isTty: boolean }): boolean {
  return !options.verbose && options.isTty;
}
