// ─── Plan-generator timeout utility ──────────────────────────────────────
//
// Stateless timeout machinery extracted from `session-scheduler.ts` so that
// workflow code outside the scheduler can wrap its own plan generators with
// the same grace-period semantics. `withTimeout` races an inner promise
// against a `setTimeout`, rejecting with a `GeneratorTimeoutError` when the
// timeout fires first and clearing the timer when the inner promise settles
// first (resolve OR reject), so no timer leak lingers.

/** Grace period for plan-generator operations (gen.next / gen.return) before
 *  the scheduler gives up and treats the operation as hung. A leaked
 *  generator is preferred over blocking the scheduler indefinitely. */
export const GENERATOR_TIMEOUT_MS = 5_000;

/** Default label used when a caller does not supply a `label` argument. */
const DEFAULT_LABEL = 'plan generator operation';

/**
 * Error raised by {@link withTimeout} when a plan-generator operation
 * (gen.next / gen.return) does not settle within its grace period.
 *
 * This is a dedicated error class so callers can distinguish a generator/plan
 * timeout from a genuine error thrown by the wrapped promise — the catch
 * blocks in `SessionScheduler.nextNonEmptyBatch` and `cleanupGenerator`
 * swallow it to keep the scheduler running after a hung generator rather than
 * failing the task.
 */
export class GeneratorTimeoutError extends Error {
  /** Label identifying the operation that timed out (e.g. 'plan generator next()'). */
  readonly label: string;
  /** The grace period, in milliseconds, that elapsed before the timeout fired. */
  readonly ms: number;

  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'GeneratorTimeoutError';
    this.label = label;
    this.ms = ms;
  }
}

/**
 * Race a promise against a timeout. If the timeout fires first, the returned
 * promise rejects with a {@link GeneratorTimeoutError} mentioning `label`.
 *
 * The timeout timer is cleared via `.then()` callbacks when the promise
 * settles first (resolve OR reject), so no timer leak lingers. When the
 * timeout fires first the timer has already executed; a later settle still
 * calls `clearTimeout` on the already-fired timer (a harmless no-op).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new GeneratorTimeoutError(label ?? DEFAULT_LABEL, ms));
    }, ms);
    // Don't let the timeout timer keep the process alive.
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as { unref?(): void }).unref?.();
    }
    p.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
