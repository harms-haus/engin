# Task pool & scheduling architecture

The pool layer (`packages/engine/src/pool/`) executes tasks concurrently. It is built around
three cooperating components:

- **`TaskGraph`** — a task dependency DAG (directed acyclic graph) with status tracking and
  dependency-pressure ranking.
- **`SessionScheduler`** — the centerpiece executor. It drives a `TaskGraph` through a
  `SessionGate` using a greedy, tiered drain loop.
- **`SessionPlanRunner`** — the runner contract that decouples _planning_ (what sessions to
  run, in what order) from _scheduling_ (when to start them, subject to gate capacity).

A **runner** is an async generator (`plan()`) that yields **batches** of `SessionSpec[]`. The
scheduler holds each batch, starts as many sessions as the gate allows, and feeds the settled
`SessionResult[]` back into the generator (via `gen.next(results)`) to advance it — but only
once the **entire batch has settled**. A batch is atomic.

This document covers the `TaskGraph` (write model), the `SessionScheduler` executor, the
`SessionGate` concurrency authority, the `SessionPlanRunner` contract, the built-in composable
runners, and the task lifecycle. For the single-step session primitive itself (`runSession`,
`SessionSpec`, `SessionResult`, `SessionError`, idempotency), see
[Session primitive](#the-session-primitive-runsession) below.

## Architecture at a glance

```
                       ┌──────────────────────────────────────────────┐
                       │                 SessionScheduler              │
                       │                                              │
   TaskGraph  ──────►  │  greedy tiered drain loop                    │
   (DAG + status)      │    T1 active → T2 parked → T3 ready          │
                       │  coalesced drain (queueMicrotask)            │
                       │  parking / lazy activation / deadlock detect │
                       └───────────────┬──────────────┬───────────────┘
                                       │              │
                                       ▼              ▼
                                SessionGate     runner.plan(ctx)
                                (concurrency)   (AsyncGenerator<
                                                 SessionSpec[], SessionResult[]>)
                                       │              │
                                       │ acquire/     │ gen.next(results)
                                       │ release      ▼
                                       │       runner.execute(ctx, spec)
                                       │              │
                                       │              ▼
                                       └──────► runScheduledSession ──► runSession
```

Key invariant the diagram encodes: **the scheduler owns the gate lifecycle directly**
(acquire before `execute`, release on settle). Runners are pure async generators that **never
touch the gate**. This is the central difference from the deleted `RunnerPool`, which started
unbounded coroutines that self-gated.

## `TaskGraph` — the DAG + status write model

Source: `packages/engine/src/pool/task-graph.ts`. A task dependency graph (DAG) with status
tracking and blocking-pressure ranking. It supersedes the status/dependency portions of the
deleted `TaskTracker`. It does **not** emit Node `EventEmitter` events — status transitions are
surfaced exclusively through an optional `onStatusTransition` callback that the scheduler
sets.

```typescript
type TaskStatus = 'ready' | 'blocked' | 'active' | 'complete' | 'failed' | 'cancelled' | 'parked';

class TaskGraph {
  onStatusTransition?: (taskId: string, status: TaskStatus) => void;

  addTask(task: Task, runnerFactory: () => SessionPlanRunner): void;
  addTasks(...tasks: (Task & { runnerFactory?: () => SessionPlanRunner })[]): void;

  getTask(id: string): TaskGraphEntry | undefined;
  getAllTasks(): TaskGraphEntry[];

  getReadyTasks(): TaskGraphEntry[]; // sorted DESC by blocking pressure
  getParkedTasks(): TaskGraphEntry[]; // sorted DESC by blocking pressure
  getActiveTasks(): TaskGraphEntry[]; // insertion order

  setTaskStatus(id: string, status: TaskStatus): void;
  recalculateReady(depsHint?: string): void;

  transitiveDependentCount(id: string): number;
  failDeadlockedTasks(): void;
}
```

### `TaskGraphEntry`

Each task is wrapped in a `TaskGraphEntry`. `TaskGraph` owns the `task`/`status` fields; the
runner / session-plan fields are mutated externally by the scheduler:

```typescript
interface TaskGraphEntry {
  task: Task; // underlying task definition (live ref)
  runnerFactory: () => SessionPlanRunner;
  status: TaskStatus; // mirrored on task.status — kept in sync
  planGen?: AsyncGenerator<SessionSpec[], SessionResult[] | undefined>;
  heldBatch?: SessionSpec[]; // current batch the scheduler is executing
  batchResults: SessionResult[]; // results for held batch, in spec order
  completedSessions: number; // scheduler-maintained
  totalSessions: number; // scheduler-maintained
}
```

### Status assignments on insert (`addTask`)

- A **pre-settled** task (`complete` / `failed` / `cancelled`) keeps its status — used when
  resuming a run where tasks already reached a terminal state.
- Otherwise **`ready`** when all dependencies are present and settled, else **`blocked`**.

`addTask` runs Kahn's-algorithm-style cycle detection after inserting; on a cycle it rolls
back the insert and **throws**. The reverse-dependency index and the memoized
transitive-dependents map are updated, then `recalculateReady` promotes any blocked
dependents whose deps are now all settled.

`addTasks(...)` is a convenience batch inserter. Tasks without an explicit `runnerFactory`
get a no-op factory (suitable for tests / status-only graphs).

### Blocking-pressure ranking

`getReadyTasks()` and `getParkedTasks()` return entries sorted **DESC by
`transitiveDependentCount(id)`** — the number of tasks that transitively depend on `id`
(computed by a reverse-topology DFS over the reverse-dependency index). Tasks that unblock
more downstream work are started first. Ties keep insertion order (first-added first-served),
relying on the stability of `Array.prototype.sort` (ES2019+) — no secondary sort key is
applied. `getActiveTasks()` returns entries in insertion order.

The transitive-dependents map is memoized and invalidated lazily on any topology change
(`addTask`). It is a pure function of the dependency topology, so it is safe to cache across
status changes.

### Status transitions (`setTaskStatus`)

```typescript
graph.setTaskStatus(id, status);
```

Updates both `entry.status` and `entry.task.status` (kept in sync). Invokes
`onStatusTransition` **only when the status actually changes** (no callback for no-op
transitions). This is the **single writer** through which all status changes flow — the
scheduler never mutates `entry.status` directly.

### `recalculateReady(depsHint?)`

When a dependency settles, transitions blocked tasks whose dependencies are now **all**
settled from `blocked` → `ready`. With `depsHint`, only dependents of that task id are
checked; without it, all blocked tasks are scanned.

### `failDeadlockedTasks()`

Fails blocked tasks whose dependency ids **don't exist in the graph** (the dependency will
never settle because it was never added). Marks each such task `failed` via `setTaskStatus`
with `result.error` starting with `deadlocked:`. Idempotent. The scheduler calls this at the
start of every `run()`.

## `SessionPlanRunner` — the runner contract

Source: `packages/engine/src/pool/runners/session-plan-types.ts`. Decouples planning from
scheduling. A runner is a stateful object with two methods. Runners are constructed via
factories ([`SessionPlanFactory`](#sessionplanfactory)) so each task gets a fresh instance.

```typescript
interface SessionPlanRunner {
  plan(ctx: SessionPlanContext): AsyncGenerator<
    SessionSpec[], // yielded batches
    SessionResult[] | undefined, // optional terminal aggregation
    SessionResult[] // results fed back via gen.next(results)
  >;
  execute(ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult>;
}

type SessionPlanFactory = () => SessionPlanRunner;
```

### The batch protocol

The scheduler drives a runner's `plan()` generator according to this protocol:

1. **Start.** The scheduler calls `gen.next()` (no argument) to start the generator and
   receive the **first batch** (`SessionSpec[]`). It **holds** that batch — it does not
   immediately call `gen.next()` again.
2. **Execute greedily.** The scheduler starts as many sessions in the held batch as gate
   capacity allows (`gate.canStart()` → `gate.acquire()` → `runner.execute()`). Sessions that
   cannot start immediately cause the task to be **parked** (status `'parked'`); already-
   started siblings continue running — they are not paused or cancelled.
3. **Advance.** Once **the entire batch has settled** (every spec completed or failed), the
   scheduler calls `gen.next(results)` to advance the generator and receive the next batch.
   `results` is `SessionResult[]` — one per spec, **in spec order**. The generator uses these
   to decide what (if anything) to yield next.
4. **Return.** When the generator returns, it MAY provide a terminal `SessionResult[]`
   (aggregated). A return value of `undefined` means the runner does not aggregate — the
   scheduler tracks terminal results itself.

> **Batch atomicity:** the generator cannot advance until ALL specs in the current batch have
> settled. A spec blocked on gate capacity **parks the task**, not the batch.

### `execute(ctx, spec)` — run one session

Runs a single `SessionSpec` and returns its `SessionResult`. **`execute()` must NOT acquire
the gate itself** — the scheduler acquires the slot before calling `execute()` and releases it
after the returned promise settles. This centralizes capacity enforcement in the scheduler
rather than duplicating it in every runner.

All built-in runners delegate `execute()` to `defaultExecute` (see
[Shared runner utilities](#shared-runner-utilities)).

### `SessionPlanContext`

Passed to `plan()` and `execute()`. Notably, it contains **no `gate`, no `runSession`, and no
`maxTaskRetries`** — the scheduler owns all of those:

```typescript
interface SessionPlanContext {
  task: Task;
  profiles: Map<string, AgentProfile>;
  sessionBaseDir: string;
  cwd: string;
  worktreeCwd?: string; // set when a worktree was created
  apiKeys?: Record<string, string>; // only in the execute context (S4 — see below)
  activeSessions: Set<{ abort(): Promise<void> }>;
  onStatus?: StatusCallbacks;
  hookRegistry?: HookRegistry;
  rendererRegistry?: RendererRegistry;
  auditLog?: AuditLog;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  phaseId: string;
  agentId: string;
}
```

> **S4 — security boundary:** the scheduler builds **two** contexts per task — a **plan
> context** (no `apiKeys`) and an **execute context** (with `apiKeys`). `plan()` never needs
> credentials; `execute()` does.

### Scheduler-side concepts (NOT runner members)

The runner contract documentation references several concepts that live on the **scheduler**,
not the runner:

- **`sessionPeek`** — "the currently-held batch": the `SessionSpec[]` most recently yielded by
  `gen.next()` that the scheduler is actively executing. The scheduler holds this reference as
  its own state (`entry.heldBatch`); the runner has no `sessionPeek` member and the scheduler
  never calls `gen.next()` just to peek.
- **`totalSessions`** — count of `SessionSpec`s yielded so far across all batches (may grow
  for coordinators that yield additional batches). Tracked as `entry.totalSessions`.
- **`completedSessions`** — count of settled (completed or failed) `execute()` calls. Tracked
  as `entry.completedSessions`.

### `SessionPlanFactory`

```typescript
type SessionPlanFactory = () => SessionPlanRunner;
```

Because runners are stateful (they track plan progress across batches), each task gets its own
instance via the factory. This prevents cross-task state leakage and lets the scheduler
construct a runner lazily when a task becomes active. Every built-in runner factory (e.g.
`singleSession`, `councilRunner`) returns a `SessionPlanFactory`.

## `SessionGate` — concurrency authority

Source: `packages/engine/src/pool/session-gate.ts`. A two-level (total + per-model) FIFO gate.
The scheduler uses the **manual acquire/release API** (it owns the session lifecycle);
`run()` is a legacy RAII convenience for callers that can express a session as a single async
function.

```typescript
interface SessionGateOptions {
  total: number; // hard cap across ALL models
  perModel: Record<string, number>; // keyed by `${provider}:${model}` or `${provider}:${model}:${agent}`
}

class SessionGate {
  constructor(options: SessionGateOptions, signal?: AbortSignal);
  onRelease?: () => void;

  availableTotal(): number;
  canStart(profile: { provider: string; model: string; agent?: string }): boolean;
  acquire(profile): boolean; // manual — returns false when saturated
  release(profile): void; // manual — must pair 1:1 with a true acquire

  run<R>(profile, fn: (handle: { signal: AbortSignal }) => Promise<R>): Promise<R>; // legacy RAII
}
```

### Scheduler-owned lifecycle: `canStart` / `acquire` / `release`

These are the methods the `SessionScheduler` uses. They are **synchronous, pure try-acquire**
calls — they never enqueue a FIFO waiter:

- **`canStart(profile)`** — non-mutating peek: could a session for this profile's model be
  admitted right now? `true` iff a total slot is free AND the per-model bucket has capacity.
  Uncapped models are gated only by the total.
- **`acquire(profile)`** — synchronously attempts to claim both a total slot and a per-model
  slot. Returns `true` iff both decrements succeeded (atomic in single-threaded JS). Returns
  `false` (never throws) when either is saturated. Does **not** enqueue a waiter.
- **`release(profile)`** — restores one unit of per-model and one of total capacity, then
  admits any FIFO `run()` waiters that may now fit, then fires `onRelease()`.

**Pairing contract:** each `true` return from `acquire()` MUST be matched by exactly one
later `release()` for the **same** profile. A `false` return MUST NOT be released. There is no
internal bookkeeping to detect unbalanced releases — callers own this invariant.

### Legacy RAII: `run(profile, fn)`

For callers that can bracket a session as a single async function. `run()` acquires
internally (enqueueing a FIFO waiter on the slow path), invokes `fn({ signal })`, and
releases in a `finally` (idempotent via a `called` flag). The scheduler does **not** use
`run()` — it uses acquire/release directly so session start and settle can live in different
stack frames.

### Lock ordering & model keys

- **Lock ordering:** total slot decremented first, per-model second (on acquire); per-model
  incremented first, total second (on release) — the exact reverse, preventing circular-wait.
- **`dispatch()`** scans each model queue head and admits any FIFO `run()` waiter whose model
  has capacity AND total has capacity.
- **Model key resolution:** prefers the 3-part key `${provider}:${model}:${agent}` when an
  agent is set AND a cap exists for it; otherwise falls back to the 2-part key.
- **`DeadlockError`** is thrown when a callback synchronously re-enters `run()` on the same
  gate while holding the last total slot (guaranteed deadlock).
- **AbortSignal:** pre-queue abort removes the waiter from its FIFO and rejects with
  `AbortError`; an already-aborted gate rejects immediately; a waiter that wakes only to
  discover it's been aborted releases its slot and rejects.

## `SessionScheduler` — the centerpiece executor

Source: `packages/engine/src/pool/session-scheduler.ts`. Drives a `TaskGraph` through a
`SessionGate` using a greedy, tiered drain loop. Unlike the deleted `RunnerPool`, it owns the
gate lifecycle directly.

```typescript
interface SessionSchedulerOptions {
  graph: TaskGraph;
  gate: SessionGate;
  profiles: Map<string, AgentProfile>;
  sessionBaseDir: string;
  cwd: string;
  onStatus?: StatusCallbacks;
  hookRegistry?: HookRegistry;
  rendererRegistry?: RendererRegistry;
  auditLog?: AuditLog;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  phaseId: string;
  apiKeys?: Record<string, string>;
  activeSessions: Set<{ abort(): Promise<void> }>;
  worktreeManager?: WorktreeManager;
}

class SessionScheduler {
  constructor(options: SessionSchedulerOptions);
  run(): Promise<{ completedTasks: number; failedTasks: number }>;
}
```

### `run()` — the main loop

1. **Early exits.** Returns `{ completedTasks: 0, failedTasks: 0 }` if the signal is already
   aborted or the graph is empty (without loading profiles or touching the gate).
2. **Setup.**
   - Clones `options.hookRegistry` into a scoped registry (so pool-internal subscriber
     registrations never mutate the original).
   - Tracks each task's initial status and fires `onTaskRegister` once per task.
   - Wires `graph.onStatusTransition` → `emitStatusEvent` (differentiates `ready`→`active`
     from `parked`→`active` — see [Task lifecycle](#task-lifecycle)).
   - Calls `graph.failDeadlockedTasks()` — missing-dep tasks become terminal immediately.
   - Wires `gate.onRelease` → `scheduleDrain()` (coalesced drain trigger).
   - Registers an abort listener that aborts every active session, cancels every non-terminal
     task, fire-and-forget-cleans up plan generators, and wakes the main loop.
3. **Resume reconstruction.** `initializeResumedTasks()` — for tasks that were mid-flight
   (`active` or `parked`) when a prior run was interrupted. Async generators aren't
   serializable, so the scheduler creates a **fresh** generator via `runner.plan(ctx)` and
   re-fetches the first batch. The [session idempotency](#resume-reconstruction) mechanism
   replays cached sessions instantly; only sessions that never actually completed re-run.
4. **Initial drain** — start as many sessions as possible.
5. **Main drain loop:**

   ```
   while (true):
     if aborted → break
     if inflight.size > 0:
       rearm wake signal
       await Promise.race([...inflight, wakePromise])
     drainPass()
     if inflight.size === 0:
       if isDone() → break
       drainPass()                    // false-deadlock guard
       if inflight.size > 0 → continue
       if isDone() → break
       handleResourceDeadlock()       // escalate
       break
   drain remaining inflight (Promise.allSettled)
   ```

6. **Teardown.** Unwires `gate.onRelease`, `graph.onStatusTransition`, the abort listener;
   clears the scoped hook registry.
7. **Count results** — `complete` → `completedTasks`; `failed`/`cancelled` → `failedTasks`.

### The greedy tiered drain loop (`drainPass`)

Each drain pass processes three tiers in **priority order**, starting specs greedily until
gate capacity is exhausted:

| Tier   | Tasks processed                       | Purpose                                                                                |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------------- |
| **T1** | `getActiveTasks()`                    | Continue specs in an active task's held batch (current-task affinity).                 |
| **T2** | `getParkedTasks()` (DESC by pressure) | Resume parked tasks whose pending specs now fit gate capacity.                         |
| **T3** | `getReadyTasks()` (DESC by pressure)  | Initialize the runner + fetch the first batch, then start specs (**lazy activation**). |

Within a tier, `tryStartBatchSpecs(entry)` iterates the held batch in order and starts every
spec the gate can admit. Already-started specs are skipped.

> **How many sessions start when one ends?** As many as capacity allows. When a session
> settles, its gate slot is released and a drain pass runs. That pass starts the active
> continuation (T1), then resumes parked tasks (T2), then initializes + starts ready tasks
> (T3) — **greedily, until either capacity is exhausted or no more specs can start.** So if a
> writer session on model A completes and the active task advances to a reviewer session on
> model B, and a ready writer task is waiting, **both** start — _provided the gate's `total`
> cap and the relevant per-model caps have room_. If only one starts, it is because the freed
> `total` slot was consumed by the (higher-priority) continuation, leaving no room for the
> ready task. Raising the gate's `total` cap (set by the workflow that constructs the
> scheduler) is what lets more sessions run concurrently.

- **T1 / T2** work on existing held batches. A spec that can't start (profile missing / gate
  saturated) is skipped — the loop tries subsequent specs (mixed-profile batches may use a
  different model that still has capacity).
- **T3** first calls `initializeReadyTask(entry)`: resolve the runner (beforeTask hook),
  optionally create a per-task worktree, create the plan generator, and fetch the first
  non-empty batch. If the generator returns immediately (all sessions cached on resume), the
  task is finalized here. Otherwise the held batch is set and specs are started.

> **Why tiers matter:** active tasks (T1) get first claim on freed capacity because they
> already have sessions running and hold a batch — continuing them avoids leaving partial
> batches stranded. Parked tasks (T2) are next, ranked by how much downstream work they
> unblock. Ready tasks (T3) are last — initializing one costs a worktree + a generator, so we
> only do it when T1/T2 are satisfied.

### Lazy activation

A `ready` task stays `ready` until its **first session actually acquires a gate slot**. There
are no premature `ready` → `active` transitions. The transition happens inside
`tryStartBatchSpecs`, on the first successful `startSession` for the task:

```typescript
// inside tryStartBatchSpecs, on the first spec that can start:
if (entry.status === 'ready') graph.setTaskStatus(taskId, 'active'); // emits task_started
if (entry.status === 'parked') graph.setTaskStatus(taskId, 'active'); // emits task_unparked
```

This means a task is never reported `active` to the UI (or to status callbacks) unless a real
session is consuming a concurrency slot.

### Parking

A spec that can't acquire a slot **parks the task** (not the batch). Already-started siblings
continue running and must settle before the generator advances.

- When an `active` task has un-started specs but none can start (and its held batch is not
  already fully settled — see H1 below), `tryStartBatchSpecs` transitions it to `parked` and
  emits `task_parked`.
- A `parked` task resumes (T2) when a drain pass finds its specs now fit capacity. The first
  successful start transitions it back to `active` and emits `task_unparked`.
- `ready` and `parked` tasks that can't start are left as-is — they don't park further.

### H1 — the `advancing` guard

While a task's `advanceBatch` is awaiting `gen.next(results)` (an async gap), the held batch
is the **old, fully-settled** batch. A coalesced drain pass must not try to start or park on
that stale batch. The `advancing` set marks tasks mid-advance; `tryStartBatchSpecs` skips them
entirely. Additionally, a task whose held batch is already fully settled
(`isBatchComplete`) is **never parked** — it's about to advance.

### Coalesced drain (`scheduleDrain`)

Multiple near-simultaneous triggers (session completions, `gate.onRelease`) are coalesced
into **one** drain pass via a flag + `queueMicrotask`:

```typescript
private scheduleDrain(): void {
  if (this.drainScheduled) return;
  this.drainScheduled = true;
  queueMicrotask(() => {
    this.drainScheduled = false;
    this.wakeResolve();    // unblocks the main loop's Promise.race
  });
}
```

The main loop `await`s `Promise.race([...inflight, wakePromise])`. A session settle resolves
its inflight promise (deleting it from the set); `scheduleDrain` resolves `wakePromise`. Either
way the loop wakes and calls `drainPass()` again.

### Batch atomicity & advancement

A batch is atomic: `gen.next(results)` is called **only when ALL specs in the held batch have
settled**. `isBatchComplete` is O(1) — it compares a `batchSettledCount` counter (incremented
when each `batchResults[i]` transitions `undefined` → defined) against the batch length.

When a batch completes, `advanceBatch(entry)`:

1. Sets the `advancing` flag (H1).
2. Passes `[...entry.batchResults]` to `gen.next(results)` via `nextNonEmptyBatch` (which
   skips empty `[]` yields and throws after 1000 consecutive empty batches — infinite-loop
   guard).
3. If the generator yields a new batch, resets per-batch state (`heldBatch`, `batchResults`,
   `batchStarted`, `batchSettledCount`) and a subsequent drain pass starts its specs.
4. If the generator returns, calls `finalizeTask`.
5. Clears the `advancing` flag in a `finally`.

If `gen.next` (or `gen.return`) throws, the error is captured and the task fails via
`failTask`.

### Single-session execution (`startSession`)

```typescript
private startSession(entry, specIndex, profile: AgentProfile): void
```

Called by `tryStartBatchSpecs` after `gate.canStart(profile)` returned true.

1. **Idempotency pre-check (E1).** If the session is already cached
   (`isSessionCached(sessionBaseDir, spec.id)` and `spec.resume !== true`), the gate
   acquire/release is **skipped entirely** — `runner.execute()` returns the cached result
   instantly via `runSession`'s idempotency mechanism. This is how resumed tasks replay
   completed sessions without consuming a slot.
2. **Acquire.** `gate.acquire(profile)`. If it returns `false` (a race: capacity vanished
   between `canStart` and `acquire`), the task is parked if active, and `startSession`
   returns without starting.
3. **Mark started** in `batchStarted`.
4. **Execute.** An async IIFE calls `runner.execute(executeCtx, spec)`. It is **not**
   wrapped in an external wall-clock timeout here — freeze detection is the responsibility
   of the in-session inactivity watchdog inside `runSession` (see S1 below). If `execute()`
   throws (e.g. `WatchdogTimeoutError`), the error is accumulated into `taskErrors` and
   `failTask(entry, executeError)` is called **immediately** — the scheduler does not store a
   synthetic empty result or advance the generator. The gate slot is released in a `finally`
   (S1: ALWAYS released).
5. **Settle.** The result is stored at `entry.batchResults[specIndex]`,
   `completedSessions` is incremented, and `batchSettledCount` is updated (E2). If the batch
   is now complete, `advanceBatch` is called.
6. **Trigger.** `scheduleDrain()` — capacity freed and/or batch advanced.

The session promise is added to the `inflight` set and removed on settle (both resolve and
reject). `inflight` is the set the main loop races against.

### Timeout hardening (S1 / S2)

- **S1 — in-session inactivity watchdog (no wall-clock race):** `runner.execute()` is NOT
  raced against a scheduler-side timeout. Model-freeze detection lives entirely inside
  `runSession`, which arms an inactivity watchdog (`DEFAULT_WATCHDOG_TIMEOUT_MS` = 300 000 ms,
  overridable via `SessionPlanContext.stepTimeoutMs`). The watchdog RESETS on every agent
  activity event and only fires when the model goes silent for the full window; a genuine
  freeze surfaces as a thrown `WatchdogTimeoutError` from `runner.execute()`, which the
  scheduler routes to `failTask`. The gate slot is ALWAYS released via try/finally regardless
  of outcome, so a hung runner cannot leak a slot or deadlock the scheduler.
- **S2 (`GENERATOR_TIMEOUT_MS` = 5 000 ms):** `planGen.next()` and `planGen.return()` are
  raced against a timeout. A leaked generator is preferred over blocking the scheduler. A
  hanging `finally`/`await` inside the generator cannot stall a drain pass.

### Task finalization

Every task reaches a terminal state through one of two paths:

- **`finalizeTask(entry)`** — the success path. Handles worktree merge-on-success
  (`worktreeManager.mergeTaskBranch`). On success: sets `result = { completed: true }`,
  `status = 'complete'`, calls `recalculateReady` to promote blocked dependents, cleans up the
  generator. On merge failure or accumulated session errors, delegates to `failTask`.
- **`failTask(entry, errorMsg)`** — the single failure path. Accumulates the error message,
  culls the worktree (best-effort — `failTask` is the **single cull owner**; callers must not
  cull before/after), sets `result = { completed: false, error }`, `status = 'failed'`,
  `recalculateReady`, cleans up the generator. Defensive: if the task is already terminal
  (e.g. cancelled by abort), it does nothing.

### Deadlock detection

Two kinds of deadlock are handled:

1. **Missing-dependency deadlock** — `graph.failDeadlockedTasks()` runs at the start of
   `run()`, before any sessions start. A blocked task whose dependency id doesn't exist in the
   graph is marked `failed` with `result.error` starting with `deadlocked:`.
2. **Resource deadlock** — detected in the main loop when `drainPass` started nothing,
   nothing is in-flight, but non-terminal tasks remain (e.g. a spec references a profile that
   doesn't exist, or all remaining tasks are parked with no path forward). A false-deadlock
   guard does one more `drainPass` (capacity may have freed during T3's async initialization,
   or a batch-advance may have just completed). If still stuck, `handleResourceDeadlock()`
   routes each stuck task through `failTask` with a `resource deadlock: ...` message.

### Resume reconstruction

When a run is interrupted and later resumed from a reconstructed `TaskGraph`, tasks that were
mid-flight (`active` or `parked`) have no live generator — async generators aren't
serializable. `initializeResumedTasks` creates a **fresh** generator via `runner.plan(ctx)`
and re-fetches the first batch. The status stays `active` or `parked`; the normal drain pass
handles session starting and transitions.

The [session idempotency](#the-session-primitive-runsession) mechanism ensures correctness:

- Sessions that **completed** (`.complete` sentinel + valid `result.json`) return the cached
  result instantly when `execute()` is called — they don't re-run, and they skip gate
  acquire/release entirely (E1).
- Sessions that were started but **never completed** are re-executed from scratch.

**Determinism requirement:** `plan()` generators MUST be deterministic given the persisted
session cache. If a runner's plan is non-deterministic (e.g. random branching), resume may
produce a different session sequence. For council/parallel runners, worker outputs on resume
may mix cached results (from completed siblings) with fresh results (from re-run siblings) —
acceptable by design.

### Runner resolution (`resolveRunner`)

Resolution order, cached per task so `beforeTask` fires once:

1. If a scoped `hookRegistry` with at least one `beforeTask` subscriber is present, invoke the
   first-wins hook seeded with `{ task }`:
   - `{ skip: true }` → skip (cancel) the task.
   - `{ runner: ... }` → use the provided runner.
   - `undefined` → abstain (fall through).
2. Fall through to the entry's `runnerFactory()`.

A hook that throws is logged and treated as abstain.

### Status event emission (`emitStatusEvent`)

Driven by `graph.onStatusTransition`. Differentiates transitions into `active` based on the
**previous** status:

| Transition          | Event                                         |
| ------------------- | --------------------------------------------- |
| `ready` → `active`  | `onTaskStart` (`task_started`)                |
| `parked` → `active` | `onTaskUnparked` (`task_unparked`)            |
| `*` → `parked`      | `onTaskParked` (`task_parked`)                |
| `*` → `complete`    | `onTaskComplete`                              |
| `*` → `failed`      | `onTaskRejected` (with `result.error`)        |
| `*` → `cancelled`   | `onTaskRejected` (reason: `'task cancelled'`) |

`ready` and `blocked` have no dedicated events.

## Task lifecycle

```
blocked ──(deps settle)──► ready ──(first spec acquires slot)──► active ──► complete
                              ▲                                       │
                              │                                       ├─► failed
                              │                                       └─► cancelled
                              │
                              └─(re-promoted by recalculateReady)
                                      ▲
                                      │
                            parked ◄──┘
                            (active task's un-started specs can't fit capacity)
                            active ◄──(capacity frees, T2 resumes)
```

| Status      | Meaning                                                                                     | Terminal? |
| ----------- | ------------------------------------------------------------------------------------------- | --------- |
| `blocked`   | Has unsettled or missing dependencies.                                                      | No        |
| `ready`     | All deps settled; runner not yet initialized / no session has acquired a slot yet.          | No        |
| `active`    | At least one session is consuming a gate slot.                                              | No        |
| `parked`    | Has un-started specs but none can fit gate capacity. Already-started siblings keep running. | No        |
| `complete`  | All sessions succeeded; worktree merged (if any).                                           | Yes       |
| `failed`    | A session/generator/merge failed, or deadlock detected.                                     | Yes       |
| `cancelled` | Aborted by signal, or skipped by a `beforeTask` hook.                                       | Yes       |

**Settled** = `complete | failed | cancelled`. Any non-settled task can be cancelled.

## The session primitive (`runSession`)

Source: `packages/engine/src/pool/session.ts`. The single-step session primitive — one agent
prompt turn. Full details are in the types reference; the essentials:

```typescript
async function runSession(ctx: RunSessionContext): Promise<SessionResult>;
function isSessionCached(sessionBaseDir: string, specId: string): boolean;
function clearTaskSessions(sessionBaseDir: string, taskId: string): void;
```

### `SessionSpec`

| Field               | Type         | Description                                                                                                                                                                                                                                                           |
| ------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | `string`     | Unique session id (persistence path segment).                                                                                                                                                                                                                         |
| `profile`           | `string`     | Agent profile id (resolved against `ctx.profiles`).                                                                                                                                                                                                                   |
| `prompt`            | `string`     | The prompt text.                                                                                                                                                                                                                                                      |
| `schema?`           | `ZodType`    | Optional Zod schema for structured output.                                                                                                                                                                                                                            |
| `outputMode`        | `OutputMode` | `'text' \| 'structured' \| 'filesystem'`.                                                                                                                                                                                                                             |
| `isReadOnly?`       | `boolean`    | When true, write/edit tools are stripped.                                                                                                                                                                                                                             |
| `runnerRole`        | `string`     | Role label (e.g. `'executor'`, `'reviewer'`).                                                                                                                                                                                                                         |
| `attempt`           | `number`     | 1-based attempt number.                                                                                                                                                                                                                                               |
| `resume?`           | `boolean`    | Resume an existing session at this id instead of creating a fresh one (used by review loops). Bypasses the idempotency cache check.                                                                                                                                   |
| `allowedWriteDirs?` | `string[]?`  | Optional override of the session write sandbox. When omitted on a non-read-only session, runSession confines writes to the session cwd (`worktreeCwd ?? cwd`) by default; read-only sessions skip the sandbox entirely (their write/edit tools are already stripped). |

### `SessionResult`

```typescript
type SessionResult =
  | { mode: 'text'; text: string }
  | { mode: 'structured'; data: unknown }
  | { mode: 'filesystem'; files: string[] };
```

### Idempotency (the resume backbone)

A session directory lives at `{sessionBaseDir}/{spec.id}/`. On completion, `runSession`
persists `result.json` + a `.complete` sentinel (with SHA-256 checksum + directory fsync).
On the next call with the same `spec.id`:

- If `.complete` + valid `result.json` exist → the **cached** result is returned instantly
  (no re-run). `isSessionCached()` is a fast `existsSync` pre-check the scheduler uses to skip
  gate acquire/release for cached sessions (E1).
- Corrupt cache (checksum/length mismatch) → permanent `SessionError`.
- A `resume: true` spec bypasses the cache check and continues the existing conversation.

This is what makes [resume reconstruction](#resume-reconstruction) correct: completed sessions
replay from cache, only incomplete sessions re-run.

### `runScheduledSession`

Source: `packages/engine/src/pool/run-scheduled-session.ts`. A thin, **gate-free** wrapper
around `runSession`. It constructs a `RunSessionContext` from a `SessionPlanContext` + spec
and delegates. It does NOT acquire or release any gate — the scheduler has already done so.
All errors (including `SessionError`) propagate to the caller.

## Shared runner utilities

Source: `packages/engine/src/pool/runners/runner-utils.ts`.

### `defaultExecute`

```typescript
const defaultExecute: SessionPlanRunner['execute'] = (ctx, spec) => runScheduledSession(spec, ctx);
```

The standard `execute` implementation every built-in runner references. Delegates to
`runScheduledSession` (gate-free). Runners should reference this instead of duplicating the
inline method.

### `delegateToChild`

```typescript
function delegateToChild(
  child: SessionPlanRunner,
  ctx: SessionPlanContext,
): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]>;
```

Fully delegates to a child runner's `plan()`: creates the child generator, re-yields every
batch, threads scheduler-supplied results back via `childGen.next(results)`, and returns the
child's terminal value. A `try/finally` calls `childGen.return()` on early termination
(whether normal, via a `.return()` from the parent, or via a thrown error) so the child's
`finally` blocks always run. Composite runners use `yield* delegateToChild(child, ctx)`
instead of duplicating the yield/next loop.

## Built-in runners

All factories live in `packages/engine/src/pool/runners/` and return a `SessionPlanFactory`.
Each runner's `plan()` is an async generator that yields batches; `execute()` delegates to
`defaultExecute`. Compositors (`linearRunner`, `parallelRunner`, `branchRunner`,
`coordinatorRunner`, `coalescingRunner`) use `delegateToChild` to nest child runners —
nesting depth is unlimited and the `SessionGate` enforces the global cap regardless of depth.

---

#### `singleSession(spec)`

```typescript
import { singleSession } from '../pool/runners/single-session.js';

const factory = singleSession({
  role: 'execute',
  profile: 'coder',
  prompt: 'Implement the function',
  outputMode: 'text',
});
```

Runs exactly **one** session. `plan()` yields a single batch `[fullSpec]` and returns
`undefined`. Deterministic id: `` `${taskId}/${role}#${attempt}` `` (`attempt` defaults to 1).

---

#### `linearRunner(children)`

```typescript
import { linearRunner } from '../pool/runners/linear-runner.js';

const factory = linearRunner([childA, childB, childC]);
```

Runs children in **strict sequential order**. Each child's `plan()` is fully consumed (all
batches re-yielded via `delegateToChild`) before advancing to the next child. The linear
runner does **not** inspect results to decide short-circuiting — if a child's `execute()`
throws, the scheduler marks the task failed and does not advance the generator, so remaining
children are naturally skipped.

---

#### `parallelRunner(children)`

```typescript
import { parallelRunner } from '../pool/runners/parallel-runner.js';

const factory = parallelRunner([childA, childB]);
```

Runs each child's **first batch** as a single combined parallel batch. Each child's
`plan().next()` is called to collect its first batch; all are concatenated and yielded
together. After the batch settles, results are split by child (based on how many specs each
contributed) and forwarded back via `childGen.next(childResults)`. Children whose plan is
exhausted after the first batch contribute nothing more. Deadlock-free: no child holds a
resource while waiting for another.

---

#### `councilRunner(workers, synthesizer)`

```typescript
import { councilRunner } from '../pool/runners/council-runner.js';

const factory = councilRunner(
  [
    {
      id: `${taskId}/worker[0]#1`,
      profile: 'architect',
      prompt: '...',
      outputMode: 'structured',
      schema,
      runnerRole: 'worker',
      attempt: 1,
    },
    {
      id: `${taskId}/worker[1]#1`,
      profile: 'engineer',
      prompt: '...',
      outputMode: 'structured',
      schema,
      runnerRole: 'worker',
      attempt: 1,
    },
  ],
  {
    id: `${taskId}/synthesizer#1`,
    profile: 'synthesizer',
    prompt: 'Merge the outputs',
    outputMode: 'structured',
    schema: mergeSchema,
    runnerRole: 'synthesizer',
    attempt: 1,
  },
);
```

Two phases:

1. **Phase 1** — yields all worker specs as a single batch. The scheduler runs them
   concurrently through the gate.
2. **Phase 2** — builds the synthesizer prompt by concatenating worker outputs
   (`text` → the text, `structured` → `JSON.stringify(data)`, `filesystem` → a placeholder),
   yields `[synthSpec]` as a second batch.

Worker IDs and the synthesizer id are taken directly from the supplied specs.

---

#### `retrospectiveCouncilRunner(options)`

```typescript
import { retrospectiveCouncilRunner } from '../pool/runners/retrospective-council-runner.js';

const factory = retrospectiveCouncilRunner({
  convener: {
    id: `${taskId}/convener#1`,
    profile: 'planner',
    prompt: 'Identify what needs fixing and produce member assignments.',
    outputMode: 'structured',
    schema: convenerSchema,
    runnerRole: 'convener',
    attempt: 1,
  },
  buildMembers: (convenerResult) => {
    const plan = convenerResult.data as ConvenerOutput;
    return plan.tasks.map((t) => ({
      id: `${taskId}/member[${t.id}]#1`,
      profile: 'fixer',
      prompt: t.instructions,
      outputMode: 'filesystem',
      runnerRole: 'member',
      attempt: 1,
    }));
  },
  retrospective: {
    id: `${taskId}/retro#1`,
    profile: 'reviewer',
    prompt: 'Re-read the diff and decide what remains.',
    outputMode: 'structured',
    schema: retroSchema,
    runnerRole: 'retrospective',
    attempt: 1,
  },
  buildRetrospectivePrompt: async (_ctx, round) => {
    const diff = await getDiff(cwd);
    return `Round ${round} retrospective.\n\nCurrent diff:\n${diff}`;
  },
  interpretRetrospective: (retroResult) => {
    const verdict = retroResult.data as RetroOutput;
    return {
      terminate: verdict.done,
      nextMembers: verdict.remaining.map((t) => ({
        id: `${taskId}/member[${t.id}]#1`,
        profile: 'fixer',
        prompt: t.instructions,
        outputMode: 'filesystem',
        runnerRole: 'member',
        attempt: 1,
      })),
    };
  },
  maxRounds: 10,
  onMaxRoundsExhausted: () => updateAuditStatus('capped'),
});
```

Runs a **convener → (members → retrospective)\*** loop — fusing `councilRunner`'s parallel-members
batch pattern with `reviewRunner`'s loop/terminate pattern. The flow:

1. **Convener** — yields `[convener]` as the first batch and awaits its result.
2. **Build members** — `buildMembers(convenerResult)` returns the first member batch. When the
   array is **empty**, the generator returns immediately (pressure-valve — no work to do).
3. **Loop** (`1..maxRounds`, default `DEFAULT_MAX_ROUNDS` = 3):
   1. Yield the members batch (all run in **parallel**, like `councilRunner`'s workers).
   2. Optionally rebuild the retrospective prompt via `buildRetrospectivePrompt(ctx, round)`. The
      callback **may be async** (e.g. it collects a fresh `git diff`); the runner awaits the
      result before yielding the spec. When omitted, `retrospective.prompt` is used as-is.
   3. Yield `[retrospective]` (the prompt from step 3.2).
   4. `interpretRetrospective(retroResult)` → `{ terminate, nextMembers }`.
   5. If `terminate` is `true` **or** `nextMembers` is empty → generator returns.
   6. Otherwise `members = nextMembers` and the loop continues.
4. **Max rounds exhausted** — calls `onMaxRoundsExhausted` (if provided; errors are swallowed)
   and **returns silently**. Unlike `reviewRunner` / `coalescingRunner`, this runner does **not**
   throw: reaching the cap is a normal "still has findings" outcome, not a task failure.

**Idempotency guard:** when `buildRetrospectivePrompt` is provided, each round's retrospective
session gets a fresh id (`${retrospective.id}-r${round}`) to prevent the session cache from
replaying a stale earlier-round result. When the callback is absent, the template id is kept
unchanged (for single-round or caller-managed reuse).

**Member results are not available** to `buildRetrospectivePrompt` — the prompt can only be built
from `ctx` and `round`. Member outputs (fixers writing code) are accessible only indirectly
(e.g. via filesystem state / a fresh `git diff`). The retrospective re-reads the resulting diff.

`execute` delegates to `defaultExecute` (gate-free). Generic and schema-agnostic: no council
schemas, no finding shapes, no profile or git knowledge — all structure is caller-provided via
the transform callbacks.

---

#### `mapRunner(options)`

```typescript
import { mapRunner } from '../pool/runners/map-runner.js';

const factory = mapRunner({
  items: ['file1.ts', 'file2.ts', 'file3.ts'],
  spec: {
    id: '',
    profile: 'formatter',
    prompt: 'Format this file',
    outputMode: 'filesystem',
    runnerRole: 'worker',
    attempt: 1,
  },
  role: 'worker',
});
```

Fans out over a collection, yielding **one batch with one spec per item**. Per-item id:
`` `${taskId}/map[${index}].${role}#${attempt}` ``. Per-item prompt:
`spec.prompt + "\n\nItem: " + JSON.stringify(item)`. Concurrency is **not** managed here —
the gate is the sole concurrency authority. Empty `items` → generator returns immediately.

---

#### `reviewRunner(executeSpec, reviewSpec, options?)`

```typescript
import { reviewRunner } from '../pool/runners/review-runner.js';

const factory = reviewRunner(
  { role: 'execute', profile: 'coder', prompt: 'Write the code', outputMode: 'filesystem' },
  { role: 'review', profile: 'reviewer', prompt: 'Review the code', outputMode: 'structured', schema: reviewSchema },
  { maxRounds: 5, onReviewReject: (round) => snapshotPlan(round) },
);
```

Implements the **execute → review loop**. For each round (`1..maxRounds`, default
`DEFAULT_MAX_ROUNDS` = 3):

1. Yield the execute session batch (with accumulated feedback appended from prior rejections).
2. Build the review prompt from the execute result (`text` → appended text, `structured` →
   `JSON.stringify(data)`, `filesystem` → a placeholder note).
3. Yield the review session batch (structured output).
4. If `reviewData.approved === true` → generator returns (task completes).
5. Otherwise collect `reviewData.feedback` and continue.
6. `maxRounds` exhausted → `plan()` throws (task fails).

IDs are **stable** across rounds: `` `${taskId}/${role}` ``. Round 2+ sets `resume: true` so
the agent sees its prior work + the new feedback instead of starting over. `attempt` stays at
1 — a resume is a continuation of the same session entity, keeping the projection key stable.

`onReviewReject(round)` fires when a review rejects, before the next execute round. Lets
callers preserve artifacts from the rejected round. Non-fatal: snapshot failures don't abort
the loop.

---

#### `coordinatorRunner(coordinatorSpec, opts)`

```typescript
import { coordinatorRunner } from '../pool/runners/coordinator-runner.js';

const factory = coordinatorRunner(coordinatorSpec, {
  childRunner: (coordinatorResult) => buildChildRunner(coordinatorResult),
});
```

Runs a coordinator session (structured output), **fully awaits it**, then delegates to
`opts.childRunner(coordinatorResult)` — a factory returning a `SessionPlanRunner` for the
children. The coordinator must fully persist before any child is invoked (enforced by
yielding the coordinator spec first and only calling `childRunner` after the result is
received). Children assign their own IDs per the childRunner's convention.

---

#### `coalescingRunner(coordinatorSpec, opts)`

```typescript
import { coalescingRunner } from '../pool/runners/coalescing-runner.js';

const factory = coalescingRunner(coordinatorSpec, {
  childRunner: (coordinatorResult, round) => buildChildRunner(coordinatorResult, round),
  maxRounds: 5,
});
```

Runs a **coordinator → children → coordinator loop**. Each round:

1. Yield the coordinator batch (id `` `${taskId}/coordinator#${round}` ``, `attempt = round`).
2. Parse structured output: `{ done: boolean, children?: unknown[], feedback?: string }`.
3. `done === true` → generator returns (task completes).
4. Otherwise delegate to `opts.childRunner(coordResult, round)` via `delegateToChild`.
5. Loop back to step 1.
6. `maxRounds` exhausted (default `DEFAULT_MAX_ROUNDS`) → `plan()` throws (task fails).

Deadlock-safe: the coordinator completes and releases its slot before children spawn (serial
yield per round).

---

#### `branchRunner(options)`

```typescript
import { branchRunner } from '../pool/runners/branch-runner.js';

const factory = branchRunner({
  branches: [
    { condition: (ctx) => ctx.task.prompt.includes('fix'), runner: fixRunner },
    { condition: (ctx) => ctx.task.prompt.includes('feature'), runner: featureRunner },
  ],
  default: triageRunner,
});
```

Selects **exactly one** child based on conditions evaluated in order. Conditions can be sync
or async (both are awaited); the first truthy result short-circuits. The selected branch's
`plan()` is fully delegated to via `delegateToChild`. If no branch matches and a `default` is
provided, it runs. If no match and no default → `plan()` throws `'No branch matched'` (task
fails).

---

### Decision guide

| Pattern                                                                 | Runner                       |
| ----------------------------------------------------------------------- | ---------------------------- |
| One session, done                                                       | `singleSession`              |
| Sequential pipeline                                                     | `linearRunner`               |
| Parallel fan-out (first batches)                                        | `parallelRunner`             |
| Multiple workers merged by a synthesizer                                | `councilRunner`              |
| Fan-out over a collection of items                                      | `mapRunner`                  |
| Execute → review → fix loop                                             | `reviewRunner`               |
| Coordinator decides, then children run                                  | `coordinatorRunner`          |
| Coordinator loop until `done: true`                                     | `coalescingRunner`           |
| Conditional routing based on task metadata                              | `branchRunner`               |
| Convener → parallel members → retrospective loop (iterative fix rounds) | `retrospectiveCouncilRunner` |

### Composability

All runners return `SessionPlanFactory`. They nest freely — e.g. a `branchRunner` branch can
contain a `reviewRunner`, whose execute step is a `mapRunner`, whose items are `singleSession`
runners. `delegateToChild` propagates `.return()` from parent to child so resource cleanup
runs at every depth, and the `SessionGate` enforces the global concurrency cap regardless of
nesting.

## Pool-level hooks

The scheduler consumes the engine's hook system at a single seam:

### `beforeTask` (first-wins, fires in `resolveRunner`)

For each task being initialized, `resolveRunner` invokes the `beforeTask` first-wins hook
seeded with `{ task }` when a scoped `hookRegistry` with at least one subscriber is present.
A subscriber may return:

- `{ skip: true }` → the task is **cancelled** in the graph; no runner executes, no worktree
  is created, no merge lifecycle fires.
- `{ runner: ... }` → **override** the resolved runner.
- `undefined` → **abstain**; `entry.runnerFactory()` resolves normally.

Results are cached per task so `beforeTask` fires exactly once.

See [Hooks](hooks.md) for the full composition model and the catalog of influence/observe
hooks.

## Where to go next

- [Building a new workflow](../guides/building-workflows.md) — using `SessionScheduler` and
  composable runners.
- [Event store & status](event-store.md) — what every lifecycle callback becomes.
- [Hooks](hooks.md) — the full hook catalog, composition rules.
- [Worktrees](worktrees.md) — per-task git worktree isolation.
- [Types reference](types.md) — `SessionSchedulerOptions`, `SessionSpec`, `SessionPlanContext`.
