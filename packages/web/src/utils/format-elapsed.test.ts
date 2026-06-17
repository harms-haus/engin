/**
 * Tests for formatElapsed utility.
 *
 * Mirrors the parameterized test pattern from tests/tui/theme.test.ts for
 * the TUI implementation so both layers produce identical output.
 */

import { describe, expect, it } from 'vitest';
import { formatElapsed } from './format-elapsed';

describe('formatElapsed', () => {
  const cases: [number, string][] = [
    [0, '<1s'],
    [500, '<1s'],
    [999, '<1s'],
    [1000, '1s'],
    [42000, '42s'],
    [59999, '59s'],
    [60000, '1m'],
    [135000, '2m15s'],
    [3600000, '1h'],
    [5025000, '1h23m'],
  ];

  it.each(cases)('formatElapsed(%d) returns %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});
