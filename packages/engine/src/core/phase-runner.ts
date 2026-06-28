// ─── PhaseRunner — the engine's phase orchestration layer ──────────────────
//
// This module ships BOTH the types (`PhaseDefinition`, `PhaseRunContext`,
// `PhaseRunnerOptions`) AND the concrete `PhaseRunner` class — the
// orchestration layer that drives a workflow through its declared phases,
// honouring the phase-level influence hooks (`beforePhase`,
// `beforePhaseTransition`, `shouldRetryPhase`, `onPhaseSettled`,
// `afterPhase`) and bounded by `maxRounds` (default 3, reproducing the
// historical ≤3-rounds retry logic).
//
// PhaseRunner depends only on the minimal {@link PhaseTracker} interface (D3
// decoupling), NOT on the concrete `WorkflowStatusTracker` class. The legacy
// `WorkflowStatusTracker` still satisfies `PhaseTracker`, so existing consumers
// that pass one are unaffected. `HookRegistry` is imported type-only from
// ../hooks/types.js, and `createHookRegistry` is imported from
// ../hooks/registry.js so the runner can fall back to a fresh empty registry
// when no `hookRegistry` is supplied via options.
//
// DEFAULT behaviors (no hooks registered):
//   - beforePhase            → no-op (don't skip; no statePatch)
//   - shouldRetryPhase       → retry while the phase result has `{ retry: true }`
//                              shape AND round < maxRounds (≤3-rounds compat)
//   - beforePhaseTransition  → { type: 'advance' } (linear progression)
//   - onPhaseSettled         → no-op (subscribers mutate args.state directly)
//   - afterPhase             → no-op
//
// CRITICAL: The PhaseRunner does NOT own task execution — that stays with
// RunnerPool/runTask. Each phase's `run()` callback owns its own task
// execution; the runner only owns the phase loop, transitions, retry, and
// result collection.

import { createHookRegistry } from '../hooks/registry.js';
import type {
  AfterPhaseArgs,
  BeforePhaseArgs,
  BeforePhaseResult,
  BeforePhaseTransitionArgs,
  HookContext,
  HookRegistry,
  OnPhaseSettledArgs,
  PhaseTransition,
  ShouldRetryPhaseArgs,
} from '../hooks/types.js';
import { DEFAULT_MAX_ROUNDS } from '../pool/constants.js';
import type { StatusCallbacks, Task } from './types.js';

/**
 * Minimal read/write surface the {@link PhaseRunner} needs from a tracker.
 *
 * Introduced in D3 to decouple the runner from the concrete
 * `WorkflowStatusTracker` class (the duplicate-state tracker slated for full
 * removal once D4 migrates all consumers). Any object satisfying this interface
 * may drive the phase loop — the engine's eventual EventStore-backed tracker
 * will implement it directly, and the legacy `WorkflowStatusTracker` already
 * satisfies it today.
 *
 * `taskTracker` is typed as the narrowest shape the runner inspects: only
 * `getAllTasks()` (surfaced to the `onPhaseSettled` hook). The concrete
 * `TaskTracker` class exposes strictly more, so a real tracker's richer surface
 * is assignable without narrowing.
 */
export interface PhaseTracker {
  /** Register a phase (id / label / icon) for display purposes. */
  registerPhase(info: { id: string; label: string; icon: string }): void;
  /** Transition to a new phase (pushes the previous into completed). */
  setPhase(phaseId: string): void;
  /** Persist the tracker's current state (durable across crashes / resumes). */
  save(): Promise<void>;
  /** The task collection the runner surfaces to the `onPhaseSettled` hook. */
  readonly taskTracker: { getAllTasks(): Task[] };
}

/**
 * A single declared phase of a workflow.
 *
 * The `run` callback is invoked by the phase runner with a
 * {@link PhaseRunContext} and MUST return a Promise — the phase's settled
 * result, surfaced later to the `afterPhase` / `onPhaseSettled` hooks via
 * `AfterPhaseArgs.result` / `OnPhaseSettledArgs` respectively.
 */
export interface PhaseDefinition {
  id: string;
  label: string;
  icon: string;
  run: (ctx: PhaseRunContext) => Promise<unknown>;
}

/**
 * Context handed to each {@link PhaseDefinition.run}.
 *
 * `state` is a mutable bag shared across phases within a single runner
 * invocation; phases may read and patch it (e.g. via the `beforePhase` hook's
 * `statePatch`, which the runner applies before invoking `run`).
 *
 * `hookRegistry` is optional: when absent, every phase-level hook invocation
 * is a no-op (the runner's defaults proceed). `signal` forwards the caller's
 * abort signal for cooperative cancellation.
 */
export interface PhaseRunContext {
  tracker: PhaseTracker;
  hookRegistry?: HookRegistry;
  state: Record<string, unknown>; // mutable state shared across phases
  cwd: string;
  workDir: string;
  signal?: AbortSignal;
}

/**
 * Options for constructing / driving a phase runner.
 *
 * `maxRounds` defaults to 3 — reproduces the historical ≤3-rounds retry
 * logic gated by the `shouldRetryPhase` hook: a phase may be retried at most
 * `maxRounds` times before the runner gives up and propagates the failure.
 */
export interface PhaseRunnerOptions {
  phases: PhaseDefinition[];
  tracker: PhaseTracker;
  hookRegistry?: HookRegistry;
  cwd: string;
  workDir: string;
  signal?: AbortSignal;
  maxRounds?: number; // default 3 — reproduces the ≤3-rounds logic
  /** Optional status-callback surface. When supplied the runner fires
   *  `onPhaseRegister` / `onPhaseStart` / `onPhaseComplete` alongside its
   *  tracker mutations so the projection learns about phases purely from
   *  events (single-writer).  */
  onStatus?: StatusCallbacks;
}

/**
 * The phase orchestration layer.
 *
 * Drives a workflow through its declared phases, honouring the phase-level
 * influence hooks and bounded by `maxRounds`. The runner observes / mutates a
 * {@link PhaseTracker}: it registers every phase for display
 * (`tracker.registerPhase`), transitions between phases
 * (`tracker.setPhase`), persists after each transition (`tracker.save`), and
 * exposes the tracker's settled tasks to the `onPhaseSettled` hook.
 *
 * The runner does NOT execute tasks itself — each phase's `run()` callback
 * owns its task execution (typically via RunnerPool / runTask). The runner
 * owns only the phase loop, transitions, retry, and result collection.
 */
export class PhaseRunner {
  private readonly options: PhaseRunnerOptions;
  private readonly registry: HookRegistry;
  private readonly maxRounds: number;

  constructor(options: PhaseRunnerOptions) {
    this.options = options;
    // Fall back to a fresh empty registry so hook invocations are uniform
    // whether or not the caller supplied one. An empty registry's invoke*
    // methods all return their "no subscribers" default (undefined / void),
    // which the runner interprets as "use the built-in default behavior".
    this.registry = options.hookRegistry ?? createHookRegistry();
    this.maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  }

  /**
   * Drive the configured phases to completion.
   *
   * For each phase the runner:
   *  1. Registers the phase on the tracker (id / label / icon) for display.
   *  2. Transitions the tracker to the phase (`setPhase`) and persists.
   *  3. Invokes `beforePhase` (first-wins) — may skip the phase and/or patch
   *     the shared state bag.
   *  4. Invokes the phase's `run()` (unless skipped).
   *  5. Invokes `shouldRetryPhase` (first-wins) — re-runs while a retry is
   *     signalled AND `round < maxRounds`. The default retries while the
   *     result has `{ retry: true }` shape.
   *  6. Invokes `onPhaseSettled` (all-run) with the tracker's settled tasks,
   *     so subscribers may collect results into the shared state.
   *  7. Invokes `afterPhase` (observe) with the result + duration.
   *  8. Invokes `beforePhaseTransition` (first-wins) — default
   *     `{ type: 'advance' }`; `{ type: 'jump', target }` skips ahead.
   */
  async run(): Promise<void> {
    const { phases, tracker } = this.options;
    if (phases.length === 0) return;

    // 1. Register every phase for display (fires "onPhaseRegister" via the
    //    tracker — registerPhase persists each entry). When an `onStatus`
    //    surface is supplied the same info is routed through
    //    `onStatus.onPhaseRegister` so the EventStore-backed projection learns
    //    about phase registrations purely from events (single-writer).
    for (const phase of phases) {
      tracker.registerPhase({ id: phase.id, label: phase.label, icon: phase.icon });
      this.options.onStatus?.onPhaseRegister?.({ id: phase.id, label: phase.label, icon: phase.icon });
    }

    // Shared mutable state bag — one instance for the whole run, forwarded to
    // every phase's run() and every phase-level hook so phases/hooks may read
    // and patch a common surface.
    const state: Record<string, unknown> = {};

    // 2. Drive the phases. `index` advances linearly by default; a
    //    `{ type: 'jump', target }` transition rewrites it to the target
    //    phase's position.
    let index = 0;
    while (index < phases.length) {
      const phase = phases[index];
      if (!phase) break;

      // Make this phase current. setPhase pushes the previous current (if any)
      // into completedPhaseIds — so by the time phase N's body runs, phase N-1
      // is recorded as completed. Persist immediately so the transition is
      // durable (setPhase itself does NOT auto-persist). When an `onStatus`
      // surface is supplied the phase-start is routed through
      //    `onStatus.onPhaseStart` so the projection learns about it purely
      //    from events.
      tracker.setPhase(phase.id);
      await tracker.save();
      this.options.onStatus?.onPhaseStart?.({ phase: phase.id, round: 1 });

      const phaseCtx = this.makePhaseContext(state);
      const hookCtx = this.makeHookContext();

      // 3. beforePhase (first-wins): skip and/or statePatch.
      const beforeArgs: BeforePhaseArgs = { phaseId: phase.id, state };
      const beforeResult = (await this.registry.invokeFirstWins('beforePhase', beforeArgs, hookCtx)) as
        | BeforePhaseResult
        | undefined;
      let skipped = false;
      if (beforeResult) {
        if (beforeResult.statePatch) {
          Object.assign(state, beforeResult.statePatch);
        }
        skipped = beforeResult.skip === true;
      }

      // 4–5. Run the phase (with shouldRetryPhase loop). A skipped phase does
      //      not run; its result is undefined.
      const startTime = Date.now();
      let result: unknown;
      if (skipped) {
        result = undefined;
      } else {
        result = await phase.run(phaseCtx);
        // shouldRetryPhase loop: re-run while a retry is signalled AND round
        // is below the hard ceiling. Round is 1-indexed (round 1 = first run,
        // round 2 = first retry, …) to reproduce the historical "≤3 rounds"
        // convention. The ceiling is enforced OUTSIDE the hook so a buggy
        // always-retry hook cannot infinite-loop the runner.
        let round = 1;
        for (;;) {
          const retryArgs: ShouldRetryPhaseArgs = {
            phaseId: phase.id,
            result,
            round,
            state,
          };
          const retryDecision = (await this.registry.invokeFirstWins('shouldRetryPhase', retryArgs, hookCtx)) as
            | boolean
            | undefined;
          const wantsRetry = retryDecision !== undefined ? retryDecision : this.defaultShouldRetry(result);
          if (!wantsRetry || round >= this.maxRounds) break;
          round++;
          result = await phase.run(phaseCtx);
        }
      }
      const durationMs = Date.now() - startTime;

      // 6. onPhaseSettled (all-run): hand subscribers the tracker's settled
      //    tasks so they may collect results into the shared state. The same
      //    `state` reference is forwarded, so mutations are visible to later
      //    phases. Guarded by hasSubscribers to avoid allocating getAllTasks()
      //    when no subscriber is registered (matches discipline in
      //    the legacy execution modules).
      if (this.registry.hasSubscribers('onPhaseSettled')) {
        const settledArgs: OnPhaseSettledArgs = {
          phaseId: phase.id,
          tasks: tracker.taskTracker.getAllTasks(),
          state,
        };
        await this.registry.invokeAllRun('onPhaseSettled', settledArgs, hookCtx);
      }

      // 7. afterPhase (observe): fire-and-forget with the result + duration.
      //    Maps onto the legacy "fire onPhaseComplete" step. When an `onStatus`
      //    surface is supplied the completion is ALSO routed through
      //    `onStatus.onPhaseComplete` so the projection learns about phase
      //    completion purely from events.
      const afterArgs: AfterPhaseArgs = {
        phaseId: phase.id,
        result,
        durationMs,
      };
      await this.registry.invokeObserve('afterPhase', afterArgs, hookCtx);
      this.options.onStatus?.onPhaseComplete?.({ phase: phase.id, durationMs });

      // 8. beforePhaseTransition (first-wins): default = advance. A jump
      //    rewrites the loop index to the target phase's position.
      const nextPhase = phases[index + 1];
      const transitionArgs: BeforePhaseTransitionArgs = {
        from: phase.id,
        to: nextPhase?.id ?? '',
        state,
      };
      const transitionResult = (await this.registry.invokeFirstWins(
        'beforePhaseTransition',
        transitionArgs,
        hookCtx,
      )) as PhaseTransition | undefined;
      const transition: PhaseTransition = transitionResult ?? { type: 'advance' };

      if (transition.type === 'jump' && transition.target !== undefined) {
        const targetIndex = phases.findIndex((p) => p.id === transition.target);
        index = targetIndex >= 0 ? targetIndex : index + 1;
      } else {
        // 'advance' (default) and 'loop' both move forward — 'loop' without a
        // bounded retry policy would infinite-loop, and shouldRetryPhase is
        // the bounded mechanism for re-running a phase, so we treat a bare
        // 'loop' transition as an advance.
        index++;
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Build the {@link PhaseRunContext} forwarded to each {@link PhaseDefinition.run}.
   * The same `state` reference is shared across every phase and every hook in
   * the run, so mutations propagate.
   */
  private makePhaseContext(state: Record<string, unknown>): PhaseRunContext {
    return {
      tracker: this.options.tracker,
      // Clone the registry so each phase's `run(ctx)` receives an isolated
      // snapshot via `ctx.hookRegistry`. Workflow code registering phase-
      // specific hooks on `ctx.hookRegistry` cannot leak to other phases, and
      // the shared `options.hookRegistry` is never mutated. The clone inherits
      // the shared registry's pre-existing subscribers (default hooks still
      // fire in each isolated scope).
      hookRegistry: this.registry.clone(),
      state,
      cwd: this.options.cwd,
      workDir: this.options.workDir,
      signal: this.options.signal,
    };
  }

  /**
   * Build the {@link HookContext} forwarded to every phase-level hook
   * invocation. Carries the registry so hooks may invoke sub-hooks.
   */
  private makeHookContext(): HookContext {
    return {
      registry: this.registry,
      cwd: this.options.cwd,
      workDir: this.options.workDir,
      signal: this.options.signal,
    };
  }

  /**
   * DEFAULT `shouldRetryPhase` behavior: retry while the phase result is a
   * `{ retry: true }`-shaped object. The `round < maxRounds` ceiling is
   * enforced by the caller, so this predicate only inspects the result shape.
   *
   * Reproduces the historical scouting ≤3-rounds compat: a phase signals
   * "retry needed" by returning `{ retry: true }`, and the runner re-runs it
   * up to `maxRounds` times.
   */
  private defaultShouldRetry(result: unknown): boolean {
    return typeof result === 'object' && result !== null && (result as { retry?: unknown }).retry === true;
  }
}

/**
 * Construct a {@link PhaseRunner} with the default (zero-config) behaviors.
 *
 * Equivalent to `new PhaseRunner(options)` — exported as a factory so callers
 * that prefer the functional style (and so the engine entry point can swap
 * implementations behind the same surface) have a stable entry point.
 */
export function createDefaultPhaseRunner(options: PhaseRunnerOptions): PhaseRunner {
  return new PhaseRunner(options);
}
