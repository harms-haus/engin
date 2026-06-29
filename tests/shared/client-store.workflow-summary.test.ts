// ────────────────────────────────────────────────────────────────────────────
// ClientStore – workflow-completion summary lines (companion to
// client-store.test.ts).
//
// When a batch of events folded through `ClientStore.applyEvents` contains a
// `workflow_completed` event whose `data.totalDurationMs` is a positive number,
// the store must — AFTER evolving the projection — compute a two-line summary
// via `formatWorkflowSummary(projection.sessions, totalDurationMs)` and append
// each returned line to `workflowEventLog` keyed by the SAME `completed.seq`
// as the completion line itself (so they drain together in the TUI event-log
// pane, which forwards every entry whose seq > lastSeenSeq).
//
// These summary entries flow through the existing `combined` / slice logic
// unchanged (no special-casing of the 1000-entry cap).
//
// Key invariants pinned here:
//   • summary lines appear only when Number(totalDurationMs) > 0;
//   • they are computed from the POST-evolve projection.sessions (so sessions /
//     tokens stamped earlier in the SAME batch are visible);
//   • every summary entry shares the completed event's seq;
//   • they are appended AFTER the per-event lines (completion line first,
//     then the two summary lines);
//   • absent or non-positive totalDurationMs → no summary lines.
//
// NOTE on robustness: expected summary strings are computed by folding the
// same events through the shared `evolve` and calling `formatWorkflowSummary`
// on the result, so these tests stay correct regardless of how `evolve`
// populates agent fields (e.g. startedAt). The only hardcoded strings are the
// '🎉 Complete …' line (deterministic from totalDurationMs + sessionCount) and
// the few cases where startedAt is seeded explicitly via applySnapshot.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'bun:test';

import { ClientStore } from '@engin/shared/client-store';
import type { EventRecord, EventType, SessionEntity, WorkflowProjection } from '@engin/shared/event-types';
import { createInitialProjection } from '@engin/shared/event-types';
import { evolve } from '@engin/shared/evolve';
import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';
import { formatWorkflowSummary } from '@engin/shared/format-workflow-summary';

// ── Helpers ─────────────────────────────────────────────────────────────────

const T0 = '2026-06-15T00:00:00.000Z';
function ts(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

function ev(
  type: EventType,
  data: Record<string, unknown> = {},
  meta: Partial<EventRecord['metadata']> = {},
  seq: number,
): EventRecord {
  return { seq, type, data, metadata: { timestamp: T0, ...meta } };
}

/** Fold `events` through the shared `evolve` from a fresh projection. */
function fold(events: EventRecord[]): WorkflowProjection {
  let p = createInitialProjection();
  for (const event of events) p = evolve(p, event);
  return p;
}

/** Format one event's log line using the POST-evolve projection as ctx
 *  (mirrors what ClientStore.applyEvents does). */
function loudLine(event: EventRecord, projection: WorkflowProjection): string | null {
  return formatWorkflowEventLine(event, { phases: projection.phases, sessions: projection.sessions });
}

/** Map events to their loud workflowEventLog entries (seq + line), ctx-aware. */
function loudEntries(events: EventRecord[]): { seq: number; line: string }[] {
  const projection = fold(events);
  return events
    .map((event) => ({ seq: event.seq, line: loudLine(event, projection) }))
    .filter((e): e is { seq: number; line: string } => e.line !== null);
}

// ────────────────────────────────────────────────────────────────────────────
// Happy path: summary lines appear alongside the completion line
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore.applyEvents — workflow_completed emits summary lines', () => {
  it('appends the two summary lines alongside the completion line', () => {
    const events: EventRecord[] = [
      ev('workflow_started', { taskPrompt: 'summary run', resumed: false }, {}, 1),
      ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1', timestamp: T0 }, 2),
      ev('turn_ended', { tokens: { input: 1200, output: 300 } }, { agentId: 'a1', taskId: 't1' }, 3),
      ev('session_completed', {}, { agentId: 'a1', taskId: 't1', timestamp: ts(30) }, 4),
      ev('workflow_completed', { totalDurationMs: 60000, sessionCount: 1 }, {}, 5),
    ];

    const store = new ClientStore();
    store.applyEvents(events);

    // Expected summary is computed from the post-evolve projection — robust to
    // whatever `evolve` does (or does not) stamp on the agent.
    const projection = fold(events);
    const expectedSummary = formatWorkflowSummary(projection.sessions, 60000).map((line: string) => ({
      seq: 5,
      line,
    }));

    expect(store.getState().workflowEventLog).toEqual([...loudEntries(events), ...expectedSummary]);
    // Two summary lines always (totalDurationMs > 0).
    expect(expectedSummary).toHaveLength(2);
  });

  it('contains the two summary lines plus the existing 🎉 Complete line', () => {
    const events: EventRecord[] = [
      ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1', timestamp: T0 }, 1),
      ev('turn_ended', { tokens: { input: 1200, output: 300 } }, { agentId: 'a1', taskId: 't1' }, 2),
      ev('session_completed', {}, { agentId: 'a1', taskId: 't1', timestamp: ts(30) }, 3),
      ev('workflow_completed', { totalDurationMs: 60000, sessionCount: 1 }, {}, 4),
    ];

    const store = new ClientStore();
    store.applyEvents(events);

    const lines = store.getState().workflowEventLog.map((e) => e.line);
    const summary = formatWorkflowSummary(fold(events).sessions, 60000);

    // The completion line (deterministic from totalDurationMs + sessionCount) …
    const completionLine = loudLine(events[events.length - 1], fold(events))!;
    expect(lines).toContain(completionLine);
    // … plus exactly the two summary lines produced from the projection.
    expect(lines).toContain(summary[0]);
    expect(lines).toContain(summary[1]);
    expect(summary[0].startsWith('📊 Tokens:')).toBe(true);
    expect(summary[1].startsWith('⏱ Time:')).toBe(true);
  });

  it('keys every summary entry with the completed event seq (drains together)', () => {
    const completedSeq = 99;
    const events: EventRecord[] = [
      ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1', timestamp: T0 }, 1),
      ev('session_completed', {}, { agentId: 'a1', taskId: 't1', timestamp: ts(30) }, 2),
      ev('workflow_completed', { totalDurationMs: 60000, sessionCount: 1 }, {}, completedSeq),
    ];

    const store = new ClientStore();
    store.applyEvents(events);

    const atCompletedSeq = store.getState().workflowEventLog.filter((e) => e.seq === completedSeq);
    const summary = formatWorkflowSummary(fold(events).sessions, 60000);

    // The completion line + exactly two summary lines, ALL sharing completedSeq.
    const completionLine = loudLine(events[events.length - 1], fold(events))!;
    expect(atCompletedSeq).toHaveLength(3);
    expect(atCompletedSeq.every((e) => e.seq === completedSeq)).toBe(true);
    expect(atCompletedSeq.map((e) => e.line)).toEqual([completionLine, summary[0], summary[1]]);
  });

  it('appends summary lines AFTER the completion line (ordering)', () => {
    const events: EventRecord[] = [
      ev('workflow_started', { taskPrompt: 'x', resumed: false }, {}, 1),
      ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1', timestamp: T0 }, 2),
      ev('session_completed', {}, { agentId: 'a1', taskId: 't1', timestamp: ts(10) }, 3),
      ev('workflow_completed', { totalDurationMs: 30000, sessionCount: 1 }, {}, 4),
    ];

    const store = new ClientStore();
    store.applyEvents(events);

    const lines = store.getState().workflowEventLog.map((e) => e.line);
    const summary = formatWorkflowSummary(fold(events).sessions, 30000);

    const completionLine = loudLine(events[events.length - 1], fold(events))!;
    const completeIdx = lines.indexOf(completionLine);
    const tokensIdx = lines.indexOf(summary[0]);
    const timeIdx = lines.indexOf(summary[1]);

    expect(completeIdx).toBeGreaterThanOrEqual(0);
    expect(tokensIdx).toBeGreaterThan(completeIdx);
    expect(timeIdx).toBeGreaterThan(tokensIdx);
  });

  it('reflects sessions + tokens spawned in the SAME batch (summary computed post-evolve)', () => {
    // Everything in one batch: the agent and its tokens only exist AFTER evolve.
    // If the summary were (incorrectly) read from the pre-batch state, the
    // agent would be missing and tokens would read 0.
    const events: EventRecord[] = [
      ev('workflow_started', { taskPrompt: 'one-shot', resumed: false }, {}, 1),
      ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1', timestamp: T0 }, 2),
      ev('turn_ended', { tokens: { input: 1200, output: 300 } }, { agentId: 'a1', taskId: 't1' }, 3),
      ev('workflow_completed', { totalDurationMs: 60000, sessionCount: 1 }, {}, 4),
    ];

    const store = new ClientStore();
    store.applyEvents(events);

    const lines = store.getState().workflowEventLog.map((e) => e.line);
    // Tokens accumulated in-batch are visible → '1.2k in · 300 out'.
    expect(lines).toContain('📊 Tokens: ↑1.2k in · ↓300 out');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Agent active time through the store (startedAt seeded via snapshot)
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore.applyEvents — summary reflects agent active time', () => {
  it('sums agent active time when startedAt is present (snapshot) and completedAt lands via event', () => {
    // Seed an agent with startedAt via a server snapshot, then complete it and
    // the workflow via events. agent_completed preserves startedAt and stamps
    // completedAt → the agent has BOTH → 30s active time counted.
    const store = new ClientStore();
    const seedAgent: SessionEntity = {
      uid: 'a1::t1',
      agentId: 'a1',
      profile: 'coder',
      phaseId: 'exec',
      taskId: 't1',
      active: true,
      log: [],
      toolCallCount: 0,
      inputTokens: 1200,
      outputTokens: 300,
      startedAt: T0,
      taskTitle: 'T1',
      runnerRole: 'executor',
      attempt: 1,
    };
    const snapshot: WorkflowProjection = {
      ...createInitialProjection(),
      seq: 10,
      currentPhaseId: 'exec',
      sessions: { 'a1::t1': seedAgent },
    };
    store.applySnapshot(snapshot, 10);

    store.applyEvents([
      ev('session_completed', {}, { agentId: 'a1', taskId: 't1', timestamp: ts(30) }, 11),
      ev('workflow_completed', { totalDurationMs: 60000, sessionCount: 1 }, {}, 12),
    ]);

    const lines = store.getState().workflowEventLog.map((e) => e.line);
    // 30s agent / 60s total → 50%.
    expect(lines).toContain('📊 Tokens: ↑1.2k in · ↓300 out');
    expect(lines).toContain('⏱ Time: 60.0s total · 30.0s session (50%)');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Guards: no summary when totalDurationMs is absent / non-positive
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore.applyEvents — workflow_completed summary guards', () => {
  it('does NOT emit summary lines when totalDurationMs is missing', () => {
    const events: EventRecord[] = [
      ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1', timestamp: T0 }, 1),
      ev('workflow_completed', { sessionCount: 1 }, {}, 2), // no totalDurationMs
    ];

    const store = new ClientStore();
    store.applyEvents(events);

    const lines = store.getState().workflowEventLog.map((e) => e.line);
    const projection = fold(events);
    const expected = events.map((e) => loudLine(e, projection)).filter((l): l is string => l !== null);
    expect(lines).toEqual([...expected]);
    expect(lines.some((l) => l.startsWith('📊 Tokens:'))).toBe(false);
    expect(lines.some((l) => l.startsWith('⏱ Time:'))).toBe(false);
  });

  it('does NOT emit summary lines when totalDurationMs is zero', () => {
    const events: EventRecord[] = [
      ev('session_started', { profile: 'coder' }, { agentId: 'a1', taskId: 't1', timestamp: T0 }, 1),
      ev('workflow_completed', { totalDurationMs: 0, sessionCount: 1 }, {}, 2),
    ];

    const store = new ClientStore();
    store.applyEvents(events);

    const lines = store.getState().workflowEventLog.map((e) => e.line);
    const projection = fold(events);
    const expected = events.map((e) => loudLine(e, projection)).filter((l): l is string => l !== null);
    expect(lines).toEqual([...expected]);
    expect(lines.some((l) => l.startsWith('📊 Tokens:'))).toBe(false);
    expect(lines.some((l) => l.startsWith('⏱ Time:'))).toBe(false);
  });

  it('does NOT emit summary lines when totalDurationMs is negative', () => {
    const events: EventRecord[] = [ev('workflow_completed', { totalDurationMs: -5, sessionCount: 1 }, {}, 1)];

    const store = new ClientStore();
    store.applyEvents(events);

    const lines = store.getState().workflowEventLog.map((e) => e.line);
    // Only the completion line (negative still renders inside it); no summary.
    const projection = fold(events);
    const expected = events.map((e) => loudLine(e, projection)).filter((l): l is string => l !== null);
    expect(lines).toEqual([...expected]);
    expect(lines.some((l) => l.startsWith('📊 Tokens:'))).toBe(false);
  });

  it('emits summary lines even with no sessions when totalDurationMs > 0', () => {
    // The only guard is totalDurationMs > 0; an empty agent set yields 0/0.
    const events: EventRecord[] = [ev('workflow_completed', { totalDurationMs: 3456, sessionCount: 0 }, {}, 1)];

    const store = new ClientStore();
    store.applyEvents(events);

    const projection = fold(events);
    const completionLine = loudLine(events[0], projection)!;
    expect(store.getState().workflowEventLog.map((e) => e.line)).toEqual([
      completionLine,
      '📊 Tokens: ↑0 in · ↓0 out',
      '⏱ Time: 3.5s total · 0.0s session (0%)',
    ]);
  });
});
