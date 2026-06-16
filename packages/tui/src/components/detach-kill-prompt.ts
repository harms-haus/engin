import { Key, matchesKey, type Component } from '@earendil-works/pi-tui';
import { bold, dim } from '../theme.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type DetachKillAction = 'detach' | 'kill';

export interface DetachKillPromptOptions {
  runId: string | undefined;
  /** Called when the user confirms a choice (Enter on Detach or Kill). */
  onConfirm: (action: DetachKillAction) => void;
  /** Called when the user dismisses the prompt (Escape or Ctrl+C). */
  onDismiss: () => void;
}

// ─── Component Factory ───────────────────────────────────────────────────────

const OPTION_LABELS: readonly DetachKillAction[] = ['detach', 'kill'];
const OPTION_DISPLAY: Record<DetachKillAction, { label: string; description: string }> = {
  detach: { label: 'Detach', description: 'Leave run running, exit client' },
  kill: { label: 'Kill', description: 'Cancel run, then exit' },
};

/**
 * Creates a detach/kill prompt overlay component.
 *
 * Renders a two-option menu — **Detach** (default, highlighted) and **Kill** —
 * showing the runId. Mirrors the {@link createQrOverlayComponent} pattern.
 *
 * Input:
 * - Up/Down **or** Left/Right → navigate selection (wraps).
 * - Enter → confirm (fires `onConfirm` with the selected action).
 * - Escape **or** Ctrl+C → dismiss (fires `onDismiss`, no confirm).
 */
export function createDetachKillPrompt(options: DetachKillPromptOptions): Component {
  let selection = 0; // 0 = Detach (default)

  const component: Component = {
    render(_width: number): string[] {
      const lines: string[] = [];
      if (options.runId) {
        lines.push(dim(`Run: ${options.runId}`));
        lines.push('');
      }
      for (let i = 0; i < OPTION_LABELS.length; i++) {
        const selected = i === selection;
        const marker = selected ? '❯' : ' ';
        const option = OPTION_DISPLAY[OPTION_LABELS[i]];
        const text = `${marker} ${option.label}`;
        const desc = `    ${option.description}`;
        lines.push(selected ? bold(text) : dim(text));
        lines.push(dim(desc));
      }
      lines.push('');
      lines.push(dim('↑/↓ select · Enter confirm · Esc cancel'));
      return lines;
    },

    invalidate(): void {
      // No external caches to invalidate — selection is internal closure state.
    },

    handleInput(data: string): void {
      // Navigate: Up/Down or Left/Right (wraps around)
      if (matchesKey(data, 'up') || matchesKey(data, 'left')) {
        selection = (selection - 1 + OPTION_LABELS.length) % OPTION_LABELS.length;
        return;
      }
      if (matchesKey(data, 'down') || matchesKey(data, 'right')) {
        selection = (selection + 1) % OPTION_LABELS.length;
        return;
      }
      // Confirm
      if (matchesKey(data, Key.enter)) {
        options.onConfirm(OPTION_LABELS[selection]);
        return;
      }
      // Dismiss: Escape or Ctrl+C
      if (matchesKey(data, 'escape') || matchesKey(data, Key.ctrl('c'))) {
        options.onDismiss();
        return;
      }
    },
  };

  return component;
}
