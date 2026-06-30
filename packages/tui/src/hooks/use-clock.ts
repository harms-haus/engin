/**
 * useClock — a single shared per-second tick source.
 *
 * Returns a `now` value (epoch ms) that advances once per second. All
 * components using this hook share ONE interval (a module-level singleton),
 * so every timer that derives from `now` updates in the SAME React commit.
 * This avoids the visual desync where each timer ticks at its own phase
 * offset (one flipping at :00.1, another at :00.7).
 *
 * The value is NOT snapped to whole-second boundaries: doing so would lag
 * `Date.now()` by up to ~1s and make a 5.0s-old task render as "4s". A plain
 * 1s cadence keeps elapsed values accurate while still updating every timer
 * in lockstep.
 *
 * Backed by `useSyncExternalStore`: the first subscriber lazily starts the
 * interval; the last subscriber out tears it down.
 */

import { useSyncExternalStore } from 'react';

const TICK_MS = 1000;

const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;
/**
 * Cached tick value. Lazily initialized to `Date.now()` on the first
 * `getSnapshot` read so the initial render is accurate (not a stale
 * module-load timestamp); updated thereafter only by each tick.
 */
let currentTick = 0;

function tick(): void {
  currentTick = Date.now();
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Lazy start: only spin up the interval once, when the first subscriber
  // arrives. One interval drives every subscriber, so all timers flip in the
  // same React commit.
  if (intervalId === null) {
    intervalId = setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    // Last subscriber out tears down the singleton so it doesn't run forever
    // (e.g. when the task list unmounts or all tasks complete). Also reset
    // currentTick so the next mount re-initializes to a fresh Date.now().
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
      currentTick = 0;
    }
  };
}

function getSnapshot(): number {
  // Lazy init: capture the current time on the FIRST read so the initial
  // render reflects an accurate `now` (rather than the module-load moment).
  // Subsequent reads return the cached value, stable until the next tick —
  // satisfying useSyncExternalStore's caching requirement.
  if (currentTick === 0) currentTick = Date.now();
  return currentTick;
}

/**
 * Subscribe to the shared per-second clock.
 *
 * @returns The current epoch timestamp (ms). Advances once per second, in
 * lockstep across all subscribers.
 */
export function useClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Test-only: reset the singleton clock state so each test re-initializes
 * `currentTick` to a fresh `Date.now()` on its first render. The module-level
 * singleton otherwise persists across tests, leaving later tests with a stale
 * `now` (and drifting elapsed assertions by up to ~1s per preceding test).
 */
export function __resetClockForTesting(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  listeners.clear();
  currentTick = 0;
}
