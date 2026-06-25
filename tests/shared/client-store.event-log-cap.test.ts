// ────────────────────────────────────────────────────────────────────────────
// ClientStore – workflowEventLog cap behavior (companion to client-store.test.ts).
//
// The workflow event log is bounded at MAX_WORKFLOW_EVENT_LOG (10000) so memory
// stays bounded for long-running workflows. Older entries are dropped FIFO once
// the cap is exceeded; the visible window is always smaller, so a bounded
// buffer loses nothing the user can see in practice. The exact boundary
// trimming (10025 events → exactly 10000 retained, oldest dropped) is pinned in
// `tests/shared/max-workflow-event-log.test.ts`, which also verifies the
// constant is the shared single source of truth.
//
// THIS file focuses on the orthogonal behaviors that must hold REGARDLESS of
// the cap value, plus the below-cap (no-drop) retention path:
//   • below the cap (sub-10000 volumes) nothing is dropped — every loud event
//     is present, including the oldest, in seq order across many batches;
//   • summary-line injection (the workflow_completed two-line aggregate) still
//     appends below the cap AND survives when trimming is ACTIVE at the
//     boundary (the newest summary lines are retained, never the dropped tail);
//   • the runLog cap (MAX_RUN_LOG, a separate server-console log) is untouched
//     by the workflow-event-log cap — the two collections are independent.
//
// This file is deliberately SEPARATE so a regression that drops summary lines
// or bleeds the runLog cap is caught here with a focused, easy-to-read failure.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'bun:test';

import type { WorkflowEventLogEntry } from '@engin/shared/client-store';
import { ClientStore } from '@engin/shared/client-store';
import type { EventRecord, EventType } from '@engin/shared/event-types';
import { MAX_RUN_LOG } from '@engin/shared/event-types';
import { formatWorkflowEventLine } from '@engin/shared/format-workflow-event';

// ── Constants ───────────────────────────────────────────────────────────────

const ISO_NOW = '2026-06-15T00:00:00.000Z';

// The workflow-event-log cap. This file characterizes BEHAVIOR (below-cap
// retention, summary-line injection, runLog independence) that holds regardless
// of where the constant is defined, so it uses a local mirror of the value
// rather than importing the shared symbol. The single-source-of-truth export
// (from @engin/shared/event-types) + barrel re-export is verified in
// `tests/shared/max-workflow-event-log.test.ts` and `tests/tracking/event-types.test.ts`.
const CAP = 10000; // mirrors MAX_WORKFLOW_EVENT_LOG

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

/** Feed `total` loud events into the store in batches of `batchSize`. */
function feedLoud(store: ClientStore, total: number, batchSize: number): EventRecord[] {
  const all: EventRecord[] = [];
  let seq = 0;
  for (let batchStart = 0; batchStart < total; batchStart += batchSize) {
    const batch: EventRecord[] = [];
    const batchEnd = Math.min(batchStart + batchSize, total);
    for (let i = batchStart; i < batchEnd; i++) {
      const e = loudEvent(++seq);
      batch.push(e);
      all.push(e);
    }
    store.applyEvents(batch);
  }
  return all;
}

// ────────────────────────────────────────────────────────────────────────────
// Below-cap retention — nothing is dropped while under MAX_WORKFLOW_EVENT_LOG
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – workflowEventLog below-cap retention (no drop under 10000)', () => {
  it('retains every loud event below the cap (>1000 events, batched)', () => {
    // The old web-only cap was 1000; the unified cap is 10000. Volumes above
    // 1000 but well below 10000 must retain everything (the web store's
    // previous 1000 cap is what this guards against regressing).
    const total = 1050;
    const store = new ClientStore();
    feedLoud(store, total, 100);

    const log = store.getState().workflowEventLog;
    expect(log).toHaveLength(total); // every loud event present
  });

  it('keeps the oldest entry below the cap (single batch)', () => {
    const store = new ClientStore();
    const events: EventRecord[] = [];
    for (let i = 1; i <= 1001; i++) events.push(loudEvent(i));
    store.applyEvents(events);

    const log = store.getState().workflowEventLog;
    expect(log).toHaveLength(1001);
    // Oldest (seq 1) is RETAINED, not dropped.
    expect(log[0].seq).toBe(1);
    expect(log[log.length - 1].seq).toBe(1001);
  });

  it('keeps the oldest entry below the cap (one event per batch)', () => {
    const store = new ClientStore();
    const total = 1005;
    // Single-event batches to exercise the accumulation path.
    for (let i = 1; i <= total; i++) {
      store.applyEvents([loudEvent(i)]);
    }

    const log = store.getState().workflowEventLog;
    expect(log).toHaveLength(total);
    expect(log[0].seq).toBe(1); // oldest still present
    expect(log[total - 1].seq).toBe(total);
  });

  it('keeps every loud entry in seq order across many batches (sub-cap volume)', () => {
    const total = 2000; // above the old 1000 cap, below the 10000 cap
    const batchSize = 37; // odd batch size so the final batch is partial
    const store = new ClientStore();
    const allLoud = feedLoud(store, total, batchSize);

    const log = store.getState().workflowEventLog;
    expect(log).toHaveLength(total);
    // Every seq 1..total is present exactly once, in order.
    expect(log.map((e) => e.seq)).toEqual(allLoud.map((e) => e.seq));
    // Cross-check: the lines match the shared formatter for every entry.
    expect(log).toEqual(loudEntries(allLoud));
  });

  it('retains a large sub-cap volume (5000) of loud events without truncation', () => {
    const total = 5000; // half the cap — nothing trimmed
    const store = new ClientStore();
    feedLoud(store, total, 500);

    expect(store.getState().workflowEventLog).toHaveLength(total);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Summary-line injection survives both below-cap and active-trimming paths
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – summary lines survive accumulation and trimming', () => {
  it('appends the workflow_completed summary lines below the cap', () => {
    // Pre-fill the log below the cap, THEN fire a workflow_completed with a
    // positive totalDurationMs. The two summary lines must be appended and
    // keyed to the completed event's seq.
    const store = new ClientStore();
    const fillCount = 1010;
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

  it('retains the newest summary lines when trimming is ACTIVE at the cap boundary', () => {
    // The critical edge case: fill PAST the cap so trimming drops the oldest
    // tail, THEN fire workflow_completed in the SAME overshoot. The three
    // completion/summary entries are the NEWEST, so they must be retained
    // (FIFO drops the oldest, never the just-appended tail).
    const store = new ClientStore();
    const fillCount = CAP + 50;
    const fillEvents: EventRecord[] = [];
    for (let i = 1; i <= fillCount; i++) fillEvents.push(loudEvent(i));
    store.applyEvents(fillEvents);
    // Trimming already engaged: capped exactly at CAP.
    expect(store.getState().workflowEventLog).toHaveLength(CAP);

    const completedSeq = fillCount + 1;
    store.applyEvents([ev('workflow_completed', { totalDurationMs: 4000, agentCount: 0 }, completedSeq)]);

    const log = store.getState().workflowEventLog;
    // Capped at CAP (1 completion + 2 summary appended, 3 oldest loud lines
    // trimmed to keep the total at the cap).
    expect(log).toHaveLength(CAP);
    // The three newest entries are the completion line + 2 summary lines, all
    // keyed to completedSeq.
    expect(log[log.length - 1].seq).toBe(completedSeq);
    expect(log[log.length - 2].seq).toBe(completedSeq);
    expect(log[log.length - 3].seq).toBe(completedSeq);
    expect(log[log.length - 2].line).toBe('📊 Tokens: ↑0 in · ↓0 out');
    expect(log[log.length - 1].line).toBe('⏱ Time: 4.0s total · 0.0s agent (0%)');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runLog cap is independent (MAX_RUN_LOG still enforced, separate collection)
// ────────────────────────────────────────────────────────────────────────────

describe('ClientStore – runLog cap (MAX_RUN_LOG) is independent of the event-log cap', () => {
  it('still caps runLog at MAX_RUN_LOG (a separate server-console log)', () => {
    // The workflow-event-log cap must NOT affect the runLog cap — the two are
    // distinct collections with distinct caps.
    const store = new ClientStore();
    for (let i = 0; i < MAX_RUN_LOG + 50; i++) {
      store.appendRunLog('info', `line-${i}`, ISO_NOW);
    }
    const runLog = store.getState().runLog;
    expect(runLog).toHaveLength(MAX_RUN_LOG);
    // Oldest dropped; first kept entry is line-50.
    expect(runLog[0].message).toBe('line-50');
  });

  it('workflowEventLog cap (10000) and runLog cap (200) are distinct values', () => {
    // Regression guard: the two caps must never be confused or aliased.
    expect(CAP).not.toBe(MAX_RUN_LOG);
    expect(CAP).toBeGreaterThan(MAX_RUN_LOG);
  });
});
