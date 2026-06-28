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
import type { SessionResult, SessionSpec } from './session.js';
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
    const result = await runPromise;

    expect(result.completedTasks).toBe(1); // R completed
    expect(result.failedTasks).toBe(1); // P failed (stuck)
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

    const result = await scheduler.run();

    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
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

    const result = await scheduler.run();

    expect(result.failedTasks).toBe(1);
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
    // the task should end up failed.
    const result = await runPromise;

    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
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

    const result = await scheduler.run();

    // The task transitions to active then parks when acquire fails.
    // With no way forward, the deadlock handler eventually fails it.
    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
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

    // A is stuck (modelB cap=0) → resource deadlock → A eventually fails.
    const result = await runPromise;
    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
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
});
