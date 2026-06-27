// ─── Tests for hooks/defaults/auditor.ts (createDefaultAuditor) ─────────────
//
// `createDefaultAuditor(auditLog)` returns an object exposing two OBSERVE hook
// functions wired into a real `AuditLog`:
//
//   onStructuredOutput: async (args) => auditLog.append({ type: 'structured_output', ... })
//   onDecision:         async (args) => auditLog.append({ type: 'decision',         ... })
//
// These are the DEFAULT implementations of the `onStructuredOutput` and
// `onDecision` observe hooks (see hooks/types.ts). They translate their hook
// args into the matching `AuditEvent` variants (see core/types.ts) and append
// them to the durable audit log.
//
// Important shape detail pinned by these tests: `AuditLog.append` takes
// `Omit<AuditEvent, 'timestamp'>` and stamps the timestamp ITSELF, so the hook
// need not supply one — and the appended record always ends up with a real
// timestamp regardless of what the hook passed.
//
// The `structured_output` AuditEvent variant carries ONLY { type, agentId,
// output, taskId?, timestamp } (no phaseId/runnerRole/attempt — those exist on
// the hook args but are intentionally not persisted to the audit event).
// The `decision` variant carries { type, agentId, decision, reasoning,
// taskId?, timestamp }.
//
// Required scenarios (from the task):
//   (a) onStructuredOutput appends a `structured_output` event to the audit log
//   (b) onDecision appends a `decision` event to the audit log
//   (c) the appended events have the correct shape (agentId, output /
//       decision+reasoning, taskId)
//
// Approach: drive a REAL `AuditLog` against a temp directory (mkdtemp under
// os.tmpdir) and read events back via `auditLog.getEvents()` to assert against
// durable, on-disk state — no stubs. The hooks under test never read `ctx`,
// but `ObserveHook` requires one positional ctx arg, so a minimal HookContext
// fixture is supplied (mirrors the makeCtx helper in registry.test.ts).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditEvent } from '../../core/types.js';
import { AuditLog } from '../../tracking/audit-log.js';
import type { HookContext } from '../types.js';
import { createDefaultAuditor } from './auditor.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Minimal HookContext — the hooks under test never read ctx, but the
 *  ObserveHook signature requires one positional argument. */
function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    registry: undefined as unknown as HookContext['registry'],
    cwd: '/repo',
    workDir: '/repo/.engin/work/run-1',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createDefaultAuditor', () => {
  let logDir: string;
  let auditLog: AuditLog;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'auditor-test-'));
    auditLog = new AuditLog(logDir);
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  // ── factory shape ────────────────────────────────────────────────────────

  it('returns an object exposing onStructuredOutput and onDecision functions', () => {
    const auditor = createDefaultAuditor(auditLog);
    expect(typeof auditor.onStructuredOutput).toBe('function');
    expect(typeof auditor.onDecision).toBe('function');
  });

  // ── (a) onStructuredOutput appends a structured_output event ─────────────

  it('(a) onStructuredOutput appends exactly one structured_output event', async () => {
    const auditor = createDefaultAuditor(auditLog);

    await auditor.onStructuredOutput({ agentId: 'agent-1', output: { answer: 42 }, taskId: 'task-9' }, makeCtx());

    const events = await auditLog.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('structured_output');
  });

  // ── (b) onDecision appends a decision event ──────────────────────────────

  it('(b) onDecision appends exactly one decision event', async () => {
    const auditor = createDefaultAuditor(auditLog);

    await auditor.onDecision(
      { agentId: 'reviewer', decision: 'reject', reasoning: 'tests failing', taskId: 'task-9' },
      makeCtx(),
    );

    const events = await auditLog.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('decision');
  });

  // ── (c) appended structured_output event has the correct shape ───────────

  it('(c) structured_output event carries agentId, output and taskId', async () => {
    const auditor = createDefaultAuditor(auditLog);
    const output = { result: 'ok', items: [1, 2, 3] };

    await auditor.onStructuredOutput({ agentId: 'agent-7', output, taskId: 'task-42' }, makeCtx());

    const [event] = (await auditLog.getEvents()) as Extract<AuditEvent, { type: 'structured_output' }>[];
    expect(event.agentId).toBe('agent-7');
    expect(event.output).toEqual(output);
    expect(event.taskId).toBe('task-42');
  });

  // ── (c) appended decision event has the correct shape ────────────────────

  it('(c) decision event carries agentId, decision, reasoning and taskId', async () => {
    const auditor = createDefaultAuditor(auditLog);

    await auditor.onDecision(
      { agentId: 'agent-7', decision: 'escalate', reasoning: 'flaky CI three times', taskId: 'task-42' },
      makeCtx(),
    );

    const [event] = (await auditLog.getEvents()) as Extract<AuditEvent, { type: 'decision' }>[];
    expect(event.agentId).toBe('agent-7');
    expect(event.decision).toBe('escalate');
    expect(event.reasoning).toBe('flaky CI three times');
    expect(event.taskId).toBe('task-42');
  });

  // ── the appended records always carry a timestamp stamped by append ──────

  it('appended structured_output record carries an ISO timestamp stamped by AuditLog.append', async () => {
    const auditor = createDefaultAuditor(auditLog);

    await auditor.onStructuredOutput({ agentId: 'a', output: null }, makeCtx());

    const [event] = await auditLog.getEvents();
    expect(typeof event.timestamp).toBe('string');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('appended decision record carries an ISO timestamp stamped by AuditLog.append', async () => {
    const auditor = createDefaultAuditor(auditLog);

    await auditor.onDecision({ agentId: 'a', decision: 'go', reasoning: 'r' }, makeCtx());

    const [event] = await auditLog.getEvents();
    expect(typeof event.timestamp).toBe('string');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ── optional taskId omitted → absent from the persisted record ───────────
  //
  // The hook maps `taskId: args.taskId` verbatim; when args.taskId is
  // undefined, JSON.stringify drops the key, so the record read back from disk
  // has no taskId at all.

  it('structured_output omits taskId from the record when args.taskId is not provided', async () => {
    const auditor = createDefaultAuditor(auditLog);

    await auditor.onStructuredOutput({ agentId: 'agent-x', output: 'plain' }, makeCtx());

    const [event] = (await auditLog.getEvents()) as Extract<AuditEvent, { type: 'structured_output' }>[];
    expect(event.agentId).toBe('agent-x');
    expect(event.output).toBe('plain');
    expect(event.taskId).toBeUndefined();
  });

  it('decision omits taskId from the record when args.taskId is not provided', async () => {
    const auditor = createDefaultAuditor(auditLog);

    await auditor.onDecision({ agentId: 'agent-x', decision: 'approve', reasoning: 'lgtm' }, makeCtx());

    const [event] = (await auditLog.getEvents()) as Extract<AuditEvent, { type: 'decision' }>[];
    expect(event.agentId).toBe('agent-x');
    expect(event.decision).toBe('approve');
    expect(event.reasoning).toBe('lgtm');
    expect(event.taskId).toBeUndefined();
  });

  // ── preserves arbitrary output payloads ──────────────────────────────────

  it('structured_output preserves an arbitrary JSON payload verbatim', async () => {
    const auditor = createDefaultAuditor(auditLog);
    const output = { nested: { deep: [1, 'two', { flag: true }], n: null }, list: [1, 2, 3] };

    await auditor.onStructuredOutput({ agentId: 'a', output, taskId: 't' }, makeCtx());

    const [event] = (await auditLog.getEvents()) as Extract<AuditEvent, { type: 'structured_output' }>[];
    expect(event.output).toEqual(output);
  });

  // ── both hooks append independently to the same log, order preserved ─────

  it('appends both event types when both hooks fire (order preserved)', async () => {
    const auditor = createDefaultAuditor(auditLog);

    await auditor.onStructuredOutput({ agentId: 'a', output: 1, taskId: 't' }, makeCtx());
    await auditor.onDecision({ agentId: 'a', decision: 'go', reasoning: 'r', taskId: 't' }, makeCtx());

    const events = await auditLog.getEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(['structured_output', 'decision']);
  });

  // ── getEvents filtering by type also reflects the appended events ─────────

  it('appended events are queryable via getEvents({ type })', async () => {
    const auditor = createDefaultAuditor(auditLog);

    await auditor.onStructuredOutput({ agentId: 'a', output: 1, taskId: 't1' }, makeCtx());
    await auditor.onDecision({ agentId: 'a', decision: 'go', reasoning: 'r', taskId: 't2' }, makeCtx());

    const decisions = await auditLog.getEvents({ type: 'decision' });
    const structured = await auditLog.getEvents({ type: 'structured_output' });

    expect(decisions).toHaveLength(1);
    expect(decisions[0].type).toBe('decision');
    expect(structured).toHaveLength(1);
    expect(structured[0].type).toBe('structured_output');
  });
});
