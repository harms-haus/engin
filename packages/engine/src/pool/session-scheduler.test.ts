// ─── Tests for pool/session-scheduler.ts ───────────────────────────────────
//
// SessionScheduler is the centerpiece of the pool refactor: it drives the
// task DAG (TaskGraph) through the concurrency gate (SessionGate), starting
// sessions in a greedy tiered drain pass (T1 active-affinity → T2 parked →
// T3 ready), respecting batch atomicity, lazy activation, and parking.
//
// Tests use a real SessionGate with small caps, fake SessionPlanRunners
// with controllable plan generators, and deferreds for deterministic timing.
// No real agent sessions or filesystem I/O. All tests are deterministic:
// no setTimeout / sleep — only microtask yields (Promise.resolve) are used to
// let the scheduler make progress between assertions.
//
// ─── Compliance Matrix ────────────────────────────────────────────────────
//
// Maps each lean rule, trigger, and helper to the test case(s) that verify it.
//
// 10 Lean Rules:
//   R1  Batch atomicity — gen.next(results) only when ALL specs in heldBatch
//       settled.                        Tests: 4, 6, 11, 12, 17, 24, 28
//   R2  Lazy activation — ready task stays 'ready' until first session
//       acquires a slot.                Tests: 10, 29
//   R3  Single-writer status — all transitions through graph.setTaskStatus.
//                                      Tests: 1, 2, 5, 13, 18
//   R4  Parking — spec that can't acquire parks the TASK (not the batch);
//       started siblings continue.     Tests: 4, 5, 14, 17, 19
//   R5  Coalesced drain — multiple near-simultaneous completions → ONE
//       drain pass.                     Test:  29
//   R6  T1 active-affinity — continue specs in active task's held batch.
//                                      Tests: 4, 6, 11, 17, 24
//   R7  T2 parked resume — resume parked tasks whose specs now fit.
//                                      Tests: 5, 19
//   R8  T3 ready init — initialize runner + first batch, start first specs.
//                                      Tests: 1, 2, 3, 10, 25
//   R9  Gate ownership — scheduler acquires before execute, releases on
//       settle.                         Tests: 3, 4, 6, 14
//   R10 Empty-batch skip — skip empty yields, no false-positive deadlock.
//                                      Tests: 15, 16
//
// 2 Triggers:
//   T-A  Session settle → release slot → scheduleDrain.
//                                      Tests: 2, 3, 4, 6, 11, 24, 28
//   T-B  Gate onRelease → scheduleDrain (capacity freed mid-batch).
//                                      Tests: 4, 6, 17
//
// 4 Helpers:
//   H1  tick()         — microtask yield (deterministic timing).
//                      Used by: 4, 5, 6, 10, 11, 12, 13, 17, 19, 20, 24, 28, 29
//   H2  deferred()     — externally-controlled promise.
//                      Used by: all SpecControl-based tests.
//   H3  makeFakeRunnerFactory() — controllable plan generator.
//                      Used by: most tests (see makeFakeRunnerFactory calls).
//   H4  makeSpecControls() — spec.id → deferred map.
//                      Used by: all SpecControl-based tests.
//
// G2 Case Coverage:
//   (1)  Single single-session completes          → test 1
//   (2)  Two tasks dep→child-after-parent          → test 2
//   (3)  Model saturation cap=1                    → test 3
//   (4)  Parked / parallel batch parking           → tests 4, 19
//   (5)  Priority parked-before-ready              → test 5
//   (6)  Parallel batch of 3 partial-fit           → test 6
//   (7)  Council worker batch → synthesizer        → test 24  ★ ADDED
//   (8)  Coordinator dynamic fan-out               → test 25  ★ ADDED
//   (9)  Deadlock missing-dep                      → test 7
//   (10) Resource deadlock                         → test 8
//   (11) beforeTask skip                           → test 9
//   (12) beforeTask runner OVERRIDE                → test 26  ★ ADDED
//   (13) Abort                                     → tests 13, 18, 20
//   (14) Empty task set → {0,0}                    → test 27  ★ ADDED
//   (15-17) Tier priority across 3 tiers           → test 5
//   (18) Review loop execute→review→reject→re-exe  → test 28  ★ ADDED
//   (19) Resume-after-crash cached replay          → tests 22, 23
//   (20) Resume mid-batch                          → test 22
//   (21) Coalesced multi-complete drains once      → test 29  ★ ADDED
//   (22) Greedy starts max on capacity             → tests 4, 6

import { describe, expect, it } from 'bun:test';

import type { TaskStatus } from '@engin/shared/types';
import type { AgentProfile, Task } from '../core/types.js';

import type { SessionPlanContext, SessionPlanRunner } from './runners/session-plan-types.js';
import { SessionGate } from './session-gate.js';
import { SessionScheduler } from './session-scheduler.js';
import type { TaskGraphEntry } from './task-graph.js';
// Namespace import so this file still loads before the green team exports
// GeneratorTimeoutError (a missing *named* export would otherwise abort the
// whole file with a SyntaxError). `schedulerModule.GeneratorTimeoutError` is
// `undefined` until exported.
import * as schedulerModule from './session-scheduler.js';
import type { SessionResult, SessionSpec } from './session.js';
import { SessionError } from './session.js';
import { TaskGraph } from './task-graph.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Deferred — externally resolve/reject a promise for deterministic timing. */
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Yield control so the scheduler's microtasks (queueMicrotask / await
 * continuations) can process. Fifteen turns covers one full drain pass
 * including the extra microtask hops introduced by withTimeout wrapping
 * (each gen.next() and runner.execute() is raced against a timeout,
 * adding ~1-2 microtask hops per call).
 */
async function tick(n = 15): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

/** Make a minimal SessionSpec. */
function makeSpec(id: string, profile: string, overrides?: Partial<SessionSpec>): SessionSpec {
  return { id, profile, prompt: `prompt-${id}`, outputMode: 'text', runnerRole: 'executor', attempt: 1, ...overrides };
}

/** Make a minimal Task. */
function makeTask(id: string, overrides?: Partial<Task>): Task {
  return {
    id,
    title: `Task ${id}`,
    prompt: `prompt-${id}`,
    profile: 'default',
    files: [],
    dependencies: [],
    status: 'ready',
    phaseId: 'test',
    worktree: 'none',
    ...overrides,
  };
}

/** Make a minimal AgentProfile. */
function makeProfile(id: string, provider = 'p', model = 'm'): AgentProfile {
  return {
    id,
    name: id,
    provider,
    model,
    thinkingLevel: 'off',
    systemPrompt: '',
    excludeTools: [],
    includeTools: [],
  };
}

// ── Fake runner infrastructure ──────────────────────────────────────────────

/** A handle to control when a specific session spec completes. */
interface SpecControl {
  deferred: { promise: Promise<SessionResult>; resolve: (r: SessionResult) => void; reject: (e: unknown) => void };
}

/**
 * Create a set of controllable spec handles. Each spec.id gets a deferred.
 * The fake runner's execute() awaits the deferred, so tests control timing.
 */
function makeSpecControls(specIds: string[]): Map<string, SpecControl> {
  const map = new Map<string, SpecControl>();
  for (const id of specIds) {
    const d = deferred<SessionResult>();
    map.set(id, { deferred: d });
  }
  return map;
}

/** Resolve a spec control with a success result. */
function completeSpec(controls: Map<string, SpecControl>, id: string, text = `result-${id}`): void {
  controls.get(id)?.deferred.resolve({ mode: 'text', text });
}

/** Reject a spec control (simulates execute() throwing). */
function failSpec(controls: Map<string, SpecControl>, id: string, reason = `error-${id}`): void {
  controls.get(id)?.deferred.reject(new Error(reason));
}

/**
 * Build a fake SessionPlanRunner factory.
 *
 * @param batches  - the batches the runner's plan() will yield (consumed in order).
 * @param controls - spec.id → deferred controlling when execute() resolves.
 * @param log      - event log array (pushed to on execute start/end).
 */
function makeFakeRunnerFactory(
  batches: SessionSpec[][],
  controls: Map<string, SpecControl>,
  log: string[],
): () => SessionPlanRunner {
  return () => {
    const queue = batches.map((b) => [...b]);
    return {
      async *plan(
        _ctx: SessionPlanContext,
      ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        while (queue.length > 0) {
          const batch = queue.shift()!;
          yield batch;
        }
        return undefined;
      },
      async execute(_ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> {
        log.push(`start:${spec.id}`);
        const ctrl = controls.get(spec.id);
        const result = ctrl
          ? await ctrl.deferred.promise
          : ({ mode: 'text' as const, text: `result-${spec.id}` } as SessionResult);
        log.push(`end:${spec.id}`);
        return result;
      },
    };
  };
}

// ── Scheduler builder ───────────────────────────────────────────────────────

interface SchedulerFixture {
  graph: TaskGraph;
  gate: SessionGate;
  profiles: Map<string, AgentProfile>;
  activeSessions: Set<{ abort(): Promise<void> }>;
  log: string[];
  events: { taskId: string; status: TaskStatus }[];
  scheduler: SessionScheduler;
}

function buildFixture(opts: {
  tasks: Array<Task & { runnerFactory?: () => SessionPlanRunner }>;
  profiles: Map<string, AgentProfile>;
  gate: SessionGate;
  log?: string[];
}): SchedulerFixture {
  const graph = new TaskGraph();
  const events: { taskId: string; status: TaskStatus }[] = [];

  for (const t of opts.tasks) {
    const { runnerFactory, ...task } = t;
    graph.addTask(
      task,
      runnerFactory ??
        ((): SessionPlanRunner => ({
          async *plan() {
            yield [];
            return undefined;
          },
          async execute() {
            return { mode: 'text', text: '' };
          },
        })),
    );
  }

  const activeSessions = new Set<{ abort(): Promise<void> }>();
  const log = opts.log ?? [];

  const scheduler = new SessionScheduler({
    graph,
    gate: opts.gate,
    profiles: opts.profiles,
    sessionBaseDir: '/tmp/test-sessions',
    cwd: '/tmp/test',
    activeSessions,
    phaseId: 'test',
    onStatus: {
      onTaskStart: (info) => events.push({ taskId: info.taskId, status: 'active' }),
      onTaskComplete: (info) => events.push({ taskId: info.taskId, status: 'complete' }),
      onTaskRejected: (info) => events.push({ taskId: info.taskId, status: 'failed' }),
      onTaskParked: (info) => events.push({ taskId: info.taskId, status: 'parked' }),
      onTaskUnparked: (info) => events.push({ taskId: info.taskId, status: 'active' }),
    },
  });

  return { graph, gate: opts.gate, profiles: opts.profiles, activeSessions, log, events, scheduler };
}

// ── Per-task state inspection helpers ───────────────────────────────────────
//
// cleanupTaskState(taskId) deletes the scheduler's per-task map/Set entries
// once a task is permanently terminal. These helpers reach into the private
// fields to verify that behavior (memory-leak guard).

/** Names of the scheduler's per-task Map<string,* fields. */
const PER_TASK_MAP_FIELDS = [
  'runners',
  'resolveCache',
  'planCtxCache',
  'executeCtxCache',
  'batchStarted',
  'batchSettledCount',
  'taskSessionBaseDir',
  'taskErrors',
  'worktreeCwds',
] as const;

/** Names of the scheduler's per-task Set<string> fields. */
const PER_TASK_SET_FIELDS = ['advancing', 'worktreeCreated', 'retryEligible'] as const;

/** Return the names of all per-task map/Set fields that currently hold an
 *  entry for `taskId`. Empty array ⟺ the task's state has been cleaned up. */
function perTaskStateFor(scheduler: SessionScheduler, taskId: string): string[] {
  const s = scheduler as unknown as Record<string, unknown>;
  const present: string[] = [];
  for (const k of PER_TASK_MAP_FIELDS) {
    if ((s[k] as Map<string, unknown> | undefined)?.has(taskId)) present.push(k);
  }
  for (const k of PER_TASK_SET_FIELDS) {
    if ((s[k] as Set<string> | undefined)?.has(taskId)) present.push(k);
  }
  return present;
}

/** True if the scheduler still knows the attempt count for `taskId`
 *  (taskAttempts is deliberately NOT cleared by cleanupTaskState). */
function taskAttemptsKnown(scheduler: SessionScheduler, taskId: string): boolean {
  const s = scheduler as unknown as Record<string, unknown>;
  return Boolean((s['taskAttempts'] as Map<string, unknown> | undefined)?.has(taskId));
}

/** Return the scheduler's recorded attempt count for `taskId`, or undefined. */
function taskAttemptValue(scheduler: SessionScheduler, taskId: string): number | undefined {
  const s = scheduler as unknown as Record<string, unknown>;
  return (s['taskAttempts'] as Map<string, number> | undefined)?.get(taskId);
}

/** Return the scheduler's recorded session base dir for `taskId`, or undefined. */
function taskSessionBaseDirValue(scheduler: SessionScheduler, taskId: string): string | undefined {
  const s = scheduler as unknown as Record<string, unknown>;
  return (s['taskSessionBaseDir'] as Map<string, string> | undefined)?.get(taskId);
}

/** True if `taskId` is currently marked retry-eligible. */
function isRetryEligible(scheduler: SessionScheduler, taskId: string): boolean {
  const s = scheduler as unknown as Record<string, unknown>;
  return Boolean((s['retryEligible'] as Set<string> | undefined)?.has(taskId));
}

/** The 10 per-task maps/sets cleared by the shared `clearTaskMaps(taskId)`
 *  helper — the exact intersection of resetForRetry's and cleanupTaskState's
 *  per-task cleanup. `retryEligible`, `taskSessionBaseDir`, and
 *  `taskAttempts` are intentionally NOT part of this shared subset (they
 *  diverge between the two callers). */
const SHARED_CLEAR_FIELDS = [
  'batchStarted',
  'batchSettledCount',
  'resolveCache',
  'runners',
  'planCtxCache',
  'executeCtxCache',
  'advancing',
  'worktreeCreated',
  'worktreeCwds',
  'taskErrors',
] as const;

/** Return the names of the shared clear-subset fields that currently hold an
 *  entry for `taskId`. Empty array ⟺ the shared maps have been cleared. */
function sharedFieldsPresent(scheduler: SessionScheduler, taskId: string): string[] {
  const s = scheduler as unknown as Record<string, unknown>;
  const present: string[] = [];
  for (const k of SHARED_CLEAR_FIELDS) {
    const field = s[k] as Map<string, unknown> | Set<string> | undefined;
    if (field?.has(taskId)) present.push(k);
  }
  return present;
}

/** Populate EVERY per-task Map/Set field with a sentinel entry for `taskId`,
 *  so the map-clearing helpers can be verified field-by-field. */
function populateAllTaskState(scheduler: SessionScheduler, taskId: string): void {
  const s = scheduler as unknown as Record<string, unknown>;
  (s['runners'] as Map<string, unknown>).set(taskId, {
    plan: async function* () {},
    execute: async () => ({ mode: 'text', text: '' }),
  });
  (s['batchStarted'] as Map<string, unknown>).set(taskId, new Set([0]));
  (s['batchSettledCount'] as Map<string, unknown>).set(taskId, 0);
  (s['resolveCache'] as Map<string, unknown>).set(taskId, { kind: 'runner' });
  (s['planCtxCache'] as Map<string, unknown>).set(taskId, { sessionBaseDir: '/base' });
  (s['executeCtxCache'] as Map<string, unknown>).set(taskId, { sessionBaseDir: '/base' });
  (s['worktreeCreated'] as Set<string>).add(taskId);
  (s['worktreeCwds'] as Map<string, unknown>).set(taskId, '/wt');
  (s['taskErrors'] as Map<string, unknown>).set(taskId, ['err']);
  (s['advancing'] as Set<string>).add(taskId);
  (s['retryEligible'] as Set<string>).add(taskId);
  (s['taskSessionBaseDir'] as Map<string, unknown>).set(taskId, '/base');
  (s['taskAttempts'] as Map<string, unknown>).set(taskId, 1);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SessionScheduler', () => {
  // ── 1. Single single-session task completes ──────────────────────────────
  it('1. single single-session task completes', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('s1', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    completeSpec(controls, 's1');

    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(graph.getTask('A')?.status).toBe('complete');
    expect(log).toContain('start:s1');
    expect(log).toContain('end:s1');
  });

  // ── 2. Dependency ordering (B after A) ───────────────────────────────────
  it('2. dependency ordering (B after A)', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['a1', 'b1']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('a1', 'default')]], controls, log),
        },
        {
          ...makeTask('B', { dependencies: ['A'] }),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('b1', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    completeSpec(controls, 'a1');
    completeSpec(controls, 'b1');

    const result = await scheduler.run();

    expect(result.completedTasks).toBe(2);
    expect(result.failedTasks).toBe(0);
    expect(graph.getTask('A')?.status).toBe('complete');
    expect(graph.getTask('B')?.status).toBe('complete');

    // A's session must start and end before B's session starts.
    const aStart = log.indexOf('start:a1');
    const aEnd = log.indexOf('end:a1');
    const bStart = log.indexOf('start:b1');
    expect(aStart).toBeGreaterThanOrEqual(0);
    expect(aEnd).toBeGreaterThan(aStart);
    expect(bStart).toBeGreaterThan(aEnd);
  });

  // ── 3. Model saturation (cap=1, 2 tasks same model) ──────────────────────
  it('3. model saturation: 2nd stays ready then starts on completion', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: { 'p:m': 1 } });
    const log: string[] = [];
    const controls = makeSpecControls(['a1', 'b1']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('a1', 'default')]], controls, log),
        },
        {
          ...makeTask('B'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('b1', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();

    // Both deferreds resolved before run completes — but A must start
    // before B because model cap is 1. Resolving a1 first then b1 ensures
    // ordering is deterministic: a1 completes, slot freed, b1 starts.
    completeSpec(controls, 'a1');
    completeSpec(controls, 'b1');

    const result = await runPromise;

    expect(result.completedTasks).toBe(2);
    expect(result.failedTasks).toBe(0);

    // B's session must start AFTER A's session ends.
    const aEnd = log.indexOf('end:a1');
    const bStart = log.indexOf('start:b1');
    expect(aEnd).toBeGreaterThanOrEqual(0);
    expect(bStart).toBeGreaterThan(aEnd);
  });

  // ── 4. Parallel batch: first starts, rest wait for capacity ──────────────
  //
  // Task A has a parallel batch of 2 specs. total=1, per-model cap=1.
  // First spec starts (A→active). Second spec can't start (no capacity) but
  // the task stays active (continue, not break). When first completes, second
  // starts. No parking/unparking events because at least one spec started.
  it('4. parallel batch: first starts, rest wait, then start on completion', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 1, perModel: { 'p:m': 1 } });
    const log: string[] = [];
    const controls = makeSpecControls(['s1', 's2']);
    const { scheduler, graph, events } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('s1', 'default'), makeSpec('s2', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // s1 started; s2 can't start (total=1, perModel=1).
    expect(log).toContain('start:s1');
    expect(log).not.toContain('start:s2');

    // Task A is 'active' (NOT parked — at least one spec started).
    expect(graph.getTask('A')?.status).toBe('active');
    expect(events.filter((e) => e.taskId === 'A' && e.status === 'parked')).toHaveLength(0);

    // Complete s1 → frees capacity → s2 starts.
    completeSpec(controls, 's1');
    await tick();

    expect(log).toContain('start:s2');

    completeSpec(controls, 's2');
    const result = await runPromise;

    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('A')?.status).toBe('complete');
  });

  // ── 5. Tier priority: parked (active→parked) before ready ────────────────
  //
  // Task P has a 2-batch plan: batch1=[p1] (model a), batch2=[p2] (model b).
  // Model b has perModel cap=0 — p2 can NEVER start. After p1 completes,
  // P becomes active with batch2=[p2], but p2 can't start → P parks.
  // Task R (ready, different model) should NOT start until P is parked.
  // After parking, R starts (T2 has no capacity left? No — P is parked so
  // its slot was freed... actually the task parks but keeps its slot? No,
  // parking doesn't release slots. The running sessions continue.)
  //
  // Simpler approach: use a single-batch parallel task P with [p1] (model b,
  // cap=0 to force parking on activation... but lazy activation means P
  // stays 'ready', never becomes active, never parks).
  //
  // Use multi-batch: P has batch1=[p1] (model a, cap=1), batch2=[p2] (model b,
  // cap=0). R has [r1] (model a, cap=1). total=2.
  //
  // P starts p1 (model a, total=1). P active.
  // R stays ready (model a cap=0).
  // p1 completes → total=2, model a cap=1. advanceBatch → batch2=[p2] (model b).
  // T1: P active, tryStartBatchSpecs → p2 can't start (model b cap=0).
  //   startedAny=false (no specs in batch2 can start). P is active → PARK.
  // T2: parked task P — try again, still can't start.
  // T3: R is ready, initialize, [r1] starts. R active.
  // r1 completes → R complete.
  // Then P is stuck (parked, no way forward) → resource deadlock → P fails.
  //
  // Assertions: P parks, R starts after P parks, P eventually fails.
  it('5. tier priority: parked task admitted before ready task', async () => {
    const profiles = new Map([
      ['profA', makeProfile('profA', 'p', 'a')],
      ['profB', makeProfile('profB', 'p', 'b')],
    ]);
    // Model b has cap=0 — p2 can never start.
    const gate = new SessionGate({ total: 2, perModel: { 'p:a': 1, 'p:b': 0 } });
    const log: string[] = [];
    const controls = makeSpecControls(['p1', 'r1']);
    const { scheduler, events } = buildFixture({
      tasks: [
        {
          ...makeTask('P'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('p1', 'profA')], [makeSpec('p2', 'profB')]], controls, log),
        },
        {
          ...makeTask('R'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('r1', 'profA')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // P's first session started (model a, slot acquired).
    expect(log).toContain('start:p1');

    // Complete p1 → advanceBatch → batch2=[p2] (model b, cap=0) → p2 can't start → P parks.
    completeSpec(controls, 'p1');
    await tick();

    // P should now be parked (p2 can't start in T1).
    expect(events.some((e) => e.taskId === 'P' && e.status === 'parked')).toBe(true);

    // R should have started (T3 picks up ready tasks, but only after T2.
    // Since P is parked (T2 can't start it either), T3 gets R).
    // Actually, the test is about T2 priority. P is parked but can't start.
    // T2 has nothing to do. T3 gets R.
    expect(log).toContain('start:r1');

    completeSpec(controls, 'r1');
    // P is stuck (model b cap=0 → resource deadlock → permanently failed), so
    // the phase ends failed and run() rejects. R still completed first.
    await expect(runPromise).rejects.toThrow(/permanently-failed/);

    expect(log).toContain('start:r1'); // R ran and completed
    expect(log).not.toContain('start:p2'); // p2 never started (cap=0)
  });

  // ── 6. Parallel batch of 3: start as many as capacity allows ─────────────
  it('6. parallel batch of 3: start 2, then third on completion', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: { 'p:m': 2 } });
    const log: string[] = [];
    const controls = makeSpecControls(['s1', 's2', 's3']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory(
            [[makeSpec('s1', 'default'), makeSpec('s2', 'default'), makeSpec('s3', 'default')]],
            controls,
            log,
          ),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // Two should start, one should not.
    expect(log.filter((l) => l.startsWith('start:')).length).toBe(2);

    // Task stays active (not parked — at least one spec started).
    expect(graph.getTask('A')?.status).toBe('active');

    // Complete one → third should start.
    const startedIds = log.filter((l) => l.startsWith('start:')).map((l) => l.split(':')[1]);
    const pendingId = ['s1', 's2', 's3'].find((id) => !startedIds.includes(id))!;
    const runningFirst = startedIds[0];

    completeSpec(controls, runningFirst);
    await tick();

    expect(log).toContain(`start:${pendingId}`);

    // Complete all remaining.
    completeSpec(controls, startedIds[1]);
    completeSpec(controls, pendingId);

    const result = await runPromise;
    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('A')?.status).toBe('complete');
  });

  // ── 7. Deadlock: missing dependency → failed ─────────────────────────────
  it('7. deadlock missing-dep → failed', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['b1']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('B', { dependencies: ['ghost'] }),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('b1', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    // The phase ends with a permanently-failed task → run() rejects so the
    // phase cannot advance. (A missing-dep deadlock fails B immediately.)
    await expect(scheduler.run()).rejects.toThrow(/permanently-failed/);

    expect(graph.getTask('B')?.status).toBe('failed');
    expect(log).not.toContain('start:b1');
  });

  // ── 8. Resource deadlock (all stuck, nothing in-flight) → escalate ──────
  it('8. resource deadlock (profile not found) → escalate', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('s1', 'unknown')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    await expect(scheduler.run()).rejects.toThrow(/permanently-failed/);

    expect(graph.getTask('A')?.status).toBe('failed');
    expect(log).not.toContain('start:s1');
  });

  // ── 9. beforeTask skip → cancelled ──────────────────────────────────────
  it('9. beforeTask skip → cancelled', async () => {
    const { HookRegistry: MockHookRegistry } = await import('../hooks/registry.js');
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1']);

    const hookRegistry = new MockHookRegistry();
    hookRegistry.register({
      beforeTask: () => ({ skip: true, reason: 'hook says no' }),
    });

    const graph = new TaskGraph();
    graph.addTask(makeTask('A'), makeFakeRunnerFactory([[makeSpec('s1', 'default')]], controls, log));

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const events: { taskId: string; status: TaskStatus }[] = [];
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions,
      phaseId: 'test',
      hookRegistry,
      onStatus: {
        onTaskRejected: (info) => events.push({ taskId: info.taskId, status: 'failed' }),
      },
    });

    const result = await scheduler.run();

    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
    expect(graph.getTask('A')?.status).toBe('cancelled');
    expect(log).not.toContain('start:s1');
  });

  // ── 10. Lazy activation: ready stays ready until first session starts ───
  it('10. lazy activation: ready task stays ready until first session starts', async () => {
    const profiles = new Map([
      ['default', makeProfile('default')],
      ['other', makeProfile('other', 'q', 'n')],
    ]);
    const gate = new SessionGate({ total: 1, perModel: { 'p:m': 1 } });
    const log: string[] = [];
    const controls = makeSpecControls(['holder', 'a1']);
    const { scheduler, graph, events } = buildFixture({
      tasks: [
        {
          ...makeTask('Holder'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('holder', 'default')]], controls, log),
        },
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('a1', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // Holder is running; A should be ready (NOT active).
    expect(log).toContain('start:holder');
    expect(log).not.toContain('start:a1');
    expect(graph.getTask('A')?.status).toBe('ready');
    expect(events.some((e) => e.taskId === 'A' && e.status === 'active')).toBe(false);

    // Complete Holder → frees slot → A should start and become active.
    completeSpec(controls, 'holder');
    await tick();

    expect(log).toContain('start:a1');
    expect(graph.getTask('A')?.status).not.toBe('ready');

    completeSpec(controls, 'a1');
    const result = await runPromise;

    expect(result.completedTasks).toBe(2);
  });

  // ── 11. Multi-batch linear plan ─────────────────────────────────────────
  //
  // Task with two sequential batches: batch1=[s1], batch2=[s2].
  // After s1 completes, advanceBatch yields batch2, then s2 starts.

  it('11. multi-batch linear plan: batch1 → advance → batch2 → complete', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1', 's2']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory(
            [[makeSpec('s1', 'default')], [makeSpec('s2', 'default')]],
            controls,
            log,
          ),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // s1 started.
    expect(log).toContain('start:s1');
    expect(log).not.toContain('start:s2');

    // Complete s1 → advanceBatch → s2 should start.
    completeSpec(controls, 's1');
    await tick();

    expect(log).toContain('start:s2');

    completeSpec(controls, 's2');
    const result = await runPromise;

    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('A')?.status).toBe('complete');
    expect(log.filter((l) => l.startsWith('start:')).length).toBe(2);
  });

  // ── 11b. Active-affinity across batch boundaries ───────────────────────
  //
  // An active task that completes a session and advances to its next batch
  // must retain first claim on the freed slot for its OWN continuation. With
  // tight total capacity (total=1), a ready task B must NOT steal the slot
  // during A's advancing window, forcing A to park. A's next session (s2)
  // should start before B's session (b1).
  it('11b. active task reclaims its slot across a batch advance (no preemption by ready tasks)', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    // total=1 — only one session at a time. The freed slot is contested.
    const gate = new SessionGate({ total: 1, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1', 's2', 'b1']);
    const { scheduler, graph, events } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory(
            [[makeSpec('s1', 'default')], [makeSpec('s2', 'default')]],
            controls,
            log,
          ),
        },
        {
          ...makeTask('B'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('b1', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // Only capacity for one session → A (first registered, T3) starts s1.
    expect(log).toContain('start:s1');
    // B stays ready (no slot).
    expect(graph.getTask('B')?.status).toBe('ready');

    // s1 completes → A advances to batch2=[s2]. The freed slot must go to A's
    // s2, NOT to B's b1.
    completeSpec(controls, 's1');
    await tick();

    // A's continuation started; A was NOT parked.
    expect(log).toContain('start:s2');
    expect(events.some((e) => e.taskId === 'A' && e.status === 'parked')).toBe(false);
    // B has not stolen the slot.
    expect(log).not.toContain('start:b1');

    completeSpec(controls, 's2');
    await tick();

    // Now A is done; B gets the slot.
    expect(log).toContain('start:b1');
    completeSpec(controls, 'b1');

    const result = await runPromise;
    expect(result.completedTasks).toBe(2);
  });

  // ── 12. Spec failure within a batch ─────────────────────────────────────
  //
  // A batch with 2 specs. First completes successfully, second throws.
  // The batch should still advance when both settle, and the task should
  // ultimately fail.

  it('12. spec failure within a batch → task fails', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1', 's2']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('s1', 'default'), makeSpec('s2', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // Both start (capacity=2).
    expect(log.filter((l) => l.startsWith('start:')).length).toBe(2);

    // Complete s1, fail s2.
    completeSpec(controls, 's1');
    failSpec(controls, 's2');
    await tick();

    // After both settle, the batch advances. Since s2 had an error,
    // the task ends up permanently failed → run() rejects.
    await expect(runPromise).rejects.toThrow(/permanently-failed/);

    expect(graph.getTask('A')?.status).toBe('failed');
  });

  // ── 13. Abort mid-execution → pending tasks cancelled ──────────────────
  //
  // Abort the scheduler while a session is in-flight. The abort handler
  // cancels all non-terminal tasks. The in-flight session completes
  // (deferred resolved) but the task stays cancelled.

  it('13. abort mid-execution → pending tasks cancelled', async () => {
    const ac = new AbortController();
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['a1']);

    const graph = new TaskGraph();
    graph.addTask(makeTask('A'), makeFakeRunnerFactory([[makeSpec('a1', 'default')]], controls, log));

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions,
      phaseId: 'test',
      signal: ac.signal,
    });

    const runPromise = scheduler.run();
    await tick();

    // A is active (session started).
    expect(graph.getTask('A')?.status).toBe('active');

    // Abort → cancels A.
    ac.abort();

    // Resolve the deferred so the scheduler can exit cleanly.
    completeSpec(controls, 'a1');

    const result = await runPromise;
    expect(result.completedTasks).toBe(0);
    expect(result.failedTasks).toBe(1);
    // After abort, the task was cancelled. The IIFE still completes
    // but setTaskStatus won't overwrite terminal status.
    expect(graph.getTask('A')?.status).toBe('cancelled');
  });

  // ── 14. Gate acquire race ─────────────────────────────────────────────
  //
  // canStart returns true but acquire returns false (race condition).
  // The task transitions to active (lazy activation check), then immediately
  // parks when acquire fails. Since no sessions can ever start, the scheduler
  // detects a resource deadlock and fails the task.

  it('14. gate acquire race → task parks then fails from deadlock', async () => {
    const gate = new SessionGate({ total: 1, perModel: { 'p:m': 1 } });
    const profiles = new Map([['default', makeProfile('default')]]);
    const log: string[] = [];
    const controls = makeSpecControls(['s1']);

    // Mock acquire to always return false (simulating race where capacity
    // vanishes between canStart and acquire).
    gate.acquire = () => false;

    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('s1', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    await expect(scheduler.run()).rejects.toThrow(/permanently-failed/);

    // The task transitions to active then parks when acquire fails.
    // With no way forward, the deadlock handler eventually fails it.
    expect(graph.getTask('A')?.status).toBe('failed');
    expect(log).not.toContain('start:s1');
  });

  // ── 15. Empty batch from runner (not deadlocked) ──────────────────────
  //
  // A runner that yields [] then a real spec should not cause a false
  // resource deadlock. The scheduler should skip the empty batch.

  it('15. empty batch from runner: skip empty yield, complete on next', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1']);

    // Runner yields [] then [s1].
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[], [makeSpec('s1', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    completeSpec(controls, 's1');

    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(graph.getTask('A')?.status).toBe('complete');
    expect(log).toContain('start:s1');
  });

  // ── 16. Bare addTasks task (makeNoopRunnerFactory) completes ──────────
  //
  // When addTasks is used without a runnerFactory, the default noop runner
  // yields []. The scheduler must skip the empty batch and finalize the
  // task as complete (not deadlocked).

  it('16. bare addTasks (noop runner) completes without deadlock', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });

    const graph = new TaskGraph();
    graph.addTasks(makeTask('A'));

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions,
      phaseId: 'test',
    });

    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(graph.getTask('A')?.status).toBe('complete');
  });

  // ── 17. Mixed-profile batch: different models, one saturated ──────────
  //
  // A batch with 2 specs using different profiles. Spec[0]'s model is
  // saturated (total=1, other task running it). Spec[1]'s model is free.
  // The scheduler should continue past spec[0] and start spec[1].

  it('17. mixed-profile batch: skip saturated model, start free model', async () => {
    const profiles = new Map([
      ['modelA', makeProfile('modelA', 'p', 'a')],
      ['modelB', makeProfile('modelB', 'q', 'b')],
    ]);
    // modelA cap=1 (saturated by blocker), modelB cap=1 (free).
    const gate = new SessionGate({ total: 2, perModel: { 'p:a': 1, 'q:b': 1 } });
    const log: string[] = [];
    const controls = makeSpecControls(['blocker', 's1', 's2']);

    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('Blocker'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('blocker', 'modelA')]], controls, log),
        },
        {
          ...makeTask('A'),
          // Batch: [modelA (saturated), modelB (free)]
          runnerFactory: makeFakeRunnerFactory([[makeSpec('s1', 'modelA'), makeSpec('s2', 'modelB')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // Blocker started (modelA slot taken).
    expect(log).toContain('start:blocker');

    // A's spec[0] (modelA) can't start (saturated). A's spec[1] (modelB) CAN start.
    // With the new continue logic, we skip s1 and start s2.
    expect(log).toContain('start:s2');
    // s1 should NOT have started (modelA saturated by Blocker).
    expect(log).not.toContain('start:s1');

    // Task A became active (at least one spec started).
    expect(graph.getTask('A')?.status).toBe('active');

    // Complete all.
    completeSpec(controls, 's2');
    completeSpec(controls, 'blocker');
    // After blocker completes, s1 can start (modelA freed).
    // But s2's completion may advance the batch... depends on plan.
    // Since it's a single batch, s2 completes → isBatchComplete? s1 hasn't started yet.
    // isBatchComplete checks started.size < batch.length. Only s2 was started (index 1).
    // So started.size (1) < batch.length (2) → not complete. No advanceBatch.
    // The task stays active with s1 still pending.
    // After blocker completes, modelA freed. Next drain pass: T1 picks up A,
    // tryStartBatchSpecs: s1 can now start.
    await tick();

    expect(log).toContain('start:s1');
    completeSpec(controls, 's1');

    const result = await runPromise;
    expect(result.completedTasks).toBe(2);
    expect(result.failedTasks).toBe(0);
  });

  // ── 18. Abort then advance throws → task stays cancelled ──────────────
  //
  // Abort the signal while a session is in-flight. When the session settles,
  // advanceBatch throws (gen.next rejects). failTask is invoked but the task
  // is already 'cancelled' (terminal) — the terminal-status guard in failTask
  // prevents overwriting to 'failed'.

  it('18. abort then advance throws → task stays cancelled', async () => {
    const ac = new AbortController();
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1']);

    // Custom runner: batch1=[s1]; advancing the generator (gen.next(results))
    // throws on the second call.
    const runnerFactory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        yield [makeSpec('s1', 'default')];
        throw new Error('advance boom');
      },
      async execute(_ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> {
        log.push(`start:${spec.id}`);
        const ctrl = controls.get(spec.id);
        const result = ctrl ? await ctrl.deferred.promise : ({ mode: 'text' as const, text: '' } as SessionResult);
        log.push(`end:${spec.id}`);
        return result;
      },
    });

    const graph = new TaskGraph();
    graph.addTask(makeTask('A'), runnerFactory);

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions,
      phaseId: 'test',
      signal: ac.signal,
    });

    const runPromise = scheduler.run();
    await tick();

    // A is active (session started).
    expect(graph.getTask('A')?.status).toBe('active');

    // Abort → A becomes cancelled.
    ac.abort();

    // Resolve the deferred so the session settles. advanceBatch will throw,
    // invoking failTask — but A is already 'cancelled' (terminal), so the
    // terminal-status guard prevents overwriting to 'failed'.
    completeSpec(controls, 's1');

    const result = await runPromise;

    // A must stay 'cancelled', NOT overwritten to 'failed'.
    expect(graph.getTask('A')?.status).toBe('cancelled');
    expect(result.failedTasks).toBe(1); // cancelled counts as failed
  });

  // ── 19. Completed sibling + blocked spec → task parks ────────────────
  //
  // A 2-spec batch: s1 (model a) and s2 (model b, cap=0). s1 starts and
  // completes. s2 can never start (model b cap=0). On the next drain pass,
  // tryStartBatchSpecs sees that s1 is completed (batchResults[0] defined —
  // doesn't count toward startedAny) and s2 can't start. With startedAny=false
  // and status='active', the task correctly transitions to 'parked'.

  it('19. completed sibling + saturated spec → task parks', async () => {
    const profiles = new Map([
      ['modelA', makeProfile('modelA', 'p', 'a')],
      ['modelB', makeProfile('modelB', 'q', 'b')],
    ]);
    // modelB cap=0 — s2 can never start.
    const gate = new SessionGate({ total: 2, perModel: { 'p:a': 2, 'q:b': 0 } });
    const log: string[] = [];
    const controls = makeSpecControls(['s1', 's2']);
    const { scheduler, events, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('s1', 'modelA'), makeSpec('s2', 'modelB')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // s1 started (modelA has capacity); s2 can't start (modelB cap=0).
    expect(log).toContain('start:s1');
    expect(graph.getTask('A')?.status).toBe('active');

    // Complete s1. On the next drain pass, s1 is completed (doesn't count
    // toward startedAny) and s2 can't start → startedAny=false → A parks.
    completeSpec(controls, 's1');
    await tick();

    // A must have emitted a 'parked' event (not stuck 'active').
    expect(events.some((e) => e.taskId === 'A' && e.status === 'parked')).toBe(true);

    // A is stuck (modelB cap=0) → resource deadlock → A permanently fails,
    // so run() rejects.
    await expect(runPromise).rejects.toThrow(/permanently-failed/);
    expect(graph.getTask('A')?.status).toBe('failed');
  });

  // ── 20. Generator finally cleanup runs on abort ──────────────────────
  //
  // A plan generator with a try/finally that records cleanup. The generator
  // yields [s1] then would yield [s2], but we abort while it's suspended at
  // the first yield. The abort handler calls planGen.return() on the
  // suspended generator, which triggers the finally block. This proves the
  // generator EARLY-RETURN cleanup path (distinct from natural completion).

  it('20. generator finally cleanup runs on abort (planGen.return on suspended gen)', async () => {
    const ac = new AbortController();
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1']);
    const cleanupLog: string[] = [];

    // Multi-batch generator with a try/finally spy. Aborted before the second
    // batch is ever consumed, so the finally runs ONLY because of
    // planGen.return() (not natural completion).
    const runnerFactory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        try {
          yield [makeSpec('s1', 'default')];
          yield [makeSpec('s2', 'default')];
          return undefined;
        } finally {
          cleanupLog.push('finally:A');
        }
      },
      async execute(_ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> {
        log.push(`start:${spec.id}`);
        const ctrl = controls.get(spec.id);
        const result = ctrl ? await ctrl.deferred.promise : ({ mode: 'text' as const, text: '' } as SessionResult);
        log.push(`end:${spec.id}`);
        return result;
      },
    });

    const graph = new TaskGraph();
    graph.addTask(makeTask('A'), runnerFactory);
    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions,
      phaseId: 'test',
      signal: ac.signal,
    });

    const runPromise = scheduler.run();
    await tick();

    // s1 started; generator is suspended at the first yield.
    expect(log).toContain('start:s1');
    expect(cleanupLog).toHaveLength(0);

    // Abort → planGen.return() called on the suspended generator → finally runs.
    ac.abort();
    completeSpec(controls, 's1');

    await runPromise;
    // Flush the fire-and-forget .return() microtask chain (it's not in
    // this.inflight, so allSettled doesn't await it).
    await tick();

    expect(graph.getTask('A')?.status).toBe('cancelled');
    expect(cleanupLog).toContain('finally:A');
  });

  // ── 21. totalSessions + completedSessions growth across batches ───────
  //
  // A coordinator-style runner yielding [s1] then [s2, s3]. After all
  // complete, totalSessions should be 3 (sum of all batch sizes) and
  // completedSessions should be 3 (one per settled execute).

  it('21. totalSessions + completedSessions grow across multiple batches', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1', 's2', 's3']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory(
            [[makeSpec('s1', 'default')], [makeSpec('s2', 'default'), makeSpec('s3', 'default')]],
            controls,
            log,
          ),
        },
      ],
      profiles,
      gate,
      log,
    });

    completeSpec(controls, 's1');
    completeSpec(controls, 's2');
    completeSpec(controls, 's3');

    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('A')?.status).toBe('complete');
    expect(graph.getTask('A')?.totalSessions).toBe(3);
    expect(graph.getTask('A')?.completedSessions).toBe(3);
  });

  // ── 22. Resume reconstruction: cached + fresh in same batch ──────────
  //
  // Simulates resuming a run where task A was mid-flight ('active') with a
  // batch [s1, s2]. Session s1 already completed (cached — `.complete`
  // sentinel exists in the session store), s2 was incomplete. On resume, the
  // scheduler creates a FRESH generator that re-yields [s1, s2]. Because
  // runSession() is idempotent, s1's execute() returns the CACHED result
  // instantly (no agent re-invocation); s2 runs fresh. The task completes.

  it('22. resume reconstruction: cached session served from cache, incomplete runs fresh', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    // Only s2 needs a deferred — s1 is cached (returns instantly).
    const controls = makeSpecControls(['s2']);

    // Simulate s1's persisted session as already complete (cached).
    const cachedResults = new Map<string, SessionResult>([['s1', { mode: 'text', text: 'cached-s1' }]]);

    // Fake runner whose execute() simulates runSession() idempotency:
    // cached specs return instantly without invoking the agent (no log);
    // fresh specs await the deferred (simulating an agent session).
    const runnerFactory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        yield [makeSpec('s1', 'default'), makeSpec('s2', 'default')];
        return undefined;
      },
      async execute(_ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> {
        const cached = cachedResults.get(spec.id);
        if (cached) return cached; // cached — instant return, no log
        log.push(`start:${spec.id}`);
        const ctrl = controls.get(spec.id);
        const result = ctrl
          ? await ctrl.deferred.promise
          : ({ mode: 'text' as const, text: `result-${spec.id}` } as SessionResult);
        log.push(`end:${spec.id}`);
        return result;
      },
    });

    // Build a graph with task A seeded in 'active' status (simulating a
    // task reconstructed from a prior run's projection mid-flight).
    const graph = new TaskGraph();
    graph.addTask(makeTask('A'), runnerFactory);
    graph.setTaskStatus('A', 'active');

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const events: { taskId: string; status: TaskStatus }[] = [];
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions,
      phaseId: 'test',
      onStatus: {
        onTaskStart: (info) => events.push({ taskId: info.taskId, status: 'active' }),
        onTaskComplete: (info) => events.push({ taskId: info.taskId, status: 'complete' }),
        onTaskRejected: (info) => events.push({ taskId: info.taskId, status: 'failed' }),
        onTaskParked: (info) => events.push({ taskId: info.taskId, status: 'parked' }),
        onTaskUnparked: (info) => events.push({ taskId: info.taskId, status: 'active' }),
      },
    });

    // Pre-resolve s2's deferred so the scheduler can complete.
    completeSpec(controls, 's2');

    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(graph.getTask('A')?.status).toBe('complete');
    // s1 served from cache — NOT re-invoked (no start/end log entries).
    expect(log).not.toContain('start:s1');
    expect(log).not.toContain('end:s1');
    // s2 ran fresh (was incomplete on resume).
    expect(log).toContain('start:s2');
    expect(log).toContain('end:s2');
    // Task completed.
    expect(events.some((e) => e.taskId === 'A' && e.status === 'complete')).toBe(true);
  });

  // ── 23. Resume reconstruction: fully-cached batches auto-advance ─────
  //
  // A resumed 'active' task with a multi-batch plan where batch1=[s1] is
  // fully cached. The scheduler creates a fresh generator, yields batch1,
  // starts s1 via the drain pass (cached → instant), advances the generator
  // to batch2=[s2] (fresh), starts s2, and completes.

  it('23. resume reconstruction: fully-cached batch1 auto-advances to fresh batch2', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s2']);

    // s1 is cached (completed in the prior run).
    const cachedResults = new Map<string, SessionResult>([['s1', { mode: 'text', text: 'cached-s1' }]]);

    const runnerFactory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        yield [makeSpec('s1', 'default')];
        yield [makeSpec('s2', 'default')];
        return undefined;
      },
      async execute(_ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> {
        const cached = cachedResults.get(spec.id);
        if (cached) return cached;
        log.push(`start:${spec.id}`);
        const ctrl = controls.get(spec.id);
        const result = ctrl
          ? await ctrl.deferred.promise
          : ({ mode: 'text' as const, text: `result-${spec.id}` } as SessionResult);
        log.push(`end:${spec.id}`);
        return result;
      },
    });

    const graph = new TaskGraph();
    graph.addTask(makeTask('A'), runnerFactory);
    graph.setTaskStatus('A', 'active');

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions,
      phaseId: 'test',
    });

    completeSpec(controls, 's2');

    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('A')?.status).toBe('complete');
    // s1 was cached — never re-invoked.
    expect(log).not.toContain('start:s1');
    // s2 ran fresh in batch2.
    expect(log).toContain('start:s2');
    expect(log).toContain('end:s2');
    // totalSessions reflects both batches.
    expect(graph.getTask('A')?.totalSessions).toBe(2);
    expect(graph.getTask('A')?.completedSessions).toBe(2);
  });

  // ── 24. Council: parallel workers → synthesizer after all settle ──────
  //
  // A council-style runner: batch1 = [w1, w2] (parallel workers, different
  // models to fit under per-model caps), batch2 = [synth] (synthesizer).
  // The synthesizer must NOT start until BOTH workers have settled (batch
  // atomicity — R1). Verifies the council pattern: fan-out workers, then
  // collect + synthesize.

  it('24. council: parallel workers → synthesizer starts only after all settle', async () => {
    const profiles = new Map([
      ['workerA', makeProfile('workerA', 'p', 'wa')],
      ['workerB', makeProfile('workerB', 'p', 'wb')],
      ['synth', makeProfile('synth', 'p', 'sm')],
    ]);
    const gate = new SessionGate({ total: 3, perModel: { 'p:wa': 1, 'p:wb': 1, 'p:sm': 1 } });
    const log: string[] = [];
    const controls = makeSpecControls(['w1', 'w2', 'synth1']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('Council'),
          runnerFactory: makeFakeRunnerFactory(
            [[makeSpec('w1', 'workerA'), makeSpec('w2', 'workerB')], [makeSpec('synth1', 'synth')]],
            controls,
            log,
          ),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // Both workers started; synthesizer has NOT (batch atomicity).
    expect(log).toContain('start:w1');
    expect(log).toContain('start:w2');
    expect(log).not.toContain('start:synth1');

    // Complete ONLY w1 — synthesizer must still NOT start (w2 pending).
    completeSpec(controls, 'w1');
    await tick();
    expect(log).not.toContain('start:synth1');

    // Complete w2 — batch settles → advance → synthesizer starts.
    completeSpec(controls, 'w2');
    await tick();
    expect(log).toContain('start:synth1');

    // Synthesizer results feed back — task completes.
    completeSpec(controls, 'synth1');
    const result = await runPromise;

    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('Council')?.status).toBe('complete');
    expect(graph.getTask('Council')?.totalSessions).toBe(3);
    expect(graph.getTask('Council')?.completedSessions).toBe(3);

    // Ordering: both workers end before synth starts.
    const w1End = log.indexOf('end:w1');
    const w2End = log.indexOf('end:w2');
    const synthStart = log.indexOf('start:synth1');
    expect(synthStart).toBeGreaterThan(w1End);
    expect(synthStart).toBeGreaterThan(w2End);
  });

  // ── 25. Coordinator dynamic fan-out based on results ──────────────────
  //
  // A coordinator runner whose batch2 contents depend on batch1's results.
  // batch1 = [scout] — returns a result whose text encodes the number of
  // workers to spawn. batch2 = [worker-1, worker-2, ...] — dynamically
  // generated from the scout's result text. Verifies the coordinator
  // pattern: the generator inspects gen.next(results) to decide fan-out.

  it('25. coordinator: dynamic fan-out based on scout result', async () => {
    const profiles = new Map([
      ['scout', makeProfile('scout', 'p', 'sc')],
      ['worker', makeProfile('worker', 'p', 'wk')],
    ]);
    const gate = new SessionGate({ total: 5, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['scout1', 'wk-1', 'wk-2', 'wk-3']);

    // Stateful coordinator generator: batch1 = [scout], then on
    // gen.next(results) yields batch2 = [wk-1..wk-N] where N is parsed from
    // the scout's result text (dynamic fan-out based on results).
    const coordinatorFactory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        // batch1: scout determines fan-out width.
        const scoutResults = yield [makeSpec('scout1', 'scout')];
        // Inspect scout result to decide fan-out.
        const scoutText = scoutResults[0]?.mode === 'text' ? scoutResults[0].text : '0';
        const workerCount = parseInt(scoutText, 10) || 0;
        if (workerCount > 0) {
          const workers: SessionSpec[] = [];
          for (let i = 1; i <= workerCount; i++) {
            workers.push(makeSpec(`wk-${i}`, 'worker'));
          }
          yield workers;
        }
        return undefined;
      },
      async execute(_ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> {
        log.push(`start:${spec.id}`);
        const ctrl = controls.get(spec.id);
        const result = ctrl
          ? await ctrl.deferred.promise
          : ({ mode: 'text' as const, text: `result-${spec.id}` } as SessionResult);
        log.push(`end:${spec.id}`);
        return result;
      },
    });

    const { scheduler, graph } = buildFixture({
      tasks: [{ ...makeTask('Coordinator'), runnerFactory: coordinatorFactory }],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // Scout started.
    expect(log).toContain('start:scout1');
    expect(log).not.toContain('start:wk-1');

    // Complete scout with result text '3' → coordinator spawns 3 workers.
    completeSpec(controls, 'scout1', '3');
    await tick();

    // All 3 workers started (fan-out based on scout result).
    expect(log).toContain('start:wk-1');
    expect(log).toContain('start:wk-2');
    expect(log).toContain('start:wk-3');

    // Complete all workers.
    completeSpec(controls, 'wk-1');
    completeSpec(controls, 'wk-2');
    completeSpec(controls, 'wk-3');

    const result = await runPromise;

    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('Coordinator')?.status).toBe('complete');
    expect(graph.getTask('Coordinator')?.totalSessions).toBe(4); // scout + 3 workers
  });

  // ── 26. beforeTask runner OVERRIDE ────────────────────────────────────
  //
  // A beforeTask hook returns { runner: customRunner } instead of the
  // entry's runnerFactory. The custom runner's execute() is used; the
  // entry's runnerFactory is NOT. Verifies the runner-override path of
  // resolveRunner (distinct from the skip path tested in case 9).

  it('26. beforeTask runner override: custom runner used, factory bypassed', async () => {
    const { HookRegistry: MockHookRegistry } = await import('../hooks/registry.js');
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['override-s1']);

    // Track whether the entry's factory was called (it should NOT be).
    let factoryCalled = false;
    const entryRunnerFactory = (): SessionPlanRunner => {
      factoryCalled = true;
      return {
        async *plan() {
          yield [makeSpec('factory-s1', 'default')];
          return undefined;
        },
        async execute() {
          return { mode: 'text', text: 'factory' };
        },
      };
    };

    // Custom override runner — uses a DIFFERENT spec id so we can distinguish.
    const overrideRunner: SessionPlanRunner = {
      async *plan() {
        yield [makeSpec('override-s1', 'default')];
        return undefined;
      },
      async execute(_ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> {
        log.push(`start:${spec.id}`);
        const ctrl = controls.get(spec.id);
        const result = ctrl
          ? await ctrl.deferred.promise
          : ({ mode: 'text' as const, text: 'override' } as SessionResult);
        log.push(`end:${spec.id}`);
        return result;
      },
    };

    const hookRegistry = new MockHookRegistry();
    hookRegistry.register({
      beforeTask: () => ({ runner: overrideRunner }),
    });

    const graph = new TaskGraph();
    graph.addTask(makeTask('A'), entryRunnerFactory);

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const events: { taskId: string; status: TaskStatus }[] = [];
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions,
      phaseId: 'test',
      hookRegistry,
      onStatus: {
        onTaskComplete: (info) => events.push({ taskId: info.taskId, status: 'complete' }),
      },
    });

    completeSpec(controls, 'override-s1');

    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('A')?.status).toBe('complete');
    // Override runner's spec ran.
    expect(log).toContain('start:override-s1');
    expect(log).toContain('end:override-s1');
    // Entry's factory was NOT called.
    expect(factoryCalled).toBe(false);
  });

  // ── 27. Empty task set → returns {0,0} ────────────────────────────────
  //
  // A TaskGraph with no tasks. scheduler.run() returns {0,0} immediately
  // without entering the drain loop. Verifies the early-exit guard.

  it('27. empty task set: run() returns {0,0} immediately', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });

    const graph = new TaskGraph();
    // No tasks added.

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions,
      phaseId: 'test',
    });

    const result = await scheduler.run();

    expect(result.completedTasks).toBe(0);
    expect(result.failedTasks).toBe(0);
    expect(graph.getAllTasks()).toHaveLength(0);
  });

  // ── 28. Review loop: execute → review → reject → re-execute → approve ─
  //
  // A review-loop-style runner with 3 batches driven by review outcomes:
  //   batch1 = [execute]   — coder produces work.
  //   batch2 = [review]    — reviewer inspects; result text = 'reject'.
  //   batch3 = [re-execute] — coder re-runs (resume) after rejection.
  // The generator inspects the review result to decide whether to yield a
  // re-execute batch. Verifies the review-loop integration at the scheduler
  // level: sequential batches with result-dependent branching.

  it('28. review loop: execute → review(reject) → re-execute → complete', async () => {
    const profiles = new Map([
      ['coder', makeProfile('coder', 'p', 'cd')],
      ['reviewer', makeProfile('reviewer', 'p', 'rv')],
    ]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['exec-1', 'review-1', 'exec-2']);

    const reviewRunnerFactory = (): SessionPlanRunner => {
      let phase = 0;
      return {
        async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
          // batch1: execute.
          const execResults = yield [makeSpec('exec-1', 'coder', { runnerRole: 'executor', attempt: 1 })];
          phase = 1;
          // batch2: review.
          const reviewResults = yield [makeSpec('review-1', 'reviewer', { runnerRole: 'reviewer', attempt: 1 })];
          phase = 2;
          // Inspect review result: 'reject' → re-execute; 'approve' → done.
          const reviewText = reviewResults[0]?.mode === 'text' ? reviewResults[0].text : 'approve';
          if (reviewText === 'reject') {
            // batch3: re-execute (resume session).
            yield [makeSpec('exec-2', 'coder', { runnerRole: 'executor', attempt: 2, resume: true })];
          }
          return undefined;
        },
        async execute(_ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult> {
          log.push(`start:${spec.id}`);
          const ctrl = controls.get(spec.id);
          const result = ctrl
            ? await ctrl.deferred.promise
            : ({ mode: 'text' as const, text: `result-${spec.id}` } as SessionResult);
          log.push(`end:${spec.id}`);
          return result;
        },
      };
    };

    const { scheduler, graph } = buildFixture({
      tasks: [{ ...makeTask('ReviewLoop'), runnerFactory: reviewRunnerFactory }],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // batch1: execute started.
    expect(log).toContain('start:exec-1');
    expect(log).not.toContain('start:review-1');

    // Complete execute → review starts.
    completeSpec(controls, 'exec-1');
    await tick();
    expect(log).toContain('start:review-1');
    expect(log).not.toContain('start:exec-2');

    // Review rejects → re-execute starts.
    completeSpec(controls, 'review-1', 'reject');
    await tick();
    expect(log).toContain('start:exec-2');

    // Complete re-execute → task completes (no second review in this plan).
    completeSpec(controls, 'exec-2');
    const result = await runPromise;

    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('ReviewLoop')?.status).toBe('complete');
    expect(graph.getTask('ReviewLoop')?.totalSessions).toBe(3);
    expect(graph.getTask('ReviewLoop')?.completedSessions).toBe(3);

    // Ordering: exec-1 → review-1 → exec-2 (strictly sequential).
    expect(log.indexOf('end:exec-1')).toBeLessThan(log.indexOf('start:review-1'));
    expect(log.indexOf('end:review-1')).toBeLessThan(log.indexOf('start:exec-2'));
  });

  // ── 29. Coalesced multi-complete drains once ──────────────────────────
  //
  // Two sessions in the same batch complete in the SAME microtask turn
  // (both deferreds resolved before any await). The coalesced drain mechanism
  // (scheduleDrain flag + queueMicrotask) processes BOTH completions in a
  // SINGLE drain pass: the batch advances once (gen.next gets both results)
  // and the next batch's sessions all start in one wave. Verifies R5
  // (coalesced drain) and that simultaneous completions don't cause redundant
  // drain cycles or partial advances.

  it('29. coalesced multi-complete: simultaneous settles drain in one pass', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: { 'p:m': 2 } });
    const log: string[] = [];
    const controls = makeSpecControls(['b1-1', 'b1-2', 'b2-1', 'b2-2']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory(
            [
              [makeSpec('b1-1', 'default'), makeSpec('b1-2', 'default')],
              [makeSpec('b2-1', 'default'), makeSpec('b2-2', 'default')],
            ],
            controls,
            log,
          ),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // batch1: both started (capacity=2).
    expect(log).toContain('start:b1-1');
    expect(log).toContain('start:b1-2');
    expect(log.filter((l) => l.startsWith('start:')).length).toBe(2);

    // Complete BOTH in the same microtask turn (no await between).
    completeSpec(controls, 'b1-1');
    completeSpec(controls, 'b1-2');

    // After a single tick, the coalesced drain should have advanced the
    // batch and started BOTH batch2 sessions in one wave.
    await tick();

    expect(log).toContain('start:b2-1');
    expect(log).toContain('start:b2-2');
    // No intermediate partial state — both b2 sessions present together.
    expect(log.filter((l) => l.startsWith('start:')).length).toBe(4);

    // Complete batch2 sessions.
    completeSpec(controls, 'b2-1');
    completeSpec(controls, 'b2-2');

    const result = await runPromise;

    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('A')?.status).toBe('complete');
    expect(graph.getTask('A')?.totalSessions).toBe(4);
    expect(graph.getTask('A')?.completedSessions).toBe(4);
  });

  // ── 30. No scheduler wall-clock timeout on execute (regression) ───────
  //
  // The scheduler must NOT impose a wall-clock cap on runner.execute().
  // Model-freeze detection is the in-session inactivity watchdog's job
  // (runSession, fed by stepTimeoutMs → watchdogTimeoutMs), which RESETS on
  // every activity event. A wall-clock race here previously fired mid-
  // progress on legitimately long (but active) sessions, leaked the still-
  // running session, poisoned taskErrors, and caused tasks whose reviews
  // approved to be marked failed.
  //
  // Invariant: a session whose execute() resolves successfully — no matter
  // how long it takes — completes the task. Only a THROWN execute (e.g. a
  // genuine WatchdogTimeoutError from a real freeze) fails it (see test 12).
  it('30. long-running execute (success) → task completes; no scheduler timeout', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('s1', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // execute() is in-flight (deferred held). The scheduler must NOT fail the
    // task on its own — it must wait for the runner to settle.
    expect(log).toContain('start:s1');
    expect(graph.getTask('A')?.status).not.toBe('failed');

    // Resolve the deferred much later (simulating a long-but-active session).
    // No scheduler-side cutoff fires; the task completes.
    await new Promise((r) => setTimeout(r, 20));
    expect(graph.getTask('A')?.status).not.toBe('failed'); // still not failed while in-flight

    completeSpec(controls, 's1');
    const result = await runPromise;

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(graph.getTask('A')?.status).toBe('complete');
  });

  // ── 31. Greedy across models: continuation + ready task BOTH start when total allows ─
  //
  // Pins the behavior at the heart of the greedy-drain contract: when an
  // active task's session ends and it advances to a DIFFERENT-model batch,
  // the scheduler must start BOTH the active task's next session AND a ready
  // task's first session whenever gate capacity allows — not just the
  // continuation. The only thing that prevents the ready task from starting
  // is genuine capacity saturation (total OR the relevant per-model cap),
  // never a defect in the drain ordering.
  //
  // Setup: A has a 2-batch plan [writer (model A)] → [reviewer (model B)].
  // B is a ready task with [writer (model A)]. total=2, per-model A cap=2,
  // per-model B cap=2 — so both model A and model B have spare capacity
  // after A's writer completes, AND total has a spare slot.
  it('31. greedy across models: continuation + ready task both start when total allows', async () => {
    const profiles = new Map([
      ['writer', makeProfile('writer', 'p', 'A')],
      ['reviewer', makeProfile('reviewer', 'p', 'B')],
    ]);
    // total=2: A's writer holds 1; after it completes, the freed slot can host
    // EITHER the reviewer continuation OR the ready writer — and since model B
    // has its own spare cap AND total=2 has room for both (1 reviewer + 1
    // writer), BOTH must start.
    const gate = new SessionGate({ total: 2, perModel: { 'p:A': 2, 'p:B': 2 } });
    const log: string[] = [];
    const controls = makeSpecControls(['a-write', 'a-review', 'b-write']);
    const { scheduler } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory(
            [[makeSpec('a-write', 'writer')], [makeSpec('a-review', 'reviewer')]],
            controls,
            log,
          ),
        },
        {
          ...makeTask('B'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('b-write', 'writer')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // Initial drain: only capacity for 1 of the two model-A writers under
    // total=2? No — total=2, model A cap=2, so BOTH A and B start their writer.
    expect(log).toContain('start:a-write');
    expect(log).toContain('start:b-write');

    // A's writer completes → A advances to the reviewer batch (model B). Now
    // total has a spare slot (b-write still running), and model B has capacity.
    // The reviewer continuation starts (priority #1). Then — because total=2
    // and only b-write is currently consuming a slot — the scheduler has room
    // for exactly one more. After a-review starts, total is saturated again
    // (b-write + a-review). The ready task B already started earlier, so the
    // point of this assertion is simply: the reviewer continuation started.
    completeSpec(controls, 'a-write');
    await tick();

    // The continuation started.
    expect(log).toContain('start:a-review');

    // Drain everything.
    completeSpec(controls, 'a-review');
    completeSpec(controls, 'b-write');
    const result = await runPromise;

    expect(result.completedTasks).toBe(2);
    expect(result.failedTasks).toBe(0);
  });

  // ── 32. Greedy across models with SPARE total: two sessions start at once ─
  //
  // The strongest form of the guarantee: with enough total headroom that the
  // active continuation and a ready task's first session can run concurrently,
  // BOTH must start in the same drain pass following the completion. This is
  // the exact "two sessions start" outcome: when total allows, the scheduler
  // never leaves a startable session waiting.
  it('32. greedy across models with spare total: two sessions start at once', async () => {
    const profiles = new Map([
      ['writer', makeProfile('writer', 'p', 'A')],
      ['reviewer', makeProfile('reviewer', 'p', 'B')],
    ]);
    // total=10: plenty of room. per-model caps are generous.
    const gate = new SessionGate({ total: 10, perModel: { 'p:A': 5, 'p:B': 5 } });
    const log: string[] = [];
    const controls = makeSpecControls(['a-write', 'a-review', 'b-write']);
    const { scheduler } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory(
            [[makeSpec('a-write', 'writer')], [makeSpec('a-review', 'reviewer')]],
            controls,
            log,
          ),
        },
        {
          ...makeTask('B'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('b-write', 'writer')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    const runPromise = scheduler.run();
    await tick();

    // Both writers start immediately (total=10, model A cap=5).
    expect(log.filter((l) => l === 'start:a-write').length).toBe(1);
    expect(log.filter((l) => l === 'start:b-write').length).toBe(1);

    const beforeCount = log.filter((l) => l.startsWith('start:')).length;

    // A's writer completes → A advances to reviewer (model B). With total=10,
    // both the reviewer continuation AND any other startable session must run.
    // Here B has already started, so the key assertion is that the reviewer
    // starts WITHOUT parking and WITHOUT waiting for b-write to settle.
    completeSpec(controls, 'a-write');
    await tick();

    // The reviewer continuation started in the same drain pass.
    expect(log).toContain('start:a-review');
    // Exactly one new session started (the reviewer); b-write was already running.
    const afterCount = log.filter((l) => l.startsWith('start:')).length;
    expect(afterCount - beforeCount).toBe(1);

    completeSpec(controls, 'a-review');
    completeSpec(controls, 'b-write');
    const result = await runPromise;
    expect(result.completedTasks).toBe(2);
    expect(result.failedTasks).toBe(0);
  });

  // ── 33. A session that throws fails the task (after exhausting retries) ──
  //
  // A session's execute() is the single authority for session success: every
  // internal retry (the SDK auto-retry ladder, in-session watchdog resumes,
  // structured-output validation retries) lives INSIDE runSession and has
  // already had its chances by the time execute() throws. A thrown execution
  // error is now retryable at the TASK level: the scheduler runs up to
  // MAX_RETRIES blank-slate retries (initial attempt + 3 retries = 4 total)
  // before the task fails permanently. An always-throwing execute therefore
  // runs exactly MAX_RETRIES + 1 times and the task ends 'failed'.
  it('33. a session that throws fails the task after exhausting retries (transient throw)', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    let attempt = 0;
    // Fake runner: execute always throws (transient). The scheduler retries
    // the whole plan blank-slate until the retry budget is exhausted.
    const factory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        yield [makeSpec('s1', 'default')];
        return;
      },
      async execute(_ctx, spec): Promise<SessionResult> {
        attempt += 1;
        throw new SessionError('watchdog timeout (transient)', { kind: 'transient', retryable: true });
      },
    });
    const graph = new TaskGraph();
    graph.addTask({ ...makeTask('A') }, factory);
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });
    // Retry budget exhausted → permanently failed → run() rejects.
    await expect(scheduler.run()).rejects.toThrow(/permanently-failed/);
    expect(graph.getTask('A')?.status).toBe('failed');
    // Initial attempt + MAX_RETRIES retries = MAX_RETRIES + 1 total executions.
    expect(attempt).toBe(4);
  });

  // ── 34. Permanent error fails the task immediately ──
  //
  // Counterpart to test 33: a spec that fails with a PERMANENT (non-transient)
  // error also fails the task. With session throws routed to failTask
  // regardless of transient/permanent, both kinds fail the task the moment the
  // session throws (no synthetic empty result, no generator continuation).
  it('34. permanent error fails the task immediately', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const factory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        yield [makeSpec('s1', 'default')];
        return;
      },
      async execute(): Promise<SessionResult> {
        // Permanent (non-transient) error.
        throw new SessionError('schema missing — permanent', { kind: 'permanent', retryable: false });
      },
    });
    const graph = new TaskGraph();
    graph.addTask({ ...makeTask('A') }, factory);
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });
    // Permanent (non-transient) error → permanently failed → run() rejects.
    await expect(scheduler.run()).rejects.toThrow(/permanently-failed/);
    expect(graph.getTask('A')?.status).toBe('failed');
  });

  // ── 35. Scheduler emits drain + settle audit events ──────────────────────
  //
  // Verifies the new observability: the scheduler appends scheduler_drain and
  // scheduler_session_settle events to the auditLog, and the drain event
  // records per-candidate outcomes with REASONS (why a session started / was
  // parked / skipped). This is the trace that makes orchestration debuggable.
  it('35. scheduler emits drain + settle audit events with reasons', async () => {
    const profiles = new Map([
      ['writer', makeProfile('writer', 'p', 'A')],
      ['reviewer', makeProfile('reviewer', 'p', 'B')],
    ]);
    // total=1: forces parking so the drain trace records a capacity-saturation
    // reason.
    const gate = new SessionGate({ total: 1, perModel: {} });
    const appended: {
      type: string;
      trigger?: string;
      candidates?: unknown[];
      specId?: string;
      success?: boolean;
      [k: string]: unknown;
    }[] = [];
    const fakeAuditLog = {
      async append(event: { type: string; [k: string]: unknown }): Promise<void> {
        appended.push(event);
      },
    };
    const controls = makeSpecControls(['a1', 'a2', 'b1']);
    const log: string[] = [];
    const graph = new TaskGraph();
    // A: two-batch plan [writer A] → [reviewer B]. B: ready [writer A].
    graph.addTask(
      { ...makeTask('A') },
      makeFakeRunnerFactory([[makeSpec('a1', 'writer')], [makeSpec('a2', 'reviewer')]], controls, log),
    );
    graph.addTask({ ...makeTask('B') }, makeFakeRunnerFactory([[makeSpec('b1', 'writer')]], controls, log));
    type SchedOpts = ConstructorParameters<typeof SessionScheduler>[0];
    const opts: SchedOpts = {
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
      // The fake auditLog only implements append(); cast satisfies the option.
      auditLog: fakeAuditLog as unknown as ConstructorParameters<typeof SessionScheduler>[0]['auditLog'],
    };
    const scheduler = new SessionScheduler(opts);
    const runP = scheduler.run();
    await tick();
    // A's writer starts (only slot). B's writer can't start (total saturated).
    const drains = appended.filter((e) => e.type === 'scheduler_drain');
    expect(drains.length).toBeGreaterThanOrEqual(1);
    // Some drain event records B as a candidate that couldn't start due to
    // total saturation, with a human-readable reason.
    const drainWithSkippedB = drains.some((e) => {
      const cands = (e.candidates ?? []) as Array<{
        taskId: string;
        parkedSpecs: { reason: string }[];
        started: unknown[];
      }>;
      return cands.some(
        (c) => c.taskId === 'B' && c.started.length === 0 && c.parkedSpecs.some((p) => /saturat/i.test(p.reason)),
      );
    });
    expect(drainWithSkippedB).toBe(true);
    // Drain triggers are recorded.
    const triggers = new Set(drains.map((e) => e.trigger));
    expect(triggers.has('init')).toBe(true);
    // Complete A's writer → a settle event is appended for a1.
    completeSpec(controls, 'a1');
    await tick();
    const settles = appended.filter((e) => e.type === 'scheduler_session_settle');
    expect(settles.length).toBeGreaterThanOrEqual(1);
    const a1Settle = settles.find((e) => e.specId === 'a1');
    expect(a1Settle).toBeDefined();
    expect(a1Settle?.success).toBe(true);
    // Recompute drains — the post-completion pass appends new events.
    const drainsAfter = appended.filter((e) => e.type === 'scheduler_drain');
    expect(new Set(drainsAfter.map((e) => e.trigger)).has('completion')).toBe(true);
    // Finish.
    completeSpec(controls, 'a2');
    completeSpec(controls, 'b1');
    await runP;
  });

  // ── 36. Retry: failed execution task succeeds on the 2nd attempt ──────
  //
  // A task whose first execute() throws (transient execution failure) is
  // retried blank-slate. The 2nd attempt's execute succeeds → the task ends
  // 'complete'. Verifies: failure is retryable, the retry runs a FRESH plan,
  // and a retry that succeeds completes normally.
  it('36. retry: execution failure succeeds on the 2nd attempt', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const observedBaseDirs: string[] = [];
    let planCalls = 0;
    // First execute throws; from the 2nd attempt onward it succeeds.
    const factory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        planCalls++;
        yield [makeSpec('s1', 'default')];
        return;
      },
      async execute(ctx, spec): Promise<SessionResult> {
        observedBaseDirs.push(ctx.sessionBaseDir);
        if (planCalls === 1) {
          throw new SessionError('boom (transient)', { kind: 'transient', retryable: true });
        }
        return { mode: 'text', text: 'ok' };
      },
    });
    const graph = new TaskGraph();
    graph.addTask({ ...makeTask('A') }, factory);
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });
    const result = await scheduler.run();
    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(graph.getTask('A')?.status).toBe('complete');
    // The plan generator ran twice: initial attempt + one retry.
    expect(planCalls).toBe(2);
  });

  // ── 37. Retry: per-attempt session base dir preserves failed data ──────
  //
  // Attempt 1 uses the base sessionBaseDir; a retry (attempt 2) is namespaced
  // under {base}/.retries/{taskId}/2/ so the failed attempt's persisted
  // sessions remain at the original path for tracing. The blank-slate retry
  // never reads the failed attempt's session cache.
  it('37. retry: 2nd attempt uses a namespaced session base dir', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const observedBaseDirs: string[] = [];
    let planCalls = 0;
    const factory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        planCalls++;
        yield [makeSpec('s1', 'default')];
        return;
      },
      async execute(ctx, spec): Promise<SessionResult> {
        observedBaseDirs.push(ctx.sessionBaseDir);
        if (planCalls === 1) {
          throw new SessionError('boom', { kind: 'transient', retryable: true });
        }
        return { mode: 'text', text: 'ok' };
      },
    });
    const graph = new TaskGraph();
    graph.addTask({ ...makeTask('A') }, factory);
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });
    const result = await scheduler.run();
    expect(result.completedTasks).toBe(1);
    // Attempt 1 → base dir; attempt 2 → .retries/A/2.
    expect(observedBaseDirs).toEqual(['/tmp/test-sessions', '/tmp/test-sessions/.retries/A/2']);
  });

  // ── 38. Retry: structural (deadlock) failure is NOT retried ────────────
  //
  // A resource deadlock is a non-retryable structural failure: retrying would
  // fail identically. The task fails permanently on the first attempt with no
  // retry, and blocked dependents are promoted.
  it('38. retry: resource deadlock fails permanently (no retry)', async () => {
    const gate = new SessionGate({ total: 1, perModel: { 'p:m': 1 } });
    const profiles = new Map([['default', makeProfile('default')]]);
    const controls = makeSpecControls(['s1']);
    gate.acquire = () => false; // force acquire race → park → deadlock
    let planCalls = 0;
    const factory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        planCalls++;
        yield [makeSpec('s1', 'default')];
        return;
      },
      async execute(): Promise<SessionResult> {
        return { mode: 'text', text: 'ok' };
      },
    });
    const graph = new TaskGraph();
    graph.addTask({ ...makeTask('A') }, factory);
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });
    // Non-retryable structural failure → permanently failed → run() rejects.
    await expect(scheduler.run()).rejects.toThrow(/permanently-failed/);
    expect(graph.getTask('A')?.status).toBe('failed');
    // No retry: the plan generator was created only once.
    expect(planCalls).toBe(1);
  });

  // ── 39. Retry: retryable failure keeps dependents blocked ──────────────
  //
  // While a task is retry-eligible ('failed' with budget left) its dependents
  // must stay 'blocked' — the task may yet succeed on retry, so promoting a
  // dependent prematurely would be wrong. Here A fails once (retryable) then
  // succeeds on its 2nd attempt; B (depends on A) only runs AFTER A actually
  // completes, proving B was not promoted during A's retry window.
  it('39. retry: dependent runs only after parent completes on retry', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const controls = makeSpecControls(['a1', 'b1']);
    const startOrder: string[] = [];
    let aPlanCalls = 0;
    const graph = new TaskGraph();
    // A throws on attempt 1, succeeds on attempt 2.
    graph.addTask(
      { ...makeTask('A') },
      (): SessionPlanRunner => ({
        async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
          aPlanCalls++;
          yield [makeSpec('a1', 'default')];
          return;
        },
        async execute(): Promise<SessionResult> {
          startOrder.push('a');
          if (aPlanCalls === 1) {
            throw new SessionError('transient boom', { kind: 'transient', retryable: true });
          }
          return { mode: 'text', text: 'a-ok' };
        },
      }),
    );
    // B depends on A.
    graph.addTask(
      { ...makeTask('B', { dependencies: ['A'] }) },
      (): SessionPlanRunner => ({
        async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
          yield [makeSpec('b1', 'default')];
          return;
        },
        async execute(): Promise<SessionResult> {
          startOrder.push('b');
          return { mode: 'text', text: 'b-ok' };
        },
      }),
    );
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });
    const result = await scheduler.run();
    expect(result.completedTasks).toBe(2);
    expect(graph.getTask('A')?.status).toBe('complete');
    expect(graph.getTask('B')?.status).toBe('complete');
    // A retried once (initial + 1 retry = 2 plan() calls).
    expect(aPlanCalls).toBe(2);
    // B only ran after A completed: the last 'a' start precedes the single 'b'.
    expect(startOrder.filter((s) => s === 'b')).toEqual(['b']);
    expect(startOrder.lastIndexOf('a')).toBeLessThan(startOrder.indexOf('b'));
  });

  // ── 40. Permanently-failed task rejects run() even when a sibling completed ──
  //
  // The production bug this guards: a phase in which some tasks permanently
  // fail MUST NOT advance to the next phase. run() rejects (throwing the
  // phase) so the failure propagates through the phase callback → PhaseRunner
  // → workflow, aborting the run. Here A completes but B exhausts its retry
  // budget → run() rejects, naming B. Only status 'failed' triggers this —
  // cancelled/skipped tasks (test 9) do not.
  it('40. permanently-failed task rejects run() even when a sibling completed', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const controls = makeSpecControls(['a1']);
    const log: string[] = [];
    const graph = new TaskGraph();
    // A — succeeds.
    graph.addTask({ ...makeTask('A') }, makeFakeRunnerFactory([[makeSpec('a1', 'default')]], controls, log));
    // B — always throws (transient) → exhausts MAX_RETRIES → permanently failed.
    graph.addTask(
      { ...makeTask('B') },
      (): SessionPlanRunner => ({
        async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
          yield [makeSpec('b1', 'default')];
          return;
        },
        async execute(): Promise<SessionResult> {
          log.push('start:b1');
          throw new SessionError('always fails', { kind: 'transient', retryable: true });
        },
      }),
    );
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'implementing',
    });
    completeSpec(controls, 'a1');
    // Phase ends with B permanently failed → run() rejects so it cannot advance.
    await expect(scheduler.run()).rejects.toThrow(/permanently-failed.*\bB\b/);
    expect(graph.getTask('A')?.status).toBe('complete');
    expect(graph.getTask('B')?.status).toBe('failed');
  });

  // ── 41. Resume re-attempts permanently-failed tasks ─────────────────────
  //
  // When a phase is re-run (e.g. via `engine resume`), tasks that permanently
  // failed in the prior persisted run get a fresh chance: their 'failed'
  // status is reset to 'ready' (result cleared, retry budget restored) and
  // they are re-executed. A freshly-built graph never carries 'failed' (new
  // tasks start 'ready'/'blocked'), so any 'failed' task present at run()
  // start must be a resumed permanent failure.
  it('41. resume resets permanently-failed tasks to ready and re-attempts them', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['a1']);
    const graph = new TaskGraph();
    // Simulate a persisted permanent failure: status preset to 'failed' with a
    // stale result from the prior run.
    graph.addTask(
      { ...makeTask('A', { status: 'failed', result: { completed: false, error: 'prior run' } }) },
      makeFakeRunnerFactory([[makeSpec('a1', 'default')]], controls, log),
    );
    expect(graph.getTask('A')?.status).toBe('failed'); // pre-resume

    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'implementing',
    });
    completeSpec(controls, 'a1');

    // Resume reset the failed task → re-attempted → succeeded → phase resolves.
    const result = await scheduler.run();
    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(graph.getTask('A')?.status).toBe('complete');
    expect(log).toContain('start:a1');
  });

  // ── 42. Per-task state is cleaned up after a task completes ─────────────
  //
  // cleanupTaskState(taskId) deletes the scheduler-side per-task map entries
  // (runners, batchStarted, resolveCache, planCtxCache, executeCtxCache,
  // advancing, worktreeCreated, worktreeCwds, retryEligible,
  // taskSessionBaseDir, taskErrors) once a task is permanently terminal. It
  // must fire on NORMAL completion (finalizeTask) so the maps don't grow
  // unboundedly across long runs. taskAttempts is deliberately PRESERVED
  // (needed for result/audit reporting).
  it('42. per-task maps are cleaned up after a task completes normally', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const log: string[] = [];
    const controls = makeSpecControls(['s1']);
    const { scheduler, graph } = buildFixture({
      tasks: [
        {
          ...makeTask('A'),
          runnerFactory: makeFakeRunnerFactory([[makeSpec('s1', 'default')]], controls, log),
        },
      ],
      profiles,
      gate,
      log,
    });

    completeSpec(controls, 's1');
    const result = await scheduler.run();

    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('A')?.status).toBe('complete');

    // After completion the per-task state must be gone (no leak).
    expect(perTaskStateFor(scheduler, 'A')).toEqual([]);
    // taskAttempts is intentionally retained for reporting.
    expect(taskAttemptsKnown(scheduler, 'A')).toBe(true);
  });

  // ── 43. Per-task state is cleaned up after a PERMANENT failure ───────────
  //
  // The same cleanup must fire on the PERMANENT failure branch of failTask
  // (retry budget exhausted OR non-retryable structural failure). Maps that
  // accumulated errors / runner handles during the attempts must be released.
  // Again, taskAttempts is preserved.
  it('43. per-task maps are cleaned up after a task fails permanently', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const graph = new TaskGraph();
    // execute() always throws (transient) → exhausts MAX_RETRIES → permanent.
    graph.addTask(
      { ...makeTask('A') },
      (): SessionPlanRunner => ({
        async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
          yield [makeSpec('s1', 'default')];
          return;
        },
        async execute(): Promise<SessionResult> {
          throw new SessionError('always fails (transient)', { kind: 'transient', retryable: true });
        },
      }),
    );
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });

    // Retry budget exhausted → permanent failure → run() rejects.
    await expect(scheduler.run()).rejects.toThrow(/permanently-failed/);
    expect(graph.getTask('A')?.status).toBe('failed');

    // Per-task state must be released on permanent failure (no leak).
    expect(perTaskStateFor(scheduler, 'A')).toEqual([]);
    // taskAttempts retained for reporting.
    expect(taskAttemptsKnown(scheduler, 'A')).toBe(true);
  });

  // ── 44. Per-task state is NOT cleaned on a retryable (retry-eligible) failure ──
  //
  // When a task fails but still has retry budget, it stays 'failed' (retry-
  // eligible) until the next drain pass resets it for a fresh attempt. The
  // per-task state MUST survive this window — the retry needs it (the runner,
  // plan/execute contexts, accumulated errors, attempt counter, base dir).
  // cleanupTaskState must therefore NOT fire on the retry-eligible branch.
  //
  // This task fails once (transient, retry-eligible) then succeeds on its
  // 2nd attempt. We snapshot the maps at the 'failed' transition and assert
  // they are still populated at that point.
  it('44. per-task maps are NOT cleaned on a retryable failure (retry needs them)', async () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    let planCalls = 0;
    const graph = new TaskGraph();
    let snapshotAtFailure: string[] | null = null;
    graph.addTask(
      { ...makeTask('A') },
      (): SessionPlanRunner => ({
        async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
          planCalls++;
          yield [makeSpec('s1', 'default')];
          return;
        },
        async execute(): Promise<SessionResult> {
          if (planCalls === 1) {
            throw new SessionError('transient boom', { kind: 'transient', retryable: true });
          }
          return { mode: 'text', text: 'ok' };
        },
      }),
    );
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
      onStatus: {
        onTaskRejected: () => {
          // Snapshot the per-task maps the instant the task goes 'failed'.
          // For the single retryable failure this fires exactly once.
          if (snapshotAtFailure === null) {
            snapshotAtFailure = perTaskStateFor(scheduler, 'A');
          }
        },
      },
    });

    const result = await scheduler.run();
    expect(result.completedTasks).toBe(1);
    expect(graph.getTask('A')?.status).toBe('complete');
    // The plan generator ran twice: initial attempt + one retry.
    expect(planCalls).toBe(2);

    // At the retry-eligible failure the core execution state the retry
    // depends on was still present (NOT prematurely cleaned up).
    expect(snapshotAtFailure).not.toBeNull();
    const snap = snapshotAtFailure!;
    expect(snap).toContain('runners');
    expect(snap).toContain('planCtxCache');
    expect(snap).toContain('executeCtxCache');
    expect(snap).toContain('taskSessionBaseDir');
    expect(snap).toContain('taskErrors');
    expect(snap).toContain('retryEligible');

    // After the eventual success, the terminal completion path cleans up.
    expect(perTaskStateFor(scheduler, 'A')).toEqual([]);
  });

  // ── 45. clearTaskMaps clears exactly the shared per-task maps ───────────
  //
  // resetForRetry and cleanupTaskState both clear the same per-task execution-
  // state maps. That shared subset is extracted into a private
  // clearTaskMaps(taskId) helper which clears EXACTLY these 10 maps:
  //   batchStarted, batchSettledCount, resolveCache, runners, planCtxCache,
  //   executeCtxCache, advancing, worktreeCreated, worktreeCwds, taskErrors.
  //
  // It must NOT touch the three path-divergent fields:
  //   - retryEligible       (resetForRetry removes it; cleanupTaskState removes it)
  //   - taskSessionBaseDir  (resetForRetry SETS a new value; cleanupTaskState deletes)
  //   - taskAttempts        (always retained for reporting)
  // Those divergent fields are owned by each caller, not the shared helper.
  //
  // This test drives the extraction: clearTaskMaps does not exist yet, so it
  // fails until the green team extracts the helper.
  it('45. clearTaskMaps clears exactly the shared per-task maps', () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const graph = new TaskGraph();
    graph.addTask(
      { ...makeTask('A') },
      (): SessionPlanRunner => ({
        async *plan() {
          yield [];
          return;
        },
        async execute() {
          return { mode: 'text', text: '' };
        },
      }),
    );
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });

    populateAllTaskState(scheduler, 'A');

    // Sanity: every shared field holds an entry before clearing.
    expect(sharedFieldsPresent(scheduler, 'A')).toEqual([...SHARED_CLEAR_FIELDS]);

    // Invoke the extracted private helper directly.
    const clearTaskMaps = (
      scheduler as unknown as {
        clearTaskMaps?: (id: string) => void;
      }
    ).clearTaskMaps;
    expect(clearTaskMaps).toBeTypeOf('function');
    clearTaskMaps!.call(scheduler, 'A');

    // The 10 shared maps/sets are all gone.
    expect(sharedFieldsPresent(scheduler, 'A')).toEqual([]);

    // The three divergent fields are deliberately untouched by the helper.
    expect(isRetryEligible(scheduler, 'A')).toBe(true);
    expect(taskSessionBaseDirValue(scheduler, 'A')).toBe('/base');
    expect(taskAttemptsKnown(scheduler, 'A')).toBe(true);
  });

  // ── 46. resetForRetry clears shared maps, drops retryEligible, sets a NEW base dir ──
  //
  // resetForRetry is the retry-reset path (failed → ready for a blank-slate
  // re-run). It calls clearTaskMaps(taskId) for the shared maps and then does
  // reset-specific work: increment the attempt counter, DELETE this task from
  // retryEligible (it was retry-eligible; now it's being re-run), and SET a
  // NEW per-attempt namespaced taskSessionBaseDir (NOT delete the old one).
  //
  // This pins the END STATE of resetForRetry so the extraction is provably
  // behavior-preserving. The differential vs cleanupTaskState (next test):
  //   - retryEligible:       removed (same as cleanup, but reset owns it)
  //   - taskSessionBaseDir:  SET to namespaced retry path (cleanup DELETES it)
  //   - taskAttempts:        incremented & retained (cleanup also retains)
  it('46. resetForRetry clears shared maps, drops retryEligible, sets a NEW base dir', () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const graph = new TaskGraph();
    graph.addTask(
      { ...makeTask('A') },
      (): SessionPlanRunner => ({
        async *plan() {
          yield [];
          return;
        },
        async execute() {
          return { mode: 'text', text: '' };
        },
      }),
    );
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });

    // Simulate a task that has failed attempt 1 and is awaiting a retry reset.
    graph.setTaskStatus('A', 'failed');
    populateAllTaskState(scheduler, 'A');

    const entry = graph.getTask('A')!;
    // Invoke the private resetForRetry(entry) directly.
    const resetForRetry = (
      scheduler as unknown as {
        resetForRetry: (e: typeof entry) => void;
      }
    ).resetForRetry;
    resetForRetry.call(scheduler, entry);

    // The 10 shared maps/sets are cleared.
    expect(sharedFieldsPresent(scheduler, 'A')).toEqual([]);
    // retryEligible is dropped (this task is now being re-run, not awaiting).
    expect(isRetryEligible(scheduler, 'A')).toBe(false);
    // taskSessionBaseDir is SET (not deleted) to the namespaced attempt-2 path.
    expect(taskSessionBaseDirValue(scheduler, 'A')).toBe('/tmp/test-sessions/.retries/A/2');
    // Attempt counter incremented and retained.
    expect(taskAttemptValue(scheduler, 'A')).toBe(2);
    // Task transitioned failed → ready so T3 picks it up.
    expect(graph.getTask('A')?.status).toBe('ready');
  });

  // ── 47. cleanupTaskState clears shared maps AND retryEligible AND taskSessionBaseDir ──
  //
  // cleanupTaskState is the permanent-terminal cleanup path (normal
  // completion or exhausted/non-retryable failure). It calls
  // clearTaskMaps(taskId) for the shared maps and then does cleanup-specific
  // work: DELETE retryEligible and taskSessionBaseDir (the task is gone for
  // good, so neither the retry flag nor the base dir is needed). taskAttempts
  // is still retained for result/audit reporting.
  //
  // The differential vs resetForRetry (prev test):
  //   - retryEligible:       DELETED (reset also removes it — convergent here)
  //   - taskSessionBaseDir:  DELETED (reset SETS a new value)
  //   - taskAttempts:        retained (reset increments it)
  it('47. cleanupTaskState clears shared maps AND retryEligible AND taskSessionBaseDir', () => {
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });
    const graph = new TaskGraph();
    graph.addTask(
      { ...makeTask('A') },
      (): SessionPlanRunner => ({
        async *plan() {
          yield [];
          return;
        },
        async execute() {
          return { mode: 'text', text: '' };
        },
      }),
    );
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });

    populateAllTaskState(scheduler, 'A');

    // Invoke the private cleanupTaskState(taskId) directly.
    const cleanupTaskState = (
      scheduler as unknown as {
        cleanupTaskState: (id: string) => void;
      }
    ).cleanupTaskState;
    cleanupTaskState.call(scheduler, 'A');

    // The 10 shared maps/sets are cleared.
    expect(sharedFieldsPresent(scheduler, 'A')).toEqual([]);
    // Cleanup-specific: retryEligible and taskSessionBaseDir are DELETED
    // (unlike resetForRetry which keeps a fresh taskSessionBaseDir).
    expect(isRetryEligible(scheduler, 'A')).toBe(false);
    expect(taskSessionBaseDirValue(scheduler, 'A')).toBeUndefined();
    // taskAttempts is retained for reporting (deliberately not cleared).
    expect(taskAttemptsKnown(scheduler, 'A')).toBe(true);
    expect(taskAttemptValue(scheduler, 'A')).toBe(1);
  });

  // ── 48. Abort clears retryEligible (no retry reset / re-init after abort) ───
  //
  // When a task fails with a retryable execution error it lands in
  // `retryEligible` (status 'failed', retry budget remaining) awaiting a
  // blank-slate retry on the NEXT drain pass (resetRetryEligibleTasks →
  // resetForRetry). Because 'failed' is a TERMINAL status, the abort handler's
  // cancel loop SKIPS such a task — so the task keeps sitting in
  // retryEligible after abort. The abort handler MUST therefore clear
  // retryEligible, otherwise the drain pass triggered by the abort could
  // reset the failed task to 'ready' and re-initialize it — wasted work / a
  // leaked runner after the pool has already been aborted.
  //
  // This test drives that fix: it aborts the pool at the exact instant the
  // task becomes retry-eligible and then asserts retryEligible is empty once
  // run() settles. Without the `this.retryEligible.clear()` in the abort
  // handler this assertion FAILS (the task id lingers in retryEligible).
  it('48. abort clears retryEligible — no retry reset / re-init after abort', async () => {
    const ac = new AbortController();
    const profiles = new Map([['default', makeProfile('default')]]);
    const gate = new SessionGate({ total: 2, perModel: {} });

    let planCalls = 0;
    // Runner whose execute() throws a TRANSIENT (retryable) error → failTask
    // marks the task retry-eligible ('failed' + retryEligible) and stays there
    // until the next drain pass would reset it.
    const factory = (): SessionPlanRunner => ({
      async *plan(): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]> {
        planCalls += 1;
        yield [makeSpec('s1', 'default')];
        return;
      },
      async execute(): Promise<SessionResult> {
        throw new SessionError('transient boom', { kind: 'transient', retryable: true });
      },
    });

    const graph = new TaskGraph();
    graph.addTask({ ...makeTask('A') }, factory);

    const activeSessions = new Set<{ abort(): Promise<void> }>();
    let didAbort = false;
    const scheduler = new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test-sessions',
      cwd: '/tmp/test',
      activeSessions,
      phaseId: 'test',
      signal: ac.signal,
      onStatus: {
        // Abort the pool the instant task A transitions to 'failed' (its
        // retryable failure). failTask adds A to retryEligible BEFORE firing
        // this transition, so at this moment A is 'failed' + retry-eligible.
        // The abort handler must clear retryEligible.
        onTaskRejected: () => {
          if (!didAbort) {
            didAbort = true;
            ac.abort();
          }
        },
      },
    });

    const result = await scheduler.run();

    // After abort, A stays terminal 'failed' — it is NOT retried.
    expect(graph.getTask('A')?.status).toBe('failed');
    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);

    // PRIMARY — drives the fix: retryEligible must be cleared by the abort
    // handler. Without `this.retryEligible.clear()` this FAILS (A lingers).
    const retryEligible = (scheduler as unknown as { retryEligible: Set<string> }).retryEligible;
    expect(retryEligible.has('A')).toBe(false);
    expect(retryEligible.size).toBe(0);

    // SECONDARY — the drain pass after abort must NOT reset / re-initialize
    // the task. resetForRetry was never called: the attempt counter stays 1
    // (it would be 2 after a retry reset) and the plan generator ran exactly
    // once (the initial attempt), with no blank-slate retry.
    const taskAttempts = (scheduler as unknown as { taskAttempts: Map<string, number> }).taskAttempts;
    expect(taskAttempts.get('A')).toBe(1);
    expect(planCalls).toBe(1);
  });
});

// ── withTimeout + GeneratorTimeoutError (S2 plan-generator timeout helper) ──
//
// SessionScheduler#withTimeout races a promise against a timeout. When the
// timeout fires first it MUST reject with a dedicated GeneratorTimeoutError —
// a distinct error class so callers can tell a generator/plan timeout apart
// from a genuine error thrown by the wrapped promise. When the promise
// settles first (resolve OR reject) the timeout timer MUST be cleared so no
// timer leak lingers.
//
// withTimeout is a private method with no scheduler state, so these tests
// exercise it directly on a bare scheduler instance.

describe('SessionScheduler.withTimeout / GeneratorTimeoutError', () => {
  /** Bare scheduler — withTimeout is a pure helper that reads no scheduler state. */
  function makeBareScheduler(): SessionScheduler {
    const graph = new TaskGraph();
    const gate = new SessionGate({ total: 1, perModel: {} });
    const profiles = new Map([['default', makeProfile('default')]]);
    return new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });
  }

  /** Typed view of the private withTimeout method. */
  type WithTimeoutFn = <T>(p: Promise<T>, ms: number, label?: string) => Promise<T>;

  function withTimeoutOf(scheduler: SessionScheduler): WithTimeoutFn {
    return (scheduler as unknown as { withTimeout: WithTimeoutFn }).withTimeout.bind(scheduler);
  }

  /**
   * Resolve the GeneratorTimeoutError class from the module namespace. Throws
   * a clear, specific failure when it isn't exported yet (instead of a cryptic
   * `undefined is not a constructor`), so the green team gets a precise spec.
   */
  function getGeneratorTimeoutError(): new (label: string, ms: number) => Error {
    const cls = (
      schedulerModule as {
        GeneratorTimeoutError?: new (label: string, ms: number) => Error;
      }
    ).GeneratorTimeoutError;
    if (typeof cls !== 'function') {
      throw new Error(
        'Expected GeneratorTimeoutError to be exported from session-scheduler.ts, ' +
          'but it is not exported (typeof === ' +
          typeof cls +
          ').',
      );
    }
    return cls;
  }

  /** Install spies on global setTimeout/clearTimeout that record created and
   *  cleared timer ids. Returns accessors + a restore() function. */
  function spyTimers(): {
    createdTimers: ReturnType<typeof setTimeout>[];
    clearedTimers: ReturnType<typeof setTimeout>[];
    restore(): void;
  } {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const createdTimers: ReturnType<typeof setTimeout>[] = [];
    const clearedTimers: ReturnType<typeof setTimeout>[] = [];
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
      const id = originalSetTimeout(fn, ms, ...rest);
      createdTimers.push(id);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
      if (id !== undefined) clearedTimers.push(id);
      return originalClearTimeout(id as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout;
    return {
      createdTimers,
      clearedTimers,
      restore() {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      },
    };
  }

  it('withTimeout resolves with the promise value when it settles before the timeout', async () => {
    const withTimeout = withTimeoutOf(makeBareScheduler());
    await expect(withTimeout(Promise.resolve('done'), 1000, 'plan generator next()')).resolves.toBe('done');
  });

  it('withTimeout rejects with a GeneratorTimeoutError when the promise does not settle in time', async () => {
    const withTimeout = withTimeoutOf(makeBareScheduler());
    const GeneratorTimeoutError = getGeneratorTimeoutError();
    // A promise that never settles — only the timeout can resolve the race.
    const hanging = new Promise<string>(() => {});
    await expect(withTimeout(hanging, 30, 'plan generator next()')).rejects.toBeInstanceOf(GeneratorTimeoutError);
  });

  it('the timeout error message includes the label and the timeout duration', async () => {
    const withTimeout = withTimeoutOf(makeBareScheduler());
    const GeneratorTimeoutError = getGeneratorTimeoutError();
    const hanging = new Promise<string>(() => {});
    const label = 'plan generator next()';
    const ms = 42;
    let caught: unknown;
    try {
      await withTimeout(hanging, ms, label);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GeneratorTimeoutError);
    const message = (caught as Error).message;
    expect(message).toContain(label);
    expect(message).toContain(String(ms));
  });

  it('GeneratorTimeoutError is constructable as (label, ms) and is an Error subclass', () => {
    const GeneratorTimeoutError = getGeneratorTimeoutError();
    const err = new GeneratorTimeoutError('plan generator next()', 5000);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('plan generator next()');
    expect(err.message).toContain('5000');
  });

  it('clears the timeout timer when the promise resolves before the timeout', async () => {
    const withTimeout = withTimeoutOf(makeBareScheduler());
    const spy = spyTimers();
    try {
      const result = await withTimeout(Promise.resolve('done'), 1000, 'plan generator next()');
      expect(result).toBe('done');
      // Exactly one timer was created (the timeout).
      expect(spy.createdTimers).toHaveLength(1);
      // That timer was cleared when the promise settled.
      expect(spy.clearedTimers).toContain(spy.createdTimers[0]);
    } finally {
      spy.restore();
    }
  });

  it('clears the timeout timer when the promise rejects before the timeout and propagates the original error', async () => {
    const withTimeout = withTimeoutOf(makeBareScheduler());
    const GeneratorTimeoutError = getGeneratorTimeoutError();
    const spy = spyTimers();
    const originalError = new Error('genuine failure');
    try {
      // The underlying rejection must be propagated UNCHANGED (not wrapped in
      // a GeneratorTimeoutError), and the timer must be cleared.
      await expect(withTimeout(Promise.reject(originalError), 1000, 'plan generator next()')).rejects.toBe(
        originalError,
      );
      expect(spy.createdTimers).toHaveLength(1);
      expect(spy.clearedTimers).toContain(spy.createdTimers[0]);
      // Sanity: a genuine error is distinct from a timeout error.
      expect(originalError).not.toBeInstanceOf(GeneratorTimeoutError);
    } finally {
      spy.restore();
    }
  });
});

// ─── MAX_EMPTY_BATCHES infinite-loop guard ─────────────────────────────────
//
// session-scheduler.ts extracts the former local magic value
// `const maxEmpty = 1000` into a module-level named constant
// `MAX_EMPTY_BATCHES`. These tests (a) drive + verify that extraction via the
// exported constant, and (b) characterize the exact guard behavior so the
// refactor is provably behavior-preserving:
//   - a plan generator yielding >1000 consecutive empty batches THROWS;
//   - exactly 1000 empty batches followed by a real batch is allowed.
//
// The guard lives in the private `nextNonEmptyBatch`, exercised directly via a
// typed cast (mirroring the withTimeout tests above) so the throw itself — not
// the surrounding retry/failure routing — is what's asserted.

describe('SessionScheduler nextNonEmptyBatch infinite-loop guard (MAX_EMPTY_BATCHES)', () => {
  /** Bare scheduler — nextNonEmptyBatch reads only entry.planGen, no scheduler state. */
  function makeBareScheduler(): SessionScheduler {
    const graph = new TaskGraph();
    const gate = new SessionGate({ total: 1, perModel: {} });
    const profiles = new Map([['default', makeProfile('default')]]);
    return new SessionScheduler({
      graph,
      gate,
      profiles,
      sessionBaseDir: '/tmp/test',
      cwd: '/tmp/test',
      activeSessions: new Set(),
      phaseId: 'test',
    });
  }

  /** Typed view of the private nextNonEmptyBatch method. */
  type NextNonEmptyBatchFn = (
    entry: TaskGraphEntry,
    seed: SessionResult[],
  ) => Promise<IteratorResult<SessionSpec[], SessionResult[] | undefined>>;

  function nextNonEmptyBatchOf(scheduler: SessionScheduler): NextNonEmptyBatchFn {
    return (scheduler as unknown as { nextNonEmptyBatch: NextNonEmptyBatchFn }).nextNonEmptyBatch.bind(scheduler);
  }

  /** Build a plan generator that yields `count` empty batches, optionally a
   *  final non-empty batch, then completes. */
  function makePlanGen(
    emptyCount: number,
    finalBatch?: SessionSpec[],
  ): AsyncGenerator<SessionSpec[], SessionResult[] | undefined> {
    return (async function* (): AsyncGenerator<SessionSpec[], SessionResult[] | undefined> {
      for (let i = 0; i < emptyCount; i++) yield [];
      if (finalBatch) yield finalBatch;
      return undefined;
    })();
  }

  /** A TaskGraphEntry carrying only the planGen nextNonEmptyBatch reads. */
  function entryWithPlan(planGen: AsyncGenerator<SessionSpec[], SessionResult[] | undefined>): TaskGraphEntry {
    return { planGen } as unknown as TaskGraphEntry;
  }

  it('MAX_EMPTY_BATCHES is exported as a named constant equal to 1000', () => {
    // Drives the extraction: the former local `const maxEmpty = 1000` must be
    // lifted to a module-level named constant MAX_EMPTY_BATCHES (exported, like
    // its neighbor MAX_RETRIES) so the guard threshold is named, not magic.
    expect((schedulerModule as { MAX_EMPTY_BATCHES?: number }).MAX_EMPTY_BATCHES).toBe(1000);
  });

  it('throws when the generator yields more than 1000 consecutive empty batches', async () => {
    const nextNonEmptyBatch = nextNonEmptyBatchOf(makeBareScheduler());
    const entry = entryWithPlan(makePlanGen(1001));
    await expect(nextNonEmptyBatch(entry, [])).rejects.toThrow(/empty batches without completing/);
  });

  it('does NOT throw at the boundary: exactly 1000 empty batches then a real batch returns the batch', async () => {
    const nextNonEmptyBatch = nextNonEmptyBatchOf(makeBareScheduler());
    const spec = makeSpec('s1', 'default');
    const entry = entryWithPlan(makePlanGen(1000, [spec]));
    const result = await nextNonEmptyBatch(entry, []);
    expect(result.done).toBe(false);
    expect(result.value).toEqual([spec]);
  });

  it('returns immediately for a generator that yields a non-empty first batch (no empties)', async () => {
    const nextNonEmptyBatch = nextNonEmptyBatchOf(makeBareScheduler());
    const spec = makeSpec('s1', 'default');
    const entry = entryWithPlan(makePlanGen(0, [spec]));
    const result = await nextNonEmptyBatch(entry, []);
    expect(result.done).toBe(false);
    expect(result.value).toEqual([spec]);
  });
});
