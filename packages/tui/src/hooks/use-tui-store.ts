/**
 * React hook that subscribes to a {@link TuiStore} via
 * `useSyncExternalStore`, returning the store instance.
 *
 * Usage:
 * ```tsx
 * const store = useTuiStore(tuiStore);
 * const { eventLogLines, isLogExpanded } = store;
 * ```
 *
 * The hook re-renders the component whenever the store's version counter
 * increments (i.e. after every `_notify()` call).
 */

import { useSyncExternalStore } from 'react';
import type { TuiStore } from '../tui-store.js';

export function useTuiStore(store: TuiStore) {
  useSyncExternalStore(store.subscribe.bind(store), store.getVersion.bind(store), store.getVersion.bind(store));
  return store;
}
