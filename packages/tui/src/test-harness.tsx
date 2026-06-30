// ─── Shared Test Harness ─────────────────────────────────────────────────────
//
// Provides `renderTest`, `sendKey`, `renderWithHost`, and re-exports `stripAnsi`
// for component tests in the tui package.
//
// Decision (locked): try `ink-testing-library` first; if it breaks under
// Ink 7 / React 19, fall back to a custom harness using Ink's render() with
// mock streams.

import { stripAnsi } from '@engin/shared/text-utils.js';
import { OverlayHost } from '@harms-haus/ink-overlay';
import { render as inkRender, type Instance as InkInstance } from 'ink';
import { EventEmitter } from 'node:events';
import { type ReactElement } from 'react';

// Re-export for assertion use.
export { stripAnsi };

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RenderResult {
  lastFrame: () => string | undefined;
  rerender: (tree: ReactElement) => void;
  stdin: { write: (data: string) => void };
  unmount: () => void;
  frames: string[];
}

// ─── Mock stream classes (used by the fallback harness) ─────────────────────

class MockStdout extends EventEmitter {
  readonly columns = 100;
  readonly frames: string[] = [];
  private _lastFrame: string | undefined;

  write = (chunk: string | Buffer): boolean => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
    this.frames.push(text);
    this._lastFrame = text;
    return true;
  };

  lastFrame = (): string | undefined => this._lastFrame;
}

class MockStderr extends EventEmitter {
  readonly frames: string[] = [];
  private _lastFrame: string | undefined;

  write = (chunk: string | Buffer): boolean => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
    this.frames.push(text);
    this._lastFrame = text;
    return true;
  };

  lastFrame = (): string | undefined => this._lastFrame;
}

class MockStdin extends EventEmitter {
  readonly isTTY = true;
  private _data: string | null = null;

  write = (data: string): void => {
    this._data = data;
    this.emit('readable');
    this.emit('data', data);
  };

  read = (): string | null => {
    const d = this._data;
    this._data = null;
    return d;
  };

  setEncoding = (): void => {
    /* noop */
  };
  setRawMode = (): void => {
    /* noop */
  };
  resume = (): void => {
    /* noop */
  };
  pause = (): void => {
    /* noop */
  };
  ref = (): void => {
    /* noop */
  };
  unref = (): void => {
    /* noop */
  };
}

// ─── Eagerly try ink-testing-library ──────────────────────────────────────

let _inkTestingRender: ((tree: ReactElement) => unknown) | null = null;

try {
  const mod = (await import('ink-testing-library')) as {
    render: (tree: ReactElement) => unknown;
    cleanup: () => void;
  };
  _inkTestingRender = mod.render;
} catch {
  // ink-testing-library unavailable or incompatible — fallback will be used
}

// ─── Custom fallback harness ───────────────────────────────────────────────

function createCustomHarness(element: ReactElement): RenderResult {
  const stdout = new MockStdout();
  const stderr = new MockStderr();
  const stdin = new MockStdin();

  const instance = inkRender(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  }) as InkInstance;

  return {
    lastFrame: stdout.lastFrame.bind(stdout),
    rerender: instance.rerender.bind(instance),
    stdin,
    unmount: instance.unmount.bind(instance),
    frames: stdout.frames,
  };
}

// ─── renderTest ─────────────────────────────────────────────────────────────

/**
 * Render a ReactElement for testing.
 *
 * Attempts `ink-testing-library`'s render() first. If it works (produces
 * non-empty output without throwing), wraps and returns the result. If it
 * throws or produces empty/undefined output, falls back to a custom harness
 * that uses Ink's render() directly with mock streams.
 */
export function renderTest(element: ReactElement): RenderResult {
  // Try ink-testing-library first
  if (_inkTestingRender) {
    try {
      const result = _inkTestingRender(element) as {
        lastFrame: () => string | undefined;
        rerender: (tree: ReactElement) => void;
        stdin: { write: (data: string) => void };
        unmount: () => void;
        cleanup: () => void;
        frames: string[];
      };

      const frame = result.lastFrame?.();

      // Require non-whitespace content — ink-testing-library sometimes
      // returns all-newlines frames (e.g. for overlay-based components)
      // that appear non-empty but contain no visible output.
      const hasContent = frame !== undefined && frame !== null && frame.trim().length > 0;
      if (hasContent) {
        return {
          lastFrame: result.lastFrame,
          rerender: result.rerender,
          stdin: result.stdin,
          unmount: () => {
            result.unmount();
            result.cleanup?.();
          },
          frames: result.frames,
        };
      }

      // Clean up ink-testing-library even when we don't use its result
      // to avoid polluting global state for subsequent tests.
      result.unmount();
      result.cleanup?.();
    } catch {
      // Fall through to custom harness
    }
  }

  // Fallback: custom harness
  return createCustomHarness(element);
}

// ─── renderWithHost ─────────────────────────────────────────────────────────

/**
 * Render a ReactElement wrapped in an `<OverlayHost>`.
 *
 * Required for overlay-component tests that use `useInputCaptureState`
 * (or other overlay context hooks) so they have the correct provider
 * ancestor in the render tree.
 *
 * Returns the same shape as `renderTest`.
 */
export function renderWithHost(element: ReactElement): RenderResult {
  return renderTest(<OverlayHost>{element}</OverlayHost>);
}

// ─── sendKey ────────────────────────────────────────────────────────────────

const KEY_MAP: Record<string, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  tab: '\t',
  shiftTab: '\x1b[Z',
  enter: '\r',
  space: ' ',
  escape: '\x1b',
  ctrlC: '\x03',
  ctrlD: '\x04',
  ctrlQ: '\x11',
  pgUp: '\x1b[5~',
  pgDn: '\x1b[6~',
  home: '\x1b[H',
  end: '\x1b[F',
};

/**
 * Write a keystroke to `stdin`.
 *
 * Accepts either a named key (e.g. `'up'`, `'enter'`, `'ctrlC'`) or
 * raw bytes (e.g. `'\x1b[A'`). If the string matches a known name it
 * is translated to the corresponding escape sequence; otherwise the
 * string is written as-is.
 */
export function sendKey(stdin: { write: (data: string) => void }, key: string): void {
  const bytes = KEY_MAP[key] ?? key;
  stdin.write(bytes);
}
