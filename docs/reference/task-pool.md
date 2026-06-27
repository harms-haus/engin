# Task pool & execution

The pool layer (`packages/engine/src/pool/`) executes tasks concurrently. A `RunnerPool`
claims tasks from a shared `TaskTracker` and dispatches each to a **Runner** function. The
runner composes one or more agent **sessions** via the session primitive (`runSession`),
gating concurrency through a **`SessionGate`**. Every session is one agent prompt turn.

This document covers the `TaskTracker` (write model), the `RunnerPool` executor, the
`SessionGate` concurrency authority, the session primitive, the runner contract, the
built-in composable runners, and the retry valve.

## `TaskTracker` — the write model

Source: `packages/engine/src/tracking/task-status.ts`. Manages a collection of `Task` objects with a DAG of
dependencies. Enforces state transitions and detects cycles. Extends `EventEmitter`.

```typescript
class TaskTracker extends EventEmitter {
  static readonly Events: {
    TaskReady: 'taskReady';
    TaskSettled: 'taskSettled';
    TaskClaimed: 'taskClaimed';
  };

  addTask(task: Omit<Task, 'status'> & { status?: TaskStatus }): void;
  getTask(id: string): Task | undefined;
  getAllTasks(): Task[];
  getReadyTasks(): Task[];
  getFailedTasks(): Task[];
  getTasksByPhase(phaseId: string): Task[];
  getPhases(): string[];
  claimTasks(count: number, agentId: string): Task[];
  completeTask(id: string, result?: unknown): void;
  failTask(id: string, result?: unknown): void;
  rejectTask(id: string, reason: string): void;
  cancelTask(id: string): void;
  resetFailedTasks(): void;
  resetStuckTasks(): void;
  resetTaskForRetry(id: string): void;
  resetForRetry(): void;
  recalculateStatuses(hintTaskId?: string): void;
  isPoolDone(): boolean;
  validateAllDependencies(): void;
  getTransitiveDependentCount(id: string): number;
  toJSON(): { tasks: Task[] };
  static fromJSON(data: { tasks: Task[] }, options?: { preserveState?: boolean }): TaskTracker;
}
```

### Task lifecycle

```
blocked → ready → active → complete
                    │
                    ├─→ failed
                    └─→ (rejectTask: stays active, appends feedback, retries)
```

Any non-settled task can be cancelled (`→ cancelled`). **Settled** = `complete | failed |
cancelled`.

### Methods

- **`addTask(task)`** — Throws on duplicate IDs. Auto-derives status: `ready` if all
  dependencies are present and settled, otherwise `blocked`. Performs a temporary insertion to
  check for cycles, rolling back and throwing if one is detected. Then `recalculateStatuses`.
- **`getReadyTasks()`** — Filters `status === 'ready'`, sorted by **transitive blocking
  pressure** (descending) — tasks that unblock more downstream work are claimed first. Ties
  preserve insertion order (first-added first-served, via stable sort).
- **`getFailedTasks()`** — Returns only `failed` tasks via a maintained index (O(failed), not
  O(N)).
- **`claimTasks(count, agentId)`** — Returns up to `count` ready tasks, mutating each in place
  to `status='active'`, `assignedAgent=agentId`. Returns **live references** (so runners can
  append `reviewFeedback` across retries — the only safe external mutation). Emits `TaskClaimed`
  on the next microtask if anything was claimed.
- **`completeTask(id, result?)`** — Throws if not found or not `active`. Sets `complete`,
  stores `result`, recalculates, emits `TaskSettled`.
- **`failTask(id, result?)`** — Throws if not found or not `active`. Sets `failed`, stores
  `result`, clears `assignedAgent`, adds to the failed index, recalculates, emits `TaskSettled`.
- **`rejectTask(id, reason)`** — Throws if not found or not `active`. Appends the reason to
  `reviewFeedback`. **The task stays `active`** (the pool still owns it). Emits `TaskReady`.
- **`cancelTask(id)`** — Throws if not found or already settled. Sets `cancelled`, emits
  `TaskSettled`.
- **`resetTaskForRetry(id)`** — Throws unless task is `failed`. Resets to `ready`, clears
  `assignedAgent`/`result`/`reviewFeedback`, removes from failed index, emits `TaskReady`. Used
  by the `RunnerPool` retry valve.
- **`resetFailedTasks()` / `resetStuckTasks()` / `resetForRetry()`** — Re-arm `failed` tasks,
  `active` tasks, or both, back to `ready`.
- **`isPoolDone()`** — `true` when empty, or when every task is settled **or** deadlocked
  (`blocked` with at least one missing dependency). **Side effect:** mutates deadlocked tasks to
  `failed` with `result.error` starting with `'deadlocked:'` (idempotent via `warnedDeadlocked`).
  Returns `false` if any task is `ready`/`active`, or `blocked` with all deps present.
- **`validateAllDependencies()`** — Throws listing each task with missing dependency IDs.
  Cycles are caught at insert time.
- **`fromJSON(data, options?)`** — Rebuild reverse-deps + failed index, run cycle detection on
  every id, then (unless `preserveState`) `resetForRetry()`. Always `recalculateStatuses()`.

### Two views of rejection

`rejectTask` keeps the task `active` on the write model — the pool still owns it and will
retry. The corresponding `task_rejected` event maps to status `failed` in the projection (read
model). Both are correct for their audience. See
[Architecture → Write model vs read model](../concepts/architecture.md#write-model-vs-read-model).

## `RunnerPool` — the executor

Source: `packages/engine/src/pool/runner-pool.ts`. Replaces the old `LanePool` + `Scheduler`
with a simpler drain-loop model. There are no lanes, no lane workers, no scheduler hooks.

```typescript
class RunnerPool {
  constructor(options: RunnerPoolOptions);
  run(): Promise<{ completedTasks: number; failedTasks: number }>;
}
```

### `RunnerPoolOptions`

| Field                   | Required | Description                                                                                                                                                         |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrentSessions` | **Yes**  | Hard cap on concurrent in-flight sessions across ALL models. Passed to `SessionGate` as the `total` limit.                                                          |
| `modelConcurrency`      | **Yes**  | Per-model concurrency caps keyed by `${provider}:${model}` (or `${provider}:${model}:${agent}`). Passed to `SessionGate` as the `perModel` map.                     |
| `profilesDirs`          | **Yes**  | Directories containing `.md` profiles.                                                                                                                              |
| `sessionBaseDir`        | **Yes**  | Base directory for persisted session storage (`{base}/{sessionId}/`).                                                                                               |
| `cwd`                   | **Yes**  | Working directory.                                                                                                                                                  |
| `taskTracker`           | **Yes**  | Shared `TaskTracker` the pool claims from.                                                                                                                          |
| `phaseId`               | **Yes**  | The phase this pool serves.                                                                                                                                         |
| `getRunnerForTask`      | No       | `(task: Task) => Runner`. The sole runner resolution path (no `getStepsForTask`). If absent or returns `undefined`, the task fails with `"No runner for task"`.     |
| `apiKeys?`              | No       | Provider → API key overrides.                                                                                                                                       |
| `onStatus?`             | No       | Status callbacks.                                                                                                                                                   |
| `auditLog?`             | No       | Audit log. When present alongside `hookRegistry`, `RunnerPool.run()` auto-registers the default auditor so `structured_output` / `decision` events land in the log. |
| `maxTaskRetries?`       | No       | Max times a failed task is retried within one pool run. Total attempts = `1 + maxTaskRetries`. Default `0` (no retries).                                            |
| `stepTimeoutMs?`        | No       | Per-prompt watchdog timeout in milliseconds. Forwarded as `watchdogTimeoutMs` to sessions.                                                                          |
| `signal?`               | No       | Abort signal.                                                                                                                                                       |
| `rendererRegistry?`     | No       | Optional registry of custom output renderers keyed by profile name.                                                                                                 |
| `hookRegistry?`         | No       | Optional registry of workflow hooks. Forwarded to runners via `RunnerContext.hookRegistry`.                                                                         |
| `worktreeManager?`      | No       | `WorktreeManager` for per-task git worktree isolation. When set, tasks with `worktree === 'code'` get their own worktree.                                           |
| `gate?`                 | No       | Pre-constructed `SessionGate`. Defaults to `new SessionGate({ total: maxConcurrentSessions, perModel: modelConcurrency }, signal)`.                                 |

### How `run()` works — the drain-loop model

1. **Early-out** on `signal?.aborted` or an empty tracker (returns zeros **without loading
   profiles or creating a gate**).
2. **Clone the hook registry.** A scoped clone of `options.hookRegistry` is created so
   pool-internal subscriber registrations never mutate the original.
3. **Register tasks.** Fire `onTaskRegister` **once per task** (`taskId`, `phaseId`, `title`,
   `dependencies`). No step layout is emitted — the projection's `TaskEntity` has no `steps`
   field.
4. **Load profiles.** `clearProfileCache()` then `loadProfilesFromDirs(profilesDirs)` — loaded
   fresh on every `run()`.
5. **Register abort listener** on the signal that aborts every active session.
6. **Register the default auditor** (when both `auditLog` and `hookRegistry` are present) as a
   subscriber for `onStructuredOutput` and `onDecision` **before** any tasks start.
7. **Deadlock observer.** A `TaskSettled` listener surfaces deadlocked tasks
   (`result.error` starts with `'deadlocked:'`) via `onTaskRejected`.
8. **Drain loop:**

```
while (true):
  if aborted → break
  claim all ready tasks (claimTasks(N, 'runner-pool'))
  for each claimed task → start processTask coroutine (unbounded)
  if no inflight coroutines:
    trigger deadlock detection (isPoolDone)
    flush microtask queue (so deadlocked TaskSettled fires)
    break
  await Promise.race(inflight)  // wait for first settlement, then re-loop
drain remaining inflight (Promise.allSettled)
```

All ready tasks are claimed and their runner coroutines started immediately (unbounded). The
`SessionGate` is the **sole concurrency cap** — runners gate themselves via
`ctx.gate.run(profile, fn)` so at most `maxConcurrentSessions` sessions execute simultaneously;
the rest block inside the gate FIFO. There is **no per-lane worker** and **no scheduler**.

### How `processTask` works

Each claimed task (`agentId = runner-{taskId}`) goes through:

1. **Fire `onTaskStart`** with `{ taskId, title, agentId, phaseId, startedAt }`.
2. **Resolve runner** via `resolveRunner`:
   - If a scoped `hookRegistry` with `beforeTask` subscribers is present, invoke the
     first-wins hook seeded with `{ task }`. A subscriber may return `{ skip: true }` (cancels
     the task), `{ runner }` (overrides), or `undefined` (abstain).
   - Otherwise, `getRunnerForTask(task)` is called.
   - If no runner is resolved, the task fails with `"No runner for task"`.
3. **Per-task worktree** (when `worktreeManager` is set and `task.worktree === 'code'`):
   create a per-task worktree via `createTaskWorktree(task.id, task.prompt, task)`; set
   `worktreeCwd` so the runner's sessions execute inside the isolated branch.
4. **Build `RunnerContext`** — see [Runner contract](#runner-contract) below.
5. **Invoke the runner** (`await runner(ctx)`). `SessionError` propagating from a runner is
   captured with its `classification` threaded to the retry valve. Other thrown errors are
   caught and become `{ status: 'failed', error }`.
6. **Handle outcome:**
   - `{ status: 'completed' }` → if a worktree was created, merge the task branch first
     (`mergeTaskBranch`); a failed merge downgrades to `failed` (non-retriable). On success,
     `safeComplete` + `onTaskComplete`.
   - `{ status: 'failed', error }` → `safeFail`, report error, invoke the retry valve.

### Retry valve (`maybeRetry`)

After a task fails, the pool decides whether to retry:

1. If the failure is **non-retriable** (e.g. merge failure) → preserve worktree, emit
   `onDecision`, do not retry.
2. If a `worktreeManager` is set → cull the task worktree (failed branch is never leaked).
3. **Classify the error** using the propagated `SessionError.classification` (when available)
   or `classify(reason)` from the message text.
4. **Permanent / abort errors** are not retried. **Transient / empty / unknown** errors ARE
   retried (subject to budget). This differs from the old `LanePool` which treated `unknown` as
   non-retriable — `RunnerPool` treats it as retryable-by-default since runner outcomes may not
   carry a labeled classification.
5. If `maxTaskRetries` budget remains → apply exponential backoff (`classification.delayMs`
   or `min(2000 * 2^used, 30000)`), abortable via `signal`. Clear persisted sessions
   (`clearTaskSessions`), reset the task to `ready` (`resetTaskForRetry`), emit `onDecision`.
   The drain loop re-claims and re-runs it.
6. If budget exhausted → task stays `failed`.

## `SessionGate` — concurrency authority

Source: `packages/engine/src/pool/session-gate.ts`. A two-level (total + per-model) FIFO gate
with RAII semantics. There is **no manual acquire/release API** — callers use
`gate.run(profile, fn)`.

```typescript
class SessionGate {
  constructor(options: SessionGateOptions, signal?: AbortSignal);
  run<R>(
    profile: { provider: string; model: string; agent?: string },
    fn: (handle: { signal: AbortSignal }) => Promise<R>,
  ): Promise<R>;
}
```

### `SessionGateOptions`

| Field      | Type                     | Description                                                                        |
| ---------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `total`    | `number`                 | Hard cap on concurrent in-flight callbacks across ALL models.                      |
| `perModel` | `Record<string, number>` | Per-model caps keyed by `${provider}:${model}` or `${provider}:${model}:${agent}`. |

### How it works

- **Lock ordering:** total slot acquired first, then per-model; released per-model first, then
  total (reverse order) — prevents circular-wait.
- **`tryAcquire(modelKey)`** is synchronous (JS is single-threaded → atomic). On success both
  counters decrement. Fast path: both slots free synchronously.
- **`dispatch()`** scans each model queue head and admits any FIFO waiter whose model has
  capacity AND total has capacity. Resolves waiters on the next microtask.
- **Model key resolution:** prefers the 3-part key `${provider}:${model}:${agent}` when an
  agent is set AND a cap exists for it; otherwise falls back to the 2-part key.
- **AbortSignal handling:** pre-queue abort removes the waiter from its FIFO and rejects with
  `AbortError`. An already-aborted gate rejects immediately. A waiter that wakes only to
  discover it's been aborted releases its slot and rejects.
- **`DeadlockError`** guard: a synchronous re-entrant `run()` on the same gate while holding
  the last total slot is detected and rejected.
- **RAII:** the `release` callback is idempotent (via a `called` flag) and always runs in a
  `finally` block.

## The session primitive (`runSession`)

Source: `packages/engine/src/pool/session.ts`. The single-step session primitive. Encapsulates
the full agent session lifecycle for one prompt turn:

```typescript
async function runSession(ctx: RunSessionContext): Promise<SessionResult>;
function clearTaskSessions(sessionBaseDir: string, taskId: string): void;
```

### `SessionSpec`

The specification for a single agent session.

| Field         | Type         | Description                                                                           |
| ------------- | ------------ | ------------------------------------------------------------------------------------- |
| `id`          | `string`     | Unique session identifier (used for persistence path).                                |
| `profile`     | `string`     | Agent profile ID (resolved against `ctx.profiles`).                                   |
| `prompt`      | `string`     | The prompt text sent to the agent.                                                    |
| `schema?`     | `ZodType`    | Optional Zod schema for structured output mode.                                       |
| `outputMode`  | `OutputMode` | `'text' \| 'structured' \| 'filesystem'` — how the response is interpreted.           |
| `isReadOnly?` | `boolean`    | When true, write/edit tools are stripped.                                             |
| `runnerRole`  | `string`     | Role label for the runner (e.g. `'executor'`, `'reviewer'`). Propagated to callbacks. |
| `attempt`     | `number`     | 1-based attempt number. Propagated to callbacks.                                      |

### `SessionResult`

```typescript
type SessionResult =
  | { mode: 'text'; text: string }
  | { mode: 'structured'; data: unknown }
  | { mode: 'filesystem'; files: string[] };
```

### `SessionError`

Thrown by `runSession` on any failure. Carries a structured `Classification` (kind: `'permanent'`
| `'transient'` | `'abort'` | `'empty'` | `'unknown'`; `retryable: boolean`) and a `transient` shortcut.

### `RunSessionContext`

| Field                 | Type                              | Description                                                                   |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `spec`                | `SessionSpec`                     | The session specification to execute.                                         |
| `sessionBaseDir`      | `string`                          | Base directory for persisted session storage.                                 |
| `cwd`                 | `string`                          | Working directory for agent operations.                                       |
| `worktreeCwd?`        | `string`                          | Per-task worktree path. When set, the agent runs inside the worktree.         |
| `phaseId`             | `string`                          | Phase identifier for callbacks.                                               |
| `agentId`             | `string`                          | Agent identifier for callbacks.                                               |
| `apiKeys?`            | `Record<string, string>`          | API key overrides.                                                            |
| `onStatus?`           | `StatusCallbacks`                 | Callbacks (`onSessionStart` / `onSessionComplete` + agent-status forwarding). |
| `activeSessions`      | `Set<{ abort(): Promise<void> }>` | Mutable set for cooperative abort.                                            |
| `profiles`            | `Map<string, AgentProfile>`       | Resolved profiles.                                                            |
| `signal?`             | `AbortSignal`                     | Cooperative cancellation.                                                     |
| `watchdogTimeoutMs?`  | `number`                          | Activity-based idle timeout.                                                  |
| `watchdogMaxResumes?` | `number`                          | Max internal retries on watchdog timeout before permanent error.              |

### Lifecycle

1. **Pre-abort check** — rejects immediately if `signal.aborted`.
2. **Path traversal validation** — `spec.id` is validated against traversal attacks (each
   `/`-delimited segment checked).
3. **Idempotency** — if `.complete` sentinel + valid `result.json` exist → return cached result.
   Corrupt cache (checksum/length mismatch) → permanent `SessionError`.
4. **Execute** — `executeAttempt`:
   - Clear partial state, `mkdir` session directory.
   - Resolve profile (read-only adjustment: add `write`/`edit` to `excludeTools`).
   - Create session directly via `requireAgentPlugin(profile.agent).createSession(...)`.
   - Register on `activeSessions` immediately (before any `await`).
   - Arm watchdog timer (resets on `turn_start`, `tool_execution_start`, `turn_end`).
   - Fire `onSessionStart`.
   - Execute by output mode (text / structured / filesystem).
   - Persist result atomically (`result.json` + `.complete` with SHA-256 checksum + directory fsync).
   - Fire `onSessionComplete`.
   - Cleanup in `finally`: clear watchdog, unsubscribe, remove from `activeSessions`, dispose session.
5. **Watchdog retry** — when both `watchdogTimeoutMs` and `watchdogMaxResumes` are set, internal
   retry re-creates the session up to `maxResumes` times before throwing a permanent error.

## Runner contract

Source: `packages/engine/src/pool/runners/types.ts`.

```typescript
type TaskOutcome = { status: 'completed' } | { status: 'failed'; error?: string };

interface RunnerContext {
  task: Task;
  gate: SessionGate;
  runSession: (ctx: RunSessionContext) => Promise<SessionResult>;
  profiles: Map<string, AgentProfile>;
  sessionBaseDir: string;
  cwd: string;
  worktreeCwd?: string;
  apiKeys?: Record<string, string>;
  activeSessions: Set<{ abort(): Promise<void> }>;
  onStatus?: StatusCallbacks;
  hookRegistry?: HookRegistry;
  rendererRegistry?: RendererRegistry;
  auditLog?: AuditLog;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  phaseId: string;
  agentId: string;
  maxTaskRetries?: number;
}

type Runner = (ctx: RunnerContext) => Promise<TaskOutcome>;
```

A runner receives a `RunnerContext` and returns a `TaskOutcome`. Runners **must not re-throw**
— all errors are caught and surfaced via `{ status: 'failed', error }`. The `RunnerPool` catch
block is a safety net for truly unexpected errors.

### Key design points

- **No `completeTask`/`failTask` callbacks.** The runner returns an outcome; the pool settles
  the task. This is a simplification from the old `TaskRunnerContext`.
- **`ctx.runSession` is a passthrough** to the session primitive. The pool does NOT re-gate
  `runSession` — runners call `ctx.gate.run` internally for each session (via
  `runSessionViaGate`).
- **`SessionError` propagation.** A `SessionError` thrown from `runSession` is allowed to
  propagate through the runner to the pool, carrying its `classification` for the retry valve.
  Unexpected non-`SessionError` throws are caught and surfaced as a minimal text result so the
  runner can decide the outcome.

### `runSessionViaGate(ctx, spec)` — shared runner helper

Source: `packages/engine/src/pool/runners/utils.ts`. The standard pattern for all built-in
runners: resolve the profile from `ctx.profiles`, acquire a concurrency slot via
`ctx.gate.run(profile, fn)`, and call `ctx.runSession` inside the gate callback. The gate's
`handle.signal` is passed as `RunSessionContext.signal` for cooperative cancellation.

## Built-in runners

All factories are in `packages/engine/src/pool/runners/`. Each returns a `Runner` function.

---

#### `singleSession(spec)`

```typescript
import { singleSession } from '../pool/runners/single-session.js';

const runner = singleSession({
  role: 'execute',
  profile: 'coder',
  prompt: 'Implement the function',
  outputMode: 'text',
  isReadOnly: false,
});
```

Runs exactly one session via the session primitive. Session ID: `{taskId}/{role}#{attempt}`.
Returns `{ status: 'completed' }` on success; rethrows `SessionError` on failure (the pool
catches it).

---

#### `linearRunner(children)`

```typescript
import { linearRunner } from '../pool/runners/linear-runner.js';

const runner = linearRunner([childA, childB, childC]);
```

Runs children in strict sequential order. If any child returns `{ status: 'failed' }`, the
runner short-circuits and returns that outcome immediately, skipping all remaining children.
A pure ordering/short-circuit combinator over arbitrary `Runner` functions.

---

#### `parallelRunner(children)`

```typescript
import { parallelRunner } from '../pool/runners/parallel-runner.js';

const runner = parallelRunner([childA, childB]);
```

Starts ALL children as independent coroutines and awaits them together via
`Promise.allSettled`. If any child returns `{ status: 'failed' }`, returns that outcome (the
first failed by array index). Siblings are **not** cancelled — they complete naturally and
their gate slots release on their own. Deadlock-free: no child holds a resource while waiting
for another.

---

#### `reviewRunner(executeSpec, reviewSpec, options?)`

```typescript
import { reviewRunner } from '../pool/runners/review-runner.js';

const runner = reviewRunner(
  { role: 'execute', profile: 'coder', prompt: 'Write the code', outputMode: 'filesystem' },
  { role: 'review', profile: 'reviewer', prompt: 'Review the code', outputMode: 'structured', schema: reviewSchema },
  { maxRounds: 5 },
);
```

Implements the execute→review loop. For each round (1..`maxRounds`, default `DEFAULT_MAX_ROUNDS`
= 3):

1. Run the execute session (`{taskId}/execute#{round}`), with accumulated feedback appended.
2. Feed the execute result into the review prompt.
3. Run the review session (`{taskId}/review#{round}`, structured output).
4. If `reviewData.approved === true` → return `{ status: 'completed' }`.
5. Otherwise collect feedback and continue.
6. `maxRounds` exhausted → `{ status: 'failed', error }`.

Transient `SessionError` in execute/review → retry-in-place (same round). Permanent → fail.

---

#### `councilRunner(workers, synthesizer)`

```typescript
import { councilRunner } from '../pool/runners/council-runner.js';

const runner = councilRunner(
  [
    {
      id: `${taskId}/worker[0]#1`,
      profile: 'architect',
      prompt: '...',
      outputMode: 'structured',
      schema: zSchema,
      runnerRole: 'worker',
      attempt: 1,
    },
    {
      id: `${taskId}/worker[1]#1`,
      profile: 'engineer',
      prompt: '...',
      outputMode: 'structured',
      schema: zSchema,
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

Runs N worker sessions in parallel (each as an independent `gate.run` coroutine, awaited
together via `Promise.allSettled`). Successful worker results are concatenated into the
synthesizer prompt. Failed workers are silently omitted. If ALL workers fail →
`{ status: 'failed' }` (synthesizer not called). The synthesizer runs after all workers settle.

---

#### `mapRunner(options)`

```typescript
import { mapRunner } from '../pool/runners/map-runner.js';

const runner = mapRunner({
  items: ['file1.ts', 'file2.ts', 'file3.ts'],
  sessionSpec: { role: 'process', profile: 'formatter', prompt: 'Format this file', outputMode: 'filesystem' },
  concurrency: 3,
});
```

Fans out over a collection, running one session per item. Session ID:
`{taskId}/map[{index}].{role}#{attempt}`. Per-item prompt: `spec.prompt + "\n\nItem: " + JSON.stringify(item)`.
When `concurrency` is set, a local worker-pool of that size serializes items; otherwise all
items run in parallel. Uses `Promise.allSettled` — all sessions settle even on partial failure
(no leak). All succeed → `{ status: 'completed' }`; any fail → `{ status: 'failed' }`.

---

#### `branchRunner(options)`

```typescript
import { branchRunner } from '../pool/runners/branch-runner.js';

const runner = branchRunner({
  branches: [
    { condition: (ctx) => ctx.task.prompt.includes('fix'), runner: fixRunner },
    { condition: (ctx) => ctx.task.prompt.includes('feature'), runner: featureRunner },
  ],
  default: triageRunner,
});
```

Evaluates `branches` in order; the first whose `condition(ctx)` returns true wins and its
runner executes. Conditions can be async (both sync and async are awaited). First truthy result
short-circuits. If no branch matches and a `default` runner is provided, it runs. Otherwise the
task fails with `{ status: 'failed', error: 'No branch matched' }`.

---

#### `coordinatorRunner(coordinatorSpec, opts)`

```typescript
import { coordinatorRunner } from '../pool/runners/coordinator-runner.js';

const runner = coordinatorRunner(coordinatorSpec, {
  childRunner: (coordinatorResult) => buildChildRunner(coordinatorResult),
});
```

Runs a coordinator session (structured output), fully awaits it, then delegates to
`opts.childRunner(coordinatorResult)` — a factory that returns a `Runner` for the children. The
coordinator must fully persist before any child is invoked (enforced by serial `await`).

---

#### `coalescingRunner(coordinatorSpec, opts)`

```typescript
import { coalescingRunner } from '../pool/runners/coalescing-runner.js';

const runner = coalescingRunner(coordinatorSpec, {
  childRunner: (data) => buildChildRunner(data),
  maxRounds: 5,
});
```

Runs a coordinator → children → coordinator loop. Each round:

1. Run coordinator session (`{taskId}/coordinator#{round}`).
2. Parse structured output: `{ done: boolean, children?: unknown[], feedback?: string }`.
3. `done === true` → `{ status: 'completed' }`.
4. Otherwise, run children via `opts.childRunner(data)`.
5. If children fail → propagate the failure. Otherwise continue to next round.
6. `maxRounds` exhausted (default `DEFAULT_MAX_ROUNDS`) → `{ status: 'failed' }`.

### Decision guide

| Pattern                                    | Runner              |
| ------------------------------------------ | ------------------- |
| One session, done                          | `singleSession`     |
| Sequential pipeline, fail on first error   | `linearRunner`      |
| Parallel fan-out, fail on first error      | `parallelRunner`    |
| Execute → review → fix loop                | `reviewRunner`      |
| Multiple workers merged by a synthesizer   | `councilRunner`     |
| Fan-out over a collection of items         | `mapRunner`         |
| Conditional routing based on task metadata | `branchRunner`      |
| Coordinator decides, then children run     | `coordinatorRunner` |
| Coordinator loop until `done: true`        | `coalescingRunner`  |

### Composability

All runners return `Runner` functions. They nest freely — e.g. a `branchRunner` branch can
contain a `reviewRunner`, whose execute step is a `mapRunner`, whose items are `singleSession`
runners. Each child runner uses `ctx.gate.run` independently, so the `SessionGate` enforces the
global concurrency cap regardless of nesting depth.

## Pool-level hooks

The pool layer consumes the engine's hook system at a single seam:

### `beforeTask` (first-wins, fires in `resolveRunner`)

For each claimed task, `resolveRunner` invokes the `beforeTask` first-wins hook seeded with
`{ task }` when a scoped `hookRegistry` with at least one subscriber is present. A subscriber
may return:

- `{ skip: true }` → the task is **cancelled** in the tracker; no runner executes, no worktree
  is created, no merge lifecycle fires.
- `{ runner: ... }` → **override** the resolved runner.
- `undefined` → **abstain**; `getRunnerForTask` resolves normally.

### `auditLog` + the default auditor (registered by `RunnerPool.run()`)

When `RunnerPool.run()` is constructed with **both** `auditLog` and `hookRegistry`, it
registers the default auditor as a subscriber for `onStructuredOutput` and `onDecision`
**before** starting tasks. Because both are **observe** hooks (fan-out), a workflow that
provides its own subscribers under the same names sees **both** fire — no manual
`auditLog.append` call required.

See [Hooks](hooks.md) for the full composition model and the catalog of influence/observe hooks.

## Validation

Source: `packages/engine/src/pool/validation.ts` and `packages/engine/src/pool/severity.ts`.

- **`assertSafeName(value, label)`** — Throws unless `value` matches `^[a-zA-Z0-9_-]+$`. Used
  on task IDs that appear in file paths.
- **`Severity`** — `'critical' | 'high' | 'medium' | 'low'`.
- **`isFailingSeverity(severity)`** — True for `critical` or `high`.
- **`extractSeverity(output)`** — Reads `output.severity` if it is a string; otherwise
  `'medium'`.

## Where to go next

- [Building a new workflow](../guides/building-workflows.md) — using `RunnerPool` and
  composable runners.
- [Event store & status](event-store.md) — what every lifecycle callback becomes.
- [Hooks](hooks.md) — the full hook catalog, composition rules.
- [Types reference](types.md) — `RunnerPoolOptions`, `TaskOutcome`, `SessionSpec`,
  `RunnerContext`.
