// ─── Tests for pool/session-watchdog.ts — extracted session watchdog ───────
//
// These are RED-team characterization tests for the extraction of the
// activity-based idle watchdog that was previously embedded inline inside
// `executeAttempt` in `session.ts`.
//
// The target module `./session-watchdog.js` does NOT exist yet (it will be
// created by the green/implement phase), so every test below is expected to
// FAIL until that module exports:
//
//   - `createSessionWatchdog(timeoutMs: number | undefined, onTimeout?: () => void)`
//     → `{ arm(): void; race<T>(work: Promise<T>): Promise<T>; dispose(): void }`
//   - `export class WatchdogTimeoutError extends Error`
//
// The semantics pinned here mirror the EXACT current inline behavior of
// `session.ts`:
//   - `arm()`: when `timeoutMs` is undefined → no-op; otherwise clear any
//     existing timer and arm a fresh `setTimeout` whose callback invokes the
//     captured `onTimeout` (abort) callback and then rejects the shared
//     watchdog promise with `new WatchdogTimeoutError(timeoutMs)`.
//   - `race(work)`: when `timeoutMs` is undefined → return `work` UNCHANGED
//     (same reference); otherwise race `work` against the watchdog promise
//     (wired to the captured reject) and pre-attach a no-op `.catch` to
//     `work` so a late abort-triggered rejection never surfaces as unhandled.
//   - `dispose()`: clear the timer (no-op if already cleared or if
//     `timeoutMs` was undefined).
//
// These tests MUST go RED against the current code (module missing) then
// GREEN once the green team implements the extraction. The existing
// `session.test.ts` (which exercises the watchdog end-to-end via `runSession`)
// MUST continue to pass unchanged.

import { describe, expect, it, mock } from 'bun:test';

// Import directly from the (to-be-created) module. This import fails today.
import { createSessionWatchdog, WatchdogTimeoutError } from './session-watchdog.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that never settles (used to force the watchdog to win the race). */
function neverSettles<T = never>(): Promise<T> {
  return new Promise<T>(() => {
    /* never resolves / rejects */
  });
}

const noopAbort = (): void => {
  /* mimic session.abort().catch(() => {}) — swallow everything */
};

// ─── Tests ────────────────────────────────────────────────────────────────

describe('createSessionWatchdog', () => {
  // ── (a) timeoutMs undefined → race returns work unchanged; arm/dispose no-op
  describe('when timeoutMs is undefined', () => {
    it('race(work) returns the exact same promise reference (no wrapping)', async () => {
      const watchdog = createSessionWatchdog(undefined, noopAbort);
      const work = Promise.resolve('value');
      // MUST be the identical reference — the disabled watchdog does not race.
      expect(watchdog.race(work)).toBe(work);
      const result = await work;
      expect(result).toBe('value');
    });

    it('arm() is a no-op (no timer ever fires, no abort)', async () => {
      const onTimeout = mock(noopAbort);
      const watchdog = createSessionWatchdog(undefined, onTimeout);
      watchdog.arm();
      watchdog.arm(); // calling multiple times is also a no-op
      await delay(60);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('dispose() is a no-op and does not throw (no timer was ever set)', () => {
      const watchdog = createSessionWatchdog(undefined, noopAbort);
      expect(() => watchdog.dispose()).not.toThrow();
      // Calling dispose before arm / multiple times is also safe.
      expect(() => {
        watchdog.dispose();
        watchdog.dispose();
      }).not.toThrow();
    });

    it('race() with a rejecting work propagates the rejection as-is (no watchdog wrapping)', async () => {
      const watchdog = createSessionWatchdog(undefined, noopAbort);
      const cause = new Error('boom');
      await expect(watchdog.race(Promise.reject(cause))).rejects.toBe(cause);
    });
  });

  // ── (c) timeout fires → race rejects with WatchdogTimeoutError
  describe('when the timeout fires', () => {
    it('race(work) rejects with a WatchdogTimeoutError', async () => {
      const watchdog = createSessionWatchdog(30, noopAbort);
      const raced = watchdog.race(neverSettles());
      // Arm must be called for the timer to be scheduled.
      watchdog.arm();

      let caught: unknown;
      try {
        await raced;
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(WatchdogTimeoutError);
      expect((caught as Error).name).toBe('WatchdogTimeoutError');
      // Message echoes the configured timeout window and the "inactivity" label.
      expect((caught as Error).message).toContain('30');
      expect((caught as Error).message).toMatch(/inactivity/);
    });

    it('race resolves with the timeoutMs passed to the constructor (echoed in error message)', async () => {
      const watchdog = createSessionWatchdog(250, noopAbort);
      const raced = watchdog.race(neverSettles());
      watchdog.arm();

      let caught: unknown;
      try {
        await raced;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WatchdogTimeoutError);
      expect((caught as Error).message).toContain('250ms');
    });
  });

  // ── (f) the abort (onTimeout) callback is invoked when the timer fires
  describe('abort callback', () => {
    it('onTimeout is invoked exactly once when the timer fires', async () => {
      const onTimeout = mock(noopAbort);
      const watchdog = createSessionWatchdog(25, onTimeout);
      watchdog.race(neverSettles());
      watchdog.arm();

      // Give the timer time to fire (a little beyond the window).
      await delay(80);

      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('onTimeout is NOT invoked when work wins before the window elapses', async () => {
      const onTimeout = mock(noopAbort);
      const watchdog = createSessionWatchdog(200, onTimeout);
      // Work resolves almost immediately — well inside the 200ms window.
      const raced = watchdog.race(delay(5).then(() => 'ok'));
      watchdog.arm();

      const result = await raced;
      expect(result).toBe('ok');

      // Clean up (mirrors the finally block in executeAttempt).
      watchdog.dispose();
      // Wait beyond the original window to be sure the timer was cleared.
      await delay(60);
      expect(onTimeout).not.toHaveBeenCalled();
    });
  });

  // ── (b) arm() resets any in-flight timer (double-arm does not double-fire)
  describe('arm() timer reset', () => {
    it('calling arm() multiple times schedules only one fire (no double-fire)', async () => {
      const onTimeout = mock(noopAbort);
      const watchdog = createSessionWatchdog(40, onTimeout);
      // Capture the shared reject via race() first, then arm several times.
      const raced = watchdog.race(neverSettles());
      watchdog.arm();
      watchdog.arm();
      watchdog.arm();

      let caught: unknown;
      try {
        await raced;
      } catch (err) {
        caught = err;
      }

      // The watchdog still wins (reject fires exactly once).
      expect(caught).toBeInstanceOf(WatchdogTimeoutError);
      // The abort callback fires exactly once despite three arm() calls —
      // each arm() must have cleared the previous in-flight timer.
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('a later arm() re-arms the window so the earlier deadline does not fire early', async () => {
      // Window of 80ms. We re-arm after ~35ms and assert the abort does NOT
      // happen at the *original* deadline (t≈80ms), only at the re-armed one
      // (t≈115ms). This distinguishes "arm clears the prior timer" from
      // "arm leaks the prior timer".
      const onTimeout = mock(noopAbort);
      const watchdog = createSessionWatchdog(80, onTimeout);
      watchdog.race(neverSettles());
      watchdog.arm(); // deadline ≈ t=80

      // Re-arm before the original deadline elapses.
      await delay(35); // t≈35
      watchdog.arm(); // clears prior; new deadline ≈ t=115

      // Past the ORIGINAL deadline (80ms) but BEFORE the re-armed one (115ms).
      // If arm() failed to clear, the abort would have fired here.
      await delay(55); // t≈90
      expect(onTimeout).not.toHaveBeenCalled();

      // Now wait past the re-armed deadline (t≈115); it fires exactly once.
      await delay(50); // t≈140
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });
  });

  // ── (d) work wins → result returned, timer cleared, no late rejection leaks
  describe('when work wins the race', () => {
    it('race resolves with the value of work', async () => {
      const watchdog = createSessionWatchdog(50, noopAbort);
      const raced = watchdog.race(Promise.resolve('winner'));
      watchdog.arm();
      await expect(raced).resolves.toBe('winner');
    });

    it('dispose() clears the in-flight timer after work wins (no late fire)', async () => {
      const onTimeout = mock(noopAbort);
      const watchdog = createSessionWatchdog(30, onTimeout);
      const raced = watchdog.race(Promise.resolve('winner'));
      watchdog.arm();
      await raced;
      watchdog.dispose();
      await delay(80);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('a late abort-triggered rejection from work does NOT leak as unhandled', async () => {
      // Mirrors the session.test.ts REGRESSION case but at the factory level.
      // The pre-attached no-op `.catch` on `work` must swallow the late reject.
      let rejectWork!: (err: unknown) => void;
      const work = new Promise<string>((_, reject) => {
        rejectWork = reject;
      });

      const watchdog = createSessionWatchdog(20, noopAbort);
      const raced = watchdog.race(work);
      watchdog.arm();

      // Watchdog fires first → race rejects with WatchdogTimeoutError.
      await expect(raced).rejects.toBeInstanceOf(WatchdogTimeoutError);

      const unhandled: unknown[] = [];
      const handler = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', handler);
      try {
        // Now work rejects late (abort propagation). This MUST be swallowed by
        // the no-op `.catch` pre-attached inside race().
        rejectWork(new Error('late abort-triggered rejection'));
        // Allow microtasks + a macrotask to flush any would-be rejection.
        await delay(60);
        expect(unhandled).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', handler);
      }
    });
  });

  // ── (e) dispose() clears the timer
  describe('dispose()', () => {
    it('clears the in-flight timer so the watchdog never fires', async () => {
      const onTimeout = mock(noopAbort);
      const watchdog = createSessionWatchdog(30, onTimeout);
      watchdog.race(neverSettles());
      watchdog.arm();
      watchdog.dispose();

      await delay(80);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('is idempotent: calling dispose() multiple times is safe', async () => {
      const onTimeout = mock(noopAbort);
      const watchdog = createSessionWatchdog(30, onTimeout);
      watchdog.race(neverSettles());
      watchdog.arm();
      expect(() => {
        watchdog.dispose();
        watchdog.dispose();
        watchdog.dispose();
      }).not.toThrow();
      await delay(80);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('clears the timer even after re-arming (dispose cancels the latest timer)', async () => {
      const onTimeout = mock(noopAbort);
      const watchdog = createSessionWatchdog(30, onTimeout);
      watchdog.race(neverSettles());
      watchdog.arm();
      await delay(10);
      watchdog.arm(); // re-arm → fresh 30ms window
      watchdog.dispose(); // cancel it
      await delay(80);
      expect(onTimeout).not.toHaveBeenCalled();
    });
  });
});

// ─── WatchdogTimeoutError class contract ───────────────────────────────────

describe('WatchdogTimeoutError', () => {
  it('is an Error subclass', () => {
    const err = new WatchdogTimeoutError(123);
    expect(err).toBeInstanceOf(Error);
  });

  it('has name === "WatchdogTimeoutError"', () => {
    const err = new WatchdogTimeoutError(123);
    expect(err.name).toBe('WatchdogTimeoutError');
  });

  it('message echoes the timeout window in ms and mentions inactivity', () => {
    const err = new WatchdogTimeoutError(4242);
    expect(err.message).toContain('4242ms');
    expect(err.message).toMatch(/inactivity/);
  });
});

// ─── Reachability from the package entrypoint (NEW public export) ──────────
//
// `WatchdogTimeoutError` is currently module-private in session.ts and NOT
// reachable via `pool/index.ts` or the package root. After the green phase it
// must be exported from `session-watchdog.js`, re-exported by `pool/index.ts`,
// and therefore reachable from the package entrypoint (`src/index.ts`).

describe('package reachability', () => {
  it('is re-exported from the pool barrel (./index.js)', async () => {
    const poolBarrel = await import('./index.js');
    expect(poolBarrel.createSessionWatchdog).toBeTypeOf('function');
    expect(poolBarrel.WatchdogTimeoutError).toBeTypeOf('function');
  });

  it('is reachable from the package entrypoint (../index.js)', async () => {
    const rootBarrel: any = await import('../index.js');
    expect(rootBarrel.createSessionWatchdog).toBeTypeOf('function');
    expect(rootBarrel.WatchdogTimeoutError).toBeTypeOf('function');
  });
});
