import type { EventRecord } from '../tracking/event-types.js';
import { stripAnsi } from './theme.js';

// ─── Pure Formatter ──────────────────────────────────────────────────────────
// Maps an EventRecord to a human-readable emoji line for the event-log widget.
// Returns `null` for verbose/silent event types that should not appear in the
// event log.

export function formatWorkflowEventLine(ev: EventRecord): string | null {
  const d = ev.data;
  const m = ev.metadata;

  switch (ev.type) {
    // ── Workflow lifecycle ─────────────────────────────────
    case 'workflow_started':
      return '🚀 Workflow started: "' + String(d.taskPrompt ?? '') + '" (resumed: ' + String(d.resumed ?? false) + ')';

    case 'workflow_completed':
      return (
        '🎉 Complete in ' +
        (Number(d.totalDurationMs ?? 0) / 1000).toFixed(1) +
        's (' +
        String(d.agentCount ?? 0) +
        ' agents)'
      );

    case 'workflow_failed':
      return '💥 Failed at ' + String(d.phase ?? '') + ': ' + String(d.error ?? '');

    // ── Phase lifecycle ──────────────────────────────────
    case 'phase_started':
      return '📦 Phase: ' + String(d.phase ?? '') + ' (round ' + String(d.round ?? '') + ')';

    case 'phase_completed':
      return '✅ Phase ' + String(d.phase ?? '') + ' done (' + (Number(d.durationMs ?? 0) / 1000).toFixed(1) + 's)';

    // ── Agent lifecycle ──────────────────────────────────
    case 'agent_spawned':
      return '⏳ Agent ' + String(d.agentId ?? m.agentId ?? '') + ' spawned (' + String(d.profile ?? '') + ')';

    case 'agent_completed':
      return '✅ Agent ' + String(d.agentId ?? m.agentId ?? '') + ' complete';

    // ── Task lifecycle ───────────────────────────────────
    case 'task_started':
      return '📋 Task ' + String(d.taskId ?? m.taskId ?? '') + ': "' + stripAnsi(String(d.title ?? '')) + '"';

    case 'task_completed':
      return '✅ Task ' + String(d.taskId ?? m.taskId ?? '') + ' complete';

    case 'task_rejected':
      return '❌ Task ' + String(d.taskId ?? m.taskId ?? '') + ' rejected: ' + String(d.reason ?? '');

    // ── Errors ───────────────────────────────────────────
    case 'error':
      return (
        '⚠️ Error in ' +
        String(m.agentId ?? '') +
        ': ' +
        stripAnsi(String(d.error ?? '')) +
        ' (' +
        String(m.phase ?? '') +
        ')'
      );

    // ── Sidebar ──────────────────────────────────────────
    case 'sidebar_updated':
      if (d.title) {
        return '📌 ' + String(d.title);
      }
      return null;

    // ── Verbose events — no event log line ────────────────
    // decision, turn_started, turn_ended, tool_call_started,
    // tool_call_ended, tasks_added, task_step_started — intentionally silent
    default:
      return null;
  }
}
