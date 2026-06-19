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

// ─── Restore real modules ─────────────────────────────────────────────────

afterAll(() => {
  mock.module('../core/profile.js', () => realProfile);
});
