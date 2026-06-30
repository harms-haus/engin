/**
 * DetachKillPrompt — Ink overlay component that asks the user whether they
 * want to detach from or kill a running session.
 *
 * Built on a bare `<Layer>` (not `<Modal>`) because Modal's default
 * `role='dialog'` auto-dismisses on any non-Escape/non-Tab input, which
 * would break arrow-key navigation of the two-option menu. Using a bare
 * `<Layer>` with `capture`, `anchor="center"`, `backdrop="none"`, and
 * `z={100}` gives us full input control while still providing the bordered
 * dialog aesthetic.
 *
 * ## Exports
 *
 * - `DetachKillPrompt` — React component.
 * - `DetachKillAction` — `'detach' | 'kill'` literal type.
 */

import { Layer } from '@harms-haus/ink-overlay';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

export type DetachKillAction = 'detach' | 'kill';

export interface DetachKillPromptProps {
  /** Whether the prompt overlay is visible. */
  open: boolean;
  /** Optional run identifier shown in the header. */
  runId?: string;
  /** Called when the user confirms a choice (Enter on Detach or Kill). */
  onConfirm: (action: DetachKillAction) => void;
  /** Called when the user dismisses (Escape, Ctrl+C, or backdrop action). */
  onDismiss: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const OPTION_LABELS: readonly DetachKillAction[] = ['detach', 'kill'];

const OPTION_DISPLAY: Record<DetachKillAction, { label: string; description: string }> = {
  detach: { label: 'Detach', description: 'Leave run running, exit client' },
  kill: { label: 'Kill', description: 'Cancel run, then exit' },
};

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Detach/kill confirmation prompt.
 *
 * Renders a centered, bordered dialog with a two-option menu.
 * - **↑/↓** or **←/→** → navigate selection (wraps).
 * - **Enter** → confirm (fires `onConfirm` with the selected action).
 * - **Escape** → dismiss (fires `onDismiss`).
 * - **Ctrl+C** → dismiss (fires `onDismiss`).
 *
 * The `<Layer>` does **not** use `role="dialog"` so arrow keys are not
 * consumed by the Layer's backdrop-input handler.
 */
export function DetachKillPrompt({ open, runId, onConfirm, onDismiss }: DetachKillPromptProps): ReactNode {
  const [selection, setSelection] = useState<number>(0);

  // ── Reset selection to Detach whenever the prompt re-opens ────────
  //
  // Without this, if a user navigates to 'Kill' and dismisses, the
  // selection persists in state and the NEXT open has Kill pre-selected
  // — a destructive-action safety bug.
  useEffect(() => {
    if (open) setSelection(0);
  }, [open]);

  // ── Input handling ──────────────────────────────────────────────────
  //
  // Escape is already handled by <Layer>'s built-in onDismiss; we handle
  // navigation, confirm, and Ctrl+C here.
  useInput(
    (input, key) => {
      // ↑ or ← → previous option (wraps)
      if (key.upArrow || key.leftArrow) {
        setSelection((s) => (s - 1 + OPTION_LABELS.length) % OPTION_LABELS.length);
        return;
      }

      // ↓ or → → next option (wraps)
      if (key.downArrow || key.rightArrow) {
        setSelection((s) => (s + 1) % OPTION_LABELS.length);
        return;
      }

      // Enter → confirm with current selection
      if (key.return) {
        onConfirm(OPTION_LABELS[selection]);
        return;
      }

      // Escape → dismiss
      if (key.escape) {
        onDismiss();
        return;
      }

      // Ctrl+C → dismiss
      if (key.ctrl && input === 'c') {
        onDismiss();
        return;
      }
    },
    { isActive: open },
  );

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <Layer anchor="center" capture backdrop="none" z={100} open={open}>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" width={50} padding={1}>
        {/* ── Title row (runId) ──────────────────────────────────── */}
        {runId && (
          <Box borderBottom paddingX={1} marginBottom={1}>
            <Text dimColor>Run: {runId}</Text>
          </Box>
        )}

        {/* ── Body — two-option menu ────────────────────────────── */}
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          {OPTION_LABELS.map((action, i) => {
            const selected = i === selection;
            const option = OPTION_DISPLAY[action];
            return (
              <Box key={action} flexDirection="column">
                <Text bold={selected} dimColor={!selected}>
                  {selected ? '❯' : ' '} {option.label}
                </Text>
                <Text dimColor> {option.description}</Text>
              </Box>
            );
          })}
        </Box>

        {/* ── Footer ──────────────────────────────────────────── */}
        <Box borderTop paddingX={1}>
          <Text dimColor>↑/↓ select · Enter confirm · Esc cancel</Text>
        </Box>
      </Box>
    </Layer>
  );
}
