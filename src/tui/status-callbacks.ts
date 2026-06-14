import type { EventStore } from '../tracking/event-store.js';
import type { EventRecord } from '../tracking/event-types.js';
import type { Dashboard } from './components/dashboard.js';
import type { EventLog } from './components/event-log.js';
import { stripAnsi } from './theme.js';

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
    const d = ev.data;
    const m = ev.metadata;

    switch (ev.type) {
      // ── Workflow lifecycle ─────────────────────────────────
      case 'workflow_started':
        eventLog.addLine(
          '🚀 Workflow started: "' + String(d.taskPrompt ?? '') + '" (resumed: ' + String(d.resumed ?? false) + ')',
        );
        break;

      case 'workflow_completed':
        eventLog.addLine(
          '🎉 Complete in ' +
            (Number(d.totalDurationMs ?? 0) / 1000).toFixed(1) +
            's (' +
            String(d.agentCount ?? 0) +
            ' agents)',
        );
        break;

      case 'workflow_failed':
        eventLog.addLine('💥 Failed at ' + String(d.phase ?? '') + ': ' + String(d.error ?? ''));
        break;

      // ── Phase lifecycle ──────────────────────────────────
      case 'phase_started':
        eventLog.addLine('📦 Phase: ' + String(d.phase ?? '') + ' (round ' + String(d.round ?? '') + ')');
        break;

      case 'phase_completed':
        eventLog.addLine(
          '✅ Phase ' + String(d.phase ?? '') + ' done (' + (Number(d.durationMs ?? 0) / 1000).toFixed(1) + 's)',
        );
        break;

      // ── Agent lifecycle ──────────────────────────────────
      case 'agent_spawned':
        eventLog.addLine(
          '⏳ Agent ' + String(d.agentId ?? m.agentId ?? '') + ' spawned (' + String(d.profile ?? '') + ')',
        );
        break;

      case 'agent_completed':
        eventLog.addLine('✅ Agent ' + String(d.agentId ?? m.agentId ?? '') + ' complete');
        break;

      // ── Task lifecycle ───────────────────────────────────
      case 'task_started':
        eventLog.addLine(
          '📋 Task ' + String(d.taskId ?? m.taskId ?? '') + ': "' + stripAnsi(String(d.title ?? '')) + '"',
        );
        break;

      case 'task_completed':
        eventLog.addLine('✅ Task ' + String(d.taskId ?? m.taskId ?? '') + ' complete');
        break;

      case 'task_rejected':
        eventLog.addLine('❌ Task ' + String(d.taskId ?? m.taskId ?? '') + ' rejected: ' + String(d.reason ?? ''));
        break;

      // ── Errors ───────────────────────────────────────────
      case 'error':
        eventLog.addLine(
          '⚠️ Error in ' +
            String(m.agentId ?? '') +
            ': ' +
            stripAnsi(String(d.error ?? '')) +
            ' (' +
            String(m.phase ?? '') +
            ')',
        );
        break;

      // ── Sidebar ──────────────────────────────────────────
      case 'sidebar_updated':
        if (d.title) {
          eventLog.addLine('📌 ' + String(d.title));
        }
        break;

      // ── Verbose events — no event log line ────────────────
      // decision, turn_started, turn_ended, tool_call_started,
      // tool_call_ended, tasks_added, task_step_started — intentionally silent
      default:
        break;
    }
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
