/**
 * TuiStore — React-bridgeable store that wraps a {@link ClientStore}.
 *
 * Holds all UI-only state (event-log lines, expand/collapse, QR overlay,
 * detach/kill prompt) and owns the session-follow logic with correct
 * `isLogExpanded` awareness — overriding the ClientStore's built-in
 * `reconcileSelection` which always runs session-follow because it is
 * called without an `isLogExpanded` parameter.
 *
 * Exposes a {@link https://react.dev/reference/react/useSyncExternalStore
 * useSyncExternalStore}-compatible interface via `subscribe` / `getVersion`.
 *
 * Design constraint C1 (plan review): because `ClientStore.selectPhase` and
 * `ClientStore.selectTask` call `reconcileSelection(this.state)` WITHOUT
 * `isLogExpanded`, session-follow would ALWAYS run even when the agent log
 * is expanded, resetting the user's expanded session selection. TuiStore
 * therefore owns session-follow with the correct `isLogExpanded` flag and
 * overrides `state.selectedSessionId` after every ClientStore mutation.
 */

import { selectNextSession } from '@engin/shared';
import type { ClientStore, ClientStoreState } from '@engin/shared/client-store';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_EVENT_LOG_LINES = 10000;

// ─── TuiStore ───────────────────────────────────────────────────────────────

export class TuiStore {
  // ── ClientStore reference ──────────────────────────────────────────────
  private readonly clientStore: ClientStore;

  // ── UI-only state (not on ClientStoreState) ────────────────────────────
  private _eventLogLines: string[] = [];
  private _isLogExpanded = false;
  private _qrString: string | null = null;
  private _qrVisible = false;
  private _promptVisible = false;
  private _inspecting = false;
  private _runId: string | undefined;
  private _resolvePause: (() => void) | null = null;

  /**
   * Tracks whether the user explicitly pinned a session via `selectNextSession`
   * (Tab / Shift+Tab). Distinguishes explicit user pinning from implicit pins
   * set by `toggleExpand`. Used by `toggleExpand` to decide whether to clear
   * `userPinnedSession` when collapsing.
   */
  private _sessionPinnedByUser = false;

  // ── useSyncExternalStore interface ────────────────────────────────────
  private _version = 0;
  private readonly _listeners = new Set<() => void>();

  // ── Drain cursors ─────────────────────────────────────────────────────
  /** Highest workflow-event seq already forwarded to eventLogLines. */
  private _lastSeq = 0;
  /** Number of runLog entries already processed. */
  private _lastRunLogCount = 0;
  /**
   * Compact signature of the sessions map, used to detect agent-output
   * updates that do NOT produce a `workflowEventLog` line. Verbose events
   * (text, thinking, tool_call*, turn_*, log, decision) append to
   * `session.log` and mutate token/tool counts but are filtered out of the
   * workflow event log (formatWorkflowEventLine returns null for them), so
   * without this signal those updates would leave `dirty` false and the
   * AgentLog would render stale until some unrelated action notified React.
   */
  private _lastSessionSignature = '';

  // ── Callbacks ─────────────────────────────────────────────────────────
  private readonly _onDetach?: () => void;
  private readonly _onKill?: () => void;

  // ── ClientStore subscription handle ───────────────────────────────────
  private readonly _unsubscribeClientStore: () => void;

  // ── Exposed read-only accessors ───────────────────────────────────────

  get eventLogLines(): string[] {
    return this._eventLogLines;
  }

  get isLogExpanded(): boolean {
    return this._isLogExpanded;
  }

  get qrString(): string | null {
    return this._qrString;
  }

  get qrVisible(): boolean {
    return this._qrVisible;
  }

  get promptVisible(): boolean {
    return this._promptVisible;
  }

  get inspecting(): boolean {
    return this._inspecting;
  }

  set inspecting(val: boolean) {
    this._inspecting = val;
    this._notify();
  }

  get runId(): string | undefined {
    return this._runId;
  }

  get resolvePause(): (() => void) | null {
    return this._resolvePause;
  }

  set resolvePause(val: (() => void) | null) {
    this._resolvePause = val;
    this._notify();
  }

  constructor(clientStore: ClientStore, options?: { onDetach?: () => void; onKill?: () => void }) {
    this.clientStore = clientStore;
    this._onDetach = options?.onDetach;
    this._onKill = options?.onKill;

    // Subscribe to ClientStore notifications — on every projection update
    // (applyEvents, selectPhase, selectTask, snapshot, …) drain new event
    // lines and re-run session-follow with isLogExpanded awareness.
    this._unsubscribeClientStore = clientStore.subscribe(() => {
      this._processStoreUpdate();
    });

    // Process the current state immediately (catches events that were already
    // in the store at construction, e.g. from replay).
    this._processStoreUpdate();
  }

  // ── useSyncExternalStore interface ────────────────────────────────────

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this._version;
  }

  private _notify(): void {
    this._version++;
    for (const listener of this._listeners) {
      listener();
    }
  }

  // ── Internal: process a ClientStore update ───────────────────────────

  /**
   * Called on every ClientStore notification AND once at construction.
   *
   * 1. Drains new `workflowEventLog` entries (seq > lastSeq), pushing each
   *    entry's `line` to `eventLogLines`. Scans from the END of the log to find
   *    the first unseen entry, then iterates only the new tail (O(new) instead
   *    of O(all)) — `workflowEventLog` is ordered by seq ascending.
   * 2. Drains new `runLog` entries (warn→"⚠️ "+message, error→"❌ "+message;
   *    info is silent).
   * 3. Caps `eventLogLines` at MAX_EVENT_LOG_LINES (10 000).
   * 4. Runs the isLogExpanded-aware session-follow, overriding any result left
   *    by the ClientStore's `reconcileSelection` (which runs unconditionally
   *    because it is called without `isLogExpanded`).
   * 5. Notifies React subscribers — BUT only when something actually observable
   *    changed (C2: avoid driving full React-tree re-renders at WebSocket
   *    frequency when no eventLogLines were added and session-follow found no
   *    change). A `dirty` flag is set true only when: new eventLogLines were
   *    pushed, the FIFO cap trimmed lines, or session-follow / expand-pinning
   *    changed `selectedSessionId` / `userPinnedSession`.
   */
  private _processStoreUpdate(): void {
    const state = this.clientStore.getState();
    let dirty = false;

    // 1. Drain workflow event-log entries (O(new) tail scan).
    //
    // workflowEventLog is ordered by seq ascending. Walk backward from the end
    // to find the leftmost index whose seq exceeds the watermark, then drain
    // only that contiguous tail. If the log was trimmed (oldest entries
    // dropped server-side / by ClientStore), the watermark may point past the
    // surviving entries — in that case every visible entry has seq > lastSeq
    // and the scan naturally starts at index 0 (re-draining a few already-seen
    // lines is harmless and bounded by MAX_WORKFLOW_EVENT_LOG).
    const log = state.workflowEventLog;
    if (log.length > 0) {
      let startIdx = log.length;
      for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].seq > this._lastSeq) {
          startIdx = i;
        } else {
          break;
        }
      }
      for (let i = startIdx; i < log.length; i++) {
        this._eventLogLines.push(log[i].line);
        dirty = true;
      }
      this._lastSeq = log[log.length - 1].seq;
    }

    // 2. Drain runLog entries
    //
    // ClientStore.appendRunLog caps runLog at MAX_RUN_LOG=200 by slicing. After a
    // trim, _lastRunLogCount may be >= state.runLog.length (the array was shortened),
    // causing the for-loop to skip all entries and lose warn/error lines. Reset the
    // cursor to 0 when that happens to re-process from the start. This may re-drain
    // a few previously-seen entries but guarantees no data loss (M1 bug fix).
    if (this._lastRunLogCount >= state.runLog.length) {
      this._lastRunLogCount = 0;
    }
    for (let i = this._lastRunLogCount; i < state.runLog.length; i++) {
      const entry = state.runLog[i];
      if (entry.level === 'warn') {
        this._eventLogLines.push('⚠️ ' + entry.message);
        dirty = true;
      } else if (entry.level === 'error') {
        this._eventLogLines.push('❌ ' + entry.message);
        dirty = true;
      }
      // info level is silent
    }
    this._lastRunLogCount = state.runLog.length;

    // 3. Cap event log lines (FIFO: drop oldest)
    if (this._eventLogLines.length > MAX_EVENT_LOG_LINES) {
      this._eventLogLines.splice(0, this._eventLogLines.length - MAX_EVENT_LOG_LINES);
      dirty = true;
    }

    // 4. Run isLogExpanded-aware session-follow, overriding ClientStore's
    //    reconcileSelection result.
    //
    //    When expanded, pin the current selection so future reconcileSelection
    //    calls don't override it (C1 constraint). The reconcileSelection call
    //    that triggered this _processStoreUpdate has already run and may have
    //    changed selectedSessionId — we accept that one-time change (it is
    //    consistent with the Dashboard behaviour of following when the current
    //    selection is null), but we pin it here so subsequent events don't
    //    keep moving the selection while the user is browsing.
    if (this._isLogExpanded) {
      // Pin the current selection to prevent future overrides.
      if (!state.userPinnedSession) {
        (state as ClientStoreState).userPinnedSession = true;
        dirty = true;
      }
    } else {
      const prevSessionId = state.selectedSessionId;
      this._applySessionFollow();
      if (state.selectedSessionId !== prevSessionId) {
        dirty = true;
      }
    }

    // 5. Detect agent-output updates that never produce a workflowEventLog
    //    line. Verbose events (text, thinking, tool_call*, turn_*, log,
    //    decision) append to `session.log` and mutate token/tool counts but
    //    are filtered out of the event log (formatWorkflowEventLine → null).
    //    Without this check those updates leave `dirty` false and the AgentLog
    //    renders stale until an unrelated action (e.g. selecting a task)
    //    notifies React. The signature captures every field the AgentLog /
    //    SessionTabBar render: the session set (uid), log growth (length +
    //    last entry id), and the header counters (toolCallCount, tokens,
    //    contextWindow, status, active).
    const sessions = state.sessions ?? {};
    let sessionSig = '';
    for (const s of Object.values(sessions)) {
      sessionSig +=
        s.uid +
        '|' +
        s.log.length +
        '|' +
        (s.log.at(-1)?.id ?? '') +
        '|' +
        s.toolCallCount +
        '|' +
        s.inputTokens +
        '|' +
        s.outputTokens +
        '|' +
        (s.contextWindow ?? '') +
        '|' +
        (s.status ?? '') +
        '|' +
        (s.active ? 1 : 0) +
        ';';
    }
    if (sessionSig !== this._lastSessionSignature) {
      this._lastSessionSignature = sessionSig;
      dirty = true;
    }

    // 6. Notify React subscribers only when something observable changed (C2).
    if (dirty) {
      this._notify();
    }
  }

  /**
   * Session-follow owned by TuiStore with correct `isLogExpanded` awareness.
   *
   * Replicates the session-follow rule from `reconcileSelection` (projection-
   * helpers.ts) but ALWAYS passes `this._isLogExpanded` as the gate. This
   * overrides whatever `selectedSessionId` the ClientStore's `reconcileSelection`
   * set, because that call does NOT receive `isLogExpanded` and would follow
   * unconditionally.
   *
   * DRIFT NOTE (H3-DRY): this method intentionally re-applies session-follow
   * because `ClientStore.selectPhase` / `selectTask` / `applyEvents` all call
   * `reconcileSelection(state)` WITHOUT the `isLogExpanded` parameter. The
   * shared helper CANNOT be modified (migration §7 forbids touching
   * packages/shared), so the rule is replicated here with one intentional
   * ADDITION: sessions are filtered by BOTH `taskId === selectedTaskId` AND
   * `phaseId === effectivePhaseId`, whereas the shared `reconcileSelection`
   * filters by `taskId` only. The phaseId filter ensures that sessions from
   * other phases are never auto-selected when the user is reviewing a
   * specific phase.
   *
   * Rule: when `selectedTaskId` is set, `!userPinnedSession`, AND
   * `!this._isLogExpanded`, filter sessions by `taskId === selectedTaskId`
   * AND `phaseId === effectivePhaseId`, pick the most-recently-started
   * (greatest `startedAt`), and set `state.selectedSessionId`. When no match,
   * set null.
   *
   * When `userPinnedSession` is true or `isLogExpanded` is true, leave
   * `selectedSessionId` untouched (preserving whatever the user or the
   * ClientStore's reconcileSelection chose).
   */
  private _applySessionFollow(): void {
    const state = this.clientStore.getState();

    if (state.selectedTaskId === null || state.userPinnedSession || this._isLogExpanded) {
      return;
    }

    const effectivePhaseId = state.selectedPhaseId ?? state.currentPhaseId ?? '';
    const taskSessions = state.sessions
      ? Object.values(state.sessions).filter((s) => s.taskId === state.selectedTaskId && s.phaseId === effectivePhaseId)
      : [];

    if (taskSessions.length === 0) {
      // Only override if it actually changes — prevents unnecessary notify
      // amplification from the ClientStore's reconcileSelection.
      if (state.selectedSessionId !== null) {
        (state as ClientStoreState).selectedSessionId = null;
      }
    } else {
      // ISO-8601-Z timestamps are lexicographically sortable, so `>` on the
      // string value gives the most-recently-started (greatest) `startedAt`.
      const mostRecent = taskSessions.reduce((best, s) => ((s.startedAt ?? '') > (best.startedAt ?? '') ? s : best));
      if (state.selectedSessionId !== mostRecent.uid) {
        (state as ClientStoreState).selectedSessionId = mostRecent.uid;
      }
    }
  }

  // ── User action methods ──────────────────────────────────────────────

  /**
   * Select a phase. Delegates to `clientStore.selectPhase` (which runs
   * reconcileSelection internally, including unconditional session-follow),
   * then overrides the session selection with the isLogExpanded-aware result.
   *
   * Design constraint C1: when `isLogExpanded` is true, clientStore's
   * reconcileSelection would unconditionally change selectedSessionId to the
   * most-recent session for the new phase's selected task. TuiStore saves the
   * previous session ID before the call and restores it (or sets null if the
   * session no longer exists in the new phase) when expanded, so that the
   * user's expanded browsing context is preserved.
   */
  selectPhase(id: string | null): void {
    const state = this.clientStore.getState();
    const prevSessionId = state.selectedSessionId;

    this.clientStore.selectPhase(id);
    // ^ clientStore.selectPhase clears userPinnedSession=false, resets
    //   selectedTaskId=null, calls reconcileSelection (unconditional
    //   session-follow), then notify() → _processStoreUpdate which already
    //   re-runs _applySessionFollow (when !isLogExpanded) or pins (when
    //   isLogExpanded). The subscription path handles session-follow, so we
    //   do NOT need to call _applySessionFollow again here (C2 redundancy).

    // H3 desync fix: clientStore.selectPhase cleared userPinnedSession. Mirror
    // that into _sessionPinnedByUser so the two flags stay in lockstep — a
    // stale _sessionPinnedByUser=true would cause toggleExpand to skip pinning.
    this._sessionPinnedByUser = false;

    // C1 override: when expanded, the subscription only pins but does NOT
    // restore the user's previous session selection. Restore it here.
    if (this._isLogExpanded) {
      this._restoreSessionSelection(prevSessionId, state);
    }

    // selectedPhaseId / selectedTaskId changed — notify so React re-renders
    // (the subscription's dirty flag does not track these selection fields).
    this._notify();
  }

  /**
   * Select a task. Delegates to `clientStore.selectTask` (which runs
   * reconcileSelection internally), then overrides session selection.
   *
   * Design constraint C1: same save-and-restore logic as selectPhase.
   */
  selectTask(id: string | null): void {
    const state = this.clientStore.getState();
    const prevSessionId = state.selectedSessionId;

    this.clientStore.selectTask(id);
    // ^ Same as selectPhase: clientStore clears userPinnedSession=false,
    //   calls reconcileSelection (unconditional session-follow), then
    //   notify() → _processStoreUpdate which already re-runs _applySessionFollow.
    //   No need to call _applySessionFollow again here (C2 redundancy).

    // H3 desync fix: mirror the cleared userPinnedSession into
    // _sessionPinnedByUser to prevent stale Tab-pin state.
    this._sessionPinnedByUser = false;

    // C1 override: when expanded, restore the user's previous session.
    if (this._isLogExpanded) {
      this._restoreSessionSelection(prevSessionId, state);
    }

    // selectedTaskId changed — notify so React re-renders.
    this._notify();
  }

  /**
   * Restore a previous session selection after clientStore's reconcileSelection
   * overwrote it. Used when `isLogExpanded` is true to preserve the user's
   * expanded browsing context.
   *
   * If the previous session still exists in the projection (belonging to the
   * current task/phase), restore it and pin it so future reconcileSelection
   * calls won't override. Otherwise set null.
   */
  private _restoreSessionSelection(prevSessionId: string | null, state: ClientStoreState): void {
    if (prevSessionId === null) return;

    const sessionStillExists = state.sessions && Object.values(state.sessions).some((s) => s.uid === prevSessionId);
    if (sessionStillExists) {
      (state as ClientStoreState).selectedSessionId = prevSessionId;
    } else {
      (state as ClientStoreState).selectedSessionId = null;
    }
    // Pin the session so future reconcileSelection calls won't override it
    // while the user is browsing expanded.
    (state as ClientStoreState).userPinnedSession = true;
  }

  /**
   * Cycle to the next/previous session for the selected task.
   *
   * Filters sessions by BOTH `taskId === selectedTaskId` AND
   * `phaseId === effectivePhaseId`, calls the shared `selectNextSession`
   * helper, sets `selectedSessionId` + `userPinnedSession = true` +
   * `sessionPinnedByUser = true`, and notifies.
   */
  selectNextSession(direction: 1 | -1): void {
    const state = this.clientStore.getState();
    const effectivePhaseId = state.selectedPhaseId ?? state.currentPhaseId ?? '';
    const filtered = state.sessions
      ? Object.values(state.sessions).filter((s) => s.taskId === state.selectedTaskId && s.phaseId === effectivePhaseId)
      : [];

    const nextId = selectNextSession(filtered, state.selectedSessionId, direction);
    if (nextId !== null) {
      (state as ClientStoreState).selectedSessionId = nextId;
    }
    (state as ClientStoreState).userPinnedSession = true;
    this._sessionPinnedByUser = true;
    this._notify();
  }

  /**
   * Toggle the agent-log expanded / collapsed state.
   *
   * Manages the `sessionPinnedByUser` flag:
   *   - When EXPANDING and `selectedSessionId !== null` and `!sessionPinnedByUser`:
   *     set `userPinnedSession = true` (implicit pin to prevent session-follow
   *     during expansion).
   *   - When COLLAPSING and `!sessionPinnedByUser`:
   *     set `userPinnedSession = false` (re-enable follow).
   */
  toggleExpand(): void {
    const state = this.clientStore.getState();
    const wasExpanded = this._isLogExpanded;
    this._isLogExpanded = !wasExpanded;

    if (this._isLogExpanded) {
      // Expanding: implicitly pin the current session to prevent
      // ClientStore's reconcileSelection from overriding it.
      if (state.selectedSessionId !== null && !this._sessionPinnedByUser) {
        (state as ClientStoreState).userPinnedSession = true;
      }
    } else {
      // Collapsing: re-enable session-follow if the user never explicitly
      // pinned via Tab.
      if (!this._sessionPinnedByUser) {
        (state as ClientStoreState).userPinnedSession = false;
      }
    }

    this._notify();
  }

  // ── QR overlay ───────────────────────────────────────────────────────

  toggleQr(): void {
    this._qrVisible = !this._qrVisible;
    this._notify();
  }

  setQrString(str: string | null): void {
    this._qrString = str;
    this._notify();
  }

  setQrVisible(visible: boolean): void {
    this._qrVisible = visible;
    this._notify();
  }

  // ── Detach/kill prompt ───────────────────────────────────────────────

  showPrompt(): void {
    this._promptVisible = true;
    this._notify();
  }

  dismissPrompt(): void {
    this._promptVisible = false;
    this._notify();
  }

  invokeDetach(): void {
    this._onDetach?.();
  }

  invokeKill(): void {
    this._onKill?.();
  }

  // ── Event log ────────────────────────────────────────────────────────

  /**
   * Append an arbitrary line to the event log (e.g. for inspector hint
   * messages). Capped at MAX_EVENT_LOG_LINES.
   */
  addEventLogLine(line: string): void {
    this._eventLogLines.push(line);
    if (this._eventLogLines.length > MAX_EVENT_LOG_LINES) {
      this._eventLogLines.splice(0, this._eventLogLines.length - MAX_EVENT_LOG_LINES);
    }
    this._notify();
  }

  // ── Run ID ───────────────────────────────────────────────────────────

  setRunId(id: string | undefined): void {
    this._runId = id;
    this._notify();
  }

  // ── ClientStore access ───────────────────────────────────────────────

  /** Returns the current ClientStore state (read-only projection). */
  getClientStoreState(): ClientStoreState {
    return this.clientStore.getState();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Unsubscribe from the ClientStore. After calling this, the TuiStore will
   * no longer receive projection updates and should be discarded.
   */
  dispose(): void {
    this._unsubscribeClientStore();
  }
}
