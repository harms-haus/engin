import type { EventRecord, WorkflowProjection } from './event-types.js';

// Re-export all state types so the web layer depends on tracking core.
// This file is the single source of truth for the web-facing protocol:
// the web app (`web/src/protocol-types.ts`) re-exports everything here.
export type {
  EventRecord,
  EventType,
  LogEntry,
  PhaseEntity,
  SessionEntity,
  TaskEntity,
  WorkflowProjection,
} from './event-types.js';

// ─── Shared UI value types ──────────────────────────────────────────────────
// NOTE: PhaseDescriptor has been replaced by PhaseEntity (re-exported above).
// Consumers should import PhaseEntity instead.

// ─── Worktree summary ───────────────────────────────────────────────────────
// Shared shape for the worktree identity broadcast to clients. It is carried
// on `RunSummary.worktree` (seen in the `runs` list and `run_started`) AND on
// the terminal `run_complete` / `run_failed` messages.
//
// IMPORTANT: the terminal messages are the AUTHORITATIVE source a client must
// read. The main worktree is set up ASYNCHRONOUSLY by RunExecutor.execute()
// (an LLM branch-slug round-trip happens first), which runs fire-and-forget
// AFTER RunManager.startRun() has already returned — so `run_started` (and the
// initial `runs` entry) is sent BEFORE `handle.summary.worktree` exists. By
// terminal time the worktree is guaranteed to be created (it is wired before
// `workflow.run()` launches), so the terminal broadcast is race-free.

export interface WorktreeSummary {
  /** Absolute path to the worktree directory on disk. */
  worktreePath: string;
  /** Name of the branch checked out in the worktree (e.g. "engin/<slug>"). */
  branchName: string;
  /** The original working directory before switching to the worktree. */
  originalCwd?: string;
}

// ─── RunSummary ─────────────────────────────────────────────────────────────
// A lightweight descriptor for a single run. Used in the active-run list
// (`runs` message) and in `run_started`. Carries just enough to render a
// sidebar entry without the full WorkflowProjection.

export interface RunSummary {
  /** == work-directory name, e.g. "1781118746110-develop". */
  runId: string;
  /** Working directory the run was launched from. */
  cwd: string;
  /** Name of the workflow definition that backs this run. */
  workflowName: string;
  /** The task prompt that seeded the run (may be truncated for display). */
  taskPrompt: string;
  /** High-level lifecycle status of the run. */
  status: 'running' | 'complete' | 'failed';
  /** Phase the run is currently in, if any. */
  currentPhaseId?: string;
  /** ISO 8601 timestamp marking when the run started. */
  startedAt: string;
  /** T33: Worktree info when the run uses a git worktree. */
  worktree?: WorktreeSummary;
}

// ─── Server to Client Messages ──────────────────────────────────────────────
//
// The multi-run protocol tags every projection/event/lifecycle message with
// `runId` so a single connection can fan out to many concurrent runs.
//
//   - `runs`          — the active-run list (sent on subscribe and on change).
//   - `run_started`   — a new run has entered the registry.
//   - `snapshot`      — full WorkflowProjection for a run (connect / resync).
//   - `events`        — batch of raw EventRecords since the last seq for a run.
//   - `run_complete`  / `run_failed` — dedicated top-level run-scoped lifecycle
//     signals (terminal; sent immediately, not coalesced).
//   - `log`           — server-captured runtime console output for a run.
//   - `auth_required` — reserved for future auth enforcement.
//   - `error`         — protocol-level errors (unknown runId, bad message, …).

export type ServerMessage =
  | { type: 'runs'; runs: RunSummary[] }
  | { type: 'run_started'; runId: string; summary: RunSummary }
  | { type: 'snapshot'; runId: string; seq: number; state: WorkflowProjection }
  | { type: 'events'; runId: string; seq: number; events: EventRecord[] }
  | { type: 'run_complete'; runId: string; worktree?: WorktreeSummary }
  | { type: 'run_failed'; runId: string; error: string; phase: string; worktree?: WorktreeSummary }
  | {
      type: 'log';
      runId: string;
      level: 'info' | 'warn' | 'error';
      message: string;
      timestamp: string;
    }
  | { type: 'auth_required' }
  | { type: 'error'; runId?: string; code: string; message: string }
  | {
      type: 'worktree_merge_result';
      runId: string;
      outcome: 'clean' | 'conflicts' | 'resolved' | 'failed' | 'declined';
      cleanupError?: string;
      worktreePath?: string;
      branchName?: string;
      /** Short, safe diagnostic for a 'failed' outcome (e.g. git stderr or
       *  agent-resolution failure reason). Absent on non-failure outcomes. */
      error?: string;
    };

// ─── Client to Server Messages ──────────────────────────────────────────────

export type ClientMessage =
  | { type: 'auth'; token?: string }
  | { type: 'list_runs' }
  | {
      type: 'start_run';
      workflowName: string;
      taskPrompt: string;
      cwd: string;
      workDir?: string;
      apiKeys?: Record<string, string>;
      /** Optional per-run timeout in milliseconds. When set, the run's
       *  AbortController is aborted after this duration, ending the run as
       *  run_failed with a 'Run timed out' message. Unset → no timeout. */
      runTimeoutMs?: number;
    }
  | { type: 'subscribe'; runId: string }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'resync'; runId: string; lastSeq?: number }
  | { type: 'cancel_run'; runId: string }
  | { type: 'worktree_action'; runId: string; action: 'merge' | 'resolve' | 'decline' };

// ─── Type guard ─────────────────────────────────────────────────────────────

export function isServerMessage(data: unknown): data is ServerMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'runs':
    case 'run_started':
    case 'snapshot':
    case 'events':
    case 'run_complete':
    case 'run_failed':
    case 'log':
    case 'auth_required':
    case 'error':
    case 'worktree_merge_result':
      return true;
    default:
      return false;
  }
}
