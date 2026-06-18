// ─── formatTokenCount tests — @engin/shared/format-token-count ──────────────
//
// formatTokenCount(n) formats an integer token count into a compact
// human-readable string with units:
//
//   n <= 0                       → '0'
//   n < 1_000                    → plain integer string
//   1_000 <= n < 1_000_000       → divide by 1_000, ≤1 decimal, trim '.0', 'k'
//   n >= 1_000_000               → divide by 1_000_000, ≤1 decimal, trim '.0', 'm'
//
// Rounding uses Math.round(value * 10) / 10, so these tests pin BOTH the
// branching boundaries AND the rounding/trimming behavior. The canonical home
// of the function is @engin/shared/format-token-count; it is also re-exported
// from the package barrel (@engin/shared), verified at the bottom of this file.

import { describe, expect, it } from 'bun:test';

// ── Canonical home (subpath import) ─────────────────────────────────────────
import { formatTokenCount } from '@engin/shared/format-token-count';

// ── Barrel import (verified to resolve to the same function) ────────────────
import { formatTokenCount as formatTokenCountFromBarrel } from '@engin/shared';

// ────────────────────────────────────────────────────────────────────────────
// Boundary values called out explicitly by the task contract
// ────────────────────────────────────────────────────────────────────────────

describe('formatTokenCount — contract boundary values', () => {
  const cases: [number, string][] = [
    [56, '56'],
    [1000, '1k'],
    [1200, '1.2k'],
    [56000, '56k'],
    [1_200_000, '1.2m'],
    [0, '0'],
  ];

  it.each(cases)('formatTokenCount(%d) === %s', (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Small counts (n < 1000) render as plain integers
// ────────────────────────────────────────────────────────────────────────────

describe('formatTokenCount — small counts render as plain integers', () => {
  const cases: [number, string][] = [
    [1, '1'],
    [56, '56'],
    [500, '500'],
    [999, '999'],
  ];

  it.each(cases)('renders %d as %s (no unit)', (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected);
  });

  it('does not append a unit to a small count', () => {
    expect(formatTokenCount(742)).not.toMatch(/[km]$/);
    expect(formatTokenCount(742)).toBe('742');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Thousands (1_000 <= n < 1_000_000) → 'k' suffix
// ────────────────────────────────────────────────────────────────────────────

describe('formatTokenCount — thousands use the "k" suffix', () => {
  const cases: [number, string][] = [
    [1000, '1k'], // exactly 1k, '.0' trimmed
    [1200, '1.2k'],
    [1500, '1.5k'],
    [5000, '5k'], // '.0' trimmed
    [56000, '56k'],
    [12500, '12.5k'],
    [999_999, '1000k'], // algorithmic consequence: 999.999 → Math.round → 1000
  ];

  it.each(cases)('formats %d as %s', (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected);
  });

  it('appends the "k" unit', () => {
    expect(formatTokenCount(2000)).toMatch(/k$/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Millions (n >= 1_000_000) → 'm' suffix
// ────────────────────────────────────────────────────────────────────────────

describe('formatTokenCount — millions use the "m" suffix', () => {
  const cases: [number, string][] = [
    [1_000_000, '1m'], // exactly 1m, '.0' trimmed
    [1_200_000, '1.2m'],
    [1_500_000, '1.5m'],
    [2_000_000, '2m'], // '.0' trimmed
    [5_600_000, '5.6m'],
    [12_500_000, '12.5m'],
    [1_500_000_000, '1500m'],
  ];

  it.each(cases)('formats %d as %s', (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected);
  });

  it('appends the "m" unit', () => {
    expect(formatTokenCount(3_000_000)).toMatch(/m$/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Zero and negative counts → '0'
// ────────────────────────────────────────────────────────────────────────────

describe('formatTokenCount — zero and negative counts return "0"', () => {
  const cases: [number, string][] = [
    [0, '0'],
    [-1, '0'],
    [-5, '0'],
    [-999, '0'],
    [-1000, '0'],
    [-1_000_000, '0'],
  ];

  it.each(cases)('formats %d as %s', (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected);
  });

  it('never renders a minus sign for negative inputs', () => {
    expect(formatTokenCount(-42)).not.toMatch(/-/);
    expect(formatTokenCount(-42)).toBe('0');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Rounding (Math.round(value * 10) / 10) at the single-decimal boundary
// ────────────────────────────────────────────────────────────────────────────

describe('formatTokenCount — single-decimal rounding', () => {
  it('rounds 1049 → 1k (1.049 rounds down to 1.0)', () => {
    expect(formatTokenCount(1049)).toBe('1k');
  });

  it('rounds 1050 → 1.1k (1.05 rounds up to 1.1)', () => {
    expect(formatTokenCount(1050)).toBe('1.1k');
  });

  it('rounds 1499 → 1.5k (1.499 rounds up to 1.5)', () => {
    expect(formatTokenCount(1499)).toBe('1.5k');
  });

  it('rounds 1_050_000 → 1.1m (1.05m rounds up to 1.1m)', () => {
    expect(formatTokenCount(1_050_000)).toBe('1.1m');
  });

  it('rounds 1_499_999 → 1.5m (1.499999m rounds up to 1.5m)', () => {
    expect(formatTokenCount(1_499_999)).toBe('1.5m');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Trailing '.0' is trimmed so whole numbers render without a decimal
// ────────────────────────────────────────────────────────────────────────────

describe('formatTokenCount — trims trailing ".0" from whole numbers', () => {
  it('trims ".0k" → "k" (e.g. 5000 → 5k, not 5.0k)', () => {
    expect(formatTokenCount(5000)).toBe('5k');
    expect(formatTokenCount(56000)).toBe('56k');
    expect(formatTokenCount(1000)).toBe('1k');
  });

  it('trims ".0m" → "m" (e.g. 2_000_000 → 2m, not 2.0m)', () => {
    expect(formatTokenCount(2_000_000)).toBe('2m');
    expect(formatTokenCount(1_000_000)).toBe('1m');
  });

  it('preserves a non-zero decimal (e.g. 1.2k stays 1.2k)', () => {
    expect(formatTokenCount(1200)).toBe('1.2k');
    expect(formatTokenCount(1_200_000)).toBe('1.2m');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Pure function & output-type sanity
// ────────────────────────────────────────────────────────────────────────────

describe('formatTokenCount — pure function sanity', () => {
  it('always returns a string', () => {
    expect(typeof formatTokenCount(0)).toBe('string');
    expect(typeof formatTokenCount(56)).toBe('string');
    expect(typeof formatTokenCount(999999)).toBe('string');
    expect(typeof formatTokenCount(9_000_000)).toBe('string');
  });

  it('is deterministic: identical inputs yield identical outputs', () => {
    expect(formatTokenCount(1234)).toBe(formatTokenCount(1234));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Export surface — only formatTokenCount is exported (helpers stay private)
// ────────────────────────────────────────────────────────────────────────────

describe('@engin/shared/format-token-count — export surface', () => {
  it('exports only formatTokenCount (no internal helpers leak)', async () => {
    const mod = (await import('@engin/shared/format-token-count')) as Record<string, unknown>;
    expect(typeof mod.formatTokenCount).toBe('function');
    // Common names a naive implementation might accidentally export — assert
    // they are NOT present on the public surface.
    expect(mod.roundToOneDecimal).toBeUndefined();
    expect(mod.trimTrailingZero).toBeUndefined();
    expect(mod.UNITS).toBeUndefined();
    expect(mod.K_THRESHOLD).toBeUndefined();
    expect(mod.M_THRESHOLD).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Barrel re-export — `import { formatTokenCount } from '@engin/shared'` resolves
// to the same function as the canonical subpath.
// ────────────────────────────────────────────────────────────────────────────

describe('@engin/shared barrel — re-exports formatTokenCount', () => {
  it('resolves formatTokenCount from the package barrel', () => {
    expect(typeof formatTokenCountFromBarrel).toBe('function');
  });

  it('the barrel export is the SAME function as the subpath export', () => {
    expect(formatTokenCountFromBarrel).toBe(formatTokenCount);
  });

  it('the barrel export produces identical output to the subpath export', () => {
    for (const n of [0, 56, 1000, 1200, 56000, 1_200_000]) {
      expect(formatTokenCountFromBarrel(n)).toBe(formatTokenCount(n));
    }
  });
});
