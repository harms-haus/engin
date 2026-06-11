import type { TaskStatus } from '../core/types.js';

// ─── ANSI Style Helpers ──────────────────────────────────────────────────────

export const cyan = (str: string): string => `\x1b[36m${str}\x1b[0m`;
export const dim = (str: string): string => `\x1b[2m${str}\x1b[0m`;
export const bold = (str: string): string => `\x1b[1m${str}\x1b[0m`;
export const green = (str: string): string => `\x1b[32m${str}\x1b[0m`;
export const red = (str: string): string => `\x1b[31m${str}\x1b[0m`;
export const yellow = (str: string): string => `\x1b[33m${str}\x1b[0m`;
export const blue = (str: string): string => `\x1b[34m${str}\x1b[0m`;
export const magenta = (str: string): string => `\x1b[35m${str}\x1b[0m`;

// ─── Background Styles ───────────────────────────────────────────────────────

export const bgDark = (str: string): string => `\x1b[48;5;236m${str}\x1b[0m`;
export const bgStatusBar = (str: string): string => `\x1b[48;5;237m${str}\x1b[0m`;

// ─── Status Mappings ─────────────────────────────────────────────────────────

const statusColorMap: Record<TaskStatus, (s: string) => string> = {
  done: green,
  failed: red,
  implementing: yellow,
  reviewing: magenta,
  claimed: blue,
  ready: cyan,
  blocked: dim,
};

export const statusColor = (status: TaskStatus): ((s: string) => string) => statusColorMap[status];

const statusIconMap: Record<TaskStatus, string> = {
  done: '✓',
  failed: '✗',
  implementing: '⟳',
  reviewing: '◎',
  claimed: '→',
  ready: '○',
  blocked: '·',
};

export const statusIcon = (status: TaskStatus): string => statusIconMap[status];

// ─── Sanitization ────────────────────────────────────────────────────────────

export const borderLine = (left: string, fill: string, right: string, innerWidth: number): string => {
  return left + fill.repeat(innerWidth) + right;
};
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}
