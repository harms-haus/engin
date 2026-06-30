import type { TaskStatus } from '@engin/shared';
import { describe, expect, it } from 'bun:test';
import { statusColor, statusColorMap, statusIcon, statusIconMap } from './theme.js';

describe('statusColorMap', () => {
  const expected: Record<TaskStatus, string | undefined> = {
    active: 'yellow',
    complete: 'green',
    failed: 'red',
    cancelled: undefined,
    ready: 'cyan',
    blocked: '#af5f5f',
    parked: 'magenta',
  };

  it('has entries for all 7 TaskStatus values', () => {
    const statuses: TaskStatus[] = ['active', 'complete', 'failed', 'cancelled', 'ready', 'blocked', 'parked'];
    for (const s of statuses) {
      expect(statusColorMap).toHaveProperty(s);
    }
  });

  it('maps each status to the correct Ink color value', () => {
    const statuses = Object.keys(expected) as TaskStatus[];
    for (const s of statuses) {
      expect(statusColorMap[s]).toBe(expected[s]);
    }
  });
});

describe('statusIconMap', () => {
  const expected: Record<TaskStatus, string> = {
    active: '▶',
    complete: '✓',
    failed: '✗',
    cancelled: '⊘',
    ready: '○',
    blocked: '·',
    parked: '⏸',
  };

  it('has entries for all 7 TaskStatus values', () => {
    const statuses: TaskStatus[] = ['active', 'complete', 'failed', 'cancelled', 'ready', 'blocked', 'parked'];
    for (const s of statuses) {
      expect(statusIconMap).toHaveProperty(s);
    }
  });

  it('maps each status to the correct icon', () => {
    const statuses = Object.keys(expected) as TaskStatus[];
    for (const s of statuses) {
      expect(statusIconMap[s]).toBe(expected[s]);
    }
  });
});

describe('statusColor helper', () => {
  it('returns "yellow" for active', () => {
    expect(statusColor('active')).toBe('yellow');
  });

  it('returns "green" for complete', () => {
    expect(statusColor('complete')).toBe('green');
  });

  it('returns "red" for failed', () => {
    expect(statusColor('failed')).toBe('red');
  });

  it('returns undefined for cancelled (use dimColor prop)', () => {
    expect(statusColor('cancelled')).toBeUndefined();
  });

  it('returns "cyan" for ready', () => {
    expect(statusColor('ready')).toBe('cyan');
  });

  it('returns "#af5f5f" for blocked', () => {
    expect(statusColor('blocked')).toBe('#af5f5f');
  });

  it('returns "magenta" for parked', () => {
    expect(statusColor('parked')).toBe('magenta');
  });
});

describe('statusIcon helper', () => {
  it('returns "▶" for active', () => {
    expect(statusIcon('active')).toBe('▶');
  });

  it('returns "✓" for complete', () => {
    expect(statusIcon('complete')).toBe('✓');
  });

  it('returns "✗" for failed', () => {
    expect(statusIcon('failed')).toBe('✗');
  });

  it('returns "⊘" for cancelled', () => {
    expect(statusIcon('cancelled')).toBe('⊘');
  });

  it('returns "○" for ready', () => {
    expect(statusIcon('ready')).toBe('○');
  });

  it('returns "·" for blocked', () => {
    expect(statusIcon('blocked')).toBe('·');
  });

  it('returns "⏸" for parked', () => {
    expect(statusIcon('parked')).toBe('⏸');
  });
});
