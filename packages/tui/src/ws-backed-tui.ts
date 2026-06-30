import type { ClientStore } from '@engin/shared/client-store';
import type { TuiStore } from './tui-store.js';

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Thin compat wrapper around TuiStore.
 *
 * TuiStore already subscribes to ClientStore in its constructor and handles
 * all event-draining, dashboard-sync, and session-follow logic. This wrapper
 * exists for backward compatibility and testability — it simply forwards
 * dispose() to the TuiStore.
 *
 * Callers that already have a TuiStore can use this to obtain a `{ dispose }`
 * handle without additional wiring.
 */
export function createWsBackedTui(deps: { clientStore: ClientStore; tuiStore: TuiStore }): { dispose: () => void } {
  return {
    dispose: () => deps.tuiStore.dispose(),
  };
}
