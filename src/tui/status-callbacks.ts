import type { EventStore } from '../tracking/event-store.js';
import type { EventRecord } from '../tracking/event-types.js';
import type { Dashboard } from './components/dashboard.js';
import type { EventLog } from './components/event-log.js';
import { formatWorkflowEventLine } from './format-workflow-event.js';

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createStoreBackedTui(deps: {
  store: EventStore;
  eventLog: EventLog;
  dashboard: Dashboard;
  requestRender: () => void;
}): { dispose: () => void } {
  const { store, eventLog, dashboard, requestRender } = deps;

  let lastSeq = 0;

  function processNewEvents(): void {
    const newEvents = store.getEventsSince(lastSeq);
    if (newEvents.length === 0) return;

    for (const ev of newEvents) {
      addEventLogLine(ev);
      lastSeq = ev.seq;
    }

    // Sync projection into dashboard widgets
    const projection = store.getProjection();
    dashboard.syncFromProjection(projection);
    requestRender();
  }

  function addEventLogLine(ev: EventRecord): void {
    const line = formatWorkflowEventLine(ev);
    if (line !== null) eventLog.addLine(line);
  }

  // Subscribe to store notifications
  const unsubscribe = store.subscribe(() => {
    processNewEvents();
  });

  // Process any events that were already in the store (e.g. from replay)
  processNewEvents();

  return {
    dispose() {
      unsubscribe();
    },
  };
}
