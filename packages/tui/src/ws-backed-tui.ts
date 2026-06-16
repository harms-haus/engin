import type { ClientStore, ClientStoreState } from '@engin/shared/client-store';
import type { WorkflowProjection } from '@engin/shared/event-types';
import type { Dashboard } from './components/dashboard.js';
import type { EventLog } from './components/event-log.js';

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * WS-backed TUI adapter — the WebSocket-era replacement for the old
 * `createStoreBackedTui` (status-callbacks.ts) pattern. Instead of subscribing
 * to a local in-process `EventStore` driven by `StatusCallbacks`, it subscribes
 * to a `ClientStore` (from `@engin/shared/client-store`): the plain-TS
 * projection store that mirrors what the web client consumes over the
 * WebSocket.
 *
 * On creation AND on every `clientStore` notification the adapter:
 *   1. Drains new entries from `state.workflowEventLog` whose `seq` is greater
 *      than the last seen seq, appending each entry's `line` to `eventLog`.
 *   2. Drains new `state.runLog` entries, appending prefixed lines for `warn`
 *      ("⚠️ " + message) and `error` ("❌ " + message) levels (`info` is silent).
 *   3. Syncs the dashboard from the current projection.
 *   4. Calls `requestRender()`.
 *
 * `dispose()` unsubscribes from the store so no further updates are processed.
 *
 * The event-log line text is produced by `formatWorkflowEventLine` (now in
 * `@engin/shared`); the ClientStore already builds the formatted
 * `workflowEventLog` entries, so this adapter only forwards their `line` text.
 */
export function createWsBackedTui(deps: {
  clientStore: ClientStore;
  eventLog: EventLog;
  dashboard: Dashboard;
  requestRender: () => void;
}): { dispose: () => void } {
  const { clientStore, eventLog, dashboard, requestRender } = deps;

  // Highest workflow-event seq already forwarded to the event log. The
  // ClientStore builds `workflowEventLog` entries (only for "loud" lifecycle
  // events) keyed by the underlying event seq; tracking the max seq seen lets
  // us drain exactly the new entries across batches without duplicates.
  let lastSeq = 0;

  // Number of `runLog` entries already processed. The runLog has no seq, so we
  // advance a cursor over its growing array.
  let lastRunLogCount = 0;

  function process(state: ClientStoreState): void {
    // 1. Drain new workflow event-log entries (seq > lastSeq).
    for (const entry of state.workflowEventLog) {
      if (entry.seq > lastSeq) {
        eventLog.addLine(entry.line);
      }
    }
    // Entries are appended in ascending seq order, so the last entry holds the
    // max seq. Advance the cursor even when no new lines were produced (e.g. a
    // batch of silent events) so subsequent batches don't re-scan.
    if (state.workflowEventLog.length > 0) {
      lastSeq = state.workflowEventLog[state.workflowEventLog.length - 1].seq;
    }

    // 2. Drain new runLog entries (warn/error prefixed; info is silent).
    for (let i = lastRunLogCount; i < state.runLog.length; i++) {
      const entry = state.runLog[i];
      if (entry.level === 'warn') {
        eventLog.addLine('⚠️ ' + entry.message);
      } else if (entry.level === 'error') {
        eventLog.addLine('❌ ' + entry.message);
      }
    }
    lastRunLogCount = state.runLog.length;

    // 3. Sync dashboard from the current projection.
    dashboard.syncFromProjection(toProjection(state));

    // 4. Request a re-render.
    requestRender();
  }

  /** Reconstruct a `WorkflowProjection` from the client store state. */
  function toProjection(state: ClientStoreState): WorkflowProjection {
    return {
      seq: state.seq,
      taskPrompt: state.taskPrompt,
      phases: state.phases,
      currentPhaseId: state.currentPhaseId,
      completedPhaseIds: state.completedPhaseIds,
      tasks: state.tasks,
      agents: state.agents,
      sidebar: state.sidebar,
      status: state.status,
      error: state.error,
      failedPhase: state.failedPhase,
      stats: state.stats,
      runLog: [],
    };
  }

  // Subscribe to store notifications.
  const unsubscribe = clientStore.subscribe((state) => {
    process(state);
  });

  // Process the current state immediately (handles events that were already in
  // the store at creation, e.g. from replay or a pre-populated store).
  process(clientStore.getState());

  return {
    dispose() {
      unsubscribe();
    },
  };
}
