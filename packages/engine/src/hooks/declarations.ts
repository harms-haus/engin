// ─── Authoritative hook declarations ───────────────────────────────────────
//
// The composition rule (and, for `'all-run'`, the reducer used to fold
// multiple subscribers' contributions) for EVERY known hook on the
// `WorkflowHooks` interface.
//
// `HookRegistry.ensureHook` consults this table at registration time so a
// hook gets its real rule + reducer attached AUTOMATICALLY — without relying
// on a separate `defineHook(name, rule, reducer?)` call that callers had to
// remember (and which, in practice, only the test suite remembered). Before
// this table existed, every hook was auto-declared as a bare `'observe'` with
// no reducer; the only `invoke*` method that reads the reducer is
// `invokeAllRun`, which then silently returned only the LAST subscriber's
// contribution, dropping the rest. With the table, `onPhaseSettled` /
// `collectContext` fold correctly in production as they do in the tests.
//
// COMPLENESS IS ENFORCED BY THE TYPE SYSTEM: `satisfies
// Record<keyof WorkflowHooks, HookDeclaration>` makes adding a new hook to
// `WorkflowHooks` (in types.ts) without adding it here a compile error — the
// `bun run typecheck` gate catches the drift. Keep this map in sync with the
// `WorkflowHooks` interface and the per-hook JSDoc (which documents each
// rule).

import { CONTEXT_BLOCK_REDUCER, PHASE_RESULTS_REDUCER } from './reducers.js';
import type { CompositionRule, WorkflowHooks } from './types.js';

/**
 * Declaration metadata for a single hook: its composition rule and, for
 * `'all-run'` hooks, the reducer used to fold per-subscriber contributions.
 */
export interface HookDeclaration {
  rule: CompositionRule;
  /**
   * Required for `'all-run'` hooks (the reducer that folds multiple
   * contributions); ignored for the other rules.
   */
  reducer?: (acc: unknown, next: unknown) => unknown;
}

/**
 * The single source of truth for every hook's composition rule + reducer.
 * Keyed by `WorkflowHooks` field name.
 */
export const HOOK_DECLARATIONS = {
  // ── all-run (reducer required) ──────────────────────────────────────────
  onPhaseSettled: { rule: 'all-run', reducer: PHASE_RESULTS_REDUCER },
  collectContext: { rule: 'all-run', reducer: CONTEXT_BLOCK_REDUCER as (acc: unknown, next: unknown) => unknown },

  // ── pipeline (ordered transforms) ───────────────────────────────────────
  beforeStepPrompt: { rule: 'pipeline' },
  onPersist: { rule: 'pipeline' },
  onRestore: { rule: 'pipeline' },
  populateWorktree: { rule: 'pipeline' },

  // ── first-wins (first non-undefined wins) ───────────────────────────────
  beforeRunMerge: { rule: 'first-wins' },
  onRunMergeConflict: { rule: 'first-wins' },
  shouldIsolate: { rule: 'first-wins' },
  beforePhase: { rule: 'first-wins' },
  beforePhaseTransition: { rule: 'first-wins' },
  shouldRetryPhase: { rule: 'first-wins' },
  beforeTask: { rule: 'first-wins' },
  claimPolicy: { rule: 'first-wins' },
  concurrencyKey: { rule: 'first-wins' },
  beforeTaskWorktreeCreate: { rule: 'first-wins' },
  onTaskMerge: { rule: 'first-wins' },
  onMergeConflict: { rule: 'first-wins' },
  onCommitFailure: { rule: 'first-wins' },

  // ── observe (fan-out, no return) ────────────────────────────────────────
  onWorkflowResume: { rule: 'observe' },
  onWorkflowAbort: { rule: 'observe' },
  onLaneError: { rule: 'observe' },
  onStructuredOutput: { rule: 'observe' },
  onDecision: { rule: 'observe' },
  afterPhase: { rule: 'observe' },
  wakeStrategy: { rule: 'observe' },
  onLaneIdle: { rule: 'observe' },
  onLaneStall: { rule: 'observe' },
  afterTaskWorktreeCreate: { rule: 'observe' },
} as const satisfies Record<keyof WorkflowHooks, HookDeclaration>;

/**
 * Look up the declaration for a hook `name`. Returns `undefined` when `name`
 * is not a known `WorkflowHooks` field (a typo, or an ad-hoc test hook).
 */
export function getHookDeclaration(name: string): HookDeclaration | undefined {
  return (HOOK_DECLARATIONS as Record<string, HookDeclaration | undefined>)[name];
}
