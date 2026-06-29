import { type EventRecord, type PhaseEntity, type SessionEntity } from './event-types.js';
import { extractSessionIdentity, resolveSession } from './evolve-utils.js';
import { formatDuration, sanitizeDisplayText, stripAnsi } from './text-utils.js';

// ─── Unified event-log line formatter ────────────────────────────────────────
//
// Every "loud" event is rendered as a single line in ONE consistent shape:
//
//   <time> | <Phase> :: <task-id> :: <session> -> <description>
//
// Slots are omitted when they do not apply to the event kind, so a phase event
// renders as `... | Planning -> phase started`, a task event as
// `... | Implementing :: t-12 -> task parked`, and a session event as
// `... | Implementing :: t-12 :: test-reviewer -> session started`.
//
// Slot sources:
//   • time    — metadata.timestamp, formatted as `HH:mm:ssam/pm` (local).
//   • Phase   — metadata.phaseId, resolved to the phase *label* via ctx when
//               available (falls back to the raw id).
//   • task-id — metadata.taskId.
//   • session — resolved from ctx.sessions by agent/task/role/attempt identity
//               (preferring runnerRole, then profile, then agentId).
//
// The context is optional; without it the formatter degrades to raw ids taken
// straight from the event metadata. Both call sites (TUI ClientStore and web
// zustand store) build a ctx from their post-evolve projection so labels and
// session names resolve to human-readable values.

/**
 * Optional projection context used to resolve human-readable phase labels and
 * session display names. Carried by the call sites from their post-evolve
 * projection. Plain data so the formatter stays pure / trivially testable.
 */
export interface WorkflowFormatContext {
  /** Phase entities for phaseId → label resolution. */
  phases?: PhaseEntity[];
  /** Session entities (keyed by session key) for agent identity → name. */
  sessions?: Record<string, SessionEntity>;
}

// ─── Prefix builders ─────────────────────────────────────────────────────────

/** Format an ISO timestamp as `HH:mm:ssam/pm` in the host's local time. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  let h = d.getHours();
  const ampm = h < 12 ? 'am' : 'pm';
  h = h % 12;
  if (h === 0) h = 12;
  const hh = String(h).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}${ampm}`;
}

/** Resolve a phase id to its human-readable label via ctx, falling back to the id. */
function resolvePhaseLabel(ctx: WorkflowFormatContext | undefined, phaseId: string | undefined): string {
  if (phaseId === undefined) return '';
  if (ctx?.phases) {
    const found = ctx.phases.find((p) => p.id === phaseId);
    if (found?.label) return found.label;
  }
  return phaseId;
}

/**
 * Resolve a session display name from ctx.sessions using the event's identity
 * (agentId/taskId/runnerRole/attempt). Prefers `runnerRole`, then `profile`,
 * then `agentId`. Returns '' when no agentId is present at all.
 */
function resolveSessionName(ev: EventRecord, ctx: WorkflowFormatContext | undefined): string {
  const { agentId, taskId, runnerRole, attempt } = extractSessionIdentity(ev);
  if (!agentId) return '';
  if (ctx?.sessions) {
    const resolved = resolveSession(ctx.sessions, agentId, taskId, runnerRole, attempt);
    if (resolved) {
      return resolved.entity.runnerRole || resolved.entity.profile || agentId;
    }
  }
  return agentId;
}

/** Scope categories — each determines which prefix slots apply.
 *  Ordered numerically so `scope >= Scope.Phase` etc. widen the prefix. */
const Scope = { Workflow: 0, Phase: 1, Task: 2, Session: 3 } as const;
type Scope = (typeof Scope)[keyof typeof Scope];

/**
 * Build the `<time> | <Phase> :: <task> :: <session> -> ` prefix for an event,
 * omitting slots that are empty or do not apply to the event's scope. Trailing
 * ` -> ` is included only when a description follows; callers always pass one.
 */
function buildPrefix(ev: EventRecord, ctx: WorkflowFormatContext | undefined, scope: Scope): string {
  const time = formatTimestamp(ev.metadata.timestamp);
  const parts: string[] = [time];

  if (scope >= Scope.Phase) {
    // metadata.phaseId is the canonical source; a few events (notably
    // workflow_failed) carry the phase only in data.phase — fall back to it.
    const phaseId = ev.metadata.phaseId ?? (typeof ev.data.phase === 'string' ? ev.data.phase : undefined);
    const phaseLabel = resolvePhaseLabel(ctx, phaseId);
    if (phaseLabel) parts.push(phaseLabel);
  }
  if (scope >= Scope.Task) {
    const taskId = ev.metadata.taskId;
    if (taskId) parts.push(taskId);
  }
  if (scope >= Scope.Session) {
    const sessionName = resolveSessionName(ev, ctx);
    if (sessionName) parts.push(sessionName);
  }

  return parts.join(' | ') + ' -> ';
}

// ─── Per-event description suffix ────────────────────────────────────────────
// Returns the description text (the part AFTER ` -> `), or `null` when the
// event is intentionally silent in the event log (verbose per-turn / per-tool
// events). The scope for each event is fixed here so the prefix shape matches
// the event semantics rather than whichever metadata fields happen to be set.

function describe(ev: EventRecord): { scope: Scope; text: string } | null {
  const d = ev.data;
  switch (ev.type) {
    // ── Workflow lifecycle (no slots) ──────────────────────────────────────
    case 'workflow_started':
      return {
        scope: Scope.Workflow,
        text: '🚀 workflow started: "' + String(d.taskPrompt ?? '') + '" (resumed: ' + String(d.resumed ?? false) + ')',
      };
    case 'workflow_completed':
      return {
        scope: Scope.Workflow,
        text:
          '🎉 complete in ' +
          (Number(d.totalDurationMs ?? 0) / 1000).toFixed(1) +
          's (' +
          String(d.sessionCount ?? d.agentCount ?? 0) +
          ' sessions)',
      };
    case 'workflow_failed':
      // No metadata.phaseId; pull the failing phase from data.phase so the
      // prefix still names where it died.
      return {
        scope: Scope.Phase,
        text: '💥 failed: ' + String(d.error ?? ''),
      };
    case 'workflow_data_set':
      return { scope: Scope.Workflow, text: '🗄 workflow data set' };

    // ── Phase lifecycle (phase slot) ───────────────────────────────────────
    case 'phase_registered':
      return { scope: Scope.Phase, text: '📝 phase registered' };
    case 'phase_started':
      return { scope: Scope.Phase, text: '📦 phase started (round ' + String(d.round ?? '') + ')' };
    case 'phase_completed':
      return {
        scope: Scope.Phase,
        text: '✅ phase completed (' + (Number(d.durationMs ?? 0) / 1000).toFixed(1) + 's)',
      };

    // ── Task lifecycle (phase + task slots) ───────────────────────────────
    case 'task_registered':
      return { scope: Scope.Task, text: '📋 task registered: "' + stripAnsi(String(d.title ?? '')) + '"' };
    case 'task_started':
      return { scope: Scope.Task, text: '📋 task started: "' + stripAnsi(String(d.title ?? '')) + '"' };
    case 'task_completed':
      return { scope: Scope.Task, text: '✅ task complete' };
    case 'task_rejected':
      return { scope: Scope.Task, text: '❌ task rejected: ' + String(d.reason ?? '') };
    case 'task_parked':
      return { scope: Scope.Task, text: '🅿 task parked' };
    case 'task_unparked':
      return { scope: Scope.Task, text: '▶ task unparked' };

    // ── Session lifecycle (phase + task + session slots) ───────────────────
    case 'session_started':
      return { scope: Scope.Session, text: '⏳ session started (' + String(d.profile ?? '') + ')' };
    case 'session_completed':
      return { scope: Scope.Session, text: '✅ session complete' };
    case 'session_failed':
      return { scope: Scope.Session, text: '💥 session failed: ' + String(d.error ?? '') };

    case 'error':
      return { scope: Scope.Session, text: '⚠️ error: ' + stripAnsi(String(d.error ?? '')) };

    // ── Auto-retry lifecycle (session slot) ────────────────────────────────
    case 'auto_retry_started': {
      const attempt = Number(d.attempt ?? 1);
      const maxAttempts = Number(d.maxAttempts ?? 1);
      const delayMs = Number(d.delayMs ?? 0);
      const delayStr = delayMs > 0 ? ` in ${formatDuration(delayMs)}` : '';
      const errorMessage = sanitizeDisplayText(String(d.errorMessage ?? ''));
      const suffix = errorMessage ? `: ${errorMessage}` : '';
      return { scope: Scope.Session, text: `🔄 retrying (attempt ${attempt}/${maxAttempts})${delayStr}${suffix}` };
    }
    case 'auto_retry_completed': {
      const success = d.success === true;
      if (success) return { scope: Scope.Session, text: '✅ retry succeeded' };
      const finalError = sanitizeDisplayText(String(d.finalError ?? ''));
      return { scope: Scope.Session, text: `❌ retry failed: ${finalError}` };
    }

    case 'agent_rendered':
      return { scope: Scope.Session, text: '🖥 agent rendered (' + String(d.profile ?? '') + ')' };

    // ── Sidebar (no slots) ─────────────────────────────────────────────────
    case 'sidebar_updated':
      if (d.title) return { scope: Scope.Workflow, text: '📌 ' + String(d.title) };
      return null;

    // ── Verbose events — intentionally silent ──────────────────────────────
    // decision, turn_started, turn_ended, tool_call_started, tool_call_ended,
    // log — per-turn / per-tool chatter, filtered from the event log.
    default:
      return null;
  }
}

// ─── Public formatter ────────────────────────────────────────────────────────

/**
 * Map an {@link EventRecord} to a single human-readable event-log line in the
 * unified `<time> | <Phase> :: <task> :: <session> -> <desc>` shape, or `null`
 * for verbose/silent event types that should not appear in the event log.
 *
 * @param ev  The event record.
 * @param ctx Optional projection context for phase-label and session-name
 *            resolution. Without it the formatter degrades to raw ids.
 */
export function formatWorkflowEventLine(ev: EventRecord, ctx?: WorkflowFormatContext): string | null {
  const desc = describe(ev);
  if (desc === null) return null;
  const prefix = buildPrefix(ev, ctx, desc.scope);
  return prefix + desc.text;
}
