// ─── Tests for pool/scheduler-timeout.ts ──────────────────────────────────
//
// Characterization tests for the extracted plan-generator timeout utility.
// `scheduler-timeout.ts` is a NEW module — it pulls the stateless timeout
// machinery that used to live inline in `session-scheduler.ts` (the private
// `SessionScheduler#withTimeout` method, the `GeneratorTimeoutError` class,
// and the `GENERATOR_TIMEOUT_MS` const) out into a standalone, reusable unit.
//
// This extraction must be behavior-preserving: the standalone `withTimeout`
// function races an inner promise against a setTimeout, rejects with a
// `GeneratorTimeoutError` when the timeout fires first, clears the timer when
// the inner promise settles first (resolve OR reject), and `unref`s the timer
// so it cannot keep the event loop alive. These tests pin that contract so the
// green team's extraction is provably faithful to the original.

import { describe, expect, it } from 'bun:test';

// Primary target — the NEW module. These named imports will fail to resolve
// until the green team creates `scheduler-timeout.ts`; that failure IS the RED
// state the TDD phase hands off.
import { GENERATOR_TIMEOUT_MS, GeneratorTimeoutError, withTimeout } from './scheduler-timeout.js';

// ─── Timer spies ───────────────────────────────────────────────────────────

/** Install spies on global setTimeout/clearTimeout that record created timers,
 *  cleared timers, and whether each created timer was `unref`'d. Returns
 *  accessors + a restore() function. */
function spyTimers(): {
  createdTimers: ReturnType<typeof setTimeout>[];
  clearedTimers: ReturnType<typeof setTimeout>[];
  unrefedTimers: ReturnType<typeof setTimeout>[];
  restore(): void;
} {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const createdTimers: ReturnType<typeof setTimeout>[] = [];
  const clearedTimers: ReturnType<typeof setTimeout>[] = [];
  const unrefedTimers: ReturnType<typeof setTimeout>[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const id = originalSetTimeout(...args);
    createdTimers.push(id);
    // Patch the returned handle to observe `unref()` calls.
    if (id && typeof id === 'object' && 'unref' in id) {
      const handle = id as { unref?(): void };
      const originalUnref = handle.unref?.bind(handle);
      handle.unref = () => {
        unrefedTimers.push(id);
        originalUnref?.();
      };
    }
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) clearedTimers.push(id);
    return originalClearTimeout(id as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  return {
    createdTimers,
    clearedTimers,
    unrefedTimers,
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

// ─── GENERATOR_TIMEOUT_MS constant ─────────────────────────────────────────

describe('GENERATOR_TIMEOUT_MS', () => {
  it('is the 5-second plan-generator grace period (5_000)', () => {
    expect(GENERATOR_TIMEOUT_MS).toBe(5_000);
  });

  it('is a finite positive number', () => {
    expect(typeof GENERATOR_TIMEOUT_MS).toBe('number');
    expect(Number.isFinite(GENERATOR_TIMEOUT_MS)).toBe(true);
    expect(GENERATOR_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

// ─── GeneratorTimeoutError ────────────────────────────────────────────────

describe('GeneratorTimeoutError', () => {
  it('is an Error subclass', () => {
    const err = new GeneratorTimeoutError('plan generator next()', 5000);
    expect(err).toBeInstanceOf(Error);
  });

  it('carries name === "GeneratorTimeoutError"', () => {
    const err = new GeneratorTimeoutError('plan generator next()', 5000);
    expect(err.name).toBe('GeneratorTimeoutError');
  });

  it('exposes the label and ms passed to the constructor as readonly props', () => {
    const label = 'plan generator return()';
    const ms = 5_000;
    const err = new GeneratorTimeoutError(label, ms);
    expect(err.label).toBe(label);
    expect(err.ms).toBe(ms);
  });

  it('formats the message as `${label} timed out after ${ms}ms`', () => {
    const err = new GeneratorTimeoutError('plan generator next()', 5000);
    expect(err.message).toBe('plan generator next() timed out after 5000ms');
    expect(err.message).toContain('plan generator next()');
    expect(err.message).toContain('5000');
  });

  it('can be constructed via `new` and thrown/caught across an async boundary', async () => {
    const boom = new GeneratorTimeoutError('op', 10);
    const throwing = async (): Promise<void> => {
      throw boom;
    };
    await expect(throwing()).rejects.toBe(boom);
  });
});

// ─── withTimeout ──────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('resolves with the inner value when it settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000, 'plan generator next()')).resolves.toBe('done');
  });

  it('preserves object identity of the resolved value', async () => {
    const obj = { a: 1, b: 2 };
    await expect(withTimeout(Promise.resolve(obj), 1000, 'op')).resolves.toBe(obj);
  });

  it('rejects with a GeneratorTimeoutError when the inner promise never settles', async () => {
    const hanging = new Promise<string>(() => {});
    await expect(withTimeout(hanging, 30, 'plan generator next()')).rejects.toBeInstanceOf(GeneratorTimeoutError);
  });

  it('rejects with a GeneratorTimeoutError whose label is the supplied label', async () => {
    const hanging = new Promise<string>(() => {});
    const label = 'plan generator next()';
    let caught: unknown;
    try {
      await withTimeout(hanging, 30, label);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GeneratorTimeoutError);
    expect((caught as GeneratorTimeoutError).label).toBe(label);
  });

  it('rejects with a GeneratorTimeoutError whose ms is the supplied timeout', async () => {
    const hanging = new Promise<string>(() => {});
    const ms = 42;
    let caught: unknown;
    try {
      await withTimeout(hanging, ms, 'plan generator next()');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GeneratorTimeoutError);
    expect((caught as GeneratorTimeoutError).ms).toBe(ms);
  });

  it('uses a default label of "plan generator operation" when no label is given', async () => {
    const hanging = new Promise<string>(() => {});
    let caught: unknown;
    try {
      await withTimeout(hanging, 30);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GeneratorTimeoutError);
    expect((caught as GeneratorTimeoutError).label).toBe('plan generator operation');
    expect((caught as GeneratorTimeoutError).message).toContain('plan generator operation');
  });

  it('the timeout error message contains the label and the ms', async () => {
    const hanging = new Promise<string>(() => {});
    const label = 'plan generator return()';
    const ms = 777;
    let caught: unknown;
    try {
      await withTimeout(hanging, ms, label);
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;
    expect(message).toContain(label);
    expect(message).toContain(String(ms));
  });

  it('clears the timeout timer when the inner promise resolves first (no late rejection)', async () => {
    const spy = spyTimers();
    try {
      const result = await withTimeout(Promise.resolve('done'), 1000, 'plan generator next()');
      expect(result).toBe('done');
      // Exactly one timer was created (the timeout).
      expect(spy.createdTimers).toHaveLength(1);
      // That timer was cleared when the promise settled.
      expect(spy.clearedTimers).toContain(spy.createdTimers[0]);
    } finally {
      spy.restore();
    }
  });

  it('clears the timeout timer when the inner promise rejects first (no late rejection)', async () => {
    const spy = spyTimers();
    const originalError = new Error('genuine failure');
    try {
      await expect(withTimeout(Promise.reject(originalError), 1000, 'plan generator next()')).rejects.toBe(
        originalError,
      );
      expect(spy.createdTimers).toHaveLength(1);
      expect(spy.clearedTimers).toContain(spy.createdTimers[0]);
    } finally {
      spy.restore();
    }
  });

  it('propagates the original rejection unchanged (does not wrap it in GeneratorTimeoutError)', async () => {
    const originalError = new Error('genuine failure');
    const caught = await withTimeout(Promise.reject(originalError), 1000, 'plan generator next()').catch((err) => err);
    expect(caught).toBe(originalError);
    expect(caught).not.toBeInstanceOf(GeneratorTimeoutError);
  });

  it('unrefs the timeout timer so it does not keep the process alive', async () => {
    const spy = spyTimers();
    try {
      await withTimeout(Promise.resolve('done'), 1000, 'plan generator next()');
      expect(spy.createdTimers).toHaveLength(1);
      expect(spy.unrefedTimers).toContain(spy.createdTimers[0]);
    } finally {
      spy.restore();
    }
  });

  it('does not reject a second time after the inner promise settles (timer cleared = no late fire)', async () => {
    // If the timer were NOT cleared, it would fire ~30ms later and attempt to
    // reject an already-settled promise (a no-op for the promise itself, but a
    // leak we must not have). We resolve immediately and then wait past the
    // timeout window; the still-cleared timer must produce no observable
    // rejection. We assert by re-awaiting the (cached) settled promise after
    // the timeout window elapses.
    const inner = Promise.resolve('ok');
    const raced = withTimeout(inner, 30, 'plan generator next()');
    await expect(raced).resolves.toBe('ok');
    // Wait beyond the timeout window.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    // Awaiting again must still resolve to the same value (no late rejection).
    await expect(raced).resolves.toBe('ok');
  });

  it('works with a non-undefined falsy inner value (e.g. 0)', async () => {
    await expect(withTimeout(Promise.resolve(0), 1000, 'plan generator next()')).resolves.toBe(0);
  });

  it('works with a null inner value', async () => {
    await expect(withTimeout(Promise.resolve(null), 1000, 'plan generator next()')).resolves.toBeNull();
  });
});
