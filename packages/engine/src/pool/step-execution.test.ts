// ─── Tests for pool/step-execution.ts — onStructuredOutput audit hook ────────
//
// These tests pin the default-auditor wiring seam introduced by the
// "Wire default auditor" task. The seam is:
//
//   After a STRUCTURED-OUTPUT step resolves (where `structuredResult` is the
//   parsed/validated result), `runStep` fires the `onStructuredOutput` OBSERVE
//   hook via `execCtx.hookRegistry.invokeObserve(...)` — but ONLY when a
//   `hookRegistry` is threaded through StepExecutionContext AND it has at
//   least one subscriber for `onStructuredOutput`.
//
// The default implementation of that hook (`createDefaultAuditor(auditLog)`,
// see hooks/defaults/auditor.ts) appends a `structured_output` event to the
// durable AuditLog. Because the auditor is registered as a hook SUBSCRIBER by
// LanePool (and by the workflow), the structured result is recorded WITHOUT
// any manual `auditLog.append` call in the caller — which is the headline
// behavior the task asks to verify.
//
// Required scenarios:
//   (a) fires onStructuredOutput after a structured step resolves (approved)
//   (b) fires onStructuredOutput even when the structured result is REJECTED
//       (the hook observes every structured result, not just approvals)
//   (c) passes the documented args shape { agentId, output, taskId, phaseId,
//       stepIndex } to invokeObserve
//   (d) does NOT fire when the registry has no onStructuredOutput subscribers
//   (e) does NOT fire when hookRegistry is absent (zero behavior change)
//   (f) END-TO-END: with a real HookRegistry seeded with
//       createDefaultAuditor(auditLog), a structured_output event lands in the
//       durable AuditLog with NO manual auditLog.append in the caller.
//
// NOTE (TDD): these tests are written against the PLANNED hook fire in runStep.
// `hookRegistry` already exists on StepExecutionContext, so the file type-checks
// cleanly today; the behavior tests go GREEN once runStep invokes the observe
// hook after `structuredResult` resolves. Mocks follow the established pattern
// in core/phase-tasks-hooks.test.ts (capture real modules → mock.module →
// static import).

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { z } from 'zod';

import type { AgentProfile, AuditEvent, Task } from '../core/types.js';
import { createDefaultAuditor } from '../hooks/defaults/auditor.js';
import { createHookRegistry } from '../hooks/registry.js';
import type { HookRegistry, OnStructuredOutputArgs } from '../hooks/types.js';
import { AuditLog } from '../tracking/audit-log.js';
import type { StepExecutionContext } from './step-execution.js';
import { runStep } from './step-execution.js';

// ─── Capture real modules before mocking ──────────────────────────────────

const realAgentLifecycle = Object.assign({}, await import('../core/agent-lifecycle.js'));
const realStructuredOutput = Object.assign({}, await import('../core/structured-output.js'));
const realPromptBuilder = Object.assign({}, await import('./prompt-builder.js'));

// ─── Mock dependencies of runStep ──────────────────────────────────────────
//
// mock.module paths are resolved relative to the test file (pool/). runStep
// (also in pool/) imports the same relative specifiers, so the mocks intercept
// its imports: spawnAgent, promptForStructured, and buildPrompt.

const mockSpawnAgent = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../core/agent-lifecycle.js', () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
}));

const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('../core/structured-output.js', () => ({
  promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
  extractJsonFromText: realStructuredOutput.extractJsonFromText,
}));

const mockBuildPrompt = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
mock.module('./prompt-builder.js', () => ({
  buildPrompt: (...args: unknown[]) => mockBuildPrompt(...args),
}));

// ─── Import after mocks ────────────────────────────────────────────────────
//
// `runStep` and `StepExecutionContext` are imported above (after the mock.module
// calls) so the module under test resolves against the mocked deps.

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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Review the plan',
    prompt: 'please review the plan',
    profile: 'reviewer',
    files: [],
    dependencies: [],
    status: 'active',
    phaseId: 'review',
    ...overrides,
  };
}

/** The structured-output Zod schema used by the reviewer step. */
const reviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string().optional(),
}) as unknown as ZodType<unknown>;

/** A structured reviewer step (has a schema → runStep takes the structured path). */
function makeReviewStep() {
  return {
    name: 'review',
    profileId: 'reviewer',
    isReadOnly: true,
    schema: reviewSchema,
    isApproved: (r: unknown) => (r as { approved?: boolean })?.approved === true,
    getFeedback: (r: unknown) => (r as { feedback?: string })?.feedback ?? 'rejected',
  };
}

/** A mock AgentLifecycleHandle with a spyable session. */
function makeMockHandle() {
  const session = {
    prompt: mock(async (_text: string) => {}),
    getLastAssistantText: mock(() => 'assistant-text'),
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

/** Build a StepExecutionContext. `onStatus` is a required key on the type but
 *  nullable; defaulting to `undefined` mirrors runner-utils.test.ts. */
function makeExecCtx(overrides: Partial<StepExecutionContext> = {}): StepExecutionContext {
  return {
    sessionBaseDir: join(tmpdir(), 'step-exec-sessions'),
    cwd: '/tmp/project',
    onStatus: undefined,
    activeSessions: new Set<{ abort(): Promise<void> }>(),
    phaseId: 'review',
    ...overrides,
  };
}

/** Build a REAL HookRegistry with the engine's observe/pipeline hooks declared. */
function makeRegistry(): HookRegistry {
  const reg = createHookRegistry();
  reg.defineHook('beforeStepPrompt', 'pipeline');
  reg.defineHook('onStructuredOutput', 'observe');
  reg.defineHook('onDecision', 'observe');
  return reg;
}

/**
 * Build a mock HookRegistry that records `invokeObserve` calls. `structuredSubs`
 * controls whether `hasSubscribers('onStructuredOutput')` reports subscribers
 * (the gate runStep checks before firing). Used for the "does NOT fire" tests
 * where there is no real subscriber to capture from.
 */
function makeSpyRegistry(structuredSubs: boolean): {
  registry: HookRegistry;
  invokeObserve: ReturnType<typeof mock>;
  hasSubscribers: ReturnType<typeof mock>;
} {
  const invokeObserve = mock(async (_name: unknown, _args: unknown, _ctx: unknown) => {});
  const hasSubscribers = mock((name: string) => {
    if (name === 'onStructuredOutput') return structuredSubs;
    // beforeStepPrompt has no subscribers → runStep uses buildPrompt.
    return false;
  });
  const registry = {
    register: mock(() => {}),
    invokeObserve,
    invokePipeline: mock(async (_n: unknown, init: unknown) => init),
    invokeFirstWins: mock(async () => undefined),
    invokeAllRun: mock(async () => undefined),
    hasSubscribers,
  } as unknown as HookRegistry;
  return { registry, invokeObserve, hasSubscribers };
}

beforeEach(() => {
  mockSpawnAgent.mockReset();
  mockPromptForStructured.mockReset();
  mockBuildPrompt.mockReset();
  // Default: buildPrompt resolves to a fixed prompt (no beforeStepPrompt subs).
  mockBuildPrompt.mockImplementation(async () => 'prompt-text');
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runStep — onStructuredOutput observe hook', () => {
  // ── (a) fires after a structured step resolves (approved) ───────────────

  it('(a) fires onStructuredOutput exactly once after an approved structured result', async () => {
    mockSpawnAgent.mockResolvedValue(makeMockHandle());
    mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });

    const reg = makeRegistry();
    const captured: OnStructuredOutputArgs[] = [];
    reg.register({ onStructuredOutput: async (args) => void captured.push(args) });

    const { result } = await runStep(
      makeTask(),
      makeReviewStep(),
      'reviewer-agent',
      { stepIndex: 1, attempt: 0, execCount: 1 },
      new Map([['reviewer', reviewerProfile]]),
      makeExecCtx({ hookRegistry: reg }),
    );

    // The step is approved (the structured result flowed through unchanged).
    expect(result.type).toBe('approved');
    // And the observe hook fired exactly once.
    expect(captured).toHaveLength(1);
  });

  // ── (b) fires even when the structured result is REJECTED ──────────────

  it('(b) fires onStructuredOutput even when the structured result is rejected', async () => {
    mockSpawnAgent.mockResolvedValue(makeMockHandle());
    mockPromptForStructured.mockResolvedValue({
      result: { approved: false, feedback: 'needs more tests' },
      attempts: 1,
    });

    const reg = makeRegistry();
    const captured: OnStructuredOutputArgs[] = [];
    reg.register({ onStructuredOutput: async (args) => void captured.push(args) });

    const { result } = await runStep(
      makeTask(),
      makeReviewStep(),
      'reviewer-agent',
      { stepIndex: 0, attempt: 0, execCount: 1 },
      new Map([['reviewer', reviewerProfile]]),
      makeExecCtx({ hookRegistry: reg }),
    );

    // Rejection flows through as a StepResult of type 'rejected'.
    expect(result.type).toBe('rejected');
    // The observe hook STILL fired — it observes every structured result.
    expect(captured).toHaveLength(1);
    expect(captured[0].output).toEqual({ approved: false, feedback: 'needs more tests' });
  });

  // ── (c) documented args shape passed to invokeObserve ──────────────────

  it('(c) passes { agentId, output, taskId, phaseId, stepIndex } to the observe hook', async () => {
    mockSpawnAgent.mockResolvedValue(makeMockHandle());
    mockPromptForStructured.mockResolvedValue({ result: { approved: true, score: 9 }, attempts: 1 });

    const reg = makeRegistry();
    const captured: OnStructuredOutputArgs[] = [];
    reg.register({ onStructuredOutput: async (args) => void captured.push(args) });

    await runStep(
      makeTask({ id: 'task-shape' }),
      makeReviewStep(),
      'reviewer-agent',
      { stepIndex: 3, attempt: 0, execCount: 1 },
      new Map([['reviewer', reviewerProfile]]),
      makeExecCtx({ hookRegistry: reg, phaseId: 'review-phase' }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      agentId: 'reviewer-agent',
      output: { approved: true, score: 9 },
      taskId: 'task-shape',
      phaseId: 'review-phase',
      stepIndex: 3,
    });
  });

  // ── (d) does NOT fire when there are no onStructuredOutput subscribers ───

  it('(d) does NOT invoke onStructuredOutput when the registry has no subscribers', async () => {
    mockSpawnAgent.mockResolvedValue(makeMockHandle());
    mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });

    const { registry, invokeObserve } = makeSpyRegistry(/* structuredSubs */ false);

    const { result } = await runStep(
      makeTask(),
      makeReviewStep(),
      'reviewer-agent',
      { stepIndex: 0, attempt: 0, execCount: 1 },
      new Map([['reviewer', reviewerProfile]]),
      makeExecCtx({ hookRegistry: registry }),
    );

    // Step still resolves normally (zero behavior change on the happy path).
    expect(result.type).toBe('approved');
    // But the observe hook was never invoked.
    expect(invokeObserve).not.toHaveBeenCalled();
  });

  // ── (e) does NOT fire when hookRegistry is absent ───────────────────────

  it('(e) does NOT fire any observe hook when hookRegistry is absent', async () => {
    mockSpawnAgent.mockResolvedValue(makeMockHandle());
    mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });

    // No hookRegistry on the execCtx at all.
    const { result } = await runStep(
      makeTask(),
      makeReviewStep(),
      'reviewer-agent',
      { stepIndex: 0, attempt: 0, execCount: 1 },
      new Map([['reviewer', reviewerProfile]]),
      makeExecCtx(),
    );

    // Zero behavior change: the structured step resolves as approved.
    expect(result.type).toBe('approved');
  });

  // ── (f) END-TO-END: structured_output lands in the AuditLog via the ─────
  //         default auditor — NO manual auditLog.append in the caller.

  it('(f) appends a structured_output event to the AuditLog via createDefaultAuditor (no manual append)', async () => {
    // Real AuditLog against a temp dir — assertions read durable on-disk state.
    const logDir = mkdtempSync(join(tmpdir(), 'step-exec-audit-'));
    const auditLog = new AuditLog(logDir);

    try {
      mockSpawnAgent.mockResolvedValue(makeMockHandle());
      mockPromptForStructured.mockResolvedValue({
        result: { approved: true, score: 9, notes: 'looks good' },
        attempts: 1,
      });

      // A real registry seeded with the DEFAULT auditor. LanePool does this in
      // run(); here we do it directly to isolate the runStep seam.
      const reg = makeRegistry();
      reg.register(createDefaultAuditor(auditLog));

      // NO manual auditLog.append here — the only writer is the auditor hook.
      await runStep(
        makeTask({ id: 'task-e2e' }),
        makeReviewStep(),
        'reviewer-agent',
        { stepIndex: 2, attempt: 0, execCount: 1 },
        new Map([['reviewer', reviewerProfile]]),
        makeExecCtx({ hookRegistry: reg, phaseId: 'review-phase' }),
      );

      const events = await auditLog.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('structured_output');

      const [event] = events as Extract<AuditEvent, { type: 'structured_output' }>[];
      expect(event.agentId).toBe('reviewer-agent');
      expect(event.taskId).toBe('task-e2e');
      expect(event.output).toEqual({ approved: true, score: 9, notes: 'looks good' });
      // AuditLog.append stamps the timestamp itself.
      expect(typeof event.timestamp).toBe('string');
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  // ── the structured_output event is queryable by type / taskId ───────────

  it('(f) structured_output event is queryable via getEvents({ type }) and getEventsByTask', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'step-exec-audit-q-'));
    const auditLog = new AuditLog(logDir);

    try {
      mockSpawnAgent.mockResolvedValue(makeMockHandle());
      mockPromptForStructured.mockResolvedValue({ result: { approved: true }, attempts: 1 });

      const reg = makeRegistry();
      reg.register(createDefaultAuditor(auditLog));

      await runStep(
        makeTask({ id: 'task-query' }),
        makeReviewStep(),
        'reviewer-agent',
        { stepIndex: 0, attempt: 0, execCount: 1 },
        new Map([['reviewer', reviewerProfile]]),
        makeExecCtx({ hookRegistry: reg }),
      );

      const byType = await auditLog.getEvents({ type: 'structured_output' });
      expect(byType).toHaveLength(1);
      expect(byType[0].type).toBe('structured_output');

      const byTask = await auditLog.getEventsByTask('task-query');
      expect(byTask).toHaveLength(1);
      expect(byTask[0].type).toBe('structured_output');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

// ─── Non-structured steps do not fire onStructuredOutput ────────────────────

describe('runStep — non-structured steps do not fire onStructuredOutput', () => {
  it('a free-form (no schema) step does NOT fire onStructuredOutput', async () => {
    mockSpawnAgent.mockResolvedValue(makeMockHandle());
    // No schema on the step → runStep takes the free-form prompt path.

    const { registry, invokeObserve } = makeSpyRegistry(/* structuredSubs */ true);

    const { result } = await runStep(
      makeTask(),
      { name: 'implement', profileId: 'reviewer', isReadOnly: false },
      'reviewer-agent',
      { stepIndex: 0, attempt: 0, execCount: 1 },
      new Map([['reviewer', reviewerProfile]]),
      makeExecCtx({ hookRegistry: registry }),
    );

    // Free-form steps are always approved.
    expect(result.type).toBe('approved');
    // onStructuredOutput is only for structured-output steps.
    expect(invokeObserve).not.toHaveBeenCalled();
  });
});

// ─── Restore real modules ─────────────────────────────────────────────────

afterAll(() => {
  mock.module('../core/agent-lifecycle.js', () => realAgentLifecycle);
  mock.module('../core/structured-output.js', () => realStructuredOutput);
  mock.module('./prompt-builder.js', () => realPromptBuilder);
});
