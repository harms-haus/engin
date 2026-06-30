// ─── Bun + Ink keyboard input regression test ──────────────────────────────
//
// Validates §5.3 blocker risk: Ink's useInput + raw-mode stdin parsing under
// Bun 1.3.14.  This is a PERMANENT regression test, NOT a temporary smoke test.
//
// Each key escape sequence is piped to Ink's stdin via the test harness mock
// stream.  We assert that Ink's useInput handler fires with the correct key
// field values.

import { describe, expect, it } from 'bun:test';
import { Text, useInput } from 'ink';
import { useRef } from 'react';
import { renderTest, sendKey } from './test-harness.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Tiny helper: await a macrotask boundary so React / Ink can flush any
 * pending discrete updates triggered by synthetic input.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A test component that captures every useInput invocation into a mutable
 * array ref so we can assert on it after sending keys.
 */
function InputRecorder({ events }: { events: Array<{ input: string; key: Record<string, boolean | undefined> }> }) {
  const firedRef = useRef(0);

  useInput((input, key) => {
    events.push({
      input,
      key: {
        ctrl: key.ctrl,
        shift: key.shift,
        tab: key.tab,
        return: key.return,
        escape: key.escape,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        leftArrow: key.leftArrow,
        rightArrow: key.rightArrow,
        pageUp: key.pageUp,
        pageDown: key.pageDown,
        home: key.home,
        end: key.end,
      },
    });
    firedRef.current++;
  });

  return <Text>Input recorder ready (fired: {firedRef.current})</Text>;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Bun + Ink keyboard input (§5.3 blocker)', () => {
  it('up arrow → key.upArrow === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'up');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.upArrow).toBe(true);
    expect(events[0]!.key.downArrow).toBe(false);
    expect(events[0]!.key.leftArrow).toBe(false);
    expect(events[0]!.key.rightArrow).toBe(false);

    unmount();
  });

  it('down arrow → key.downArrow === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'down');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.downArrow).toBe(true);

    unmount();
  });

  it('right arrow → key.rightArrow === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'right');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.rightArrow).toBe(true);

    unmount();
  });

  it('left arrow → key.leftArrow === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'left');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.leftArrow).toBe(true);

    unmount();
  });

  it('tab → key.tab === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'tab');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.tab).toBe(true);
    expect(events[0]!.key.shift).toBe(false);

    unmount();
  });

  it('shift+tab → key.tab === true && key.shift === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'shiftTab');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.tab).toBe(true);
    expect(events[0]!.key.shift).toBe(true);

    unmount();
  });

  it('enter → key.return === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'enter');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.return).toBe(true);

    unmount();
  });

  it('space → input === " " (and key.space is undefined)', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'space');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.input).toBe(' ');
    // Ink's useInput does NOT expose a key.space field
    expect((events[0]!.key as Record<string, boolean | undefined>).space).toBeUndefined();

    unmount();
  });

  it('ctrl+c → key.ctrl === true && input === "c"', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'ctrlC');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.ctrl).toBe(true);
    expect(events[0]!.input).toBe('c');

    unmount();
  });

  it('ctrl+d → key.ctrl === true && input === "d"', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'ctrlD');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.ctrl).toBe(true);
    expect(events[0]!.input).toBe('d');

    unmount();
  });

  it('ctrl+q → key.ctrl === true && input === "q"', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'ctrlQ');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.ctrl).toBe(true);
    expect(events[0]!.input).toBe('q');

    unmount();
  });

  it('pgup → key.pageUp === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'pgUp');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.pageUp).toBe(true);

    unmount();
  });

  it('pgdn → key.pageDown === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'pgDn');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.pageDown).toBe(true);

    unmount();
  });

  it('home → key.home === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'home');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.home).toBe(true);

    unmount();
  });

  it('end → key.end === true', async () => {
    const events: Array<{ input: string; key: Record<string, boolean | undefined> }> = [];
    const { stdin, unmount } = renderTest(<InputRecorder events={events} />);

    sendKey(stdin, 'end');
    await tick();

    expect(events.length).toBe(1);
    expect(events[0]!.key.end).toBe(true);

    unmount();
  });
});
