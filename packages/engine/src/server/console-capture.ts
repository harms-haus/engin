// ─── Console capture (async-context-scoped) ─────────────────────────────────
//
// Captures per-run `console.warn` / `console.error` / `console.info` output
// into the CURRENT run's EventStore WITHOUT mutating the process-global
// `console` object per run. Capture routes through AsyncLocalStorage, so
// concurrent runs each capture their own output with no per-run save/restore
// and no cross-contamination.
//
//   - `installConsoleCapture()` replaces the global `console.warn/error/info`
//     ONCE (idempotent). The wrappers look up the active run's store via the
//     async-local context. When a run is executing (inside
//     `runWithConsoleCapture`), its console output is appended to that run's
//     store as a `log` event AND forwarded to the original method; outside any
//     run the wrappers are inert and behave exactly like the originals.
//
// Because routing is resolved per-async-context rather than by overwriting a
// shared global, two concurrent runs each capture their own console output
// with no per-run save/restore and no cross-contamination.

import { AsyncLocalStorage } from 'node:async_hooks';

import type { EventStore } from '../tracking/event-store.js';

/** Per-run context carried by the async-local store. */
interface CaptureContext {
  store: EventStore;
}

/**
 * AsyncLocalStorage holding the active run's capture context, resolved by the
 * console wrappers to route captured output to the correct run's store.
 * `undefined` outside any {@link runWithConsoleCapture} scope.
 */
const captureContext = new AsyncLocalStorage<CaptureContext>();

/**
 * Run `fn` with the given `store` installed as the active capture context.
 *
 * Any `console.warn` / `console.error` / `console.info` call made by `fn` or
 * its awaited continuations is appended to `store` as a `log` event (and
 * still forwarded to the original console method). The context is scoped to
 * `fn`'s execution and is automatically unavailable once `fn` settles, so
 * capture does not leak beyond the run's scope.
 */
export async function runWithConsoleCapture<T>(store: EventStore, fn: () => Promise<T>): Promise<T> {
  return captureContext.run({ store }, fn);
}

// ─── Message formatting ─────────────────────────────────────────────────────

/**
 * Coerce console call arguments to a single human-readable message string,
 * joining with spaces. Matches the legacy `args.join(' ')` output for string
 * arguments while stringifying non-string arguments explicitly.
 */
function formatMessage(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
}

// ─── Install ────────────────────────────────────────────────────────────────

let installed = false;

/**
 * Replace the global `console.warn` / `console.error` / `console.info` with
 * context-aware wrappers, ONCE per process. Double-install is a no-op.
 *
 * Each wrapper, when an active capture context exists (a run executing inside
 * {@link runWithConsoleCapture}), appends a `log` event shaped
 * `{ level, message }` to that run's store AND calls the original method.
 * With no active context it simply delegates to the original method, so the
 * wrappers are inert outside a run.
 *
 * `console.log` is intentionally NEVER overridden — library noise like dotenv
 * output is ignored. The originals are captured at install time (before any
 * run starts) and are never restored; the wrappers ARE the global console
 * methods for the lifetime of the process, routing purely via async context.
 */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;

  console.warn = (...args: unknown[]): void => {
    const ctx = captureContext.getStore();
    if (ctx) {
      ctx.store.append('log', { level: 'warn', message: formatMessage(args) });
    }
    originalWarn(...args);
  };

  console.error = (...args: unknown[]): void => {
    const ctx = captureContext.getStore();
    if (ctx) {
      ctx.store.append('log', { level: 'error', message: formatMessage(args) });
    }
    originalError(...args);
  };

  console.info = (...args: unknown[]): void => {
    const ctx = captureContext.getStore();
    if (ctx) {
      ctx.store.append('log', { level: 'info', message: formatMessage(args) });
    }
    originalInfo(...args);
  };
}
