// ─── composeHooks — the composition seam for the hook system ────────────────
//
// This is step 1 of the hook system (see hooks.prompt.md §10). It replaces the
// single `options.onStatus = storeCallbacks` assignment in `run-executor.ts`
// with:
//
//   const { onStatus, registry } = composeHooks(storeCallbacks, workflow.hooks);
//   options.onStatus = onStatus;          // behaviorally identical to storeCallbacks
//   options.hookRegistry = registry;      // consumed by engine primitives
//
// DESIGN DECISION (pinned by compose.test.ts):
//
//   observe/influence-hook firing from within `onStatus` is DEFERRED to the
//   engine primitives (runStep, LanePool, PhaseRunner) that own a proper
//   `HookContext`. The composed `onStatus` wraps ONLY the store callbacks — so
//   `composeHooks(storeCallbacks, hooks).onStatus` is behaviorally IDENTICAL
//   to `storeCallbacks` (zero behavior change — the firmest constraint in
//   hooks.prompt.md §2 #2), and the returned `registry` is consumed
//   separately by the engine primitives via `registry.invoke*`.
//
// Rationale: a `HookContext` (cwd, workDir, signal, registry) is built
// per-invocation by the engine and is NOT available at compose time. Routing
// observe/influence firing through the engine primitives keeps `onStatus`
// synchronous (matching today's store behavior), avoids fabricating a hollow
// context, and leaves the fan-out decision in the hands of the code that owns
// a real one.
//
// Consequences pinned by the tests:
//  - `composeHooks(storeCallbacks, {}).onStatus` delegates every one of the
//    {@link STATUS_CALLBACK_METHODS} to the matching store callback with
//    IDENTICAL args (single source of truth, no copy, ...args spread).
//  - The returned {@link HookRegistry} carries every registered influence
//    hook (single fn, fn[], single provider, or provider[]).
//  - Store callbacks ALWAYS fire, even when influence hooks share the same
//    name — `onStatus` never reaches into the registry.

import type { StatusCallbacks } from '../core/types.js';
import { STATUS_CALLBACK_METHODS } from '../core/types.js';
import type { HookRegistry } from './registry.js';
import { createHookRegistry } from './registry.js';
import type { HookProvider, WorkflowHooks } from './types.js';

/**
 * Compose the engine's status-callback surface with workflow-provided hooks.
 *
 * Returns:
 *  - `onStatus` — a {@link StatusCallbacks} object exposing exactly the
 *    {@link STATUS_CALLBACK_METHODS}. Each method forwards `...args`
 *    verbatim to the matching `storeCallbacks[method]` (tolerating a missing
 *    handler, since every field is optional) and returns `void`. Synchronous,
 *    matching today's store behavior. Observe/influence firing is NOT done
 *    here (see the file-header design decision).
 *  - `registry` — a fresh, independent {@link HookRegistry} carrying every
 *    influence hook from `hookProviders` (normalized from a single provider or
 *    an array of them, registered in array order).
 *
 * The pair is the composition seam: `options.onStatus = onStatus` preserves
 * behavior, while `options.hookRegistry = registry` hands the engine
 * primitives a typed hook surface to invoke at the proper lifecycle seams.
 */
export function composeHooks(
  storeCallbacks: StatusCallbacks,
  hookProviders: HookProvider,
): { onStatus: StatusCallbacks; registry: HookRegistry } {
  // ── Registry: normalize providers and register influence hooks ──────────
  const registry = createHookRegistry();
  const providers: WorkflowHooks[] = Array.isArray(hookProviders) ? hookProviders : [hookProviders];
  for (const provider of providers) {
    registry.register(provider);
  }

  // ── onStatus: wrap ONLY the store callbacks (zero behavior change) ───────
  //
  // Build every STATUS_CALLBACK_METHOD dynamically so the composed object has
  // the exact 21-method shape. Each method accepts `...args: unknown[]` and
  // forwards them verbatim to the store (the source of truth). Missing store
  // handlers are tolerated via optional-chaining — every StatusCallbacks
  // field is optional.
  const onStatus = Object.fromEntries(
    STATUS_CALLBACK_METHODS.map((name) => [
      name,
      (...args: unknown[]): void => {
        const handler = (storeCallbacks as Record<string, ((...args: unknown[]) => void) | undefined>)[name];
        handler?.(...args);
      },
    ]),
  ) as StatusCallbacks;

  return { onStatus, registry };
}
