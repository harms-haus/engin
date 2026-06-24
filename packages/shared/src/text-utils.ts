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
