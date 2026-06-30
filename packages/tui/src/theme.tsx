import type { TaskStatus } from '@engin/shared';

/**
 * Declarative Ink `<Text>` color values keyed by task status.
 * - A value of `undefined` means the component should use Ink's `dimColor` prop
 *   instead of a specific color (e.g. for `cancelled`).
 */
export const statusColorMap: Record<TaskStatus, string | undefined> = {
  active: 'yellow',
  complete: 'green',
  failed: 'red',
  cancelled: undefined,
  ready: 'cyan',
  blocked: '#af5f5f',
  parked: 'magenta',
};

/** Human-readable icons keyed by task status. */
export const statusIconMap: Record<TaskStatus, string> = {
  active: '▶',
  complete: '✓',
  failed: '✗',
  cancelled: '⊘',
  ready: '○',
  blocked: '·',
  parked: '⏸',
};

/** Look up the Ink `<Text color>` value for a given status. */
export const statusColor = (status: TaskStatus): string | undefined => statusColorMap[status];

/** Look up the icon character for a given status. */
export const statusIcon = (status: TaskStatus): string => statusIconMap[status];
