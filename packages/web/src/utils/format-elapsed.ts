/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Mirrors the implementation in packages/tui/src/theme.ts so that the web
 * layer produces identical output for the same elapsed time.
 *
 * @param ms – elapsed time in milliseconds
 * @returns formatted string (e.g. '<1s', '42s', '2m15s', '1h23m')
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return '<1s';
  }
  if (ms < 60000) {
    return Math.floor(ms / 1000) + 's';
  }
  if (ms < 3600000) {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return secs === 0 ? mins + 'm' : mins + 'm' + secs + 's';
  }
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return mins === 0 ? hours + 'h' : hours + 'h' + mins + 'm';
}
