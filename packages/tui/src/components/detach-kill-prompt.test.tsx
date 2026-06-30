/**
 * Tests for {@link DetachKillPrompt}.
 *
 * Verifies rendering, keyboard navigation, confirmation, and dismissal.
 *
 * @module detach-kill-prompt.test
 */

import { OverlayHost } from '@harms-haus/ink-overlay';
import { describe, expect, it, vi } from 'bun:test';
import { renderWithHost, sendKey, stripAnsi } from '../test-harness.js';
import { DetachKillPrompt, type DetachKillAction } from './detach-kill-prompt.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Small delay to let Ink's rendering loop flush after mount or key events.
 * Required because `<Layer>` registers itself in a `useEffect` which is
 * async relative to the initial `render()` call.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Render a DetachKillPrompt with a mock onConfirm/onDismiss and return
 * helpers for inspecting the output and interacting.
 */
function setup(
  props?: Partial<{
    open: boolean;
    runId: string;
    onConfirm: (action: DetachKillAction) => void;
    onDismiss: () => void;
  }>,
) {
  const onConfirm = vi.fn<(action: DetachKillAction) => void>();
  const onDismiss = vi.fn<() => void>();

  const result = renderWithHost(
    <DetachKillPrompt
      open={props?.open ?? true}
      runId={props?.runId}
      onConfirm={props?.onConfirm ?? onConfirm}
      onDismiss={props?.onDismiss ?? onDismiss}
    />,
  );

  return { result, onConfirm, onDismiss };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DetachKillPrompt', () => {
  // ── Rendering ──────────────────────────────────────────────────────────

  it('renders both options with Detach selected by default', async () => {
    const { result } = setup();
    await tick();

    const frame = stripAnsi(result.lastFrame() ?? '');

    // Both actions are listed
    expect(frame).toContain('Detach');
    expect(frame).toContain('Kill');

    // Detach is the default selection (❯ marker)
    expect(frame).toContain('❯ Detach');

    // Kill is unselected (space prefix)
    expect(frame).toContain('  Kill');

    // Descriptions are visible
    expect(frame).toContain('Leave run running, exit client');
    expect(frame).toContain('Cancel run, then exit');

    // Footer is shown
    expect(frame).toContain('↑/↓ select');
    expect(frame).toContain('Enter confirm');
    expect(frame).toContain('Esc cancel');
  });

  it('renders runId when provided', async () => {
    const { result } = setup({ runId: 'abc-123' });
    await tick();

    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('Run: abc-123');
  });

  it('does not render runId section when runId is undefined', async () => {
    const { result } = setup();
    await tick();

    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).not.toContain('Run:');
  });

  // ── Navigation ────────────────────────────────────────────────────────

  it('moves selection to Kill on ↓ key (wraps once)', async () => {
    const { result } = setup();
    await tick();

    sendKey(result.stdin, 'down');
    await tick();

    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('❯ Kill');
    expect(frame).toContain('  Detach');
  });

  it('moves selection to Kill on → key', async () => {
    const { result } = setup();
    await tick();

    sendKey(result.stdin, 'right');
    await tick();

    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('❯ Kill');
  });

  it('wraps selection from Kill back to Detach on ↓ then ↓', async () => {
    const { result } = setup();
    await tick();

    sendKey(result.stdin, 'down'); // → Kill
    await tick();

    sendKey(result.stdin, 'down'); // → Detach (wraps)
    await tick();

    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('❯ Detach');
  });

  it('wraps selection from Detach to Kill on ↑ key', async () => {
    const { result } = setup();
    await tick();

    sendKey(result.stdin, 'up'); // → Kill (wraps backward)
    await tick();

    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('❯ Kill');
  });

  it('wraps selection from Kill back to Detach on ↑ key', async () => {
    const { result } = setup();
    await tick();

    sendKey(result.stdin, 'down'); // → Kill
    await tick();

    sendKey(result.stdin, 'up'); // → Detach
    await tick();

    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('❯ Detach');
  });

  it('moves selection with ← key (same as ↑)', async () => {
    const { result } = setup();
    await tick();

    sendKey(result.stdin, 'left'); // → Kill (wraps backward)
    await tick();

    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('❯ Kill');
  });

  // ── Confirmation — Enter ──────────────────────────────────────────────

  it('calls onConfirm with "detach" when Enter is pressed on default selection', async () => {
    const { result, onConfirm } = setup();
    await tick();

    sendKey(result.stdin, 'enter');
    await tick();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('detach');
  });

  it('calls onConfirm with "kill" when Enter is pressed after moving to Kill', async () => {
    const { result, onConfirm } = setup();
    await tick();

    sendKey(result.stdin, 'down'); // → Kill
    await tick();

    sendKey(result.stdin, 'enter');
    await tick();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('kill');
  });

  // ── Dismissal — Escape ────────────────────────────────────────────────

  it('calls onDismiss when Escape is pressed', async () => {
    const { result, onDismiss } = setup();
    await tick();

    sendKey(result.stdin, 'escape');
    await tick();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // ── Dismissal — Ctrl+C ────────────────────────────────────────────────

  it('calls onDismiss when Ctrl+C is pressed', async () => {
    const { result, onDismiss } = setup();
    await tick();

    sendKey(result.stdin, 'ctrlC');
    await tick();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // ── Non-dismissal — Ctrl+D ────────────────────────────────────────────

  it('does NOT call onDismiss when Ctrl+D is pressed (handled upstream)', async () => {
    const { result, onDismiss } = setup();
    await tick();

    sendKey(result.stdin, 'ctrlD');
    await tick();

    expect(onDismiss).not.toHaveBeenCalled();
  });

  // ── Hidden when not open ──────────────────────────────────────────────

  it('renders no visible content when open={false}', async () => {
    const { result } = setup({ open: false });
    await tick();

    const frame = stripAnsi(result.lastFrame() ?? '');

    // When closed, the overlay content should not appear
    expect(frame).not.toContain('Detach');
    expect(frame).not.toContain('Kill');
    expect(frame).not.toContain('❯');
  });

  // ── Selection reset on re-open ───────────────────────────────────────

  it('resets selection to Detach when re-opened after navigating to Kill', async () => {
    const { result, onConfirm, onDismiss } = setup({ open: true });
    await tick();

    // First open — Detach is selected
    let frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('❯ Detach');

    // Navigate to Kill
    sendKey(result.stdin, 'down');
    await tick();
    frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('❯ Kill');

    // Close the prompt via open={false}.
    // Must re-wrap in OverlayHost because rerender replaces the
    // entire tree, stripping the wrapper that renderWithHost provides.
    result.rerender(
      <OverlayHost>
        <DetachKillPrompt open={false} onConfirm={onConfirm} onDismiss={onDismiss} />
      </OverlayHost>,
    );
    await tick();

    frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).not.toContain('Detach');
    expect(frame).not.toContain('Kill');

    // Re-open — should reset to Detach
    result.rerender(
      <OverlayHost>
        <DetachKillPrompt open={true} onConfirm={onConfirm} onDismiss={onDismiss} />
      </OverlayHost>,
    );
    await tick();

    frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('❯ Detach');
    expect(frame).toContain('  Kill');
  });
});
