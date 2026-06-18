// ────────────────────────────────────────────────────────────────────────────
// ClientStore – workflowEventLog cap removal (companion to client-store.test.ts).
//
// The event-log widget now retains the WHOLE log, so the store-level cap that
// previously truncated `workflowEventLog` at 1000 entries inside
// `ClientStore.applyEvents` had to be removed — otherwise events were silently
// dropped before ever reaching the TUI.
//
// These tests pin the uncapped behavior:
//   • feeding >1000 loud workflow events through `applyEvents` (in batches)
//     yields a `workflowEventLog` whose length EXCEEDS 1000;
//   • nothing is dropped — every loud event is present, including the oldest;
//   • seq ordering is preserved across many batches;
//   • summary-line injection (the workflow_completed two-line aggregate) still
//     appends and is NOT truncated by any cap;
//   • the runLog cap (MAX_RUN_LOG, a separate server-console log) is untouched.
//
// This file is deliberately SEPARATE so a regression that reintroduces the
// cap is caught here with a focused, easy-to-read failure.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'bun:test';

import type { WorkflowEventLogEntry } from '@engin/shared/client-store';
import { ClientStore } from '@engin/shared/client-store';
import type { EventRecord, EventType } from '@engin/shared/event-types';
import { MAX_RUN_LOG } from '@engin/shared/event-types';
import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';

// ── Constants ───────────────────────────────────────────────────────────────

const ISO_NOW = '2026-06-15T00:00:00.000Z';
const OLD_CAP = 1000; // the previous store-level cap that was REMOVED

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build an EventRecord with an explicit seq (no shared mutable counter). */
function ev(type: EventType, data: Record<string, unknown>, seq: number): EventRecord {
  return { seq, type, data, metadata: { timestamp: ISO_NOW } };
}

/**
 * A loud event that always produces exactly one workflowEventLog line.
 * `phase_started` is used so that each event contributes a deterministic
 * single line and folds cleanly through `evolve` at any volume.
 */
function loudEvent(seq: number): EventRecord {
  return ev('phase_started', { phase: `p-${seq}`, round: 1 }, seq);
}

/** All loud workflowEventLog entries for a batch of events (using the shared formatter). */
function loudEntries(events: EventRecord[]): WorkflowEventLogEntry[] {
  return events
    .map((event) => ({ seq: event.seq, line: formatWorkflowEventLine(event) }))
    .filter((e): e is WorkflowEventLogEntry => e.line !== null);
}

// ────────────────────────────────────────────────────────────────────────────
// Cap removal — no truncation beyond 1000
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – workflowEventLog is uncapped (no 1000-entry cap)', () => {
  it('retains MORE than 1000 entries when fed >1000 loud events in batches', () => {
    // Verification scenario from the task: feed >1000 workflow events through
    // ClientStore.applyEvents (in batches) and assert the log length EXCEEDS
    // 1000 (nothing dropped).
    const total = OLD_CAP + 50; // 1050 loud events
    const batchSize = 100;
    const store = new ClientStore();

    let seq = 0;
    for (let batchStart = 0; batchStart < total; batchStart += batchSize) {
      const batch: EventRecord[] = [];
      const batchEnd = Math.min(batchStart + batchSize, total);
      for (let i = batchStart; i < batchEnd; i++) {
        batch.push(loudEvent(++seq));
      }
      store.applyEvents(batch);
    }

    const log = store.getState().workflowEventLog;
    expect(log.length).toBeGreaterThan(OLD_CAP);
    expect(log).toHaveLength(total); // every loud event present
  });

  it('does NOT drop the oldest entry when crossing 1000 (single batch)', () => {
    // Previous behavior dropped seq 1 once the slice window slid past 1000.
    const store = new ClientStore();
    const events: EventRecord[] = [];
    for (let i = 1; i <= OLD_CAP + 1; i++) events.push(loudEvent(i));
    store.applyEvents(events);

    const log = store.getState().workflowEventLog;
    expect(log).toHaveLength(OLD_CAP + 1);
    // Oldest (seq 1) is RETAINED, not dropped.
    expect(log[0].seq).toBe(1);
    expect(log[log.length - 1].seq).toBe(OLD_CAP + 1);
  });

  it('does NOT drop the oldest entry when crossing 1000 (batched)', () => {
    const store = new ClientStore();
    const total = OLD_CAP + 5;
    // Small batches to exercise the accumulation path across the old boundary.
    for (let i = 1; i <= total; i++) {
      store.applyEvents([loudEvent(i)]);
    }

    const log = store.getState().workflowEventLog;
    expect(log).toHaveLength(total);
    expect(log[0].seq).toBe(1); // oldest still present
    expect(log[total - 1].seq).toBe(total);
  });

  it('keeps every loud entry in seq order across many batches', () => {
    const total = OLD_CAP * 2; // 2000 events, well past the old cap
    const batchSize = 37; // odd batch size so the final batch is partial
    const store = new ClientStore();
    const allLoud: EventRecord[] = [];

    let seq = 0;
    for (let batchStart = 0; batchStart < total; batchStart += batchSize) {
      const batch: EventRecord[] = [];
      const batchEnd = Math.min(batchStart + batchSize, total);
      for (let i = batchStart; i < batchEnd; i++) {
        const e = loudEvent(++seq);
        batch.push(e);
        allLoud.push(e);
      }
      store.applyEvents(batch);
    }

    const log = store.getState().workflowEventLog;
    expect(log).toHaveLength(total);
    // Every seq 1..total is present exactly once, in order.
    expect(log.map((e) => e.seq)).toEqual(allLoud.map((e) => e.seq));
    // Cross-check: the lines match the shared formatter for every entry.
    expect(log).toEqual(loudEntries(allLoud));
  });

  it('retains a large volume (5000+) of loud events without truncation', () => {
    const total = 5000;
    const batchSize = 500;
    const store = new ClientStore();

    let seq = 0;
    for (let batchStart = 0; batchStart < total; batchStart += batchSize) {
      const batch: EventRecord[] = [];
      const batchEnd = Math.min(batchStart + batchSize, total);
      for (let i = batchStart; i < batchEnd; i++) batch.push(loudEvent(++seq));
      store.applyEvents(batch);
    }

    expect(store.getState().workflowEventLog).toHaveLength(total);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Summary-line injection survives the cap removal
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – summary lines survive uncapped accumulation', () => {
  it('appends the workflow_completed summary lines after >1000 loud events', () => {
    // Pre-fill the log past the old cap, THEN fire a workflow_completed with a
    // positive totalDurationMs. The two summary lines must still be appended
    // (not truncated by any cap) and keyed to the completed event's seq.
    const store = new ClientStore();
    const fillCount = OLD_CAP + 10;
    const fillEvents: EventRecord[] = [];
    for (let i = 1; i <= fillCount; i++) fillEvents.push(loudEvent(i));
    store.applyEvents(fillEvents);
    expect(store.getState().workflowEventLog).toHaveLength(fillCount);

    const completedSeq = fillCount + 1;
    store.applyEvents([ev('workflow_completed', { totalDurationMs: 4000, agentCount: 0 }, completedSeq)]);

    const log = store.getState().workflowEventLog;
    // fillCount loud lines + 1 completion line + 2 summary lines.
    expect(log).toHaveLength(fillCount + 3);
    expect(log[log.length - 1].seq).toBe(completedSeq);
    expect(log[log.length - 2].seq).toBe(completedSeq);
    expect(log[log.length - 3].seq).toBe(completedSeq);
    // The summary lines themselves (deterministic with 0 agents / 0 tokens).
    expect(log[log.length - 2].line).toBe('📊 Tokens: ↑0 in · ↓0 out');
    expect(log[log.length - 1].line).toBe('⏱ Time: 4.0s total · 0.0s agent (0%)');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runLog cap is OUT OF SCOPE and unchanged (MAX_RUN_LOG still enforced)
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – runLog cap (MAX_RUN_LOG) is unchanged', () => {
  it('still caps runLog at MAX_RUN_LOG (a separate server-console log)', () => {
    // The workflow-event-log cap removal must NOT affect the runLog cap.
    const store = new ClientStore();
    for (let i = 0; i < MAX_RUN_LOG + 50; i++) {
      store.appendRunLog('info', `line-${i}`, ISO_NOW);
    }
    const runLog = store.getState().runLog;
    expect(runLog).toHaveLength(MAX_RUN_LOG);
    // Oldest dropped; first kept entry is line-50.
    expect(runLog[0].message).toBe('line-50');
  });
});
