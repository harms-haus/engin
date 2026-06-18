import type { TaskStatus } from '@engin/shared';
import { describe, expect, it } from 'bun:test';
import {
  bgDark,
  bgStatusBar,
  blue,
  bold,
  cyan,
  darkRed,
  dim,
  formatElapsed,
  green,
  magenta,
  normal,
  red,
  statusColor,
  statusIcon,
  yellow,
} from '../../packages/tui/src/theme.js';

describe('ANSI style functions', () => {
  it('cyan wraps with 36m and resets', () => {
    expect(cyan('hi')).toBe('\x1b[36mhi\x1b[0m');
  });

  it('dim wraps with 2m and resets', () => {
    expect(dim('hi')).toBe('\x1b[2mhi\x1b[0m');
  });

  it('bold wraps with 1m and resets', () => {
    expect(bold('hi')).toBe('\x1b[1mhi\x1b[0m');
  });

  it('green wraps with 32m and resets', () => {
    expect(green('hi')).toBe('\x1b[32mhi\x1b[0m');
  });

  it('red wraps with 31m and resets', () => {
    expect(red('hi')).toBe('\x1b[31mhi\x1b[0m');
  });

  it('yellow wraps with 33m and resets', () => {
    expect(yellow('hi')).toBe('\x1b[33mhi\x1b[0m');
  });

  it('blue wraps with 34m and resets', () => {
    expect(blue('hi')).toBe('\x1b[34mhi\x1b[0m');
  });

  it('magenta wraps with 35m and resets', () => {
    expect(magenta('hi')).toBe('\x1b[35mhi\x1b[0m');
  });

  it('bgDark wraps with 48;5;236m and resets', () => {
    expect(bgDark('hi')).toBe('\x1b[48;5;236mhi\x1b[0m');
  });

  it('bgStatusBar wraps with 48;5;237m and resets', () => {
    expect(bgStatusBar('hi')).toBe('\x1b[48;5;237mhi\x1b[0m');
  });

  it('darkRed wraps with 38;5;131m and resets', () => {
    expect(darkRed('hi')).toBe('\x1b[38;5;131mhi\x1b[0m');
  });

  it('normal returns input unchanged with no ANSI wrapping', () => {
    expect(normal('hi')).toBe('hi');
  });
});

describe('statusColor', () => {
  const cases: [TaskStatus, string][] = [
    ['active', '\x1b[33mX\x1b[0m'],
    ['complete', '\x1b[32mX\x1b[0m'],
    ['failed', '\x1b[31mX\x1b[0m'],
    ['cancelled', '\x1b[2mX\x1b[0m'],
    ['ready', '\x1b[36mX\x1b[0m'],
    ['blocked', '\x1b[38;5;131mX\x1b[0m'],
  ];

  it.each(cases)('statusColor(%s) applies the correct color', (status, expected) => {
    expect(statusColor(status)('X')).toBe(expected);
  });

  it('returns a function', () => {
    const fn = statusColor('active');
    expect(typeof fn).toBe('function');
  });
});

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

describe('statusIcon', () => {
  const cases: [TaskStatus, string][] = [
    ['active', '▶'],
    ['complete', '✓'],
    ['failed', '✗'],
    ['cancelled', '⊘'],
    ['ready', '○'],
    ['blocked', '·'],
  ];

  it.each(cases)('statusIcon(%s) returns %s', (status, expected) => {
    expect(statusIcon(status)).toBe(expected);
  });
});
