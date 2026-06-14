import type { TaskStatus } from '../core/types.js';

// ─── ANSI Style Helpers ──────────────────────────────────────────────────────

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
  done: green,
  failed: red,
  implementing: yellow,
  reviewing: magenta,
  claimed: blue,
  ready: cyan,
  blocked: darkRed,
};

export const statusColor = (status: TaskStatus): ((s: string) => string) => statusColorMap[status];

const statusIconMap: Record<TaskStatus, string> = {
  done: '✓',
  failed: '✗',
  implementing: '⟳',
  reviewing: '◎',
  claimed: '→',
  ready: '○',
  blocked: '⊘',
};

export const statusIcon = (status: TaskStatus): string => statusIconMap[status];

// ─── Sanitization ────────────────────────────────────────────────────────────

export const borderLine = (left: string, fill: string, right: string, innerWidth: number): string => {
  return left + fill.repeat(innerWidth) + right;
};
export function stripAnsi(str: string): string {
  if (!str.includes('\x1b')) return str;
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

// ─── Format Helpers ───────────────────────────────────────────────────────────

export function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return '<1s';
  }
  if (ms < 60000) {
    return Math.floor(ms / 1000) + 's';
  }
  if (ms < 3600000) {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return secs === 0 ? mins + 'm' : mins + 'm' + secs + 's';
  }
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return mins === 0 ? hours + 'h' : hours + 'h' + mins + 'm';
}
