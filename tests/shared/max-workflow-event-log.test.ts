// ────────────────────────────────────────────────────────────────────────────
// MAX_WORKFLOW_EVENT_LOG — consolidated shared constant.
//
// BACKGROUND
// ----------
// `MAX_WORKFLOW_EVENT_LOG` was previously defined independently in two places
// with DIVERGENT values:
//
//   • packages/shared/src/client-store.ts  → const MAX_WORKFLOW_EVENT_LOG = 10000
//   • packages/web/src/store/workflow-store.ts → const MAX_WORKFLOW_EVENT_LOG = 1000
//
// That meant the web client retained 10× fewer event-log entries than the TUI
// for the same workflow. The refactor consolidates the constant into
// `@engin/shared/event-types` (alongside `MAX_RUN_LOG`) with the unified value
// 10000, and both stores import it from there.
//
// WHAT THESE TESTS PIN
// --------------------
//   1. The constant is exported from its canonical home
//      (`@engin/shared/event-types`) AND re-exported through the package
//      barrel (`@engin/shared`) — single source of truth.
//   2. Its value is 10000 (the larger of the two previous caps).
//   3. The TUI `ClientStore` actually caps `workflowEventLog` at exactly this
//      shared constant value (behavior ↔ constant consistency). This is the
//      characterization that proves the TUI keeps its 10000-entry scroll-back
//      before AND after switching to the imported constant.
//
// The web WorkflowStore cap is covered by the vitest suite in
// `packages/web/src/store/workflow-store.test.ts`.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'bun:test';

import { ClientStore } from '@engin/shared/client-store';
import type { EventRecord, EventType } from '@engin/shared/event-types';
import { MAX_RUN_LOG, MAX_WORKFLOW_EVENT_LOG } from '@engin/shared/event-types';
// Barrel re-export — must resolve to the SAME value.
import { MAX_WORKFLOW_EVENT_LOG as BARREL_MAX } from '@engin/shared';

const ISO_NOW = '2026-06-15T00:00:00.000Z';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A "loud" event that always yields exactly one workflowEventLog line. */
function loudEvent(seq: number): EventRecord {
  const e: EventRecord = {
    seq,
    type: 'phase_started' as EventType,
    data: { phase: `p-${seq}`, round: 1 },
    metadata: { timestamp: ISO_NOW },
  };
  return e;
}

// ── Constant: canonical export + barrel re-export ──────────────────────────

describe('MAX_WORKFLOW_EVENT_LOG – consolidated shared constant', () => {
  it('is exported from @engin/shared/event-types as 10000', () => {
    expect(typeof MAX_WORKFLOW_EVENT_LOG).toBe('number');
    expect(MAX_WORKFLOW_EVENT_LOG).toBe(10000);
  });

  it('is re-exported through the @engin/shared barrel at the same value', () => {
    expect(BARREL_MAX).toBe(MAX_WORKFLOW_EVENT_LOG);
    expect(BARREL_MAX).toBe(10000);
  });

  it('is the unified (larger) cap — strictly greater than the old web cap of 1000', () => {
    // The web store previously used 1000; the unified value must preserve the
    // more generous TUI scroll-back rather than shrinking it.
    expect(MAX_WORKFLOW_EVENT_LOG).toBeGreaterThan(1000);
  });

  it('is distinct from MAX_RUN_LOG (a separate server-console log cap)', () => {
    expect(MAX_WORKFLOW_EVENT_LOG).not.toBe(MAX_RUN_LOG);
    expect(MAX_WORKFLOW_EVENT_LOG).toBeGreaterThan(MAX_RUN_LOG);
  });
});

// ── Behavior ↔ constant consistency (TUI ClientStore) ──────────────────────

describe('ClientStore – workflowEventLog cap tracks MAX_WORKFLOW_EVENT_LOG', () => {
  it('retains exactly MAX_WORKFLOW_EVENT_LOG entries when fed more, dropping oldest (FIFO)', () => {
    const CAP = MAX_WORKFLOW_EVENT_LOG;
    const OVER = CAP + 25;
    const store = new ClientStore();
    const events: EventRecord[] = [];
    for (let i = 1; i <= OVER; i++) events.push(loudEvent(i));
    store.applyEvents(events);

    const log = store.getState().workflowEventLog;
    // Capped exactly at the shared constant.
    expect(log).toHaveLength(CAP);
    // Oldest retained entry is the (OVER - CAP + 1)-th; earlier ones dropped.
    expect(log[0].seq).toBe(OVER - CAP + 1);
    // Newest entry is retained.
    expect(log[CAP - 1].seq).toBe(OVER);
  });

  it('does NOT trim when at or below MAX_WORKFLOW_EVENT_LOG (batched accumulation)', () => {
    // Feed in small batches up to exactly the cap; nothing should be dropped.
    const CAP = MAX_WORKFLOW_EVENT_LOG;
    const store = new ClientStore();
    for (let i = 1; i <= CAP; i++) {
      store.applyEvents([loudEvent(i)]);
    }
    expect(store.getState().workflowEventLog).toHaveLength(CAP);
    expect(store.getState().workflowEventLog[0].seq).toBe(1);
  });

  it('caps across many batches (trim happens per-batch, not just single-batch)', () => {
    const CAP = MAX_WORKFLOW_EVENT_LOG;
    const TOTAL = CAP + 50;
    const BATCH = 100;
    const store = new ClientStore();

    let seq = 0;
    for (let start = 0; start < TOTAL; start += BATCH) {
      const batch: EventRecord[] = [];
      const end = Math.min(start + BATCH, TOTAL);
      for (let i = start; i < end; i++) batch.push(loudEvent(++seq));
      store.applyEvents(batch);
    }

    const log = store.getState().workflowEventLog;
    expect(log).toHaveLength(CAP);
    // Oldest retained = TOTAL - CAP + 1; the first 50 entries were trimmed.
    expect(log[0].seq).toBe(TOTAL - CAP + 1);
    expect(log[CAP - 1].seq).toBe(TOTAL);
  });
});
