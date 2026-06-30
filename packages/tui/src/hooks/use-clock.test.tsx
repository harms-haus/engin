/**
 * Tests for the shared per-second clock (useClock).
 *
 * The key invariant: a SINGLE interval drives every subscriber, so all
 * consumers update in lockstep (no per-instance phase drift). Backed by
 * useSyncExternalStore; the singleton is reset between tests.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { __resetClockForTesting, useClock } from './use-clock.js';

afterEach(() => {
  __resetClockForTesting();
});

function Tick({ label }: { label: string }): React.ReactElement {
  const now = useClock();
  return <Text>{`${label}:${now}`}</Text>;
}

function TwoTicks(): React.ReactElement {
  return (
    <>
      <Tick label="a" />
      <Tick label="b" />
    </>
  );
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('useClock', () => {
  it('returns a fresh, accurate timestamp on first render', () => {
    const before = Date.now();
    const { lastFrame, unmount } = render(<Tick label="x" />);
    const frame = lastFrame() ?? '';
    const now = Number(frame.split(':')[1]);
    expect(now).toBeGreaterThanOrEqual(before);
    // Within the same render tick — no 1s staleness.
    expect(now - before).toBeLessThan(1000);
    unmount();
  });

  it('two subscribers share the SAME now value (lockstep)', () => {
    const { lastFrame, unmount } = render(<TwoTicks />);
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const a = Number(lines[0]!.split(':')[1]);
    const b = Number(lines[1]!.split(':')[1]);
    expect(a).toBe(b);
    unmount();
  });

  it('advances both subscribers together after ~1s (no drift)', async () => {
    const { lastFrame, unmount } = render(<TwoTicks />);
    const firstFrame = lastFrame() ?? '';
    const firstA = Number(firstFrame.split('\n')[0]!.split(':')[1]);
    const firstB = Number(firstFrame.split('\n')[1]!.split(':')[1]);

    // Wait for at least one tick (>1s).
    await new Promise((r) => setTimeout(r, 1200));
    await tick();

    const nextFrame = lastFrame() ?? '';
    const nextA = Number(nextFrame.split('\n')[0]!.split(':')[1]);
    const nextB = Number(nextFrame.split('\n')[1]!.split(':')[1]);

    // Both advanced by ~1s and remain equal.
    expect(nextA).toBeGreaterThan(firstA);
    expect(nextA).toBe(nextB);
    expect(nextA - firstA).toBeGreaterThanOrEqual(900);
    unmount();
  });

  it('tears down the singleton interval when the last subscriber unmounts', async () => {
    const { unmount } = render(<Tick label="x" />);
    unmount();
    // Re-rendering a fresh component should re-initialize cleanly (no leaked
    // interval throwing or double-ticking).
    const before = Date.now();
    const { lastFrame, unmount: unmount2 } = render(<Tick label="y" />);
    const now = Number((lastFrame() ?? '').split(':')[1]);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now - before).toBeLessThan(1000);
    unmount2();
  });
});
