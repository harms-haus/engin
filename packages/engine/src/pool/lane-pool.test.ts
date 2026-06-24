// ─── Tests for pool/lane-pool.ts — default auditor registration ──────────────
//
// Verifies the "Wire default auditor" registration seam in `LanePool.run()`:
//
//   BEFORE starting lanes, when BOTH `options.auditLog` AND
//   `options.hookRegistry` are present, `run()` registers the default auditor
//   (`createDefaultAuditor(auditLog)` from hooks/defaults/auditor.ts) as a
//   subscriber for `onStructuredOutput` and `onDecision`.
//
//   This is what lets structured output + decisions land in the durable
//   AuditLog WITHOUT any manual `auditLog.append` call in workflow code: the
//   pool owns the registration, and `runStep` (pool path) / `runStepTask`
//   (one-step path) own the hook firing.
//
// Required scenarios:
//   (a) run() registers onStructuredOutput + onDecision subscribers when
//       auditLog + hookRegistry are both provided.
//   (b) the registered auditor is FUNCTIONAL — invoking onStructuredOutput via
//       the registry appends a structured_output event to the AuditLog.
//   (c) run() does NOT register an auditor when auditLog is absent (backward
//       compat — manual auditLog.append calls in workflow code still work).
//   (d) run() does NOT register an auditor when hookRegistry is absent.
//   (e) pre-existing hookRegistry subscribers are preserved ALONGSIDE the
//       auditor (observe = fan-out; both fire).
//
// NOTE (TDD): `LanePool.run()` does not yet perform this registration, so the
// positive scenarios (a), (b), (e) are RED until the implementation lands; the
// negative scenarios (c), (d) pass today. `LanePoolOptions.auditLog` already
// exists on the type, so the file type-checks cleanly. Mocks follow the
// established pattern in core/phase-tasks-hooks.test.ts.
//
// Approach: drive a REAL TaskTracker + REAL HookRegistry + REAL AuditLog and a
// no-op TaskRunner that settles its task, so run() terminates quickly. Only
// `loadProfilesFromDirs` / `clearProfileCache` are mocked (to avoid real FS
// reads). maxConcurrentLanes=1 + laneWaitTimeoutMs=100 keeps the suite fast.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditEvent, Task } from '../core/types.js';
import type { WorktreeManager } from '../core/worktree-manager.js';
import { createHookRegistry } from '../hooks/registry.js';
import type { HookContext, HookRegistry } from '../hooks/types.js';
import { AuditLog } from '../tracking/audit-log.js';
import { TaskTracker } from '../tracking/task-status.js';
import { LanePool } from './lane-pool.js';
import type { LanePoolOptions, TaskRunner } from './types.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realProfile = Object.assign({}, await import('../core/profile.js'));

// ─── Mock profile loading (avoid real FS reads) ────────────────────────────
//
// `loadProfilesFromDirs(dirs)` takes a single arg; `clearProfileCache()` takes
// none. We forward the single arg (no rest-spread) — the `mock() & ((...)=>)`
// spread idiom used elsewhere trips TS2556 on a clean (non-incremental) build.

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((dirs: unknown) => unknown);
const mockClearProfileCache = mock(() => {});
mock.module('../core/profile.js', () => ({
  loadProfilesFromDirs: (dirs: unknown) => mockLoadProfilesFromDirs(dirs),
  clearProfileCache: () => mockClearProfileCache(),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

// (LanePool / TaskTracker / types imported above.)

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/** Minimal HookContext (the auditor hooks never read ctx). */
function makeHookCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: undefined as unknown as HookContext['registry'],
    cwd: '/tmp/project',
    workDir: '/tmp/project/.engin/work/run-1',
    ...overrides,
  };
}

/** A TaskRunner that immediately settles its task as completed. */
function completingRunner(): TaskRunner {
  return async (ctx) => {
    ctx.completeTask('done');
    return { status: 'completed', output: 'done' };
  };
}

function makeTask(id = 'task-1'): Task {
  return {
    id,
    title: 'Do the thing',
    prompt: 'please do the thing',
    profile: 'coder',
    files: [],
    dependencies: [],
    status: 'ready',
    phaseId: 'implement',
  };
}

/** Build LanePoolOptions. Optional auditLog / hookRegistry default to omitted. */
function makeOptions(overrides: Partial<LanePoolOptions> = {}): LanePoolOptions {
  const taskTracker = overrides.taskTracker ?? new TaskTracker();
  return {
    maxConcurrentLanes: 1,
    profilesDirs: ['/tmp/profiles'],
    sessionBaseDir: join(tmpdir(), 'lane-pool-sessions'),
    cwd: '/tmp/project',
    taskTracker,
    phaseId: 'implement',
    maxStepRetries: 1,
    laneWaitTimeoutMs: 100,
    // getRunnerForTask takes a task and RETURNS a TaskRunner; wrap the factory.
    getRunnerForTask: () => completingRunner(),
    ...overrides,
  };
}

/** Build a real HookRegistry with the engine's observe hooks declared. */
function makeRegistry(): HookRegistry {
  const reg = createHookRegistry();
  reg.defineHook('onStructuredOutput', 'observe');
  reg.defineHook('onDecision', 'observe');
  reg.defineHook('beforeStepPrompt', 'pipeline');
  return reg;
}

beforeEach(() => {
  mockLoadProfilesFromDirs.mockReset();
  mockClearProfileCache.mockReset();
  // Default: profile loading returns an empty map (the no-op runner ignores it).
  mockLoadProfilesFromDirs.mockResolvedValue(new Map());
});

afterEach(() => {
  // Defensive: ensure no lingering mock state between tests.
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LanePool.run() — default auditor registration', () => {
  // ── (a) registers onStructuredOutput + onDecision subscribers ──────────

  it('(a) registers onStructuredOutput + onDecision when auditLog + hookRegistry are provided', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'lane-pool-audit-a-'));
    const auditLog = new AuditLog(logDir);
    const hookRegistry = makeRegistry();

    // Sanity: no subscribers before run().
    expect(hookRegistry.hasSubscribers('onStructuredOutput')).toBe(false);
    expect(hookRegistry.hasSubscribers('onDecision')).toBe(false);

    try {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask());
      const pool = new LanePool(makeOptions({ taskTracker: tracker, auditLog, hookRegistry }));

      await pool.run();

      // After run(), the default auditor is registered for both observe hooks.
      expect(hookRegistry.hasSubscribers('onStructuredOutput')).toBe(true);
      expect(hookRegistry.hasSubscribers('onDecision')).toBe(true);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  // ── (b) the registered auditor is FUNCTIONAL ───────────────────────────
  //
  // After run() registers the auditor, invoking onStructuredOutput via the
  // registry (as runStep does) appends a structured_output event to the
  // AuditLog — proving the registered subscriber is the real auditor wired
  // to this auditLog, not a no-op.

  it('(b) the registered auditor appends a structured_output event when invoked via the registry', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'lane-pool-audit-b-'));
    const auditLog = new AuditLog(logDir);
    const hookRegistry = makeRegistry();

    try {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask('task-b'));
      const pool = new LanePool(makeOptions({ taskTracker: tracker, auditLog, hookRegistry }));

      await pool.run();

      // run() itself produces no audit events (the no-op runner doesn't fire
      // the hook). Invoke the hook directly, exactly as runStep would.
      await hookRegistry.invokeObserve(
        'onStructuredOutput',
        { agentId: 'reviewer-agent', output: { approved: true }, taskId: 'task-b', phaseId: 'review', stepIndex: 0 },
        makeHookCtx({ registry: hookRegistry }),
      );

      const events = await auditLog.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('structured_output');
      const [event] = events as Extract<AuditEvent, { type: 'structured_output' }>[];
      expect(event.agentId).toBe('reviewer-agent');
      expect(event.taskId).toBe('task-b');
      expect(event.output).toEqual({ approved: true });
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  // ── (c) no auditor when auditLog is absent (backward compat) ───────────

  it('(c) does NOT register an auditor when auditLog is absent', async () => {
    const hookRegistry = makeRegistry();

    const tracker = new TaskTracker();
    tracker.addTask(makeTask());
    // auditLog intentionally omitted.
    const pool = new LanePool(makeOptions({ taskTracker: tracker, hookRegistry }));

    await pool.run();

    // No auditLog → no default auditor → no subscribers for the audit hooks.
    expect(hookRegistry.hasSubscribers('onStructuredOutput')).toBe(false);
    expect(hookRegistry.hasSubscribers('onDecision')).toBe(false);
  });

  // ── (d) no auditor when hookRegistry is absent (backward compat) ───────

  it('(d) does NOT register an auditor when hookRegistry is absent', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'lane-pool-audit-d-'));
    const auditLog = new AuditLog(logDir);

    try {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask());
      // hookRegistry intentionally omitted.
      const pool = new LanePool(makeOptions({ taskTracker: tracker, auditLog }));

      const result = await pool.run();

      // Pool still runs to completion (backward compat — no hooks at all).
      expect(result.completedTasks).toBe(1);
      expect(result.failedTasks).toBe(0);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  // ── (e) pre-existing subscribers preserved alongside the auditor ───────
  //
  // When the workflow registers its OWN onStructuredOutput subscriber before
  // run(), the default auditor is added ALONGSIDE it — observe = fan-out, so
  // BOTH fire when the hook is invoked.

  it('(e) preserves a pre-existing onStructuredOutput subscriber alongside the auditor (fan-out)', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'lane-pool-audit-e-'));
    const auditLog = new AuditLog(logDir);
    const hookRegistry = makeRegistry();

    // A workflow-provided subscriber captured BEFORE run().
    const workflowSeen: unknown[] = [];
    hookRegistry.register({ onStructuredOutput: async (args) => void workflowSeen.push(args) });
    expect(hookRegistry.hasSubscribers('onStructuredOutput')).toBe(true);

    try {
      const tracker = new TaskTracker();
      tracker.addTask(makeTask('task-e'));
      const pool = new LanePool(makeOptions({ taskTracker: tracker, auditLog, hookRegistry }));

      await pool.run();

      // Invoke the hook — BOTH the workflow subscriber and the default
      // auditor must fire (observe fan-out).
      await hookRegistry.invokeObserve(
        'onStructuredOutput',
        { agentId: 'a', output: { ok: true }, taskId: 'task-e' },
        makeHookCtx({ registry: hookRegistry }),
      );

      // Workflow subscriber fired.
      expect(workflowSeen).toHaveLength(1);
      // Default auditor fired (audit log received the event).
      const events = await auditLog.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('structured_output');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

// ── Merge failure is non-retriable and preserves the worktree ───────────
//
// When a task's approved work cannot be merged (the merge-commit fix-up
// exhausted), re-running the task is futile — the WORK is fine, the
// integration is the problem. So a merge failure must NOT reset+re-run the
// task (which would burn the retry budget re-doing write-tests → … → review
// only to hit the same merge failure), and must NOT cull the task worktree
// (the approved work is preserved on its branch for manual merge).

describe('LanePool — merge failure is non-retriable + preserves the worktree', () => {
  /** A completing runner that counts how many times it was invoked. */
  function countingCompletingRunner(counter: { n: number }): TaskRunner {
    return async (ctx) => {
      counter.n++;
      ctx.completeTask('done');
      return { status: 'completed', output: 'done' };
    };
  }

  it('does not re-run the task and does not cull when mergeTaskBranch throws', async () => {
    const runCount = { n: 0 };
    const decisions: string[] = [];
    const cull = mock(() => Promise.resolve());
    const worktreeManager = {
      mainWorktreePath: '/run/work/worktree',
      createTaskWorktree: mock(async () => '/run/work/task-wt'),
      mergeTaskBranch: mock(async () => {
        throw new Error('pre-commit hook rejected');
      }),
      cullTaskWorktree: cull,
    } as unknown as WorktreeManager;

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('task-merge'));
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        worktreeManager,
        // Two retries ALLOWED — the test asserts NONE are consumed.
        maxTaskRetries: 2,
        getRunnerForTask: () => countingCompletingRunner(runCount),
        onStatus: { onDecision: (e) => decisions.push(e.decision) },
      }),
    );

    const result = await pool.run();

    // The runner ran exactly ONCE (no task retry despite maxTaskRetries: 2).
    expect(runCount.n).toBe(1);
    // The task is counted as failed (the merge could not complete).
    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
    // The task worktree was NOT culled — preserved for manual merge.
    expect(cull).not.toHaveBeenCalled();
    // A decision event surfaces the integration failure + preservation.
    expect(decisions.some((d) => d.includes('failed on integration') && d.includes('worktree preserved'))).toBe(true);
    expect(decisions.some((d) => d.includes('Retrying failed task'))).toBe(false);
  });

  it('still retries a NORMAL step failure (regression guard)', async () => {
    // A runner that fails with a TRANSIENT message — retriable under the
    // new classify-based policy. maxTaskRetries: 1 ⇒ up to 2 total runs.
    const runCount = { n: 0 };
    const failingRunner: TaskRunner = async (ctx) => {
      runCount.n++;
      ctx.failTask({ completed: false, error: 'overloaded' });
      return { status: 'failed', feedback: 'overloaded' };
    };

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('task-step'));
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        // No worktreeManager ⇒ no merge step ⇒ a normal retriable failure.
        maxTaskRetries: 1,
        getRunnerForTask: () => failingRunner,
      }),
    );

    const result = await pool.run();

    // Two total runs (initial + 1 retry) — normal failures are still retried.
    expect(runCount.n).toBe(2);
    expect(result.failedTasks).toBe(1);
  });
});

// ── Orphaned active task prevention ───────────────────────────────────────
//
// When pre-try code in processTask throws (e.g. onTaskStart callback), the
// task was left 'active' forever — the lane rejects, Promise.allSettled
// swallows it, and isPoolDone() never returns true. The fix wraps pre-try
// code in its own try/catch that settles the task to 'failed' before
// re-throwing.

describe('LanePool — orphaned active task prevention (SITE A)', () => {
  it('onTaskStart callback throws → task ends failed, pool completes (no hang)', async () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask('orphan-test'));

    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        onStatus: {
          onTaskStart: () => {
            throw new Error('onTaskStart crashed');
          },
        },
      }),
    );

    const result = await pool.run();

    // Task must NOT be 'active' — it was settled to 'failed' by the orphan
    // prevention catch before the error was re-thrown.
    const task = tracker.getTask('orphan-test');
    expect(task?.status).toBe('failed');
    // Pool must drain (isPoolDone() returns true).
    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
  });

  it('beforeTask {skip:true} still cancels correctly (regression guard)', async () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask('skip-test'));

    // Build a registry with the beforeTask first-wins hook declared.
    const hookRegistry = createHookRegistry();
    hookRegistry.defineHook('beforeTask', 'first-wins');
    hookRegistry.register({
      beforeTask: () => ({ skip: true, reason: 'test skip' }),
    });

    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        hookRegistry,
        getRunnerForTask: undefined, // no runner needed — skip short-circuits
      }),
    );

    const result = await pool.run();

    const task = tracker.getTask('skip-test');
    expect(task?.status).toBe('cancelled');
    expect(result.completedTasks).toBe(0);
    expect(result.failedTasks).toBe(0);
  });

  it('normal happy path completes task (regression guard)', async () => {
    const tracker = new TaskTracker();
    tracker.addTask(makeTask('happy'));

    const pool = new LanePool(makeOptions({ taskTracker: tracker }));
    const result = await pool.run();

    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);
    expect(tracker.getTask('happy')?.status).toBe('complete');
  });
});

// ── Class-aware retries with backoff ─────────────────────────────────────
//
// maybeRetryFailedTask now calls classify(reason) to decide whether a
// failure is transient (retryable with backoff) or permanent (no retry).
//
// Required scenarios:
//   (a) Transient failure ("rate limit exceeded") → task reset to ready
//       after a delay > 0, taskRetries incremented, onDecision called.
//   (b) Permanent failure ("Unknown model X for provider Y") → task stays
//       failed, NO retry, taskRetries NOT incremented, onDecision with
//       permanent message.
//   (c) Budget exhaustion (used >= max) → permanent failure, not retried.
//   (d) Abort during backoff → delay cancelled promptly (pool exits fast).
//   (e) Merge failure remains non-retriable (regression guard).

describe('LanePool — class-aware retries with backoff (PART B)', () => {
  /** A failing runner that counts invocations and returns a specific failure. */
  function failingRunnerWithReason(counter: { n: number }, feedback: string): TaskRunner {
    return async (ctx) => {
      counter.n++;
      // The runner must fail the task in the tracker (as real runners do).
      ctx.failTask({ completed: false, error: feedback });
      return { status: 'failed', feedback };
    };
  }

  // ── (a) Transient failure → retry after delay ───────────────────────

  it('(a) transient failure (rate limit) resets to ready after a delay, increments retry count, fires onDecision', async () => {
    const runCount = { n: 0 };
    const decisions: string[] = [];

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('transient'));

    const start = Date.now();
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        // maxTaskRetries: 1 → 1 retry → backoff ~2s (fits in 5s timeout).
        // Escalation across retries is covered by the dedicated (g) test.
        maxTaskRetries: 1,
        getRunnerForTask: () => failingRunnerWithReason(runCount, 'rate limit exceeded'),
        onStatus: { onDecision: (e) => decisions.push(e.decision) },
      }),
    );

    const result = await pool.run();
    const elapsed = Date.now() - start;

    // The task was retried: initial run + at least 1 retry = runCount >= 2.
    expect(runCount.n).toBeGreaterThanOrEqual(2);
    // The task is ultimately still failed (all retries exhausted).
    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
    // There was a measurable delay (> 100ms) due to backoff.
    expect(elapsed).toBeGreaterThan(100);
    // onDecision was called with a retry announcement.
    expect(decisions.some((d) => d.includes('Retrying failed task'))).toBe(true);
    // onDecision was NOT called with a permanent failure message.
    expect(decisions.some((d) => d.includes('permanently'))).toBe(false);
  });

  // ── (b) Permanent failure → no retry ────────────────────────────────

  it('(b) permanent failure (unknown model) stays failed, no retry, no delay, fires permanent onDecision', async () => {
    const runCount = { n: 0 };
    const decisions: string[] = [];

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('perm'));

    const start = Date.now();
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        maxTaskRetries: 2,
        getRunnerForTask: () => failingRunnerWithReason(runCount, 'Unknown model "foo" for provider "bar"'),
        onStatus: { onDecision: (e) => decisions.push(e.decision) },
      }),
    );

    const result = await pool.run();
    const elapsed = Date.now() - start;

    // The runner ran exactly once — no retry for permanent errors.
    expect(runCount.n).toBe(1);
    // Task stays failed.
    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
    expect(tracker.getTask('perm')?.status).toBe('failed');
    // No significant delay (permanent = no backoff).
    expect(elapsed).toBeLessThan(2000);
    // onDecision surfaces the permanent failure.
    expect(decisions.some((d) => d.includes('permanently') && d.includes('perm'))).toBe(true);
    // No retry announcement.
    expect(decisions.some((d) => d.includes('Retrying failed task'))).toBe(false);
  });

  // ── (b2) Permanent failure via config error pattern ──────────────────

  it('(b2) permanent failure (no API key) stays failed, no retry', async () => {
    const runCount = { n: 0 };
    const decisions: string[] = [];

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('nokey'));

    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        maxTaskRetries: 3,
        getRunnerForTask: () => failingRunnerWithReason(runCount, 'No API key for openai'),
        onStatus: { onDecision: (e) => decisions.push(e.decision) },
      }),
    );

    const result = await pool.run();

    expect(runCount.n).toBe(1);
    expect(result.failedTasks).toBe(1);
    expect(decisions.some((d) => d.includes('permanently'))).toBe(true);
    expect(decisions.some((d) => d.includes('Retrying'))).toBe(false);
  });

  // ── (c) Budget exhaustion ───────────────────────────────────────────

  it('(c) budget exhaustion (used >= max) → permanent failure, not retried further', async () => {
    const runCount = { n: 0 };
    const decisions: string[] = [];

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('budget'));

    // maxTaskRetries: 1 → total attempts = 2. The runner fails transiently,
    // so it gets 1 retry (runCount goes to 2). On the second failure, the
    // budget is exhausted and it stays failed.
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        maxTaskRetries: 1,
        getRunnerForTask: () => failingRunnerWithReason(runCount, 'overloaded'),
        onStatus: { onDecision: (e) => decisions.push(e.decision) },
      }),
    );

    const result = await pool.run();

    // Initial run + 1 retry = 2 total.
    expect(runCount.n).toBe(2);
    expect(result.failedTasks).toBe(1);
    // Only 1 retry announcement (the second failure is budget-exhausted).
    const retryAnnouncements = decisions.filter((d) => d.includes('Retrying'));
    expect(retryAnnouncements.length).toBe(1);
  });

  // ── (d) Abort during backoff → delay cancelled promptly ─────────────

  it('(d) abort during backoff delay cancels the delay promptly', async () => {
    const runCount = { n: 0 };
    const ac = new AbortController();

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('abort-backoff'));

    // The runner fails transiently on the first run, triggering a backoff.
    // After a short delay, we abort — the backoff should be cancelled
    // promptly so the pool exits quickly.
    let resolveFirstRun: () => void;
    const firstRunGate = new Promise<void>((r) => {
      resolveFirstRun = r;
    });

    const runner: TaskRunner = async (ctx) => {
      runCount.n++;
      if (runCount.n === 1) {
        // First run: fail and signal that we're done.
        ctx.failTask({ completed: false, error: 'overloaded' });
        // Give a tick for maybeRetryFailedTask to start the backoff.
        queueMicrotask(() => resolveFirstRun!());
        return { status: 'failed', feedback: 'overloaded' };
      }
      // Second run (if reached): we were aborted, so shouldn't get here,
      // but handle gracefully.
      ctx.failTask({ completed: false, error: 'overloaded' });
      return { status: 'failed', feedback: 'overloaded' };
    };

    const start = Date.now();
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        maxTaskRetries: 5,
        signal: ac.signal,
        getRunnerForTask: () => runner,
      }),
    );

    const runP = pool.run();

    // Wait for the first run to finish and the backoff to start.
    await firstRunGate;
    // Give a tiny bit for the backoff to begin.
    await new Promise((r) => setTimeout(r, 10));

    // Abort — this should cancel the backoff delay.
    ac.abort();

    const result = await runP;
    const elapsed = Date.now() - start;

    // The pool must exit promptly (< 2s) even though maxTaskRetries=5
    // would imply a long backoff if not cancelled.
    expect(elapsed).toBeLessThan(2000);
    // Only 1 run (the abort stopped the retry loop).
    expect(runCount.n).toBe(1);
    expect(result.completedTasks).toBe(0);
  });

  // ── (e) Merge failure remains non-retriable (regression guard) ──────

  it('(e) merge failure remains non-retriable (regression guard for kb-6)', async () => {
    const runCount = { n: 0 };
    const decisions: string[] = [];
    const cull = mock(() => Promise.resolve());
    const worktreeManager = {
      mainWorktreePath: '/run/work/worktree',
      createTaskWorktree: mock(async () => '/run/work/task-wt'),
      mergeTaskBranch: mock(async () => {
        throw new Error('merge conflict');
      }),
      cullTaskWorktree: cull,
    } as unknown as WorktreeManager;

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('merge-retain'));
    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        worktreeManager,
        maxTaskRetries: 3,
        getRunnerForTask: () => {
          const counter = { n: 0 };
          return async (ctx) => {
            counter.n++;
            ctx.completeTask('done');
            return { status: 'completed', output: 'done' };
          };
        },
        onStatus: { onDecision: (e) => decisions.push(e.decision) },
      }),
    );

    const result = await pool.run();

    // Merge failed → task failed, no retry despite maxTaskRetries: 3.
    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
    // Worktree preserved (not culled).
    expect(cull).not.toHaveBeenCalled();
    // Integration failure message, not a retry.
    expect(decisions.some((d) => d.includes('failed on integration'))).toBe(true);
    expect(decisions.some((d) => d.includes('Retrying'))).toBe(false);
  });

  // ── (f) Transient then permanent on subsequent retry ─────────────────

  it('(f) unknown error kind → no retry, permanent onDecision', async () => {
    const runCount = { n: 0 };
    const decisions: string[] = [];

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('unknown'));

    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        maxTaskRetries: 2,
        getRunnerForTask: () => failingRunnerWithReason(runCount, 'xyzzy foobarbaz'),
        onStatus: { onDecision: (e) => decisions.push(e.decision) },
      }),
    );

    const result = await pool.run();

    // Unknown errors are not retryable.
    expect(runCount.n).toBe(1);
    expect(result.failedTasks).toBe(1);
    expect(decisions.some((d) => d.includes('permanently'))).toBe(true);
    expect(decisions.some((d) => d.includes('Retrying'))).toBe(false);
  });
});

// ─── (g) Transient backoff delay INCREASES across successive retries ────
//
// Verify that the exponential backoff from classify(reason, { attempt })
// actually escalates: attempt 1 → ~2s, attempt 2 → ~4s, so the gap between
// successive retries grows. We record timestamps in the runner and assert
// gap2 > gap1. This is deterministic because the min of each attempt's
// range is strictly greater than the max of the previous attempt's range.

describe('LanePool — transient backoff escalation', () => {
  it('(g) backoff delay increases across successive retries (exponential)', async () => {
    const timestamps: number[] = [];
    const runCount = { n: 0 };

    const runner: TaskRunner = async (ctx) => {
      timestamps.push(Date.now());
      runCount.n++;
      ctx.failTask({ completed: false, error: 'rate limit exceeded' });
      return { status: 'failed', feedback: 'rate limit exceeded' };
    };

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('backoff-inc'));

    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        maxTaskRetries: 2,
        getRunnerForTask: () => runner,
      }),
    );

    await pool.run();

    // 3 total runs: initial + 2 retries.
    expect(runCount.n).toBe(3);
    expect(timestamps.length).toBe(3);

    const gap1 = timestamps[1] - timestamps[0]; // attempt 1 backoff (~2-2.5s)
    const gap2 = timestamps[2] - timestamps[1]; // attempt 2 backoff (~4-4.5s)

    // Exponential: computeTransientDelay(1) ∈ [2000, 2500],
    // computeTransientDelay(2) ∈ [4000, 4500]. gap2 > gap1 always.
    expect(gap2).toBeGreaterThan(gap1);
  }, 15_000); // generous timeout for escalating backoff (~6-7s total)
});

// ── Deadlocked task surfaces onTaskRejected ─────────────────────────────
//
// When isPoolDone() detects a 'blocked' task whose dependency references a
// non-existent task (deadlocked), it marks the task as 'failed' with a
// descriptive result. The TaskSettled observer in LanePool.run() must fire
// onTaskRejected with the deadlock reason so the TUI/web can display it.

describe('LanePool — deadlocked task fires onTaskRejected', () => {
  it('onTaskRejected fires for a deadlocked task with the deadlock reason', async () => {
    const rejected: { taskId: string; reason: string }[] = [];

    const tracker = new TaskTracker();
    // Task depends on a non-existent task → addTask computes 'blocked' status
    // because status is intentionally omitted (makeTask hardcodes 'ready').
    tracker.addTask({
      id: 'deadlock-test',
      title: 'Deadlock Test',
      prompt: 'do deadlock-test',
      profile: 'default',
      files: [],
      dependencies: ['nonexistent'],
      phaseId: 'test',
    });
    // Sanity: the task is 'blocked' (dep doesn't exist).
    expect(tracker.getTask('deadlock-test')?.status).toBe('blocked');

    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        onStatus: {
          onTaskRejected: (e) => rejected.push({ taskId: e.taskId, reason: e.reason }),
        },
      }),
    );

    const result = await pool.run();

    // The deadlocked task was failed by isPoolDone.
    expect(result.failedTasks).toBe(1);
    expect(result.completedTasks).toBe(0);
    const task = tracker.getTask('deadlock-test');
    expect(task?.status).toBe('failed');

    // onTaskRejected fired for the deadlocked task with the reason.
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected.some((r) => r.taskId === 'deadlock-test')).toBe(true);
    expect(rejected.some((r) => r.reason.includes('deadlocked'))).toBe(true);
  });

  it('onTaskRejected fires exactly once per deadlocked task (idempotent)', async () => {
    const rejected: string[] = [];

    const tracker = new TaskTracker();
    // Omit status so addTask computes 'blocked' (dep doesn't exist).
    tracker.addTask({
      id: 'idem-dead',
      title: 'Idem Dead',
      prompt: 'do idem-dead',
      profile: 'default',
      files: [],
      dependencies: ['no-such-task'],
      phaseId: 'test',
    });

    const pool = new LanePool(
      makeOptions({
        taskTracker: tracker,
        onStatus: {
          onTaskRejected: (e) => rejected.push(e.taskId),
        },
      }),
    );

    await pool.run();

    // Exactly one onTaskRejected per deadlocked task, even if isPoolDone
    // or TaskSettled fires multiple times.
    const count = rejected.filter((id) => id === 'idem-dead').length;
    expect(count).toBe(1);
  });
});

// ─── Restore real modules ─────────────────────────────────────────────────

afterAll(() => {
  mock.module('../core/profile.js', () => realProfile);
});
