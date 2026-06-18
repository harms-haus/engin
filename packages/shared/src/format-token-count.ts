/**
 * Formats an integer token count into a compact human-readable string with units.
 *
 * - n < 1000       → plain integer string (e.g. 56 → '56')
 * - 1000 ≤ n < 1M  → divide by 1000, up to 1 decimal, trim trailing '.0', append 'k'
 * - n ≥ 1_000_000  → divide by 1_000_000, up to 1 decimal, trim trailing '.0', append 'm'
 * - n ≤ 0          → '0'
 */

export function formatTokenCount(n: number): string {
  if (n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));

  if (n < 1_000_000) {
    const raw = Math.round((n / 1000) * 10) / 10;
    const s = raw.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) + 'k' : s + 'k';
  }

  const raw = Math.round((n / 1_000_000) * 10) / 10;
  const s = raw.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) + 'm' : s + 'm';
}
