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

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/**
 * Format a duration (in milliseconds) as a coarse human-readable elapsed-time
 * string suitable for compact UI display.
 *
 * - For sub-second durations (`< 1000`) returns `'<1s'`.
 * - For durations under an hour returns minutes (and seconds when non-zero):
 *   e.g. `42_000 -> '42s'`, `65_000 -> '1m5s'`.
 * - For durations of an hour or more returns hours (and minutes when non-zero):
 *   e.g. `3_600_000 -> '1h'`, `5_025_000 -> '1h23m'`.
 */
export function formatElapsed(ms: number): string {
  if (ms < MS_PER_SECOND) return '<1s';
  if (ms < MS_PER_MINUTE) return Math.floor(ms / MS_PER_SECOND) + 's';
  if (ms < MS_PER_HOUR) {
    const mins = Math.floor(ms / MS_PER_MINUTE);
    const secs = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
    return secs === 0 ? mins + 'm' : mins + 'm' + secs + 's';
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const mins = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return mins === 0 ? hours + 'h' : hours + 'h' + mins + 'm';
}
