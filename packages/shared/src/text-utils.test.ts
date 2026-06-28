// Tests for the shared text-utility helpers.
//
// These pin down the observable behavior of the helpers that live in
// `@engin/shared/text-utils`, including `formatElapsed` which is consolidated
// here from its former duplicated locations (tui/theme.ts and
// web/utils/format-elapsed.ts).

import { describe, expect, it } from 'bun:test';
import { formatDuration, formatElapsed, sanitizeDisplayText, stripAnsi } from './text-utils.js';

describe('stripAnsi', () => {
  it('returns the original string unchanged when it contains no ESC', () => {
    const input = 'plain text — no escapes';
    expect(stripAnsi(input)).toBe(input);
  });

  it('strips a simple CSI color sequence', () => {
    expect(stripAnsi('\x1b[36mhi\x1b[0m')).toBe('hi');
  });

  it('strips a 256-color / multi-parameter SGR sequence', () => {
    expect(stripAnsi('\x1b[38;5;131mx\x1b[0m')).toBe('x');
  });

  it('strips an OSC sequence terminated by BEL', () => {
    expect(stripAnsi('a\x1b]0;title\x07b')).toBe('ab');
  });

  it('strips an OSC sequence terminated by ST (ESC backslash)', () => {
    expect(stripAnsi('a\x1b]0;title\x1b\\b')).toBe('ab');
  });

  it('leaves surrounding text intact when removing multiple escapes', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[0m and \x1b[31mred\x1b[0m')).toBe('bold and red');
  });

  it('handles an empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

describe('sanitizeDisplayText', () => {
  it('collapses a single newline to a space', () => {
    expect(sanitizeDisplayText('line one\nline two')).toBe('line one line two');
  });

  it('collapses consecutive CR/LF runs to a single space', () => {
    expect(sanitizeDisplayText('a\r\n\r\nb')).toBe('a b');
  });

  it('strips ANSI escapes in addition to collapsing newlines', () => {
    expect(sanitizeDisplayText('\x1b[32mgood\x1b[0m\n\x1b[31mbad\x1b[0m')).toBe('good bad');
  });

  it('returns plain text unchanged', () => {
    expect(sanitizeDisplayText('nothing fancy')).toBe('nothing fancy');
  });
});

describe('formatDuration', () => {
  const cases: [number, string][] = [
    // non-positive durations render as empty
    [-1000, ''],
    [-1, ''],
    [0, ''],
    // sub-second: raw millisecond count
    [1, '1ms'],
    [999, '999ms'],
    // seconds with trailing zeros trimmed
    [1000, '1s'],
    [1500, '1.5s'],
    [2000, '2s'],
    [12500, '12.5s'],
  ];

  it.each(cases)('formatDuration(%d) returns %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('trims trailing zeros only after the decimal point', () => {
    // 3000 -> '3' (3.000 -> trim) -> '3s'
    expect(formatDuration(3000)).toBe('3s');
    // 3100 -> '3.1' -> '3.1s'
    expect(formatDuration(3100)).toBe('3.1s');
  });
});

describe('formatElapsed', () => {
  const cases: [number, string][] = [
    // sub-second bucket (< 1000): always '<1s'
    [-1, '<1s'],
    [-1000, '<1s'],
    [0, '<1s'],
    [1, '<1s'],
    [500, '<1s'],
    [999, '<1s'],
    // seconds bucket (1000..59999): Math.floor(ms/1000) + 's'
    [1000, '1s'],
    [1500, '1s'],
    [1999, '1s'],
    [2000, '2s'],
    [42000, '42s'],
    [59999, '59s'],
    // minutes bucket (60000..3599999)
    [60000, '1m'],
    [60999, '1m'],
    [65000, '1m 5s'],
    [120000, '2m'],
    [135000, '2m 15s'],
    [3599999, '59m 59s'],
    // hours bucket (>= 3600000)
    [3600000, '1h'],
    [3600001, '1h'],
    [5025000, '1h 23m'],
    [7200000, '2h'],
    [86640000, '24h 4m'],
  ];

  it.each(cases)('formatElapsed(%d) returns %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});
