// ─── Tests for cli/prompt.ts — readline yes/No helper ───────────────────────
//
// Drives the EXTRACTION of `promptYesNo` out of the monolithic `commands.ts`
// into its own `prompt.ts` module, and the CONSOLIDATION of the duplicate
// `confirmStop` helper into this single `promptYesNo`.
//
// `promptYesNo` is not directly injectable (it creates its own readline
// interface against process.stdin/stdout), so we mock `node:readline` to feed
// canned answers and capture the rendered prompt string. The mock is
// process-global, but no other test file in this package invokes a readline
// code path, so the leak is contained.
//
// Module under test: ./prompt.js

import { describe, expect, it, mock } from 'bun:test';

// ─── Per-test mock state ────────────────────────────────────────────────────
//
// Mutated by individual `it(...)` blocks before invoking `promptYesNo`. The
// mock factory closes over these module-level bindings, so changing them in a
// test body changes what the next `createInterface()` call returns.

let nextAnswer = '';
/** When true, simulate stdin reaching EOF before any answer is read. */
let eof = false;
/** Every prompt string handed to `rl.question(...)`, most-recent last. */
const capturedPrompts: string[] = [];
/** Registered `'close'` listeners on the fake interface. */
let closeListeners: Array<() => void> = [];

mock.module('node:readline', () => ({
  createInterface: (_opts: unknown) => ({
    question(prompt: string, cb: (answer: string) => void): void {
      capturedPrompts.push(prompt);
      if (!eof) {
        // Defer to keep async semantics like real readline.
        queueMicrotask(() => cb(nextAnswer));
      }
      // When `eof` is true, never invoke `cb` — the close handler (fired
      // below) resolves the promise, exactly like real stdin EOF.
    },
    on(event: string, listener: () => void): void {
      if (event === 'close') {
        closeListeners.push(listener);
        if (eof) {
          // stdin already at EOF when the handler is attached → fire it.
          queueMicrotask(() => listener());
        }
      }
    },
    close(): void {
      for (const listener of closeListeners) listener();
    },
  }),
}));

// Imported AFTER mock.module is registered (bun applies the mock to hoisted
// imports of the builtin, verified empirically).
import { promptYesNo } from './prompt.js';

/** Reset all mutable mock state between tests for independence. */
function resetMock(): void {
  nextAnswer = '';
  eof = false;
  closeListeners = [];
  capturedPrompts.length = 0;
}

// ─── Affirmative answers ────────────────────────────────────────────────────

describe('promptYesNo — affirmative answers', () => {
  it('returns true for "y" (default false)', async () => {
    resetMock();
    nextAnswer = 'y';
    expect(await promptYesNo('continue?', false)).toBe(true);
  });

  it('returns true for "yes" (default true)', async () => {
    resetMock();
    nextAnswer = 'yes';
    expect(await promptYesNo('continue?', true)).toBe(true);
  });

  it('is case-insensitive: "YES", "Yes", "Y" are all affirmative', async () => {
    for (const ans of ['YES', 'Yes', 'Y', 'yEs']) {
      resetMock();
      nextAnswer = ans;
      expect(await promptYesNo('continue?', false)).toBe(true);
    }
  });

  it('trims surrounding whitespace before matching', async () => {
    resetMock();
    nextAnswer = '  yes  ';
    expect(await promptYesNo('continue?', false)).toBe(true);
  });
});

// ─── Non-affirmative answers ────────────────────────────────────────────────

describe('promptYesNo — non-affirmative answers', () => {
  it('returns false for "n" / "no" regardless of default', async () => {
    for (const ans of ['n', 'no', 'NO', 'No']) {
      resetMock();
      nextAnswer = ans;
      // default true would be returned only for empty input; an explicit
      // "no" must still be non-affirmative.
      expect(await promptYesNo('continue?', true)).toBe(false);
    }
  });

  it('returns false for arbitrary non-yes text', async () => {
    for (const ans of ['nope', 'xyz', '1', '0', 'true', 'maybe']) {
      resetMock();
      nextAnswer = ans;
      expect(await promptYesNo('continue?', false)).toBe(false);
    }
  });
});

// ─── Default value (empty input) ────────────────────────────────────────────

describe('promptYesNo — empty input falls back to defaultValue', () => {
  it('empty input → true when defaultValue is true', async () => {
    resetMock();
    nextAnswer = '';
    expect(await promptYesNo('continue?', true)).toBe(true);
  });

  it('empty input → false when defaultValue is false', async () => {
    resetMock();
    nextAnswer = '';
    expect(await promptYesNo('continue?', false)).toBe(false);
  });
});

// ─── EOF / stdin close ──────────────────────────────────────────────────────

describe('promptYesNo — stdin closes without input (EOF)', () => {
  it('resolves to defaultValue=true on EOF', async () => {
    resetMock();
    eof = true;
    expect(await promptYesNo('continue?', true)).toBe(true);
  });

  it('resolves to defaultValue=false on EOF', async () => {
    resetMock();
    eof = true;
    expect(await promptYesNo('continue?', false)).toBe(false);
  });
});

// ─── Prompt rendering ───────────────────────────────────────────────────────

describe('promptYesNo — prompt hint rendering', () => {
  it('renders the [Y/n] hint when default is true', async () => {
    resetMock();
    nextAnswer = 'y';
    await promptYesNo('Continue?', true);
    expect(capturedPrompts.at(-1)).toBe('Continue? [Y/n] ');
  });

  it('renders the [y/N] hint when default is false', async () => {
    resetMock();
    nextAnswer = 'n';
    await promptYesNo('Continue?', false);
    expect(capturedPrompts.at(-1)).toBe('Continue? [y/N] ');
  });

  it('includes the caller-supplied prompt text verbatim', async () => {
    resetMock();
    nextAnswer = 'y';
    await promptYesNo('Warning: not a git repo. Proceed?', false);
    expect(capturedPrompts.at(-1)).toContain('Warning: not a git repo. Proceed?');
  });
});

// ─── Consolidation: promptYesNo replaces the old confirmStop ────────────────
//
// The former private `confirmStop(activeRuns)` helper (server down) asked
// "<n> active run(s) in progress. Stop the server anyway? [y/N]" and returned
// true only on y/yes, false otherwise (default false, EOF→false). After
// consolidation this exact behavior is served by `promptYesNo(prompt, false)`.
// These tests pin the consolidated contract so a regression to a separate
// duplicate helper is caught.

describe('promptYesNo — consolidated confirmStop use-case (default false)', () => {
  const STOP_PROMPT = '3 active run(s) in progress. Stop the server anyway?';

  it('returns true on "y"', async () => {
    resetMock();
    nextAnswer = 'y';
    expect(await promptYesNo(STOP_PROMPT, false)).toBe(true);
  });

  it('returns false on "n"', async () => {
    resetMock();
    nextAnswer = 'n';
    expect(await promptYesNo(STOP_PROMPT, false)).toBe(false);
  });

  it('returns false on empty input (safe default — do not stop)', async () => {
    resetMock();
    nextAnswer = '';
    expect(await promptYesNo(STOP_PROMPT, false)).toBe(false);
  });

  it('returns false on EOF (safe default — do not stop)', async () => {
    resetMock();
    eof = true;
    expect(await promptYesNo(STOP_PROMPT, false)).toBe(false);
  });
});
