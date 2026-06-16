# Event store & status

engin's status model is **event-sourced**. Instead of mutating a state object
directly, every status change is recorded as an append-only `EventRecord`, and an
in-memory `WorkflowProjection` is derived by replaying those events through the pure
`evolve()` reducer.

The `EventStore` lives **inside the server** (one per run, in
`packages/engine/src/tracking/`). Clients never touch an `EventStore` directly —
they receive run-scoped `snapshot` / `events` / `run_complete` / `run_failed` /
`log` messages over WebSocket and rebuild their own projection through the **shared**
`evolve` reducer (`packages/shared/src/evolve.ts`).

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
    metadata?: { agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number },
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

Atomically write `{ state, seq, timestamp }` to `event-snapshot.json` (temp file +
rename).

### `EventStore.load(workDir)`

Factory for resume: load a snapshot if present, then replay `events.jsonl` records
with `seq > snapshotSeq` through `evolve()`. Falls back to a pristine in-memory
projection when neither file exists. The server's `RunManager.startRun` uses this
when starting or resuming a run.

## `createStoreCallbacks(store): StatusCallbacks`

Source: `packages/engine/src/tracking/store-callbacks.ts`. A `StatusCallbacks`
implementation that fans every callback into `store.append()` with the appropriate
`EventType`. The server passes this to a workflow's `onStatus`. The mapping is
**1:1**:

| Callback             | EventType            |
| -------------------- | -------------------- |
| `onWorkflowStart`    | `workflow_started`   |
| `onPhaseRegister`    | `phase_registered`   |
| `onPhaseStart`       | `phase_started`      |
| `onPhaseComplete`    | `phase_completed`    |
| `onAgentSpawn`       | `agent_spawned`      |
| `onAgentComplete`    | `agent_completed`    |
| `onTaskRegister`     | `task_registered`    |
| `onTaskStart`        | `task_started`       |
| `onStepStart`        | `step_started`       |
| `onTaskComplete`     | `task_completed`     |
| `onTaskRejected`     | `task_rejected`      |
| `onDecision`         | `decision`           |
| `onError`            | `error`              |
| `onWorkflowComplete` | `workflow_completed` |
| `onWorkflowFailed`   | `workflow_failed`    |
| `onSidebarUpdate`    | `sidebar_updated`    |
| `onTurnStart`        | `turn_started`       |
| `onTurnEnd`          | `turn_ended`         |
| `onToolCallStart`    | `tool_call_started`  |
| `onToolCallEnd`      | `tool_call_ended`    |

> Note: the `log` event type is **not** produced by a `StatusCallbacks` method. It
> is emitted server-side by the scoped `console.warn`/`error`/`info` override inside
> `RunManager.executeWorkflow` (see [The `log` event type](#the-log-event-type)
> below).

`onWorkflowFailed` stores `error.message` plus `errorName`/`errorStack`/`phase` in
the event data; the reducer reads `data.error` for `projection.error`.

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

Source: `packages/shared/src/evolve.ts` (re-exported by the engine's tracking layer).
Pure and immutable — it always returns a shallow clone (via `clone(state, patch)`)
and bumps `seq`. This is the **same** reducer the clients run (the web imports it as
`evolveClient`; the TUI's `ClientStore` folds events through it directly).

**Constants:**

- `MAX_AGENT_LOG = 500` — agent log entries are capped; the oldest are dropped.
- `MAX_RUN_LOG = 200` — runtime console log entries are capped (FIFO).

**Helpers:**

- `agentKey(agentId, taskId?)` → `${agentId}::${taskId}` if `taskId`, else just
  `agentId`.
- `resolveAgent(agents, agentId, taskId?)` — exact key match first; otherwise, when
  no `taskId`, scan for an agent matching `agentId`, preferring one with
  `active === true`.
- `capLog(log)` — keep the last 500 entries.

### Per-event effects

| Event                | Effect                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow_started`   | Sets `taskPrompt` and `status = 'running'`.                                                                                                                                                                                                                                                                                                                       |
| `workflow_completed` | `status = 'complete'`.                                                                                                                                                                                                                                                                                                                                            |
| `workflow_failed`    | `status = 'failed'`; `error` from `data.error`; `failedPhase` from `data.phaseId ?? data.phase`.                                                                                                                                                                                                                                                                  |
| `phase_registered`   | If `data.id` is empty → no-op. If the phase exists → no-op. Otherwise append a new `PhaseEntity` (label defaults to id, icon defaults to `''`, `taskIds: []`).                                                                                                                                                                                                    |
| `phase_started`      | `currentPhaseId = data.phase ?? metadata.phaseId ?? existing`.                                                                                                                                                                                                                                                                                                    |
| `phase_completed`    | Append `data.phase ?? currentPhaseId` to `completedPhaseIds` (deduped).                                                                                                                                                                                                                                                                                           |
| `agent_spawned`      | Upsert by `agentKey`. New entity: construct full `AgentEntity`, **increment `agentCount`**, link the task step if `taskId` and `stepIndex` are present. Existing entity: preserve `log`/tokens/`toolCallCount`, update `profile`/`phaseId`/`stepIndex`/`sessionId`/`sessionPath`, set `active=true`, clear `completedAt`; **does not** re-increment `agentCount`. |
| `agent_completed`    | Resolve the agent; set `active=false`, `completedAt = metadata.timestamp`.                                                                                                                                                                                                                                                                                        |
| `task_registered`    | If `taskId` empty or exists → no-op. Otherwise build `StepEntity[]` from `data.steps` (each with `index` = position, `profile = profileId ?? profile`), create the `TaskEntity` with `status='ready'`, and append `taskId` to the owning `PhaseEntity.taskIds` (deduped) when `phaseId` matches a known phase.                                                    |
| `task_started`       | Task `status='active'`; `startedAt = data.startedAt` if numeric, else preserved.                                                                                                                                                                                                                                                                                  |
| `step_started`       | Requires numeric `data.stepIndex`; sets `activeStepIndex`. Links the agent to the step if resolvable.                                                                                                                                                                                                                                                             |
| `task_completed`     | `status='complete'`; `completedAt = metadata.timestamp`.                                                                                                                                                                                                                                                                                                          |
| `task_rejected`      | `status='failed'`. (The projection maps "rejected" to `failed`; the executor keeps the task `active` for retry.)                                                                                                                                                                                                                                                  |
| `decision`           | Append a `decision` log entry to the resolved agent (capped).                                                                                                                                                                                                                                                                                                     |
| `error`              | Append an `error` log entry to the resolved agent (capped).                                                                                                                                                                                                                                                                                                       |
| `turn_started`       | **No-op** — only bumps `seq`.                                                                                                                                                                                                                                                                                                                                     |
| `turn_ended`         | For each content block, push a `text` or `thinking` log entry. Add `data.tokens.input`/`output` to the agent's token totals and to `stats.totalTokens`. Cap the log.                                                                                                                                                                                              |
| `tool_call_started`  | Append a `tool_call_start` log entry; **increment the agent's `toolCallCount`**.                                                                                                                                                                                                                                                                                  |
| `tool_call_ended`    | Append a `tool_call_end` log entry. Does not change `toolCallCount`.                                                                                                                                                                                                                                                                                              |
| `log`                | Append a `LogEntry` (`type: 'error'` for level error, else `'text'`) to `runLog`, capped at `MAX_RUN_LOG`. (Server-captured console output; not produced by `StatusCallbacks`.)                                                                                                                                                                                   |
| `sidebar_updated`    | Update `sidebar.title` (if defined) and `sidebar.indicator` (if defined). Does **not** touch phases.                                                                                                                                                                                                                                                              |

### Subtle behaviours

- Agents are keyed **per `(agentId, taskId)`**. The same `agentId` reused across two
  tasks produces two distinct `AgentEntity` records.
- `agentCount` increments only on the **first spawn** of a given key; subsequent
  re-spawns (upsert) do not.
- Step linking (`tasks[taskId].steps[stepIndex].agentKey`) happens in
  `agent_spawned` and `step_started` whenever both `taskId` and `stepIndex` are
  present and the step slot exists.
- `turn_started` is the only event that is a pure no-op.

## `WorkflowProjection`

The canonical read-model. See [Types reference → `WorkflowProjection`](types.md#workflowprojection).

## Client-side projection stores

Clients rebuild the projection themselves from the WS stream, using the shared
`evolve`:

- **TUI** — `ClientStore` (`packages/shared/src/client-store.ts`): a plain-TS store
  with `applySnapshot(state, seq)`, `applyEvents(events)`, `appendRunLog(...))`,
  `selectPhase/Task/Step`, selection reconciliation (the same follow rules as the
  web), and a `workflowEventLog` (lines pre-formatted by
  `formatWorkflowEventLine`).
- **Web** — the zustand `workflow-store` (`packages/web/src/store/workflow-store.ts`):
  `applySnapshot(runId, snapshot, seq)`, `applyEvents(runId, events)`, plus a
  multi-run `runs` list and `cancelRun`.

Both preserve accumulated event lines on reconnect (they are immutable seq-keyed
facts) and only clear them on a genuine fresh start or server reset.

## Persistence files

Within a run's work directory (on the server):

| File                  | Contents                                                                           |
| --------------------- | ---------------------------------------------------------------------------------- |
| `events.jsonl`        | Append-only newline-delimited `EventRecord`s.                                      |
| `event-snapshot.json` | Atomically written `{ state, seq, timestamp }` (temp + rename).                    |
| `.engin-state.json`   | `WorkflowStatusTracker` state (the write-model view).                              |
| `audit/audit.jsonl`   | Legacy `AuditLog` events (agent_start/agent_end/decision/structured_output/error). |

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
