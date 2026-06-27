# Event store & status

engin's status model is **event-sourced**. Instead of mutating a state object
directly, every status change is recorded as an append-only `EventRecord`, and an
in-memory `WorkflowProjection` is derived by replaying those events through the pure
`evolve()` reducer.

The `EventStore` lives **inside the server** (one per run, in
`packages/engine/src/tracking/`). Clients never touch an `EventStore` directly —
they receive run-scoped `snapshot` / `events` / `run_complete` / `run_failed` /
`log` messages over WebSocket and rebuild their own projection through the **shared**
`evolve` reducer (`packages/shared/src/evolve.ts`, which dispatches to per-domain
handler modules).

```
 SERVER (one EventStore per run)              CLIENTS (TUI ClientStore / web zustand)
 EventStore ──append──► events.jsonl (durable)
        │                       │
        │  evolve()             │ replay on resume
        ▼                       ▼
   WorkflowProjection ◄──────── rebuild
        │
        └─► StatusBridge ──► WebSocket (runId-tagged) ──► ClientStore / zustand
                                                       (replays via shared evolve)
```

## `EventStore`

Source: `packages/engine/src/tracking/event-store.ts`.

```typescript
class EventStore {
  constructor(workDir: string, opts?: { maxRingBuffer?: number });
  append(
    type: EventType,
    data: Record<string, unknown>,
    metadata?: { agentId?: string; taskId?: string; phaseId?: string; runnerRole?: string; attempt?: number },
  ): EventRecord;
  getProjection(): WorkflowProjection;
  getSnapshot(): { state: WorkflowProjection; seq: number };
  getEventsSince(seq: number): EventRecord[];
  subscribe(cb: (projection: WorkflowProjection) => void): () => void;
  flush(): Promise<void>;
  saveSnapshot(): Promise<void>;
  static load(workDir: string, opts?: { maxRingBuffer?: number }): Promise<EventStore>;
}
```

### `append(type, data, metadata?)`

Assigns the next monotonic `seq`, pushes the record into a bounded ring buffer
(default 1000 entries; trims to the tail), evolves the projection, enqueues a
coalesced durable write, and notifies subscribers synchronously. Returns the created
`EventRecord`. The record's `metadata.timestamp` is set automatically.

### Write coalescing

Records appended within the same microtask tick are accumulated in `pendingRecords`
and flushed to disk in a single `appendFile` call by `drainPending()`. This avoids
one fs syscall per event while preserving seq ordering and line-delimited JSON.

### `flush(): Promise<void>`

If a microtask drain is pending, drains it synchronously, then awaits the write
queue. Guarantees durability even when called immediately after `append()`. The
server calls this before flipping run status to terminal so the terminal event
records are on disk by the time clients see "complete".

### `getEventsSince(seq)`

Returns all records with `seq > arg` from the ring buffer, using **binary search**
(the buffer is a contiguous, seq-ordered slice). If `seq` is older than the buffer's
oldest record, returns everything available.

### `subscribe(cb)`

Register a projection-change listener. Returns an unsubscribe function. Subscriber
errors are caught and do not crash the store. On the server, the per-run
`StatusBridge` is the primary subscriber.

### `saveSnapshot()`

Atomically write `{ state, seq, timestamp, version }` to `event-snapshot.json` (temp file +
rename). `version` is the current `SNAPSHOT_VERSION`; it lets `load()` detect snapshots
written by an incompatible evolve schema.

### `EventStore.load(workDir)`

Factory for resume: load a snapshot if present, then replay `events.jsonl` records
with `seq > snapshotSeq` through `evolve()`. Falls back to a pristine in-memory
projection when neither file exists. **Version gating:** if the snapshot's `version`
field is missing or does not equal the current `SNAPSHOT_VERSION`, the snapshot
is discarded and _all_ events are replayed from `events.jsonl` starting at `seq` 0.

## `createStoreCallbacks(store): StatusCallbacks`

Source: `packages/engine/src/tracking/store-callbacks.ts`. A `StatusCallbacks`
implementation that fans every callback into `store.append()` with the appropriate
`EventType`. The server passes this to a workflow's `onStatus`. The mapping is
**1:1**:

| Callback               | EventType              |
| ---------------------- | ---------------------- |
| `onWorkflowStart`      | `workflow_started`     |
| `onPhaseRegister`      | `phase_registered`     |
| `onPhaseStart`         | `phase_started`        |
| `onPhaseComplete`      | `phase_completed`      |
| `onSessionStart`       | `session_started`      |
| `onSessionComplete`    | `session_completed`    |
| `onAutoRetryStart`     | `auto_retry_started`   |
| `onAutoRetryCompleted` | `auto_retry_completed` |
| `onTaskRegister`       | `task_registered`      |
| `onTaskStart`          | `task_started`         |
| `onTaskComplete`       | `task_completed`       |
| `onTaskRejected`       | `task_rejected`        |
| `onDecision`           | `decision`             |
| `onAgentRender`        | `agent_rendered`       |
| `onError`              | `error`                |
| `onWorkflowComplete`   | `workflow_completed`   |
| `onWorkflowFailed`     | `workflow_failed`      |
| `onSidebarUpdate`      | `sidebar_updated`      |
| `onTurnStart`          | `turn_started`         |
| `onTurnEnd`            | `turn_ended`           |
| `onToolCallStart`      | `tool_call_started`    |
| `onToolCallEnd`        | `tool_call_ended`      |

> Note: the `log` event type is **not** produced by a `StatusCallbacks` method. It
> is emitted server-side by the scoped `console.warn`/`error`/`info` override inside
> `RunManager.executeWorkflow` (see [The `log` event type](#the-log-event-type)
> below).

`onSessionStart` stores `agentId`, `profile`, `sessionId`, `sessionPath`, and
`contextWindow` in the event data, with `runnerRole` and `attempt` carried in the
`SessionSpec` (forwarded through `RunSessionContext`). The metadata carries `agentId`,
`taskId`, and `phaseId`.

`onWorkflowFailed` stores `error.message` plus `errorName`/`phase` in
the event data; the reducer reads `data.error` for `projection.error`.

### Composition with workflow hooks (`composeHooks`)

Source: `packages/engine/src/hooks/compose.ts`. The store callbacks above are the **terminal
sink** — they always fire, unconditionally. When a workflow exports a `hooks` field, the
engine's `RunExecutor` composes them with the store callbacks via a single seam:

```typescript
const { onStatus, registry } = composeHooks(storeCallbacks, workflow.hooks ?? []);
// onStatus  → passed to the workflow as options.onStatus (the store callbacks ALWAYS fire)
// registry  → threaded to engine primitives (RunnerPool, PhaseRunner, WorktreeManager)
//             and surfaced to the workflow as options.hookRegistry
```

Two firm guarantees pin this seam:

- **Store callbacks ALWAYS fire.** The composed `onStatus` forwards every
  `STATUS_CALLBACK_METHOD` verbatim to `storeCallbacks[method]` and **never** reaches into the
  registry. A workflow with no `hooks` (or an empty registry) is byte-for-byte unchanged —
  `composeHooks(storeCallbacks, []).onStatus` is behaviorally identical to `storeCallbacks`, and
  the returned registry is empty.
- **Observe hooks fire IN ADDITION.** Observe subscribers (`onStructuredOutput`, `onDecision`,
  `afterPhase`, …) are a _secondary_ fan-out into a separate sink (e.g. the `AuditLog`). They
  never replace the event store. In particular, the audit-log `onDecision` hook and the
  event-store `StatusCallbacks.onDecision` callback fire **independently into different sinks**
  — do not conflate them. Firing is deferred to the engine primitives (which own a real
  `HookContext`), keeping `onStatus` synchronous.

See [Hooks](hooks.md) for the full composition model and the catalog of influence/observe
hooks.

## The `log` event type

Because the server and the TUI are now separate processes, the TUI can no longer
monkey-patch `console.*` to gain visibility into runtime warnings. Instead, the
server captures runtime console output and emits it as `log` events:

- Within each run's execution scope, `console.warn` / `console.error` /
  `console.info` are overridden to **also** call `store.append('log', { level,
message })`. The originals still run (the server log file captures them).
  `console.log` is intentionally **not** overridden.
- `log` is added to `EventType`. Its `evolve` case appends a `LogEntry` to the
  projection's `runLog` (capped at `MAX_RUN_LOG = 200`, FIFO).
- The `StatusBridge` coalesces and broadcasts these as `events`; the protocol also
  has a dedicated `{ type: 'log', runId, level, message, timestamp }` server message.
- **Known limitation / future work:** The `{ type: 'log', runId, level, message,
timestamp }` server message type is defined in the protocol, and clients have
  rendering pipelines in place (`appendRunLog` in both TUI and web clients,
  `formatWorkflowEventLine` in the stdout renderer). However, the server does
  **not** currently emit `log` messages — `StatusBridge` only sends `snapshot`,
  `events`, `run_complete`, and `run_failed`. Server-captured console output is
  therefore not yet visible to clients.

## The `evolve` reducer

Source: `packages/shared/src/evolve.ts` (a thin dispatcher that routes each event
to its per-domain handler module). Pure and immutable — it always returns a shallow
clone (via `clone(state, patch)`) and bumps `seq`. This is the **same** reducer the
clients run (the web imports it as `evolveClient`; the TUI's `ClientStore` folds
events through it directly).

**Constants:**

- `MAX_SESSION_LOG = 500` — session log entries are capped; the oldest are dropped.
- `MAX_RUN_LOG = 200` — runtime console log entries are capped (FIFO).

**Helpers** (source: `packages/shared/src/evolve-utils.ts`):

- `sessionKey(agentId, taskId?, runnerRole?, attempt?)` — builds a stable key:
  - `taskId` undefined → just `agentId` (non-task sessions like scouts/planners).
  - Otherwise → `agentId::taskId[::runnerRole][::attempt]` (each component appended
    only when defined).
- `resolveSession(sessions, agentId, taskId?, runnerRole?, attempt?)` — try an exact
  `sessionKey` match first; if that fails, scan all sessions filtering by `agentId`
  (required) and `taskId` (when defined), preferring one with `active === true`. A
  session is **skipped** only when its `runnerRole` differs AND its `attempt`
  matches — that combination means it is a different session for the same retry
  iteration (e.g. executor vs reviewer at attempt 1).
- `extractSessionIdentity(event)` — reads identity fields from `event.metadata` first
  (falling back to `event.data`), covering both canonical and legacy producers.
- `capLog(log, entry?)` — keep the last 500 entries, optionally folding in a new
  entry in a single allocation.

### Per-event effects

| Event                  | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow_started`     | Sets `taskPrompt` and `status = 'running'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `workflow_completed`   | `status = 'complete'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `workflow_failed`      | `status = 'failed'`; `error` from `data.error`; `failedPhase` from `data.phaseId ?? data.phase`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `phase_registered`     | If `data.id` is empty → no-op. If the phase exists → no-op. Otherwise append a new `PhaseEntity` (label defaults to id, icon defaults to `''`, `taskIds: []`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `phase_started`        | `currentPhaseId = data.phase ?? metadata.phaseId ?? existing`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `phase_completed`      | Append `data.phase ?? currentPhaseId` to `completedPhaseIds` (deduped).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `session_started`      | Upsert by `sessionKey`. New entity: construct full `SessionEntity` (default `runnerRole: 'executor'`, `attempt: 1`), **increment `sessionCount`**, stamp `startedAt = metadata.timestamp` (once, at first spawn), read `contextWindow` from `data.contextWindow` (defensively coerced to a number), copy `taskTitle` from the owning task when `taskId` matches. Existing entity: preserve `log`/tokens/`toolCallCount`/`startedAt`, update `profile`/`phaseId`/`sessionId`/`sessionPath`, refresh `contextWindow` when present, update `runnerRole`/`attempt`, set `active=true`, clear `completedAt`; **does not** re-increment `sessionCount`. |
| `session_completed`    | Resolve the session via `resolveSession`; set `active=false`, `completedAt = metadata.timestamp`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `task_registered`      | If `taskId` empty or exists → no-op. Otherwise create the `TaskEntity` with `status='ready'` (no steps — `TaskEntity` has no `steps` field) and append `taskId` to the owning `PhaseEntity.taskIds` (deduped) when `phaseId` matches a known phase.                                                                                                                                                                                                                                                                                                                                                                                               |
| `task_started`         | Task `status='active'`; `startedAt = data.startedAt` if numeric, else preserved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `task_completed`       | `status='complete'`; `completedAt = metadata.timestamp`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `task_rejected`        | `status='failed'`. (The projection maps "rejected" to `failed`; the executor keeps the task `active` for retry.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `decision`             | Append a `decision` log entry to the resolved session (capped).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `error`                | Append an `error` log entry to the resolved session (capped).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `agent_rendered`       | Append a `render` log entry to the resolved session (capped).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `turn_started`         | **No-op** — only bumps `seq`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `turn_ended`           | For each content block, push a `text` or `thinking` log entry. Add `data.tokens.input`/`output` to the session's token totals and to `stats.totalTokens`. Cap the log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tool_call_started`    | Append a `tool_call_start` log entry; **increment the session's `toolCallCount`**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tool_call_ended`      | Append a `tool_call_end` log entry. Does not change `toolCallCount`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `log`                  | Append a `LogEntry` (`type: 'error'` for level error, else `'text'`) to `runLog`, capped at `MAX_RUN_LOG`. (Server-captured console output; not produced by `StatusCallbacks`.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sidebar_updated`      | Update `sidebar.title` (if defined) and `sidebar.indicator` (if defined). Does **not** touch phases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `auto_retry_started`   | Append a `text` log entry (`"Retrying (attempt n/max) in Ds: error"`) to the resolved session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `auto_retry_completed` | Append a `text` (`"Retry succeeded"`) or `error` (`"Retry failed: ..."`) log entry to the resolved session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Subtle behaviours

- Sessions are keyed **per `(agentId, taskId, runnerRole, attempt)`** when all four are
  present, falling back to fewer components for legacy events that lack some fields.
  The same `agentId` reused across two tasks, across two roles within the same task, or
  across two attempts produces distinct `SessionEntity` records, each accumulating its own
  `log`, token totals, and `toolCallCount`.
- `sessionCount` increments only on the **first spawn** of a given key; subsequent
  re-spawns (upsert) do not.
- `turn_started` is the only event that is a pure no-op (besides bumping `seq`).
- Session resolution (`resolveSession`) uses an exact key match fast-path, then falls back
  to a scan. This is critical because some events (e.g. `turn_ended`, `tool_call_*`,
  `decision`) may carry only `agentId` and `taskId` without `runnerRole`/`attempt`, so the
  exact-key path would otherwise miss.

## `WorkflowProjection`

The canonical read-model. See [Types reference → `WorkflowProjection`](types.md#workflowprojection).

## Client-side projection stores

Clients rebuild the projection themselves from the WS stream, using the shared
`evolve`:

- **TUI** — `ClientStore` (`packages/shared/src/client-store.ts`): a plain-TS store
  with `applySnapshot(state, seq)`, `applyEvents(events)`, `appendRunLog(...)`,
  selection reconciliation (phase / task / session), and a `workflowEventLog`.
- **Web** — the zustand `workflow-store` (`packages/web/src/store/workflow-store.ts`):
  `applySnapshot(runId, snapshot, seq)`, `applyEvents(runId, events)`, plus a
  multi-run `runs` list and `cancelRun`.

Both preserve accumulated event lines on reconnect (they are immutable seq-keyed
facts) and only clear them on a genuine fresh start or server reset.

## Persistence files

Within a run's work directory (on the server):

| File                  | Contents                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `events.jsonl`        | Append-only newline-delimited `EventRecord`s.                                                        |
| `event-snapshot.json` | Atomically written `{ state, seq, timestamp, version }` (temp + rename); version = SNAPSHOT_VERSION. |
| `.engin-state.json`   | `WorkflowStatusTracker` state (the write-model view).                                                |
| `audit/audit.jsonl`   | Legacy `AuditLog` events (agent_start/agent_end/decision/structured_output/error).                   |

## `AuditLog`

Source: `packages/engine/src/tracking/audit-log.ts`. JSONL-backed audit log.

```typescript
class AuditLog {
  constructor(logDir: string);
  append(event: Omit<AuditEvent, 'timestamp'>): Promise<void>;
  getEvents(filter?: { taskId?: string; type?: string }): Promise<AuditEvent[]>;
  getEventsByTask(taskId: string): Promise<AuditEvent[]>;
  getStats(): Promise<{ totalEvents: number; totalCost: number; totalTokens: number }>;
  clear(): Promise<void>;
}
```

Events are cached in-memory after first read (capped at 5000; the last 5000 are
kept); the cache is invalidated on each `append`. `getStats` counts events and sums
`cost`/`tokens` from `agent_end` events where those fields are numbers.

## Where to go next

- [Architecture → How status flows](../concepts/architecture.md#how-status-flows).
- [Server reference](server.md) — the `StatusBridge` that broadcasts these events.
- [Task pool & execution](task-pool.md) — the write model that produces these events.
