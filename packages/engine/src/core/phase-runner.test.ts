// ─── Tests for core/phase-runner.ts — the PhaseRunner orchestration class ────
//
// These tests pin the concrete `PhaseRunner` + `createDefaultPhaseRunner`
// behaviors against a REAL implementation: ./phase-runner.js now exports BOTH
// the types (`PhaseDefinition`, `PhaseRunContext`, `PhaseRunnerOptions`) AND
// the `PhaseRunner` class / `createDefaultPhaseRunner` factory. The file was
// originally written TDD-style against a not-yet-created module (RED imports →
// GREEN once the implementation landed); it is now a full GREEN regression
// suite for the runner's default + hook-driven orchestration: linear advance,
// the ≤3-rounds retry loop, beforePhase skip, beforePhaseTransition jump
// (forward AND backward), onPhaseSettled result collection, and
// deterministic / resumable tracker persistence across a skip.
//
// Module under test: ./phase-runner.js
//
// The PhaseRunner drives a workflow through its declared phases, honouring the
// phase-level influence hooks (`beforePhase`, `beforePhaseTransition`,
// `shouldRetryPhase`, `onPhaseSettled`, `afterPhase`) and bounded by
// `maxRounds` (default 3 — the historical ≤3-rounds retry logic).
//
// DEFAULT behaviors pinned here (no hooks registered):
//   - beforePhase            → no-op (don't skip)
//   - shouldRetryPhase       → retry while the phase result has `{ retry: true }`
//                              shape AND round < maxRounds (≤3-rounds compat)
//   - beforePhaseTransition  → { type: 'advance' } (linear progression)
//   - onPhaseSettled         → no-op (don't collect)
//
// The runner observes / mutates a REAL WorkflowStatusTracker, constructed
// against a temp directory (see makeTempDir). Per the task constraint we do NOT
// invent a WorkflowStatusTracker mock class — we use the real one and, where we
// need to observe invocations, wrap a single method (`save`) on the real
// instance (the same pattern used in tests/tracking/workflow-status.test.ts).
//
// NOTE on status-callback firing: PhaseRunnerOptions carries `tracker` +
// `hookRegistry` but NO `onStatus` surface (the option shape is pinned by
// tests/core/phase-runner.test.ts), so the legacy status-callback names from
// the task prose map onto the mechanisms the runner DOES own:
//   - "fire onPhaseRegister"  → tracker.registerPhase   (verified via tracker.phases)
//   - "fire onPhaseComplete"  → the `afterPhase` observe hook + tracker transition
//   - round progression       → the `round` arg passed to `shouldRetryPhase`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Task } from '../core/types.js';
import { createHookRegistry } from '../hooks/registry.js';
import type {
  AfterPhaseArgs,
  BeforePhaseArgs,
  BeforePhaseTransitionArgs,
  HookContext,
  HookRegistry,
  OnPhaseSettledArgs,
  ShouldRetryPhaseArgs,
} from '../hooks/types.js';
import { WorkflowStatusTracker } from '../tracking/workflow-status.js';
import type { PhaseDefinition, PhaseRunnerOptions } from './phase-runner.js';
import { PhaseRunner } from './phase-runner.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Build a minimal valid PhaseDefinition whose run resolves to a sentinel. */
function makePhase(
  overrides: Partial<Omit<PhaseDefinition, 'run'>> & { run?: PhaseDefinition['run'] } = {},
): PhaseDefinition {
  return {
    id: 'phase',
    label: 'Phase',
    icon: '🔹',
    run: async () => 'done',
    ...overrides,
  };
}

// Temp-directory tracking (inlined so this co-located test stays self-contained —
// mirrors hooks/defaults/workflow.test.ts). Each dir is created on demand and
// recursively removed in afterEach.
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `phase-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

// Shared per-test fixtures: a fresh temp dir + a REAL tracker each test.
let dir: string;
let tracker: WorkflowStatusTracker;

beforeEach(async () => {
  dir = await makeTempDir();
  tracker = new WorkflowStatusTracker(dir);
});

afterEach(async () => {
  tracker.dispose();
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

/** Build PhaseRunnerOptions anchored to the per-test dir + tracker. `phases`
 *  is required (no sensible default); tracker / cwd / workDir default to the
 *  per-test fixtures. */
function makeOptions(overrides: Partial<PhaseRunnerOptions> & { phases: PhaseDefinition[] }): PhaseRunnerOptions {
  return {
    tracker,
    cwd: dir,
    workDir: dir,
    ...overrides,
  };
}

// ── (a) linear advance ──────────────────────────────────────────────────────

describe('PhaseRunner — linear advance', () => {
  it('runs phases in declared order and records completion on the tracker', async () => {
    const order: string[] = [];
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        label: 'Alpha',
        icon: '🅰️',
        run: async () => {
          order.push('A');
        },
      }),
      makePhase({
        id: 'B',
        label: 'Bravo',
        icon: '🅱️',
        run: async () => {
          order.push('B');
        },
      }),
      makePhase({
        id: 'C',
        label: 'Charlie',
        icon: '🅲',
        run: async () => {
          order.push('C');
        },
      }),
    ];

    const runner = new PhaseRunner(makeOptions({ phases }));
    await runner.run();

    // Each phase ran exactly once, in declared order.
    expect(order).toEqual(['A', 'B', 'C']);
    // The tracker recorded the progression: C is current, A & B completed.
    expect(tracker.currentPhaseId).toBe('C');
    expect(tracker.completedPhaseIds).toEqual(['A', 'B']);
    // Every phase was registered for display (the "fire onPhaseRegister" step).
    expect(tracker.phases.map((p) => p.id)).toEqual(['A', 'B', 'C']);
  });

  it('passes a PhaseRunContext carrying the shared tracker, cwd, workDir and a mutable state bag', async () => {
    let observed: { cwd: string; workDir: string; hasTracker: boolean; stateIsObject: boolean } | undefined;
    const phase = makePhase({
      id: 'solo',
      run: async (ctx) => {
        observed = {
          cwd: ctx.cwd,
          workDir: ctx.workDir,
          hasTracker: ctx.tracker === tracker,
          stateIsObject: typeof ctx.state === 'object' && ctx.state !== null,
        };
      },
    });

    await new PhaseRunner(makeOptions({ phases: [phase] })).run();

    expect(observed).toEqual({ cwd: dir, workDir: dir, hasTracker: true, stateIsObject: true });
  });

  it('shares one mutable state bag across phases (a later phase reads an earlier phase write)', async () => {
    let seenByB: unknown;
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async (ctx) => {
          ctx.state.shared = 'from-A';
        },
      }),
      makePhase({
        id: 'B',
        run: async (ctx) => {
          seenByB = ctx.state.shared;
        },
      }),
    ];

    await new PhaseRunner(makeOptions({ phases })).run();

    expect(seenByB).toBe('from-A');
  });

  it('handles an empty phase list as a no-op', async () => {
    const runner = new PhaseRunner(makeOptions({ phases: [] }));
    await expect(runner.run()).resolves.toBeUndefined();
    expect(tracker.completedPhaseIds).toEqual([]);
    expect(tracker.phases).toEqual([]);
  });
});

// ── (b) shouldRetryPhase loops back (≤3 rounds) ────────────────────────────

describe('PhaseRunner — shouldRetryPhase (≤3 rounds)', () => {
  it('runs a phase exactly once when no retry is signalled (default)', async () => {
    let runs = 0;
    const phase = makePhase({
      id: 'once',
      run: async () => {
        runs++;
        return { ok: true };
      },
    });

    await new PhaseRunner(makeOptions({ phases: [phase] })).run();

    expect(runs).toBe(1);
  });

  it('default retry re-runs while the result is { retry: true }, bounded by the default maxRounds (3)', async () => {
    // The phase keeps asking for a retry until its 3rd run, then succeeds. With
    // the DEFAULT maxRounds (3) this yields exactly 3 runs — pinning the
    // historical ≤3-rounds bound. Robust to the round-numbering convention: the
    // 3rd run returns a non-retry result, so the loop stops there whether round
    // starts at 0 or 1. (If the default maxRounds were < 3, the bound would
    // stop the loop before the success result and runs would be < 3.)
    let runs = 0;
    const phase = makePhase({
      id: 'scout',
      run: async () => {
        runs++;
        return runs < 3 ? { retry: true } : { reports: ['r1'] };
      },
    });

    await new PhaseRunner(makeOptions({ phases: [phase] })).run();

    expect(runs).toBe(3);
  });

  it('an explicit shouldRetryPhase hook controls retry, bounded by maxRounds', async () => {
    let runs = 0;
    const phase = makePhase({
      id: 'flaky',
      run: async () => {
        runs++;
        return `attempt-${runs}`;
      },
    });
    const registry = createHookRegistry();
    // Retry until 3 total runs (runCount-based → independent of round numbering).
    registry.register({ shouldRetryPhase: () => runs < 3 });

    await new PhaseRunner(makeOptions({ phases: [phase], hookRegistry: registry, maxRounds: 3 })).run();

    expect(runs).toBe(3);
  });

  it('maxRounds is a hard ceiling even when the hook always asks to retry', async () => {
    // shouldRetryPhase always returns true, but maxRounds=2 caps execution at 2
    // rounds (rounds 1, then 2). Pins the ≤maxRounds bound and the rounds-are-
    // 1-indexed convention (the historical "≤3 rounds" = rounds 1,2,3).
    let runs = 0;
    const phase = makePhase({
      id: 'greedy',
      run: async () => {
        runs++;
        return runs;
      },
    });
    const registry = createHookRegistry();
    registry.register({ shouldRetryPhase: () => true });

    await new PhaseRunner(makeOptions({ phases: [phase], hookRegistry: registry, maxRounds: 2 })).run();

    expect(runs).toBe(2);
  });

  it('an explicit shouldRetryPhase=false wins over a { retry: true } result', async () => {
    // The default would retry on { retry: true }, but a registered hook
    // returning false (non-undefined) short-circuits first-wins → no retry.
    let runs = 0;
    const phase = makePhase({
      id: 'opt',
      run: async () => {
        runs++;
        return { retry: true };
      },
    });
    const registry = createHookRegistry();
    registry.register({ shouldRetryPhase: () => false });

    await new PhaseRunner(makeOptions({ phases: [phase], hookRegistry: registry, maxRounds: 3 })).run();

    expect(runs).toBe(1);
  });

  it('passes an incrementing, 1-indexed round number to shouldRetryPhase', async () => {
    const rounds: number[] = [];
    const phase = makePhase({ id: 'rounds', run: async () => ({ retry: true }) });
    const registry = createHookRegistry();
    registry.register({
      shouldRetryPhase: (args: ShouldRetryPhaseArgs) => {
        rounds.push(args.round);
        return rounds.length < 3; // stop after 3 observations
      },
    });

    await new PhaseRunner(makeOptions({ phases: [phase], hookRegistry: registry, maxRounds: 3 })).run();

    // Round strictly increases across retries (1, 2, 3) — the documented
    // "≤3 rounds" semantics.
    expect(rounds).toEqual([1, 2, 3]);
  });

  it('default maxRounds is exactly 3 — pinning the shared DEFAULT_MAX_ROUNDS value', async () => {
    // CHARACTERIZATION: after the consolidation refactor, the PhaseRunner
    // default MUST remain 3 (the shared DEFAULT_MAX_ROUNDS constant). An
    // always-retry hook with no explicit maxRounds option should cap
    // execution at exactly 3 runs — proving the default is the historical
    // magic number 3, not a local copy that could drift.
    const expectedRounds = 3;
    let runs = 0;
    const phase = makePhase({
      id: 'ceiling',
      run: async () => {
        runs++;
        return runs;
      },
    });
    const registry = createHookRegistry();
    registry.register({ shouldRetryPhase: () => true });

    // NO explicit maxRounds → defaults to the shared constant.
    await new PhaseRunner(makeOptions({ phases: [phase], hookRegistry: registry })).run();

    expect(runs).toBe(expectedRounds);
  });

  it('maxRounds=1 means exactly one run (no retries) even when the hook always asks to retry', async () => {
    // Boundary: maxRounds=1 is the minimum non-zero ceiling — the phase runs
    // once and the retry loop never re-enters. Pins the lower bound so a
    // refactor of the default does not alter the single-round semantics.
    let runs = 0;
    const phase = makePhase({
      id: 'once-only',
      run: async () => {
        runs++;
      },
    });
    const registry = createHookRegistry();
    registry.register({ shouldRetryPhase: () => true });

    await new PhaseRunner(makeOptions({ phases: [phase], hookRegistry: registry, maxRounds: 1 })).run();

    expect(runs).toBe(1);
  });
});

// ── (c) beforePhase skip=true ───────────────────────────────────────────────

describe('PhaseRunner — beforePhase skip', () => {
  it('skips execution when beforePhase returns { skip: true } but still completes the phase', async () => {
    const ran = new Set<string>();
    const afterPhaseFired: string[] = [];
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async () => {
          ran.add('A');
        },
      }),
      makePhase({
        id: 'B',
        run: async () => {
          ran.add('B');
        },
      }),
    ];
    const registry = createHookRegistry();
    registry.register({
      beforePhase: (args: BeforePhaseArgs) => (args.phaseId === 'A' ? { skip: true } : undefined),
      // "fire onPhaseComplete" maps onto the afterPhase observe hook here.
      afterPhase: (args: AfterPhaseArgs) => {
        afterPhaseFired.push(args.phaseId);
      },
    });

    await new PhaseRunner(makeOptions({ phases, hookRegistry: registry })).run();

    // Phase A was NOT executed...
    expect(ran.has('A')).toBe(false);
    // ...but B was, so execution still advanced past A.
    expect(ran.has('B')).toBe(true);
    // onPhaseComplete (afterPhase) STILL fires for the skipped phase A.
    expect(afterPhaseFired).toContain('A');
    expect(afterPhaseFired).toContain('B');
    // The skipped phase still counts as completed for transition purposes.
    expect(tracker.completedPhaseIds).toEqual(['A']);
    expect(tracker.currentPhaseId).toBe('B');
  });

  it('skips a MIDDLE phase (B) but still fires onPhaseComplete and advances to C', async () => {
    // Task requirement (3): a beforePhase { skip: true } for phase B means B's
    // run() is NOT called, yet the observe hook ("onPhaseComplete" → afterPhase)
    // STILL fires for B and the NEXT phase (C) advances normally.
    const ran: string[] = [];
    const onPhaseComplete: string[] = [];
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async () => {
          ran.push('A');
        },
      }),
      makePhase({
        id: 'B',
        run: async () => {
          ran.push('B');
        },
      }),
      makePhase({
        id: 'C',
        run: async () => {
          ran.push('C');
        },
      }),
    ];
    const registry = createHookRegistry();
    registry.register({
      beforePhase: (args: BeforePhaseArgs) => (args.phaseId === 'B' ? { skip: true } : undefined),
      afterPhase: (args: AfterPhaseArgs) => {
        onPhaseComplete.push(args.phaseId);
      },
    });

    await new PhaseRunner(makeOptions({ phases, hookRegistry: registry })).run();

    // B never executed (its run() was never invoked)...
    expect(ran).toEqual(['A', 'C']);
    // ...but onPhaseComplete STILL fired for B — the observe hook runs even for
    // skipped phases (the result is simply undefined).
    expect(onPhaseComplete).toEqual(['A', 'B', 'C']);
    // The runner still advanced past the skipped phase: C is current, A & B are
    // recorded as completed (a downstream consumer sees a linear progression).
    expect(tracker.currentPhaseId).toBe('C');
    expect(tracker.completedPhaseIds).toEqual(['A', 'B']);
  });

  it('applies beforePhase statePatch to the shared state before invoking run', async () => {
    let seen: unknown;
    const phase = makePhase({
      id: 'A',
      run: async (ctx) => {
        seen = ctx.state.injected;
      },
    });
    const registry = createHookRegistry();
    registry.register({ beforePhase: () => ({ statePatch: { injected: 42 } }) });

    await new PhaseRunner(makeOptions({ phases: [phase], hookRegistry: registry })).run();

    expect(seen).toBe(42);
  });
});

// ── (d) beforePhaseTransition jump ──────────────────────────────────────────

describe('PhaseRunner — beforePhaseTransition jump', () => {
  it('jumps to a target phase, skipping the linearly-next one', async () => {
    const ran: string[] = [];
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async () => {
          ran.push('A');
        },
      }),
      makePhase({
        id: 'B',
        run: async () => {
          ran.push('B');
        },
      }),
      makePhase({
        id: 'C',
        run: async () => {
          ran.push('C');
        },
      }),
    ];
    const registry = createHookRegistry();
    registry.register({
      beforePhaseTransition: (args: BeforePhaseTransitionArgs) =>
        args.from === 'A' ? { type: 'jump', target: 'C' } : undefined,
    });

    await new PhaseRunner(makeOptions({ phases, hookRegistry: registry })).run();

    // A ran, then we jumped A → C, so B was never visited.
    expect(ran).toEqual(['A', 'C']);
    expect(tracker.currentPhaseId).toBe('C');
    // B was never set as current, so it does not appear in completedPhaseIds.
    expect(tracker.completedPhaseIds).toEqual(['A']);
  });

  it('jumps BACKWARD to a target phase ({ type: "jump", target }) and re-runs it', async () => {
    // Task requirement (4): after phase B, beforePhaseTransition returns
    // { type: 'jump', target: 'A' } → execution jumps back to A and re-runs it.
    // The runner has NO built-in jump-cycle guard, so the hook owns termination:
    // here the jump fires only on the FIRST B visit (bVisits === 1); the second
    // B visit falls through to the default advance.
    const order: string[] = [];
    let bVisits = 0;
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async () => {
          order.push('A');
        },
      }),
      makePhase({
        id: 'B',
        run: async () => {
          bVisits += 1;
          order.push('B');
        },
      }),
      makePhase({
        id: 'C',
        run: async () => {
          order.push('C');
        },
      }),
    ];
    const registry = createHookRegistry();
    registry.register({
      beforePhaseTransition: (args: BeforePhaseTransitionArgs) =>
        args.from === 'B' && bVisits === 1 ? { type: 'jump', target: 'A' } : undefined,
    });

    await new PhaseRunner(makeOptions({ phases, hookRegistry: registry })).run();

    // Execution order: A, B(1st) → jump back to A, B(2nd) → advance C.
    expect(order).toEqual(['A', 'B', 'A', 'B', 'C']);
    // B was genuinely re-run by the backward jump (not just re-entered).
    expect(bVisits).toBe(2);
    // C is the final current phase — the run terminated cleanly after the jump.
    expect(tracker.currentPhaseId).toBe('C');
  });

  it('a jump to an unknown target falls back to advancing (no crash, no infinite loop)', async () => {
    // Defensive: a bogus jump target must not throw or spin forever — the
    // runner falls back to a linear advance so a misconfigured hook can never
    // wedge the workflow.
    const ran: string[] = [];
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async () => {
          ran.push('A');
        },
      }),
      makePhase({
        id: 'B',
        run: async () => {
          ran.push('B');
        },
      }),
    ];
    const registry = createHookRegistry();
    registry.register({
      beforePhaseTransition: () => ({ type: 'jump', target: 'no-such-phase' }),
    });

    await expect(new PhaseRunner(makeOptions({ phases, hookRegistry: registry })).run()).resolves.toBeUndefined();
    expect(ran).toEqual(['A', 'B']);
  });

  it('default transition (no hook) advances linearly', async () => {
    const ran: string[] = [];
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async () => {
          ran.push('A');
        },
      }),
      makePhase({
        id: 'B',
        run: async () => {
          ran.push('B');
        },
      }),
    ];
    // No hookRegistry → the default { type: 'advance' } transition proceeds.
    await new PhaseRunner(makeOptions({ phases })).run();

    expect(ran).toEqual(['A', 'B']);
    expect(tracker.currentPhaseId).toBe('B');
    expect(tracker.completedPhaseIds).toEqual(['A']);
  });
});

// ── (e) onPhaseSettled collects task results into state ─────────────────────

describe('PhaseRunner — onPhaseSettled', () => {
  it('passes the phase tasks to onPhaseSettled and persists hook state writes for later phases', async () => {
    let settledTasks: Task[] | undefined;
    let seenByPlan: unknown;

    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'scout',
        // The scout phase produces settled tasks (with results) in the tracker.
        run: async (ctx) => {
          ctx.tracker.taskTracker.addTask({
            id: 's1',
            title: 'scout-1',
            prompt: 'p',
            profile: 'scout',
            files: [],
            dependencies: [],
            phaseId: 'scout',
            worktree: 'none',
            status: 'complete',
            result: { found: 'api-keys' },
          });
          ctx.tracker.taskTracker.addTask({
            id: 's2',
            title: 'scout-2',
            prompt: 'p',
            profile: 'scout',
            files: [],
            dependencies: [],
            phaseId: 'scout',
            worktree: 'none',
            status: 'complete',
            result: { found: 'endpoints' },
          });
        },
      }),
      makePhase({
        id: 'plan',
        run: async (ctx) => {
          seenByPlan = ctx.state.scoutResults;
        },
      }),
    ];

    const registry = createHookRegistry();
    registry.register({
      onPhaseSettled: (args: OnPhaseSettledArgs) => {
        if (args.phaseId === 'scout') {
          settledTasks = args.tasks;
          // Collect each scout task's result into the shared state bag.
          args.state.scoutResults = args.tasks.filter((t) => t.phaseId === 'scout').map((t) => t.result);
        }
      },
    });

    await new PhaseRunner(makeOptions({ phases, hookRegistry: registry })).run();

    // onPhaseSettled received the scout phase's tasks (with their results).
    expect(settledTasks?.map((t) => t.id).sort()).toEqual(['s1', 's2']);
    // The collected results landed in the shared state, readable by the next phase.
    expect(seenByPlan).toEqual([{ found: 'api-keys' }, { found: 'endpoints' }]);
  });

  it('collects phase A COMPLETED task results into state.phaseAResults for later phases', async () => {
    // Task requirement (5): onPhaseSettled collects the COMPLETED task results
    // of phase A into the shared state bag under a named key (phaseAResults),
    // which a subsequent phase reads. Only settled (complete) tasks are
    // collected — a task still in flight is excluded by the hook's own filter.
    let seenByB: unknown;
    let settledForA: Task[] | undefined;
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async (ctx) => {
          ctx.tracker.taskTracker.addTask({
            id: 'a1',
            title: 'task-1',
            prompt: 'p',
            profile: 'arch',
            files: [],
            dependencies: [],
            phaseId: 'A',
            worktree: 'none',
            status: 'complete',
            result: { artifact: 'doc.md' },
          });
          ctx.tracker.taskTracker.addTask({
            id: 'a2',
            title: 'task-2',
            prompt: 'p',
            profile: 'arch',
            files: [],
            dependencies: [],
            phaseId: 'A',
            worktree: 'none',
            status: 'complete',
            result: { artifact: 'spec.md' },
          });
          ctx.tracker.taskTracker.addTask({
            id: 'a3',
            title: 'task-3',
            prompt: 'p',
            profile: 'arch',
            files: [],
            dependencies: [],
            phaseId: 'A',
            worktree: 'none',
            status: 'active',
          });
        },
      }),
      makePhase({
        id: 'B',
        run: async (ctx) => {
          seenByB = ctx.state.phaseAResults;
        },
      }),
    ];
    const registry = createHookRegistry();
    registry.register({
      onPhaseSettled: (args: OnPhaseSettledArgs) => {
        if (args.phaseId === 'A') {
          settledForA = args.tasks;
          // Collect ONLY completed phase-A task results into state.phaseAResults.
          args.state.phaseAResults = args.tasks
            .filter((t) => t.phaseId === 'A' && t.status === 'complete')
            .map((t) => t.result);
        }
      },
    });

    await new PhaseRunner(makeOptions({ phases, hookRegistry: registry })).run();

    // The hook observed every phase-A task (including the still-active one)...
    expect(settledForA?.map((t) => t.id).sort()).toEqual(['a1', 'a2', 'a3']);
    // ...but only the two COMPLETE results were collected into state.phaseAResults.
    expect(seenByB).toEqual([{ artifact: 'doc.md' }, { artifact: 'spec.md' }]);
  });
});

// ── (f) tracker state is persisted after each phase ─────────────────────────

describe('PhaseRunner — tracker persistence', () => {
  it('persists tracker state after each phase transition', async () => {
    const phases: PhaseDefinition[] = [
      makePhase({ id: 'A', run: async () => {} }),
      makePhase({ id: 'B', run: async () => {} }),
      makePhase({ id: 'C', run: async () => {} }),
    ];

    // Wrap the REAL tracker.save to snapshot the tracker state at each call.
    // (Only one method is wrapped on the real instance — no mock class.)
    const snapshots: { current: string; completed: string[] }[] = [];
    const originalSave = tracker.save.bind(tracker);
    tracker.save = async () => {
      snapshots.push({ current: tracker.currentPhaseId, completed: [...tracker.completedPhaseIds] });
      await originalSave();
    };

    await new PhaseRunner(makeOptions({ phases })).run();

    // save() was invoked at intermediate points — one per phase transition —
    // capturing each phase becoming current (A, then B with A completed, then
    // C with B completed). `setPhase` does NOT auto-persist, so these snapshots
    // can only exist if the runner explicitly calls save() after transitions.
    expect(snapshots.some((s) => s.current === 'A')).toBe(true);
    expect(snapshots.some((s) => s.current === 'B' && s.completed.includes('A'))).toBe(true);
    expect(snapshots.some((s) => s.current === 'C' && s.completed.includes('B'))).toBe(true);

    // The final persisted file on disk reflects the full progression.
    const raw = await readFile(join(dir, '.engin-state.json'), 'utf-8');
    const persisted = JSON.parse(raw) as Record<string, unknown>;
    expect(persisted.currentPhaseId).toBe('C');
    expect(persisted.completedPhaseIds).toEqual(['A', 'B']);
  });
});

// ── (g) deterministic settlement: skip still persists + resumes ─────────────

describe('PhaseRunner — deterministic settlement (resume after skip)', () => {
  it('calls tracker.save() even when a phase is skipped, leaving a resumable on-disk state', async () => {
    // Task requirement (6): when beforePhase skips a phase, the tracker is
    // STILL in a valid, persisted state — save() was invoked (the runner calls
    // setPhase + save BEFORE the skip decision) and a subsequent resume
    // reconstructs the full progression from disk with no data loss.
    const ran: string[] = [];
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async () => {
          ran.push('A');
        },
      }),
      makePhase({
        id: 'B',
        run: async () => {
          ran.push('B');
        },
      }),
      makePhase({
        id: 'C',
        run: async () => {
          ran.push('C');
        },
      }),
    ];
    const registry = createHookRegistry();
    registry.register({
      beforePhase: (args: BeforePhaseArgs) => (args.phaseId === 'B' ? { skip: true } : undefined),
    });

    // Wrap the REAL tracker.save to count invocations (no mock tracker class —
    // the same single-method wrap pattern used in the persistence suite above).
    let saveCalls = 0;
    const originalSave = tracker.save.bind(tracker);
    tracker.save = async () => {
      saveCalls += 1;
      await originalSave();
    };

    await new PhaseRunner(makeOptions({ phases, hookRegistry: registry })).run();

    // B was skipped — never ran.
    expect(ran).toEqual(['A', 'C']);
    // save() was called at least once per phase transition (A, B, C) — proving
    // the runner persisted state even across the skipped phase.
    expect(saveCalls).toBeGreaterThanOrEqual(3);

    // Force-flush any queued auto-persist so the on-disk file is fully settled
    // before we read it back.
    await tracker.save();

    // The on-disk file reflects a valid, linear progression through the skip.
    const raw = await readFile(join(dir, '.engin-state.json'), 'utf-8');
    const persisted = JSON.parse(raw) as { currentPhaseId: string; completedPhaseIds: string[] };
    expect(persisted.currentPhaseId).toBe('C');
    expect(persisted.completedPhaseIds).toEqual(['A', 'B']);

    // Resume would work correctly: a FRESH tracker loaded from the same dir
    // round-trips the persisted phase progression exactly (no loss across skip).
    const resumed = await WorkflowStatusTracker.load(dir);
    try {
      expect(resumed.currentPhaseId).toBe('C');
      expect(resumed.completedPhaseIds).toEqual(['A', 'B']);
    } finally {
      resumed.dispose();
    }
  });

  it('resumes into a tracker that can continue advancing (persisted state is actionable)', async () => {
    // A two-phase run (A runs, B skipped) leaves a persisted state; loading it
    // back yields a tracker whose phase markers a follow-on runner could resume
    // from. We pin the round-trip AND that the resumed tracker is usable:
    // advancing it reproduces the expected completed-phase history.
    const registry = createHookRegistry();
    registry.register({
      beforePhase: (args: BeforePhaseArgs) => (args.phaseId === 'B' ? { skip: true } : undefined),
    });
    const phases: PhaseDefinition[] = [
      makePhase({ id: 'A', run: async () => {} }),
      makePhase({ id: 'B', run: async () => {} }),
    ];

    await new PhaseRunner(makeOptions({ phases, hookRegistry: registry })).run();
    // Force-flush so load() observes the terminal state.
    await tracker.save();

    const resumed = await WorkflowStatusTracker.load(dir);
    try {
      expect(resumed.currentPhaseId).toBe('B');
      expect(resumed.completedPhaseIds).toEqual(['A']);
      // A follow-on runner could resume by advancing to the next phase:
      resumed.setPhase('C');
      expect(resumed.currentPhaseId).toBe('C');
      expect(resumed.completedPhaseIds).toEqual(['A', 'B']);
    } finally {
      resumed.dispose();
    }
  });
});

// ── hook invocation context (bonus) ─────────────────────────────────────────

describe('PhaseRunner — hook invocation', () => {
  it('invokes hooks with a HookContext carrying cwd, workDir and the registry', async () => {
    let seenCtx: HookContext | undefined;
    const registry = createHookRegistry();
    registry.register({
      beforePhase: (_args: BeforePhaseArgs, ctx: HookContext) => {
        seenCtx = ctx;
        return undefined;
      },
    });

    await new PhaseRunner(makeOptions({ phases: [makePhase({ id: 'A' })], hookRegistry: registry })).run();

    expect(seenCtx?.cwd).toBe(dir);
    expect(seenCtx?.workDir).toBe(dir);
    // The same registry is forwarded so hooks may invoke sub-hooks.
    expect(seenCtx?.registry).toBe(registry);
  });

  it('surfaces the phase result and a non-negative duration to the afterPhase hook', async () => {
    let captured: { phaseId: string; result: unknown; durationMs: number } | undefined;
    const registry = createHookRegistry();
    registry.register({
      afterPhase: (args: AfterPhaseArgs) => {
        captured = { phaseId: args.phaseId, result: args.result, durationMs: args.durationMs };
      },
    });
    const phase = makePhase({ id: 'A', run: async () => ({ value: 7 }) });

    await new PhaseRunner(makeOptions({ phases: [phase], hookRegistry: registry })).run();

    expect(captured?.phaseId).toBe('A');
    expect(captured?.result).toEqual({ value: 7 });
    expect(typeof captured?.durationMs).toBe('number');
    expect(captured?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Per-phase hook registry isolation ───────────────────────────────────────
//
// Each phase's `run(ctx)` receives an isolated `hookRegistry` via
// `PhaseRunContext.hookRegistry` — a clone of the shared registry created by
// `makePhaseContext` (which calls `this.registry.clone()`). A subscriber
// registered in phase A's `run()` on `ctx.hookRegistry` is NOT visible to
// phase B's `ctx.hookRegistry`, and the shared `options.hookRegistry` is NOT
// mutated. Pre-existing subscribers from the shared registry are inherited by
// each clone.

describe('PhaseRunner — per-phase registry isolation', () => {
  it('each phase receives a distinct hookRegistry instance (not the shared one)', async () => {
    const registries: Array<{ phaseId: string; registry: HookRegistry | undefined }> = [];

    const sharedRegistry = createHookRegistry();
    // Pre-existing subscriber on the shared registry — must be inherited.
    sharedRegistry.register({ afterPhase: () => {} });

    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async (ctx) => {
          registries.push({ phaseId: 'A', registry: ctx.hookRegistry });
        },
      }),
      makePhase({
        id: 'B',
        run: async (ctx) => {
          registries.push({ phaseId: 'B', registry: ctx.hookRegistry });
        },
      }),
    ];

    await new PhaseRunner(makeOptions({ phases, hookRegistry: sharedRegistry })).run();

    const regA = registries.find((r) => r.phaseId === 'A')?.registry;
    const regB = registries.find((r) => r.phaseId === 'B')?.registry;

    // Each phase must receive a registry.
    expect(regA).toBeDefined();
    expect(regB).toBeDefined();

    // They must be DIFFERENT instances (clones, not the shared one).
    expect(regA).not.toBe(regB);
    expect(regA).not.toBe(sharedRegistry);
    expect(regB).not.toBe(sharedRegistry);
  });

  it('a beforeTask subscriber registered in phase A is NOT visible to phase B', async () => {
    let phaseASeenBeforeTask: boolean | undefined;
    let phaseBSeenBeforeTask: boolean | undefined;

    const sharedRegistry = createHookRegistry();

    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async (ctx) => {
          // Register a beforeTask subscriber ONLY on phase A's registry.
          ctx.hookRegistry?.register({ beforeTask: () => ({ skip: true }) });
          phaseASeenBeforeTask = ctx.hookRegistry?.hasSubscribers('beforeTask');
        },
      }),
      makePhase({
        id: 'B',
        run: async (ctx) => {
          phaseBSeenBeforeTask = ctx.hookRegistry?.hasSubscribers('beforeTask');
        },
      }),
    ];

    await new PhaseRunner(makeOptions({ phases, hookRegistry: sharedRegistry })).run();

    // Phase A's registry DOES have the subscriber (it was registered there).
    expect(phaseASeenBeforeTask).toBe(true);
    // Phase B's registry does NOT — isolation held.
    expect(phaseBSeenBeforeTask).toBe(false);
  });

  it('the shared options.hookRegistry is NOT mutated by phase registrations', async () => {
    const sharedRegistry = createHookRegistry();

    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async (ctx) => {
          // Register on the phase-local registry — must not leak.
          ctx.hookRegistry?.register({ beforeTask: () => ({ skip: true }) });
        },
      }),
      makePhase({ id: 'B' }),
    ];

    await new PhaseRunner(makeOptions({ phases, hookRegistry: sharedRegistry })).run();

    // The shared registry must NOT have gained a beforeTask subscriber.
    expect(sharedRegistry.hasSubscribers('beforeTask')).toBe(false);
  });

  it('each phase registry inherits pre-existing subscribers from the shared registry', async () => {
    const sharedRegistry = createHookRegistry();
    const seen: string[] = [];
    sharedRegistry.register({
      afterPhase: () => {
        seen.push('shared-subscriber');
      },
    });

    let phaseARegistry: HookRegistry | undefined;
    const phases: PhaseDefinition[] = [
      makePhase({
        id: 'A',
        run: async (ctx) => {
          phaseARegistry = ctx.hookRegistry;
        },
      }),
    ];

    await new PhaseRunner(makeOptions({ phases, hookRegistry: sharedRegistry })).run();

    // The phase's cloned registry inherited the shared subscriber.
    expect(phaseARegistry?.hasSubscribers('afterPhase')).toBe(true);
    // And it fires when invoked on the clone. The runner already fired it
    // once during its own afterPhase invocation on the shared registry, so
    // the manual invocation on the clone adds a second entry.
    await phaseARegistry?.invokeObserve('afterPhase' as never, undefined, {
      registry: phaseARegistry!,
      cwd: dir,
      workDir: dir,
    });
    expect(seen).toEqual(['shared-subscriber', 'shared-subscriber']);
  });
});
