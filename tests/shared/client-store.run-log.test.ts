// ────────────────────────────────────────────────────────────────────────────
// ClientStore – appendRunLog tests (companion to client-store.test.ts).
//
// WHY A SEPARATE FILE
// -------------------
// The task spec is explicit that `ClientStoreState` adds a `workflowEventLog`
// array (built from workflow events via `formatWorkflowEventLine`), but it
// lists `appendRunLog` as a method WITHOUT naming the collection it writes to.
//
// Interpretation adopted here (and pinned by these tests):
//
//   `appendRunLog` serves the protocol's `{ type: 'log'; level; message;
//   timestamp }` server message — i.e. server-captured RUNTIME console output,
//   which is conceptually distinct from the workflow EVENT log. The method
//   name ("RunLog", not "EventLog") and the structured `{ level, message,
//   timestamp }` shape both point to a SEPARATE `runLog` collection rather
//   than overloading `workflowEventLog` (whose entries are seq-keyed
//   `{ seq, line }`).
//
// Therefore this file assumes:
//
//   export interface RunLogEntry {
//     level: 'info' | 'warn' | 'error';
//     message: string;
//     timestamp: string;
//   }
//
//   export interface ClientStoreState extends WorkflowProjection {
//     ...
//     runLog: RunLogEntry[];
//   }
//
//   appendRunLog(level: 'info' | 'warn' | 'error', message: string, timestamp: string): void;
//
// This file is deliberately SEPARATE so that, should the implementation choose
// a different shape/name for the run-log collection, only THIS file fails to
// typecheck — the main `client-store.test.ts` suite (applySnapshot,
// applyEvents, selection, event-log building) remains green and independent.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'bun:test';

import { ClientStore } from '@engin/shared/client-store';

const ISO_NOW = '2026-06-15T00:00:00.000Z';

describe('ClientStore – appendRunLog', () => {
  it('starts with an empty runLog', () => {
    const store = new ClientStore();
    expect(store.getState().runLog).toEqual([]);
  });

  it('appends a structured entry with level / message / timestamp', () => {
    const store = new ClientStore();
    store.appendRunLog('info', 'starting build', ISO_NOW);

    expect(store.getState().runLog).toEqual([{ level: 'info', message: 'starting build', timestamp: ISO_NOW }]);
  });

  it('preserves insertion order across multiple appends', () => {
    const store = new ClientStore();
    store.appendRunLog('info', 'one', '2026-06-15T00:00:01.000Z');
    store.appendRunLog('warn', 'two', '2026-06-15T00:00:02.000Z');
    store.appendRunLog('error', 'three', '2026-06-15T00:00:03.000Z');

    expect(store.getState().runLog).toEqual([
      { level: 'info', message: 'one', timestamp: '2026-06-15T00:00:01.000Z' },
      { level: 'warn', message: 'two', timestamp: '2026-06-15T00:00:02.000Z' },
      { level: 'error', message: 'three', timestamp: '2026-06-15T00:00:03.000Z' },
    ]);
  });

  it('notifies listeners on every append', () => {
    const store = new ClientStore();
    const calls: number[] = [];
    store.subscribe(() => calls.push(1));

    store.appendRunLog('info', 'a', ISO_NOW);
    store.appendRunLog('error', 'b', ISO_NOW);

    expect(calls).toHaveLength(2);
  });

  it('does not affect the projection or workflowEventLog', () => {
    const store = new ClientStore();
    store.applyEvents([
      { seq: 1, type: 'workflow_started', data: { taskPrompt: 'x' }, metadata: { timestamp: ISO_NOW } },
    ]);
    const seqBefore = store.getState().seq;
    const eventLogBefore = store.getState().workflowEventLog.length;

    store.appendRunLog('info', 'runtime line', ISO_NOW);

    const s = store.getState();
    expect(s.seq).toBe(seqBefore); // projection untouched
    expect(s.workflowEventLog).toHaveLength(eventLogBefore); // event log untouched
  });
});
