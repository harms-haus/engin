/**
 * Plain-TS projection store for the TUI.
 *
 * Ports the core logic from `web/src/store/workflow-store.ts` into a
 * framework-free class — no zustand, no React, no Immer. The TUI (and any
 * other non-React consumer) subscribes to this store and reads a
 * `ClientStoreState` projection that mirrors the web store's shape but uses
 * the shared `WorkflowProjection` field names directly (`agents`, `tasks`,
 * … rather than the web store's `agentsById` / `tasksById`).
 *
 * Event folding is delegated to the shared `evolve` reducer and event-log
 * lines are produced via `formatWorkflowEventLine`.
 */

import type { EventRecord, WorkflowProjection } from './event-types.js';
import { createInitialProjection, MAX_RUN_LOG } from './event-types.js';
import { evolve } from './evolve.js';
import { formatWorkflowEventLine } from './format-workflow-event.js';
import { reconcileSelection, toProjection, writeProjectionToState } from './projection-helpers.js';

const MAX_WORKFLOW_EVENT_LOG = 1000;

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
  selectedStepIndex: number | null;
  userPinnedPhase: boolean;
  userPinnedStep: boolean;
};

// ─── Helpers ────────────────────────────────────────────────────────────────
// capAgentLogs / toProjection / writeProjectionToState / reconcileSelection
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
      selectedStepIndex: null,
      userPinnedPhase: false,
      userPinnedStep: false,
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

    // Build workflow-level event lines from this batch.
    const collected: WorkflowEventLogEntry[] = [];
    for (const event of events) {
      const line = formatWorkflowEventLine(event);
      if (line !== null) {
        collected.push({ seq: event.seq, line });
      }
    }
    if (collected.length > 0) {
      const combined = [...this.state.workflowEventLog, ...collected];
      this.state.workflowEventLog = combined.slice(combined.length - MAX_WORKFLOW_EVENT_LOG);
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
    // Reset task/step when phase changes.
    this.state.selectedTaskId = null;
    this.state.selectedStepIndex = null;
    this.state.userPinnedStep = false;
    // Run follow rules to settle on an initial task/step.
    reconcileSelection(this.state);
    this.notify();
  }

  selectTask(id: string | null): void {
    this.state.selectedTaskId = id;
    this.state.selectedStepIndex = null;
    this.state.userPinnedStep = false;
    // Run follow rules to settle on an initial step.
    reconcileSelection(this.state);
    this.notify();
  }

  selectStep(index: number | null): void {
    this.state.selectedStepIndex = index;
    this.state.userPinnedStep = true;
    this.notify();
  }
}
