// ─── Hardening regression tests for EventStore ──────────────────────────────
//
// Pins two safety mechanisms in `EventStore` that previously had no dedicated
// coverage. `just_tests` mode — these exercise EXISTING code and must PASS.
//
//   1. Subscriber leak after dispose
//      `dispose()` clears the subscriber Set, but `subscribe()` has NO
//      `disposed` guard. A subscriber added AFTER dispose is silently inert:
//      `append()` is a complete no-op once disposed (it never iterates
//      subscribers), so the callback never fires. These tests lock that
//      contract so a future refactor cannot accidentally make post-dispose
//      subscribers fire — or drop the subscriber clear.
//
//   2. Write-queue backpressure exhaustion
//      After MAX_CONSECUTIVE_WRITE_FAILURES (10) consecutive disk-write
//      failures the store stops attempting disk writes (preventing unbounded
//      promise-chain growth under sustained disk failure), while the in-memory
//      ring buffer + projection keep updating. Only persistence is
//      short-circuited; once stopped it stays stopped.
//
// ── Leak-free strategy ─────────────────────────────────────────────────────
// NO `mock.module('node:fs/promises')` is used — that would leak process-globally
// and silently break sibling suites (e.g. `auditor.test.ts`) that rely on real
// `appendFile`. Instead:
//   • Disk failures are induced by pointing the store at an UNWRITABLE path
//     (a workDir nested under a regular file → `mkdir` throws ENOTDIR), so
//     every drain's `ensureDir()` fails and `consecutiveWriteFailures` climbs.
//   • Write attempts are counted via `persistError` (the module-load-time
//     `console.error` reference): each failed attempt logs exactly one
//     "Failed to persist events" line, and the backpressure guard logs a
//     "…consecutive write failures…" warning at exactly the 10th. A fresh
//     dynamic import (query-string suffix, the spike-replay pattern) forces
//     event-store to re-bind `persistError` to our spy regardless of whether
//     another test file already loaded it. The spy passes through to the real
//     `console.error` so sibling output is never suppressed.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Capture the real console.error, then install a pass-through spy ─────────
const realConsoleError = console.error;
const errorCalls: unknown[][] = [];
const errorSpy = mock((...args: unknown[]) => {
  errorCalls.push(args);
  // Pass through so sibling test files' console output is not suppressed while
  // this spy is active.
  realConsoleError(...args);
});
console.error = errorSpy;

// ── Fresh EventStore load (query string defeats module dedup) ──────────────
// A runtime-built specifier keeps tsc from statically resolving the query
// string, and forces a fresh module instance whose body re-binds `persistError`
// to the spy above — independent of any other test file that loaded event-store
// earlier in the process.
const eventStoreSpecifier = './event-store.js?hardening=1';
const { EventStore } = (await import(/* @vite-ignore */ eventStoreSpecifier)) as typeof import('./event-store.js');

afterAll(() => {
  console.error = realConsoleError;
});

// ── Helpers ────────────────────────────────────────────────────────────────
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'es-hardening-'));
}

/** EventStore.MAX_CONSECUTIVE_WRITE_FAILURES — mirrored here as a constant. */
const BACKPRESSURE_LIMIT = 10;

function isFailedToPersist(args: unknown[]): boolean {
  return typeof args[0] === 'string' && (args[0] as string).includes('Failed to persist events');
}

function isBackpressureWarning(args: unknown[]): boolean {
  return typeof args[0] === 'string' && (args[0] as string).includes('consecutive write failures');
}

/** Count of write ATTEMPTS so far (one "Failed to persist events" log per attempt). */
function failedWriteAttempts(): number {
  return errorCalls.filter(isFailedToPersist).length;
}

/** Count of backpressure-guard warnings emitted so far. */
function backpressureWarnings(): number {
  return errorCalls.filter(isBackpressureWarning).length;
}

/**
 * Build a workDir whose creation always fails: `workDir` is nested under a
 * regular FILE, so `mkdir(workDir, { recursive: true })` throws ENOTDIR on
 * every drain (dirEnsured never flips true). Returns the workDir + a cleanup fn.
 */
function unwritableWorkDir(): { workDir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'es-bp-'));
  const workDir = join(parent, 'blocker', 'sub');
  writeFileSync(join(parent, 'blocker'), 'i am a regular file, not a directory');
  return {
    workDir,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}

// ─── 1. Subscriber leak after dispose ──────────────────────────────────────
describe('EventStore hardening — subscriber leak after dispose', () => {
  let dir: string;

  beforeEach(() => {
    errorCalls.length = 0;
    dir = tempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('subscribe() after dispose(): the returned unsubscribe fn does not throw', () => {
    const store = new EventStore(dir);
    store.dispose();

    const cb = mock(() => {});
    // subscribe() has no `disposed` guard, so this must not throw.
    const unsubscribe = store.subscribe(cb);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('append() after dispose() does NOT invoke a subscriber added after dispose (append is a no-op)', () => {
    const store = new EventStore(dir);
    store.dispose();

    const cb = mock(() => {});
    store.subscribe(cb);

    const rec = store.append('workflow_started', { taskPrompt: 'post-dispose' });

    // The post-dispose subscriber never fires.
    expect(cb).not.toHaveBeenCalled();
    // And no disk write is attempted for the no-op append.
    expect(failedWriteAttempts()).toBe(0);

    // append still returns a synthetic record carrying the next seq so callers
    // that assign seq keep counting…
    expect(rec.type).toBe('workflow_started');
    expect(rec.seq).toBe(1);
    // …but the projection + ring buffer are frozen (no side effects).
    expect(store.getEventsSince(0)).toHaveLength(0);
    expect(store.getSnapshot().seq).toBe(1);
  });

  it('subscribe() then dispose(): post-dispose operations do not invoke the callback; unsubscribe works post-dispose', () => {
    const store = new EventStore(dir);
    const cb = mock(() => {});
    const unsubscribe = store.subscribe(cb);

    // Pre-dispose append fires the subscriber normally (sanity: mechanism works).
    store.append('workflow_started', { taskPrompt: 'pre-dispose' });
    expect(cb).toHaveBeenCalledTimes(1);

    store.dispose(); // clears the subscriber Set

    // Post-dispose appends are no-ops — the cleared callback never fires again.
    store.append('workflow_started', { taskPrompt: 'post-1' });
    store.append('workflow_data_set', { counter: 99 });
    expect(cb).toHaveBeenCalledTimes(1); // unchanged

    // No writes attempted after dispose either.
    expect(failedWriteAttempts()).toBe(0);

    // Unsubscribe is safe to call after dispose.
    expect(() => unsubscribe()).not.toThrow();
  });

  it('dispose() is idempotent for subscribers: a second dispose keeps them inert', () => {
    const store = new EventStore(dir);
    const cb = mock(() => {});
    store.subscribe(cb);
    store.dispose();
    expect(() => store.dispose()).not.toThrow(); // second dispose is a no-op

    store.append('workflow_started', { taskPrompt: 'x' });
    expect(cb).not.toHaveBeenCalled();
  });
});

// ─── 2. Write-queue backpressure exhaustion ────────────────────────────────
describe('EventStore hardening — write-queue backpressure exhaustion', () => {
  let env: { workDir: string; cleanup: () => void };

  beforeEach(() => {
    errorCalls.length = 0;
    env = unwritableWorkDir();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('stops attempting disk writes after EXACTLY MAX_CONSECUTIVE_WRITE_FAILURES (10) consecutive failures', async () => {
    const store = new EventStore(env.workDir);

    // First 9 consecutive failures: writes are still attempted on each flush.
    for (let i = 0; i < 9; i++) {
      store.append('workflow_data_set', { counter: i });
      await store.flush();
    }
    expect(failedWriteAttempts()).toBe(9);
    expect(backpressureWarnings()).toBe(0);

    // 10th consecutive failure trips the guard.
    store.append('workflow_data_set', { counter: 9 });
    await store.flush();
    expect(failedWriteAttempts()).toBe(BACKPRESSURE_LIMIT);
    expect(backpressureWarnings()).toBe(1);

    // The very next drain short-circuits — no 11th write attempt.
    store.append('workflow_data_set', { counter: 10 });
    await store.flush();
    expect(failedWriteAttempts()).toBe(BACKPRESSURE_LIMIT);
    expect(backpressureWarnings()).toBe(1);
  });

  it('once stopped, stays stopped: further append+flush cycles make no more write attempts', async () => {
    const store = new EventStore(env.workDir);
    // Trip the guard.
    for (let i = 0; i < BACKPRESSURE_LIMIT; i++) {
      store.append('workflow_data_set', { counter: i });
      await store.flush();
    }
    expect(failedWriteAttempts()).toBe(BACKPRESSURE_LIMIT);

    // Pile on many more — writes are permanently short-circuited.
    for (let i = 0; i < 15; i++) {
      store.append('workflow_data_set', { counter: 100 + i });
      await store.flush();
    }
    expect(failedWriteAttempts()).toBe(BACKPRESSURE_LIMIT);
    expect(backpressureWarnings()).toBe(1);
  });

  it('in-memory projection keeps evolving after disk writes stop', async () => {
    const store = new EventStore(env.workDir);
    for (let i = 0; i < 15; i++) {
      store.append('workflow_data_set', { counter: i });
      await store.flush();
    }
    // Disk writes stopped at 10, but evolve() ran for ALL 15 appends.
    const projection = store.getProjection();
    expect(projection.workflowData?.counter).toBe(14);
    expect(store.getSnapshot().seq).toBe(15);
  });

  it('in-memory ring buffer keeps accumulating records after disk writes stop', async () => {
    const store = new EventStore(env.workDir);
    for (let i = 0; i < 15; i++) {
      store.append('workflow_data_set', { counter: i });
      await store.flush();
    }
    const events = store.getEventsSince(0);
    expect(events).toHaveLength(15);
    expect(events[14].seq).toBe(15);
    expect(events[14].data.counter).toBe(14);
  });

  it('backpressure warning fires at EXACTLY the 10th consecutive failure (not before, not repeated) and names the limit', async () => {
    const store = new EventStore(env.workDir);

    for (let i = 0; i < 9; i++) {
      store.append('workflow_data_set', { counter: i });
      await store.flush();
    }
    expect(backpressureWarnings()).toBe(0); // 9 failures — no warning yet

    store.append('workflow_data_set', { counter: 9 });
    await store.flush();
    expect(backpressureWarnings()).toBe(1); // 10th failure emits it exactly once

    // Suppressed subsequent attempts never repeat the warning.
    for (let i = 0; i < 5; i++) {
      store.append('workflow_data_set', { counter: 100 + i });
      await store.flush();
    }
    expect(backpressureWarnings()).toBe(1);

    // The warning text names the 10-failure limit.
    const warningArgs = errorCalls.find(isBackpressureWarning)!;
    expect((warningArgs[0] as string).includes('10')).toBe(true);
  });

  it('a successful write resets the failure streak so intermittent failures do NOT trip backpressure', async () => {
    // Drive the workDir through three phases by toggling its writability:
    //   phase 1 — unwritable (mkdir ENOTDIR): 5 consecutive failures.
    //   phase 2 — writable:        1 success → streak resets to 0.
    //   phase 3 — unwritable again: 9 more failures (streak tops out at 9).
    // Net: 14 total failures but never 10-in-a-row → no backpressure trip.
    const parent = mkdtempSync(join(tmpdir(), 'es-reset-'));
    const blocker = join(parent, 'blocker');
    const workDir = join(blocker, 'sub');
    try {
      writeFileSync(blocker, 'regular file'); // phase 1: mkdir under it → ENOTDIR
      const store = new EventStore(workDir);

      for (let i = 0; i < 5; i++) {
        store.append('workflow_data_set', { counter: i });
        await store.flush();
      }
      expect(failedWriteAttempts()).toBe(5);

      // phase 2: make blocker a real directory so mkdir(workDir) succeeds and
      // appendFile writes successfully → consecutiveWriteFailures resets to 0.
      rmSync(blocker);
      mkdirSync(blocker);
      store.append('workflow_data_set', { counter: 5 });
      await store.flush();
      expect(failedWriteAttempts()).toBe(5); // success logs nothing
      expect(backpressureWarnings()).toBe(0);

      // phase 3: remove the dir again so appendFile hits ENOENT. dirEnsured is
      // already true (set during the successful write), so ensureDir is skipped
      // and appendFile is called directly on the now-missing path.
      rmSync(blocker, { recursive: true, force: true });
      for (let i = 0; i < 9; i++) {
        store.append('workflow_data_set', { counter: 10 + i });
        await store.flush();
      }
      // 5 + 9 = 14 attempts, but the streak never reached 10 → no trip.
      expect(failedWriteAttempts()).toBe(14);
      expect(backpressureWarnings()).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
