// ─── Text Sanitisation Utilities ─────────────────────────────────────────────
//
// Pure helpers shared across the @engin/shared layer for safe terminal /
// event-log rendering.

/**
 * Strip ANSI escape sequences (CSI and OSC) from `str`.
 *
 * Fast-path: when `str` does not contain ESC (`\x1b`) the original string
 * is returned with zero allocation.
 */
export function stripAnsi(str: string): string {
  if (!str.includes('\x1b')) return str;
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

/**
 * Sanitise a string for single-line display: strip ANSI escapes and collapse
 * newlines / carriage returns to spaces.
 */
export function sanitizeDisplayText(str: string): string {
  return stripAnsi(str).replace(/[\r\n]+/g, ' ');
}

/**
 * Format a duration (in milliseconds) as a compact human-readable string.
 *
 * - For `ms <= 0` returns `''` (caller is expected to omit the suffix).
 * - For sub-second durations (`< 1000`) returns `${ms}ms`.
 * - Otherwise returns `${seconds}s` with trailing zeros trimmed
 *   (e.g. `2000 -> '2s'`, `1500 -> '1.5s'`).
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${String(ms / 1000).replace(/\.0+$/, '')}s`;
}
