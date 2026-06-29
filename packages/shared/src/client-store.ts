/**
 * Plain-TS projection store for the TUI.
 *
 * Ports the core logic from `web/src/store/workflow-store.ts` into a
 * framework-free class — no zustand, no React, no Immer. The TUI (and any
 * other non-React consumer) subscribes to this store and reads a
 * `ClientStoreState` projection that mirrors the web store's shape but uses
 * the shared `WorkflowProjection` field names directly (`sessions`, `tasks`,
 * … rather than the web store's `sessionsById` / `tasksById`).
 *
 * Event folding is delegated to the shared `evolve` reducer and event-log
 * lines are produced via `formatWorkflowEventLine`.
 */

import type { EventRecord, TaskStatus, WorkflowProjection } from './event-types.js';
import { createInitialProjection, MAX_RUN_LOG, MAX_WORKFLOW_EVENT_LOG } from './event-types.js';
import { evolve } from './evolve.js';
import { formatWorkflowEventLine } from './format-workflow-event.js';
import { formatWorkflowSummary } from './format-workflow-summary.js';
import { reconcileSelection, toProjection, writeProjectionToState } from './projection-helpers.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowEventLogEntry {
  seq: number;
  line: string;
}

/**
 * Server-captured runtime console output, distinct from the workflow event
 * log. Populated via `appendRunLog` (the `{ type: 'log' }` server message)
 * rather than through `applyEvents`.
 */
export interface RunLogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

export type ClientStoreState = Omit<WorkflowProjection, 'runLog'> & {
  /** Runtime console output (RunLogEntry[]), overriding the projection's LogEntry[]. */
  runLog: RunLogEntry[];
  workflowEventLog: WorkflowEventLogEntry[];
  selectedPhaseId: string | null;
  selectedTaskId: string | null;
  selectedSessionId: string | null;
  userPinnedPhase: boolean;
  userPinnedSession: boolean;
  /**
   * Previous-state fields populated by the shared `reconcileSelection`
   * write-back on every call so the NEXT call can detect a phase / task-status
   * transition. Mirrors the web WorkflowStoreState's two prev-tracking
   * fields.
   */
  prevCurrentPhaseId: string | null;
  prevSelectedTaskStatus: TaskStatus | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────
// capSessionLogs / toProjection / writeProjectionToState / reconcileSelection
// live in ./projection-helpers.js (shared with web workflow-store).

// ─── Store ──────────────────────────────────────────────────────────────────

export class ClientStore {
  private state: ClientStoreState;
  private listeners = new Set<(s: ClientStoreState) => void>();

  constructor() {
    this.state = {
      ...createInitialProjection(),
      runLog: [],
      workflowEventLog: [],
      selectedPhaseId: null,
      selectedTaskId: null,
      selectedSessionId: null,
      userPinnedPhase: false,
      userPinnedSession: false,
      prevCurrentPhaseId: null,
      prevSelectedTaskStatus: null,
    };
  }

  getState(): ClientStoreState {
    return this.state;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: (s: ClientStoreState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const state = this.state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  /** Full projection replace from a server snapshot. */
  applySnapshot(snapshot: WorkflowProjection, seq: number): void {
    writeProjectionToState(this.state, snapshot, /* fromSnapshot */ true);
    // Only clear the event log on a genuine fresh start (first connect) or
    // server reset (seq went backwards). On reconnection, preserve accumulated
    // event lines — they are immutable seq-keyed facts.
    if (this.state.seq === 0 || seq < this.state.seq) {
      this.state.workflowEventLog = [];
    }
    this.state.seq = seq;
    reconcileSelection(this.state);
    this.notify();
  }

  /** Fold a batch of events through the shared `evolve` reducer. */
  applyEvents(events: EventRecord[]): void {
    if (events.length === 0) return;

    let projection = toProjection(this.state);
    for (const event of events) {
      projection = evolve(projection, event);
    }
    writeProjectionToState(this.state, projection);
    this.state.seq = projection.seq;
    reconcileSelection(this.state);

    // Build workflow-level event lines from this batch. The ctx is built
    // from the POST-evolve projection so phase labels resolve to their
    // human-readable form and session names resolve to runnerRole/profile
    // (rather than the raw scheduler-<id> agentId).
    const ctx = { phases: this.state.phases, sessions: this.state.sessions };
    const collected: WorkflowEventLogEntry[] = [];
    for (const event of events) {
      const line = formatWorkflowEventLine(event, ctx);
      if (line !== null) {
        collected.push({ seq: event.seq, line });
      }
    }
    // Workflow-completion summary: AFTER the per-event lines (so the '🎉
    // Complete …' line precedes the two summary lines), compute a two-line
    // aggregate from the POST-evolve projection.sessions (so sessions / tokens
    // stamped earlier in this same batch are visible). Every summary entry
    // shares the completed event's seq so they drain together in the TUI
    // event-log pane. Only emitted when totalDurationMs is a positive number.
    const completed = events.find((e) => e.type === 'workflow_completed');
    if (completed && Number(completed.data.totalDurationMs) > 0) {
      for (const line of formatWorkflowSummary(projection.sessions, Number(completed.data.totalDurationMs))) {
        collected.push({ seq: completed.seq, line });
      }
    }
    if (collected.length > 0) {
      // Append in place rather than spreading the whole log into a new array
      // (the spread-and-reassign allocated/copied O(N) entries on every
      // batch — O(N²) summed across a long workflow). Downstream consumers
      // drain new entries by seq watermark on every `notify()`, so the same
      // array reference being mutated is fine.
      this.state.workflowEventLog.push(...collected);
      // Bounded retention: trim the oldest entries (FIFO) once the cap is
      // exceeded so memory stays bounded. Trimmed entries have already been
      // drained by downstream seq-watermark consumers, so the same mutated
      // array reference stays consistent. Slicing in place preserves the
      // array-reference contract above.
      const over = this.state.workflowEventLog.length - MAX_WORKFLOW_EVENT_LOG;
      if (over > 0) {
        this.state.workflowEventLog.splice(0, over);
      }
    }

    this.notify();
  }

  setStatus(status: 'running' | 'complete' | 'failed'): void {
    this.state.status = status;
    this.notify();
  }

  setFailed(error: string, failedPhase: string): void {
    this.state.status = 'failed';
    this.state.error = error;
    this.state.failedPhase = failedPhase;
    this.notify();
  }

  /** Append a runtime console line (server `{ type: 'log' }` message). */
  appendRunLog(level: 'info' | 'warn' | 'error', message: string, timestamp: string): void {
    this.state.runLog.push({ level, message, timestamp });
    if (this.state.runLog.length > MAX_RUN_LOG) {
      this.state.runLog = this.state.runLog.slice(this.state.runLog.length - MAX_RUN_LOG);
    }
    this.notify();
  }

  selectPhase(id: string | null): void {
    this.state.selectedPhaseId = id;
    // Pinned if a completed phase is explicitly selected.
    this.state.userPinnedPhase = id !== null && this.state.completedPhaseIds.includes(id);
    // Reset task when phase changes.
    this.state.selectedTaskId = null;
    this.state.userPinnedSession = false;
    // Run follow rules to settle on an initial task/session.
    reconcileSelection(this.state);
    this.notify();
  }

  selectTask(id: string | null): void {
    this.state.selectedTaskId = id;
    this.state.userPinnedSession = false;
    // Run follow rules to settle selection.
    reconcileSelection(this.state);
    this.notify();
  }
}
