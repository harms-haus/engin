// ─── Session Watchdog ─────────────────────────────────────────────────────
//
// Reusable activity-based idle watchdog extracted from `session.ts`.
//
// `createSessionWatchdog` returns a small handle with three methods —
// `arm`, `race`, and `dispose` — that together implement the same semantics
// previously embedded inline inside `executeAttempt`:
//
//   - `arm()`: clear any in-flight timer and arm a fresh `setTimeout` whose
//     callback invokes the captured `onTimeout` (abort) callback and then
//     rejects the shared watchdog promise with a `WatchdogTimeoutError`.
//   - `race(work)`: race `work` against the watchdog promise, pre-attaching a
//     no-op `.catch` to `work` so a late abort-triggered rejection never
//     surfaces as unhandled.
//   - `dispose()`: clear the timer.
//
// When `timeoutMs` is undefined the watchdog is disabled: `arm` and `dispose`
// are no-ops and `race` returns `work` unchanged (same reference).

/**
 * Sentinel error thrown when the watchdog timer fires.
 *
 * EXPORTED so workflow code building custom session primitives can catch and
 * distinguish a watchdog timeout from other failures.
 */
export class WatchdogTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Session watchdog timed out after ${timeoutMs}ms of inactivity`);
    this.name = 'WatchdogTimeoutError';
  }
}

/** Handle returned by {@link createSessionWatchdog}. */
export interface SessionWatchdog {
  /** Clear any in-flight timer and arm a fresh idle window. No-op when the
   *  watchdog is disabled (`timeoutMs === undefined`). */
  arm(): void;
  /** Race `work` against the watchdog. When the watchdog is disabled, returns
   *  `work` unchanged (same reference). Otherwise races `work` against the
   *  shared watchdog promise and pre-attaches a no-op `.catch` to `work` so a
   *  late abort-triggered rejection never surfaces as unhandled. */
  race<T>(work: Promise<T>): Promise<T>;
  /** Clear the in-flight timer. No-op when already cleared or when the
   *  watchdog is disabled. */
  dispose(): void;
}

/**
 * Create a reusable activity-based idle watchdog.
 *
 * @param timeoutMs  Idle window in milliseconds. When `undefined` the watchdog
 *                   is disabled (all methods are no-ops / pass-through).
 * @param onTimeout  Invoked (without `await`) when the timer fires — typically
 *                   `() => session.abort().catch(() => {})`.
 */
export function createSessionWatchdog(timeoutMs: number | undefined, onTimeout?: () => void): SessionWatchdog {
  // Shared reject wired by `race` and triggered by the timer callback.
  let watchdogReject: ((reason: unknown) => void) | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs === undefined) {
    return {
      arm() {
        /* disabled — no-op */
      },
      race<T>(work: Promise<T>): Promise<T> {
        return work;
      },
      dispose() {
        /* disabled — no-op */
      },
    };
  }

  const arm = (): void => {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      onTimeout?.();
      watchdogReject?.(new WatchdogTimeoutError(timeoutMs));
    }, timeoutMs);
  };

  const race = <T>(work: Promise<T>): Promise<T> => {
    const watchdogPromise = new Promise<never>((_, reject) => {
      watchdogReject = reject;
    });
    // Pre-attach a no-op catch so that when the watchdog wins and the abort
    // propagates into `work`, the resulting rejection is swallowed.
    work.catch(() => {
      /* swallow abort-triggered rejection from the raced loser */
    });
    const raced = Promise.race([work, watchdogPromise]) as Promise<T>;
    // Pre-attach a no-op catch to the race result so that when the watchdog
    // fires and the caller does not await the result, the rejection never
    // surfaces as unhandled. Awaiting `raced` still throws normally.
    raced.catch(() => {
      /* swallow unawaited watchdog rejection */
    });
    return raced;
  };

  const dispose = (): void => {
    if (watchdogTimer !== undefined) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  };

  return { arm, race, dispose };
}
