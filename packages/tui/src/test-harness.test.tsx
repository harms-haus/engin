// ─── Tests for the shared test harness ───────────────────────────────────────
//
// Asserts that `renderTest` renders elements correctly and `stripAnsi` removes
// ANSI escape codes as expected.

import { describe, expect, it } from 'bun:test';
import { Text } from 'ink';
import { renderTest, sendKey, stripAnsi } from './test-harness.js';

// ─── renderTest ─────────────────────────────────────────────────────────────

describe('renderTest', () => {
  it('renders a <Text> element and lastFrame() contains the output', () => {
    const { lastFrame } = renderTest(<Text>Hello World</Text>);
    expect(lastFrame()).toContain('Hello World');
  });
});

// ─── sendKey ─────────────────────────────────────────────────────────────────

describe('sendKey', () => {
  it('writes named key sequences to stdin', () => {
    const { stdin } = renderTest(<Text>Keys</Text>);
    expect(() => sendKey(stdin, 'up')).not.toThrow();
    expect(() => sendKey(stdin, 'enter')).not.toThrow();
    expect(() => sendKey(stdin, 'ctrlC')).not.toThrow();
  });

  it('writes raw sequences for unknown keys as-is', () => {
    const { stdin } = renderTest(<Text>Raw</Text>);
    expect(() => sendKey(stdin, '\x1b[Z')).not.toThrow();
  });
});

// ─── stripAnsi (re-export) ──────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes ANSI color codes from a styled string', () => {
    const styled = '\x1b[36mHello\x1b[0m World';
    expect(stripAnsi(styled)).toBe('Hello World');
  });

  it('returns the original string unchanged when it contains no ANSI codes', () => {
    const plain = 'Hello World';
    expect(stripAnsi(plain)).toBe(plain);
  });

  it('handles an empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});
