import type { ContextBlock } from './types.js';

export const CONTEXT_BLOCK_REDUCER = (acc: ContextBlock[] | undefined, next: ContextBlock): ContextBlock[] => {
  // Returns a NEW array each fold (non-mutating contract pinned by tests).
  // This is O(n²) across N collectContext subscribers, but `collectContext`
  // is currently inlined into `defaultBeforeStepPrompt` and not invoked via
  // the registry, so n is 0 in practice. Revisit (mutable accumulator) once
  // collectContext is wired as a registry-fired all-run hook.
  return [...(acc ?? []), next];
};

/**
 * Reducer for the `onPhaseSettled` (`all-run`) hook: shallow-merges per-subscriber
 * contribution objects (`{ [taskId]: result }`) into a single aggregated record.
 * Later contributions WIN on key conflicts (right-most spread overrides). Seeds
 * the accumulator from `undefined` as `{}` so the first contribution stands on
 * its own. Always returns a NEW object (spread) so callers' accumulators are
 * never mutated in place.
 *
 * The parameter types are deliberately `unknown` (NOT `Record<string, unknown>`)
 * so the reducer is assignable to the registry's `defineHook` reducer contract
 * (`(acc: unknown, next: unknown) => unknown`) and tolerates a `let acc: unknown`
 * accumulator threaded through a fold loop. The contributions are cast to
 * `Record<string, unknown>` internally — every `onPhaseSettled` subscriber
 * contributes an object shape by contract.
 */
export const PHASE_RESULTS_REDUCER = (acc: unknown, next: unknown): Record<string, unknown> => {
  return {
    ...((acc as Record<string, unknown> | undefined) ?? {}),
    ...(next as Record<string, unknown>),
  };
};
