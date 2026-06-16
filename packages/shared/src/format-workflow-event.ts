import type { EventRecord } from './event-types.js';

// ─── Private: stripAnsi ──────────────────────────────────────────────────────
// Inlined copy of the stripAnsi helper from src/tui/theme.ts. The shared
// package must not import from the TUI layer, so we duplicate the two regex
// replacements for ANSI escape sequences here.

function stripAnsi(str: string): string {
  if (!str.includes('\x1b')) return str;
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

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
    case 'phase_registered':
      return '📝 Phase registered: ' + String(d.label ?? '');

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
    case 'task_registered':
      return (
        '📋 Task registered: "' +
        String(d.title ?? '') +
        '" (phase: ' +
        String(d.phaseId ?? m.phaseId ?? '') +
        ', ' +
        String(d.stepCount ?? 0) +
        ' steps)'
      );

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
        String(m.phaseId ?? '') +
        ')'
      );

    // ── Sidebar ──────────────────────────────────────────
    case 'sidebar_updated':
      if (d.title) {
        return '📌 ' + String(d.title);
      }
      return null;

    // ── Step lifecycle ────────────────────────────────────
    case 'step_started':
      return (
        'Step ' +
        String(d.stepIndex ?? m.stepIndex ?? '') +
        ' started: ' +
        String(d.stepName ?? '') +
        ' (task: ' +
        String(d.taskId ?? m.taskId ?? '') +
        ', agent: ' +
        String(d.agentId ?? m.agentId ?? '') +
        ')'
      );

    // ── Verbose events — no event log line ────────────────
    // decision, turn_started, turn_ended, tool_call_started,
    // tool_call_ended, tasks_added — intentionally silent
    default:
      return null;
  }
}
