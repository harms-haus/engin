# Event store & status

engin's status model is **event-sourced**. Instead of mutating a state object directly, every
status change is recorded as an append-only `EventRecord`, and an in-memory
`WorkflowProjection` is derived by replaying those events through the pure `evolve()` reducer.
The TUI and the web mirror both subscribe to the same store.

```
EventStore ──append──► events.jsonl (durable)
        │                  │
        │   evolve()       │ replay on resume
        ▼                  ▼
   WorkflowProjection ◄─── rebuild
        │
        ├─► TUI widgets (subscribe)
        └─► StatusBridge ──► WebSocket ──► browser/mobile
```

## `EventStore`

Source: `src/tracking/event-store.ts`.

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

Assigns the next monotonic `seq`, pushes the record into a bounded ring buffer (default 1000
entries; trims to the tail), evolves the projection, enqueues a coalesced durable write, and
notifies subscribers synchronously. Returns the created `EventRecord`. The record's
`metadata.timestamp` is set automatically.

### Write coalescing

Records appended within the same microtask tick are accumulated in `pendingRecords` and flushed
to disk in a single `appendFile` call by `drainPending()`. This avoids one fs syscall per event
while preserving seq ordering and line-delimited JSON.

### `flush(): Promise<void>`

If a microtask drain is pending, drains it synchronously, then awaits the write queue.
Guarantees durability even when called immediately after `append()`. The CLI calls this in its
`finally` block so the event log is durable before teardown.

### `getEventsSince(seq)`

Returns all records with `seq > arg` from the ring buffer, using **binary search** (the buffer
is a contiguous, seq-ordered slice). If `seq` is older than the buffer's oldest record, returns
everything available.

### `subscribe(cb)`

Register a projection-change listener. Returns an unsubscribe function. Subscriber errors are
caught and do not crash the store.

### `saveSnapshot()`

Atomically write `{ state, seq, timestamp }` to `event-snapshot.json` (temp file + rename).

### `EventStore.load(workDir)`

Factory for resume: load a snapshot if present, then replay `events.jsonl` records with
`seq > snapshotSeq` through `evolve()`. Falls back to a pristine in-memory projection when
neither file exists.

## `createStoreCallbacks(store): StatusCallbacks`

Source: `src/tracking/store-callbacks.ts`. A `StatusCallbacks` implementation that fans every
callback into `store.append()` with the appropriate `EventType`. The CLI passes this to a
workflow's `onStatus`. The mapping is **1:1**:

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

`onWorkflowFailed` stores `error.message` plus `errorName`/`errorStack`/`phase` in the event
data; the reducer reads `data.error` for `projection.error`.

## The `evolve` reducer

Source: `src/tracking/evolve.ts`. Pure and immutable — it always returns a shallow clone (via
`clone(state, patch)`) and bumps `seq`.

**Constants:**

- `MAX_AGENT_LOG = 500` — agent log entries are capped; the oldest are dropped.

**Helpers:**

- `agentKey(agentId, taskId?)` → `${agentId}::${taskId}` if `taskId`, else just `agentId`.
- `resolveAgent(agents, agentId, taskId?)` — exact key match first; otherwise, when no
  `taskId`, scan for an agent matching `agentId`, preferring one with `active === true`.
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
| `sidebar_updated`    | Update `sidebar.title` (if defined) and `sidebar.indicator` (if defined). Does **not** touch phases.                                                                                                                                                                                                                                                              |

### Subtle behaviours

- Agents are keyed **per `(agentId, taskId)`**. The same `agentId` reused across two tasks
  produces two distinct `AgentEntity` records.
- `agentCount` increments only on the **first spawn** of a given key; subsequent re-spawns
  (upsert) do not.
- Step linking (`tasks[taskId].steps[stepIndex].agentKey`) happens in `agent_spawned` and
  `step_started` whenever both `taskId` and `stepIndex` are present and the step slot exists.
- `turn_started` is the only event that is a pure no-op.

## `WorkflowProjection`

The canonical read-model. See [Types reference → `WorkflowProjection`](types.md#workflowprojection).

## Persistence files

Within a run's work directory:

| File                  | Contents                                                                           |
| --------------------- | ---------------------------------------------------------------------------------- |
| `events.jsonl`        | Append-only newline-delimited `EventRecord`s.                                      |
| `event-snapshot.json` | Atomically written `{ state, seq, timestamp }` (temp + rename).                    |
| `.engin-state.json`   | `WorkflowStatusTracker` state (the write-model view).                              |
| `audit/audit.jsonl`   | Legacy `AuditLog` events (agent_start/agent_end/decision/structured_output/error). |

## `AuditLog`

Source: `src/tracking/audit-log.ts`. JSONL-backed audit log.

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

Events are cached in-memory after first read (capped at 5000; the last 5000 are kept); the
cache is invalidated on each `append`. `getStats` counts events and sums `cost`/`tokens` from
`agent_end` events where those fields are numbers.

## Where to go next

- [Architecture → How status flows](../concepts/architecture.md#how-status-flows).
- [Task pool & execution](task-pool.md) — the write model that produces these events.
- [Web reference](web.md) — how events are broadcast to clients.
