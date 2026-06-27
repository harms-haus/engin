// ─── Integration tests: default auditor wiring through LanePool ──────────────
//
// End-to-end verification that the DEFAULT AUDITOR, registered by
// `LanePool.run()` when BOTH `auditLog` AND `hookRegistry` are present on
// `LanePoolOptions`, actually fires through the REAL execution path —
// `LanePool.run()` → `Scheduler` → `processTask` → `linearStepsRunner` →
// `runStep` → hook firing → default auditor → `AuditLog.append`.
//
// The unit tests in `auditor.test.ts` pin the auditor's two hook functions in
// isolation; `lane-pool.test.ts` pins the registration seam (that subscribers
// exist after `run()`); `step-execution.test.ts` pins the `runStep` fire
// point. THIS file stitches all three together: it drives a REAL `LanePool`
// over a REAL `HookRegistry` + REAL `AuditLog` + REAL `TaskTracker` and a
// REAL `linearStepsRunner` (via `getStepsForTask`), with only the I/O-heavy
// leaf dependencies (`spawnAgent`, `promptForStructured`, `buildPrompt`,
// profile loading) mocked away.
//
// Required scenarios (from the task):
//   (1) Structured output triggers audit append — a schema step run through
//       the pool lands a `structured_output` event in the AuditLog with NO
//       manual `auditLog.append` anywhere in the test or its runner.
//   (2) Decision triggers audit append — a rejected review lands a `decision`
//       event in the AuditLog.
//   (3) Both store and audit fire — the `onStatus.onDecision` store callback
//       AND the audit-log `onDecision` hook BOTH receive the decision (the
//       hook fires IN ADDITION TO the store callback, not instead of it).
//   (4) No `auditLog` → no auditor — when `auditLog` is omitted from
//       `LanePoolOptions`, no auditor is registered and no audit events are
//       appended (backward compat).
//   (5) Workflow-provided hook + default auditor both fire — a custom
//       `onStructuredOutput` subscriber registered BEFORE `run()` fires
//       ALONGSIDE the default auditor (observe = fan-out).
//
// Mock strategy: capture the real modules via top-level `await import`, then
// `mock.module` their leaf I/O dependencies. `mock.module` paths resolve to
// the same absolute specifiers that `pool/step-execution.ts` and
// `pool/lane-pool.ts` import (verified against the existing
// `step-execution.test.ts` / `lane-pool.test.ts` patterns), so the mocks
// intercept the real firing chain.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { z } from 'zod';

import type { AgentProfile, AuditEvent, StatusCallbacks, Task } from '../../core/types.js';
import { AuditLog } from '../../tracking/audit-log.js';
import { TaskTracker } from '../../tracking/task-status.js';
import { createHookRegistry } from '../registry.js';
import type { HookRegistry, OnStructuredOutputArgs } from '../types.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realAgentLifecycle = Object.assign({}, await import('../../core/agent-lifecycle.js'));
const realStructuredOutput = Object.assign({}, await import('../../core/structured-output.js'));
const realPromptBuilder = Object.assign({}, await import('../../pool/prompt-builder.js'));
const realProfile = Object.assign({}, await import('../../core/profile.js'));

// ─── Mock the I/O-heavy leaf dependencies of the firing chain ──────────────
//
// Each mock forwards through a resettable `mock()` so individual tests can
// program the structured-output result (approved vs. rejected) and assert on
// call counts. The single-arg forward idiom (no rest-spread) avoids TS2556
// on a clean (non-incremental) build — same approach as lane-pool.test.ts.

const mockSpawnAgent = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../core/agent-lifecycle.js', () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../core/structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
  // Passthrough — not exercised by this chain, but keep the export present so
  // any transitive importer of the module does not get `undefined`.
  extractJsonFromText: realStructuredOutput.extractJsonFromText,
}));

const mockBuildPrompt = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../../pool/prompt-builder.js', () => ({
  buildPrompt: (...args: unknown[]) => mockBuildPrompt(...args),
}));

const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((dirs: unknown) => unknown);
const mockClearProfileCache = mock(() => {});
mock.module('../../core/profile.js', () => ({
  loadProfilesFromDirs: (dirs: unknown) => mockLoadProfilesFromDirs(dirs),
  clearProfileCache: () => mockClearProfileCache(),
}));

// ─── Import the module under test AFTER mocks are registered ───────────────
//
// `LanePool` transitively imports `step-execution.ts` (→ spawnAgent /
// promptForStructured / buildPrompt) and `profile.ts` (→ loadProfilesFromDirs
// / clearProfileCache). Importing it here (after the mock.module calls) ensures
// its module graph resolves against the mocks — matching the
// "import after mocks" pattern in core/phase-tasks-hooks.test.ts.

import { LanePool } from '../../pool/lane-pool.js';
import type { LanePoolOptions, StepDefinition } from '../../pool/types.js';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const reviewerProfile: AgentProfile = {
  id: 'reviewer',
  name: 'Reviewer',
  provider: 'openai',
  model: 'gpt-4',
  thinkingLevel: 'medium',
  systemPrompt: 'You are a reviewer.',
  excludeTools: [],
  includeTools: [],
};

/** The structured-output Zod schema used by the reviewer step. */
const reviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string().optional(),
}) as unknown as ZodType<unknown>;

/** A structured reviewer step (has a schema → runStep takes the structured path). */
function makeReviewStep(): StepDefinition {
  return {
    name: 'review',
    profileId: 'reviewer',
    isReadOnly: true,
    schema: reviewSchema,
    isApproved: (r: unknown) => (r as { approved?: boolean })?.approved === true,
    getFeedback: (r: unknown) => (r as { feedback?: string })?.feedback ?? 'No feedback provided',
  };
}

function makeTask(id = 'task-1'): Task {
  return {
    id,
    title: 'Review the thing',
    prompt: 'please review the thing',
    profile: 'reviewer',
    files: [],
    dependencies: [],
    status: 'ready',
    worktree: 'none',
    phaseId: 'review',
  };
}

/**
 * A mock `AgentLifecycleHandle` with a spyable session. `runStep` only touches
 * `handle.session` (passed to the mocked `promptForStructured`), `handle.dispose`,
 * `handle.sessionPath`, and `handle.complete()` — none of the real session
 * methods are invoked on the structured path because `promptForStructured` is
 * mocked. The full session surface is included for fidelity with
 * step-execution.test.ts.
 */
function makeMockHandle() {
  const session = {
    prompt: mock(async (_text: string) => {}),
    getLastAssistantText: mock(() => 'assistant-text'),
    getLastAssistantMessage: mock(() => undefined),
    sessionId: 'reviewer-session',
    sessionFile: join(tmpdir(), 'reviewer-session.jsonl'),
    subscribe: mock(() => () => {}),
    dispose: mock(() => {}),
    abort: mock(async () => {}),
  };
  return {
    session,
    dispose: mock(() => {}),
    sessionId: 'reviewer-session',
    sessionPath: join(tmpdir(), 'reviewer-session.jsonl'),
    complete: mock(() => {}),
  };
}

/** Build a REAL HookRegistry with the engine's observe/pipeline hooks declared. */
function makeRegistry(): HookRegistry {
  const reg = createHookRegistry();
  reg.defineHook('beforeSessionPrompt', 'pipeline');
  reg.defineHook('onStructuredOutput', 'observe');
  reg.defineHook('onDecision', 'observe');
  return reg;
}

/**
 * Build `LanePoolOptions` wired to run a single schema step through the REAL
 * `linearStepsRunner` (via `getStepsForTask`). `auditLog` / `hookRegistry` /
 * `onStatus` default to omitted so each test opts in explicitly.
 *
 * `maxStepRetries: 1` means a rejected review fires `onDecision` exactly once
 * (the first rejection) before the runner settles the task — keeping the
 * decision-event count deterministic for scenarios (2) and (3).
 */
function makeOptions(overrides: Partial<LanePoolOptions> = {}): LanePoolOptions {
  const taskTracker = overrides.taskTracker ?? new TaskTracker();
  return {
    maxConcurrentLanes: 1,
    profilesDirs: ['/tmp/profiles'],
    sessionBaseDir: join(tmpdir(), 'auditor-int-sessions'),
    cwd: '/tmp/project',
    taskTracker,
    phaseId: 'review',
    maxStepRetries: 1,
    laneWaitTimeoutMs: 100,
    getStepsForTask: () => [makeReviewStep()],
    ...overrides,
  };
}

// ─── Temp-dir lifecycle ──────────────────────────────────────────────────────

/** Temp dirs created during a test, cleaned in afterEach. */
const tempDirs: string[] = [];

/** Create a fresh AuditLog backed by a temp directory (cleaned afterEach). */
function makeAuditLog(): AuditLog {
  const dir = mkdtempSync(join(tmpdir(), 'auditor-int-'));
  tempDirs.push(dir);
  return new AuditLog(dir);
}

beforeEach(() => {
  mockSpawnAgent.mockReset();
  mockPromptForStructured.mockReset();
  mockBuildPrompt.mockReset();
  mockLoadProfilesFromDirs.mockReset();
  mockClearProfileCache.mockReset();
  // Defaults: a spawned agent handle, a no-op prompt builder, and a profiles
  // map containing the `reviewer` profile the reviewer step requires.
  // `promptForStructured` is intentionally NOT defaulted here — each test
  // programs the structured result (approved / rejected) it needs.
  mockSpawnAgent.mockResolvedValue(makeMockHandle());
  mockBuildPrompt.mockImplementation(async () => 'prompt-text');
  mockLoadProfilesFromDirs.mockResolvedValue(new Map([['reviewer', reviewerProfile]]));
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LanePool default auditor — end-to-end wiring', () => {
  // ── (1) Structured output triggers audit append ─────────────────────────
  //
  // A schema step run through the pool lands a `structured_output` event in
  // the durable AuditLog. The event is written SOLELY by the default auditor
  // registered inside `LanePool.run()` — there is NO `auditLog.append` call
  // anywhere in this test, in `linearStepsRunner`, or in `runStep`.

  it('(1) appends a structured_output event for a schema step with no manual auditLog.append', async () => {
    const auditLog = makeAuditLog();
    const hookRegistry = makeRegistry();

    // Approved structured result → the step completes on the first attempt.
    mockPromptForStructured.mockResolvedValue({
      result: { approved: true, score: 9, notes: 'looks good' },
      attempts: 1,
    });

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('task-structured'));
    const pool = new LanePool(makeOptions({ taskTracker: tracker, auditLog, hookRegistry }));

    const result = await pool.run();

    // Sanity: the task completed (the firing path ran end to end).
    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);

    // The audit log received exactly one event, of type structured_output.
    const events = await auditLog.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('structured_output');

    const [event] = events as Extract<AuditEvent, { type: 'structured_output' }>[];
    expect(event.agentId).toBeTypeOf('string');
    expect(event.agentId.length).toBeGreaterThan(0);
    expect(event.taskId).toBe('task-structured');
    expect(event.output).toEqual({ approved: true, score: 9, notes: 'looks good' });
    // AuditLog.append stamps the timestamp itself — the hook never supplies one.
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ── (2) Decision triggers audit append ──────────────────────────────────
  //
  // A REJECTED review drives `linearStepsRunner` to fire `onDecision` (once,
  // because maxStepRetries=1). The default auditor translates that into a
  // `decision` event in the AuditLog.

  it('(2) appends a decision event when a review is rejected', async () => {
    const auditLog = makeAuditLog();
    const hookRegistry = makeRegistry();

    // Rejected structured result (no `severity` → defaults to 'medium', which
    // is non-failing, so the task settles as completed-with-caveats rather
    // than failed — but the rejection still fires onDecision once).
    mockPromptForStructured.mockResolvedValue({
      result: { approved: false, feedback: 'needs more tests' },
      attempts: 1,
    });

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('task-decision'));
    const pool = new LanePool(makeOptions({ taskTracker: tracker, auditLog, hookRegistry }));

    await pool.run();

    // The rejection fires BOTH a structured_output event (the rejected result
    // is still observed) AND a decision event. Filter to the decision event.
    const decisions = await auditLog.getEvents({ type: 'decision' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].type).toBe('decision');

    const [decision] = decisions as Extract<AuditEvent, { type: 'decision' }>[];
    expect(decision.taskId).toBe('task-decision');
    expect(decision.agentId).toBeTypeOf('string');
    expect(decision.agentId.length).toBeGreaterThan(0);
    // The decision text mentions the rejected step + retry; reasoning carries
    // the reviewer's feedback.
    expect(decision.decision).toContain('rejected');
    expect(decision.reasoning).toBe('needs more tests');
    expect(decision.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ── (3) Both store and audit fire ───────────────────────────────────────
  //
  // The `onStatus.onDecision` STORE callback (which `createStoreCallbacks`
  // routes into the EventStore) AND the audit-log `onDecision` HOOK both
  // receive the decision. The hook fires IN ADDITION TO the store callback,
  // not instead of it — they are independent sinks.

  it('(3) fires onStatus.onDecision (store) AND the audit-log onDecision hook for one rejection', async () => {
    const auditLog = makeAuditLog();
    const hookRegistry = makeRegistry();

    // Capture what the event-store-side callback receives. Mirrors the shape
    // createStoreCallbacks forwards into EventStore.append('decision', ...).
    const storeDecisions: { agentId: string; decision: string; reasoning: string; taskId?: string }[] = [];
    const onStatus: StatusCallbacks = {
      onDecision: (info) => storeDecisions.push(info),
    };

    mockPromptForStructured.mockResolvedValue({
      result: { approved: false, feedback: 'tests missing' },
      attempts: 1,
    });

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('task-both'));
    const pool = new LanePool(makeOptions({ taskTracker: tracker, auditLog, hookRegistry, onStatus }));

    await pool.run();

    // Store side: the onStatus.onDecision callback fired exactly once.
    expect(storeDecisions).toHaveLength(1);
    expect(storeDecisions[0].taskId).toBe('task-both');
    expect(storeDecisions[0].reasoning).toBe('tests missing');
    expect(storeDecisions[0].decision).toContain('rejected');

    // Audit side: the default auditor appended exactly one decision event.
    const auditDecisions = await auditLog.getEvents({ type: 'decision' });
    expect(auditDecisions).toHaveLength(1);
    expect(auditDecisions[0].type).toBe('decision');

    // Both sinks received the SAME decision payload (same taskId / reasoning).
    const [auditDecision] = auditDecisions as Extract<AuditEvent, { type: 'decision' }>[];
    expect(auditDecision.taskId).toBe(storeDecisions[0].taskId);
    expect(auditDecision.reasoning).toBe(storeDecisions[0].reasoning);
  });

  // ── (4) No auditLog → no auditor (backward compat) ──────────────────────
  //
  // When `auditLog` is omitted from LanePoolOptions, `run()` registers NO
  // default auditor: no subscribers for the audit hooks, and no audit events
  // are appended. The pool still runs to completion (backward compat).

  it('(4) registers no auditor and appends no audit events when auditLog is absent', async () => {
    const hookRegistry = makeRegistry();

    mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });

    // Sanity: no subscribers before run().
    expect(hookRegistry.hasSubscribers('onStructuredOutput')).toBe(false);
    expect(hookRegistry.hasSubscribers('onDecision')).toBe(false);

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('task-noaudit'));
    // auditLog intentionally omitted.
    const pool = new LanePool(makeOptions({ taskTracker: tracker, hookRegistry }));

    const result = await pool.run();

    // Backward compat: the pool still completes the task (no crash from the
    // missing auditLog).
    expect(result.completedTasks).toBe(1);
    expect(result.failedTasks).toBe(0);

    // No auditor was registered: neither audit hook gained a subscriber.
    expect(hookRegistry.hasSubscribers('onStructuredOutput')).toBe(false);
    expect(hookRegistry.hasSubscribers('onDecision')).toBe(false);
  });

  // ── (5) Workflow-provided hook + default auditor both fire (fan-out) ─────
  //
  // A workflow that registers its OWN `onStructuredOutput` subscriber BEFORE
  // `run()` sees it fire ALONGSIDE the default auditor (observe = fan-out).
  // Both the custom subscriber and the AuditLog receive the structured output.

  it('(5) fires a workflow-provided onStructuredOutput hook AND the default auditor (fan-out)', async () => {
    const auditLog = makeAuditLog();
    const hookRegistry = makeRegistry();

    // The workflow's own subscriber, registered BEFORE run(). LanePool.run()
    // will add the default auditor ALONGSIDE it.
    const workflowSeen: OnStructuredOutputArgs[] = [];
    hookRegistry.register({
      onStructuredOutput: async (args) => {
        workflowSeen.push(args);
      },
    });
    // Sanity: the workflow subscriber is present before run() registers the auditor.
    expect(hookRegistry.hasSubscribers('onStructuredOutput')).toBe(true);

    mockPromptForStructured.mockResolvedValue({
      result: { approved: true, summary: 'ship it' },
      attempts: 1,
    });

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('task-fanout'));
    const pool = new LanePool(makeOptions({ taskTracker: tracker, auditLog, hookRegistry }));

    await pool.run();

    // Workflow subscriber fired exactly once.
    expect(workflowSeen).toHaveLength(1);
    expect(workflowSeen[0].taskId).toBe('task-fanout');
    expect(workflowSeen[0].output).toEqual({ approved: true, summary: 'ship it' });

    // Default auditor ALSO fired — the AuditLog received the structured_output
    // event. (Proves the auditor was added alongside, not replaced by, the
    // workflow subscriber.)
    const events = await auditLog.getEvents({ type: 'structured_output' });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('structured_output');

    const [event] = events as Extract<AuditEvent, { type: 'structured_output' }>[];
    expect(event.taskId).toBe('task-fanout');
    expect(event.output).toEqual({ approved: true, summary: 'ship it' });
  });
});

// ─── Extra coverage: createDefaultAuditor is the registered subscriber ───────
//
// A focused check that the subscriber LanePool.run() registers for
// `onStructuredOutput` is functionally identical to `createDefaultAuditor` —
// i.e. the pool wires the REAL default auditor, not a stub. This guards
// against a future refactor that swaps in a no-op.

describe('LanePool default auditor — registered subscriber is the real auditor', () => {
  it('appends the structured output to the SAME auditLog instance passed to LanePoolOptions', async () => {
    const auditLog = makeAuditLog();
    const hookRegistry = makeRegistry();

    mockPromptForStructured.mockResolvedValue({ result: { approved: true, marker: 'e2e' }, attempts: 1 });

    const tracker = new TaskTracker();
    tracker.addTask(makeTask('task-same-log'));
    const pool = new LanePool(makeOptions({ taskTracker: tracker, auditLog, hookRegistry }));

    await pool.run();

    // The event landed in the auditLog INSTANCE we passed in (not some other
    // log), proving the registered auditor captured our specific AuditLog.
    const events = await auditLog.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('structured_output');
    expect((events[0] as Extract<AuditEvent, { type: 'structured_output' }>).output).toEqual({
      approved: true,
      marker: 'e2e',
    });
  });
});

// ─── Restore real modules ─────────────────────────────────────────────────

afterAll(() => {
  mock.module('../../core/agent-lifecycle.js', () => realAgentLifecycle);
  mock.module('../../core/structured-output.js', () => realStructuredOutput);
  mock.module('../../pool/prompt-builder.js', () => realPromptBuilder);
  mock.module('../../core/profile.js', () => realProfile);
});
