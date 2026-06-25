import type { TaskStatus } from '@engin/shared';

// ─── ANSI Style Helpers ──────────────────────────────────────────────────────

/** Default foreground — no ANSI wrapping. Used for plain (unstyled) cells. */
export const normal = (str: string): string => str;

export const cyan = (str: string): string => `\x1b[36m${str}\x1b[0m`;
export const dim = (str: string): string => `\x1b[2m${str}\x1b[0m`;
export const bold = (str: string): string => `\x1b[1m${str}\x1b[0m`;
export const underline = (str: string): string => `\x1b[4m${str}\x1b[0m`;
export const green = (str: string): string => `\x1b[32m${str}\x1b[0m`;
export const red = (str: string): string => `\x1b[31m${str}\x1b[0m`;
export const yellow = (str: string): string => `\x1b[33m${str}\x1b[0m`;
export const blue = (str: string): string => `\x1b[34m${str}\x1b[0m`;
export const magenta = (str: string): string => `\x1b[35m${str}\x1b[0m`;
export const darkRed = (str: string): string => `\x1b[38;5;131m${str}\x1b[0m`;

// ─── Background Styles ───────────────────────────────────────────────────────

export const bgDark = (str: string): string => `\x1b[48;5;236m${str}\x1b[0m`;
export const bgStatusBar = (str: string): string => `\x1b[48;5;237m${str}\x1b[0m`;

// ─── Status Mappings ─────────────────────────────────────────────────────────

const statusColorMap: Record<TaskStatus, (s: string) => string> = {
  active: yellow,
  complete: green,
  failed: red,
  cancelled: dim,
  ready: cyan,
  blocked: darkRed,
};

export const statusColor = (status: TaskStatus): ((s: string) => string) => statusColorMap[status];

const statusIconMap: Record<TaskStatus, string> = {
  active: '▶',
  complete: '✓',
  failed: '✗',
  cancelled: '⊘',
  ready: '○',
  blocked: '·',
};

export const statusIcon = (status: TaskStatus): string => statusIconMap[status];

// ─── Sanitization ────────────────────────────────────────────────────────────

export const borderLine = (left: string, fill: string, right: string, innerWidth: number): string => {
  return left + fill.repeat(innerWidth) + right;
};
