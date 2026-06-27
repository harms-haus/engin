import type { EventRecord } from './event-types.js';
import { formatDuration, sanitizeDisplayText, stripAnsi } from './text-utils.js';

// ─── Pure Formatter ──────────────────────────────────────────────────────────
// Maps an EventRecord to a human-readable emoji line for the event-log widget.
// Returns `null` for verbose/silent event types that should not appear in the
// event log.

export function formatWorkflowEventLine(ev: EventRecord): string | null {
  const d = ev.data;
  const m = ev.metadata;

  switch (ev.type) {
    // ── Workflow lifecycle ─────────────────────────────────────────────────
    case 'workflow_started':
      return '🚀 Workflow started: "' + String(d.taskPrompt ?? '') + '" (resumed: ' + String(d.resumed ?? false) + ')';

    case 'workflow_completed':
      return (
        '🎉 Complete in ' +
        (Number(d.totalDurationMs ?? 0) / 1000).toFixed(1) +
        's (' +
        String(d.sessionCount ?? 0) +
        ' sessions)'
      );

    case 'workflow_failed':
      return '💥 Failed at ' + String(d.phase ?? '') + ': ' + String(d.error ?? '');

    // ── Phase lifecycle ────────────────────────────────────────────────────
    case 'phase_registered':
      return '📝 Phase registered: ' + String(d.label ?? '');

    case 'phase_started':
      return '📦 Phase: ' + String(d.phase ?? '') + ' (round ' + String(d.round ?? '') + ')';

    case 'phase_completed':
      return '✅ Phase ' + String(d.phase ?? '') + ' done (' + (Number(d.durationMs ?? 0) / 1000).toFixed(1) + 's)';

    // ── Session lifecycle ──────────────────────────────────────────────────
    case 'session_started':
      return '⏳ Session ' + String(d.agentId ?? m.agentId ?? '') + ' started (' + String(d.profile ?? '') + ')';

    case 'session_completed':
      return '✅ Session ' + String(d.agentId ?? m.agentId ?? '') + ' complete';

    // ── Task lifecycle ─────────────────────────────────────────────────────
    case 'task_registered':
      return (
        '📋 Task registered: "' + String(d.title ?? '') + '" (phase: ' + String(d.phaseId ?? m.phaseId ?? '') + ')'
      );

    case 'task_started':
      return '📋 Task ' + String(d.taskId ?? m.taskId ?? '') + ': "' + stripAnsi(String(d.title ?? '')) + '"';

    case 'task_completed':
      return '✅ Task ' + String(d.taskId ?? m.taskId ?? '') + ' complete';

    case 'task_rejected':
      return '❌ Task ' + String(d.taskId ?? m.taskId ?? '') + ' rejected: ' + String(d.reason ?? '');

    // ── Errors ─────────────────────────────────────────────────────────────
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

    // ── Sidebar ────────────────────────────────────────────────────────────
    case 'sidebar_updated':
      if (d.title) {
        return '📌 ' + String(d.title);
      }
      return null;

    // ── Auto-retry lifecycle ────────────────────────────────────────────────
    case 'auto_retry_started': {
      const attempt = Number(d.attempt ?? 1);
      const maxAttempts = Number(d.maxAttempts ?? 1);
      const delayMs = Number(d.delayMs ?? 0);
      const delayStr = delayMs > 0 ? ` in ${formatDuration(delayMs)}` : '';
      const errorMessage = sanitizeDisplayText(String(d.errorMessage ?? ''));
      const suffix = errorMessage ? `: ${errorMessage}` : '';
      return `🔄 Retrying (attempt ${attempt}/${maxAttempts})${delayStr}${suffix}`;
    }

    case 'auto_retry_completed': {
      const success = d.success === true;
      const finalError = sanitizeDisplayText(String(d.finalError ?? ''));
      if (success) {
        return '✅ Retry succeeded';
      }
      return `❌ Retry failed: ${finalError}`;
    }

    // ── Verbose events — no event log line ──────────────────────────────────
    // decision, turn_started, turn_ended, tool_call_started,
    // tool_call_ended — intentionally silent
    default:
      return null;
  }
}
