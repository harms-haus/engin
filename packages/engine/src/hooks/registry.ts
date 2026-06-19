// ─── HookRegistry implementation ────────────────────────────────────────────
//
// Concrete runtime implementation of the HookRegistry interface declared in
// types.ts. This is step 3 of the hook system (see hooks.prompt.md §10). It
// ships:
//
//   class HookRegistry implements HookRegistry {
//     defineHook(name, rule, reducer?): void
//     register(hooks: WorkflowHooks): void   // single fn OR fn[] per field;
//                                             // auto-declares unknown hooks
//                                             // as 'observe'
//     async invokeObserve(name, args, ctx): Promise<void>
//       // fan-out: Promise.all, swallow+console.warn per-subscriber errors
//     async invokePipeline(name, initialValue, args, ctx): Promise<unknown>
//       // ordered, sequential; seeds with initialValue; returns final value
//     async invokeFirstWins(name, args, ctx): Promise<unknown | undefined>
//       // first non-undefined wins; short-circuits
//     async invokeAllRun(name, args, ctx): Promise<unknown>
//       // Promise.all of every subscriber; folds results via reducer
//     hasSubscribers(name): boolean           // true if ≥1 subscriber
//   }
//
//   function createHookRegistry(): HookRegistry
//
// Composition-rule semantics:
//  - observe:     fan-out (Promise.all); per-subscriber errors swallowed + console.warn
//  - pipeline:    ordered, sequential; seeds with initialValue; returns final value
//  - first-wins:  sequential; first non-undefined wins; short-circuits
//  - all-run:     Promise.all of every subscriber; folds results via reducer
//                 (accumulator seeded with undefined, the reducer's identity)

import { safeErrorMessage } from '../core/utils.js';
import { getHookDeclaration } from './declarations.js';
import type { CompositionRule, HookContext, WorkflowHooks } from './types.js';

/**
 * Internal subscriber shape. The typed hook-function shapes in types.ts
 * (ObserveHook, PipelineHook, …) are erased at runtime; the registry invokes
 * every subscriber positionally with the args tuple dictated by the
 * composition rule.
 */
type Subscriber = (...args: unknown[]) => unknown;

/**
 * Internal per-hook record: declared composition rule, optional reducer
 * (required for `'all-run'`), and the ordered list of registered subscribers.
 */
interface HookEntry {
  rule: CompositionRule;
  reducer?: (acc: unknown, next: unknown) => unknown;
  subscribers: Subscriber[];
}

/**
 * Concrete {@link HookRegistry}.
 *
 * Each hook name maps to a {@link HookEntry} stored in a per-instance `Map`.
 * Hooks are declared via {@link HookRegistry.defineHook} before subscribers
 * register for them; if a hook name reaches {@link HookRegistry.register}
 * without a prior declaration it is auto-declared as `'observe'` (defensive
 * — the engine declares its own hooks during setup, but a stray hooks object
 * must never throw at registration time).
 */
export class HookRegistry {
  /** Per-hook storage. Always created per-instance — no shared static state. */
  private readonly hooks = new Map<string, HookEntry>();

  // ── Declaration ──────────────────────────────────────────────────────────

  /**
   * Declare a hook with a composition rule (and, for `'all-run'`, the reducer
   * used to fold per-subscriber contributions). Called by `composeHooks` or
   * by the engine during setup, before any subscribers register.
   */
  defineHook(name: string, rule: CompositionRule, reducer?: (acc: unknown, next: unknown) => unknown): void {
    this.hooks.set(name, { rule, reducer, subscribers: [] });
  }

  // ── Registration ────────────────────────────────────────────────────────

  /**
   * Register every hook field on `hooks`. Each field may be a single function
   * or an array of functions; both forms are appended to the hook's
   * subscriber list in order. Unknown hook names are auto-declared as
   * `'observe'` (defensive). Non-function, non-array field values (null,
   * undefined, strings, …) are silently ignored.
   */
  register(hooks: WorkflowHooks): void {
    for (const [name, value] of Object.entries(hooks)) {
      const fns = normalizeSubscribers(value);
      if (fns.length === 0) continue;
      this.ensureHook(name);
      const entry = this.hooks.get(name);
      if (entry) entry.subscribers.push(...fns);
    }
  }

  // ── Composition-rule invokers ───────────────────────────────────────────

  /**
   * Observe fan-out: fire every subscriber with `(args, ctx)`. Uses
   * `Promise.all` so async subscribers run concurrently. Per-subscriber
   * errors (sync throws or async rejections) are swallowed and logged via
   * `console.warn` so one bad subscriber cannot break the fan-out.
   *
   * Composition rule: `'observe'`.
   */
  async invokeObserve<K extends keyof WorkflowHooks>(name: K, args: unknown, ctx: HookContext): Promise<void> {
    const entry = this.hooks.get(name as string);
    if (!entry || entry.subscribers.length === 0) return;
    await Promise.all(
      entry.subscribers.map(async (sub) => {
        try {
          await sub(args, ctx);
        } catch (err) {
          console.warn(`[HookRegistry] observe subscriber for "${name as string}" failed:`, safeErrorMessage(err));
        }
      }),
    );
  }

  /**
   * Pipeline: seed with `initialValue`, then for each subscriber IN ORDER call
   * `(currentValue, args, ctx)` and use the awaited return as the next
   * `currentValue`. Sequential (NOT Promise.all — pipeline order matters).
   * Returns the final value (or `initialValue` unchanged if no subscribers).
   *
   * Composition rule: `'pipeline'`.
   */
  async invokePipeline<K extends keyof WorkflowHooks>(
    name: K,
    initialValue: unknown,
    args: unknown,
    ctx: HookContext,
  ): Promise<unknown> {
    const entry = this.hooks.get(name as string);
    if (!entry || entry.subscribers.length === 0) return initialValue;
    let value = initialValue;
    for (const sub of entry.subscribers) {
      value = await sub(value, args, ctx);
    }
    return value;
  }

  /**
   * First-wins: for each subscriber IN ORDER call `(args, ctx)`. The first to
   * return a non-`undefined` value wins — short-circuit and return it.
   * Sequential. Returns `undefined` if every subscriber abstains (or if
   * there are no subscribers).
   *
   * Composition rule: `'first-wins'`. Note that any non-`undefined` value
   * (incl. `false`, `0`, `''`) wins; only `undefined` abstains.
   */
  async invokeFirstWins<K extends keyof WorkflowHooks>(
    name: K,
    args: unknown,
    ctx: HookContext,
  ): Promise<unknown | undefined> {
    const entry = this.hooks.get(name as string);
    if (!entry || entry.subscribers.length === 0) return undefined;
    for (const sub of entry.subscribers) {
      const result = await sub(args, ctx);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  /**
   * All-run: fire every subscriber with `(args, ctx)` via `Promise.all`, then
   * fold the results through the hook's reducer. The accumulator is seeded
   * with `undefined` (the reducer's identity) and updated in subscriber
   * order: `acc = reducer(acc, contribution)`. Returns the folded value, or
   * `undefined` if there are no subscribers.
   *
   * Composition rule: `'all-run'`.
   */
  async invokeAllRun<K extends keyof WorkflowHooks>(name: K, args: unknown, ctx: HookContext): Promise<unknown> {
    const entry = this.hooks.get(name as string);
    if (!entry || entry.subscribers.length === 0) return undefined;
    const contributions = await Promise.all(entry.subscribers.map((sub) => sub(args, ctx)));
    if (!entry.reducer) {
      // A single contribution (or none) needs no folding — last-wins is the
      // only value. But an all-run hook with MULTIPLE contributors and no
      // reducer would silently drop N-1 of them; that is a misconfiguration
      // (every known all-run hook has a reducer via HOOK_DECLARATIONS), so
      // fail loudly instead of silently returning the last contribution.
      if (contributions.length > 1) {
        throw new Error(
          `invokeAllRun("${String(name)}") has ${contributions.length} contributions but no reducer; ` +
            `${contributions.length - 1} would be silently dropped. Declare a reducer ` +
            `(via HOOK_DECLARATIONS for an engine hook, or defineHook for an ad-hoc hook).`,
        );
      }
      return contributions[contributions.length - 1];
    }
    let acc: unknown = undefined;
    for (const contribution of contributions) {
      acc = entry.reducer(acc, contribution);
    }
    return acc;
  }

  // ── Introspection ───────────────────────────────────────────────────────

  /** True if `name` has at least one registered subscriber. */
  hasSubscribers(name: string): boolean {
    const entry = this.hooks.get(name);
    return !!entry && entry.subscribers.length > 0;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Ensure a hook entry exists for `name`, auto-declaring it as `'observe'`
   * if it has not been declared yet. Mirrors the defensive contract pinned in
   * the tests: a `register()` call with an unknown hook name must not throw.
   */
  private ensureHook(name: string): void {
    if (this.hooks.has(name)) return;
    // Consult the authoritative declaration table (hooks/declarations.ts):
    // every known hook gets its REAL composition rule — and, for 'all-run',
    // its reducer — attached automatically, with no separate `defineHook`
    // step required. This is what makes `invokeAllRun` fold correctly in
    // production (previously every hook was auto-declared as a bare
    // 'observe' with no reducer, so multi-subscriber all-run hooks silently
    // dropped all but the last contribution).
    //
    // A genuinely unknown name (a typo, or an ad-hoc test hook) still
    // auto-declares as 'observe', preserving the defensive contract that
    // `register()` must never throw on a stray hooks object.
    const decl = getHookDeclaration(name);
    if (decl) {
      this.hooks.set(name, { rule: decl.rule, reducer: decl.reducer, subscribers: [] });
    } else {
      this.hooks.set(name, { rule: 'observe', subscribers: [] });
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Coerce a `WorkflowHooks` field value into an array of subscriber functions.
 *
 *  - A single function → `[fn]`
 *  - An array → filtered to functions only (non-functions dropped)
 *  - Anything else (null, undefined, string, number, …) → `[]`
 */
function normalizeSubscribers(value: unknown): Subscriber[] {
  if (typeof value === 'function') return [value as Subscriber];
  if (Array.isArray(value)) return value.filter((v): v is Subscriber => typeof v === 'function');
  return [];
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Construct a fresh, independent {@link HookRegistry} (no shared static
 * state). The canonical entry point for engine setup.
 */
export function createHookRegistry(): HookRegistry {
  return new HookRegistry();
}
