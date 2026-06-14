# Task pool & execution

The pool layer (`src/pool/`) executes tasks concurrently. A `LanePool` spins up N workers
("lanes") that each claim tasks from a shared `TaskTracker` and process them through a
configurable sequence of steps, with reviewer feedback loops. Every step is one agent.

This document covers the `TaskTracker` (write model), the `LanePool` executor, step execution
and retries, and the prompt builder.

## `TaskTracker` — the write model

Source: `src/tracking/task-status.ts`. Manages a collection of `Task` objects with a DAG of
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
  getTasksByPhase(phaseId: string): Task[];
  getPhases(): string[];
  claimTasks(count: number, agentId: string): Task[];
  completeTask(id: string): void;
  failTask(id: string, result?: unknown): void;
  rejectTask(id: string, reason: string): void;
  cancelTask(id: string): void;
  resetFailedTasks(): void;
  resetStuckTasks(): void;
  resetForRetry(): void;
  recalculateStatuses(hintTaskId?: string): void;
  isPoolDone(): boolean;
  validateAllDependencies(): void;
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
- **`getReadyTasks()`** — Filters `status === 'ready'`, sorted by
  `(dependencies.length asc, id asc)`.
- **`claimTasks(count, agentId)`** — Returns up to `count` ready tasks, mutating each in place
  to `status='active'`, `assignedAgent=agentId`. Returns **live references** (so lanes can
  append `reviewFeedback` across retries — the only safe external mutation). Emits `TaskClaimed`
  on the next microtask if anything was claimed.
- **`completeTask(id)`** — Throws if not found or not `active`. Sets `complete`,
  recalculates, emits `TaskSettled`.
- **`failTask(id, result?)`** — Throws if not found or not `active`. Sets `failed`, stores
  `result`, clears `assignedAgent`, recalculates, emits `TaskSettled`.
- **`rejectTask(id, reason)`** — Throws if not found or not `active`. Appends the reason to
  `reviewFeedback`. **The task stays `active`** (the lane still owns it). Emits `TaskReady`.
- **`cancelTask(id)`** — Throws if not found or already settled. Sets `cancelled`, emits
  `TaskSettled`.
- **`resetFailedTasks()` / `resetStuckTasks()` / `resetForRetry()`** — Re-arm `failed` tasks,
  `active` tasks, or both, back to `ready` (clearing `assignedAgent`/`result`/`reviewFeedback`
  where applicable).
- **`isPoolDone()`** — `true` when empty, or when every task is settled **or** deadlocked
  (`blocked` with at least one missing dependency). Warns once per deadlocked task. Returns
  `false` if any task is `ready`/`active`, or `blocked` with all deps present.
- **`validateAllDependencies()`** — Throws listing each task with missing dependency IDs.
  Cycles are caught at insert time.
- **`fromJSON(data, options?)`** — Rebuild reverse-deps, run cycle detection on every id, then
  (unless `preserveState`) `resetForRetry()`. Always `recalculateStatuses()`.

### Two views of rejection

`rejectTask` keeps the task `active` on the write model — the lane still owns it and will
retry the previous step. The corresponding `task_rejected` event maps to status `failed` in
the projection (read model). Both are correct for their audience. See
[Architecture → Write model vs read model](../concepts/architecture.md#write-model-vs-read-model).

## `LanePool` — the executor

Source: `src/pool/lane-pool.ts`.

```typescript
class LanePool {
  constructor(options: LanePoolOptions);
  run(): Promise<LanePoolResult;
}
```

### How `run()` works

1. **Early-out** on `signal?.aborted` (returns zeros) or an empty tracker (returns zeros
   **without loading profiles or spawning lanes**).
2. **Register tasks.** Fire `onTaskRegister` **once per task**, **before** profile loading and
   before spawning any lanes. For each task it computes the steps via `getStepsForTask` and
   maps them to `{ name, profileId, isReadOnly }`. This lets the UI render the full task
   layout immediately.
3. **Load profiles.** `clearProfileCache()` then `loadProfilesFromDirs(profilesDirs)` — loaded
   fresh on every `run()`.
4. **Register an abort listener** on the signal that aborts every active session.
5. **Spawn lanes.** `maxConcurrentLanes` workers run in parallel via `Promise.allSettled`. Lane
   failures are isolated and reported via `onError` (agentId `lane-<index>`).
6. **Result counts.** Filter `getAllTasks()` by `status === 'complete'` and `=== 'failed'`.

### How a lane works

Each lane (`agentId = lane-<index>`) runs a loop:

1. **Wire wait sources first** — register `TaskReady`/`TaskSettled` listeners, an abort
   listener, and a `setTimeout(..., laneWaitTimeoutMs)` **before** the completion check (this
   closes a TOCTOU gap).
2. **Check `isPoolDone()` before `claimTasks`** — a completed task is never re-armed.
3. `claimTasks(1, agentId)`.
4. **If claimed** — clean up wait sources, reset the consecutive-timeout counter, and
   `processTask(...)`. On throw, report the error and safely fail the task.
5. **If nothing claimed** — `await wakePromise` (resolves on a task event, the timeout, or
   abort).

There is **no exponential backoff**. The lane idle poll is a fixed `laneWaitTimeoutMs`
(default `60000` ms). A lane warns **once** if it stalls for `STALL_WARN_THRESHOLD` (5)
consecutive timeouts.

## Step execution and retries

Source: `src/pool/task-processor.ts` and `src/pool/step-execution.ts`.

### `processTask(task, agentId, profiles, ctx)`

Runs a task's ordered steps. Defaults: `maxStepRetries = options.maxStepRetries ?? 5`. If there
are no steps, the task fails with `'No steps defined for task'`.

Per-step state maps track the rejection count (`stepAttempts`), execution count
(`stepExecutions`), and persisted session (`taskSessions`) for each step index.

The loop:

1. Fire `onTaskStart` once at the start (with `phaseId`).
2. For the current step, fire `onStepStart`, then `runStep(...)`. Any existing session for the
   step is passed in as `existingSessionPath` for resume; after the run, the old session is
   disposed and replaced.
3. **On approval** — capture the output, advance `currentStepIndex`.
4. **On rejection**:
   - `appendReviewFeedback(task, feedback)`.
   - Increment `stepAttempts` for the current step.
   - Fire `onDecision` with `decision: 'Step "<name>" rejected (attempt <n>/<max>), retrying'`
     and `reasoning: feedback`.
   - If attempts hit the limit:
     - If `severity` (from `extractSeverity`) is `critical` or `high` → fire `onTaskRejected`
       and fail the task.
     - Otherwise → try to submit the task as complete (with feedback attached); if submission
       fails, fail it.
     - Dispose all sessions, return.
   - Otherwise → `currentStepIndex = Math.max(0, currentStepIndex - 1)`: **back up exactly one
     step** (clamped at 0) so the previous step re-runs with the feedback appended to its
     prompt.
5. **All steps approved** — dispose sessions, submit as complete. On success fire
   `onTaskComplete`; on failure fail the task.

### `runStep(task, step, agentId, ctx, profiles, execCtx, existingSessionPath?)`

Runs a single step. The session directory is
`{sessionBaseDir}/{taskId}/{execCount}-{stepIndex}-{step.name}` — note the first segment is
the per-step **execution count**, not the rejection attempt.

- **Read-only steps** add `write`/`edit` to the profile's `excludeTools` (deduplicated).
- **Resume** — if `existingSessionPath` is provided, the harness is created with
  `resumeSessionPath` instead of `sessionDir`.
- The session is added to `activeSessions` **before** `onAgentSpawn` fires, so an abort between
  the two yields an `onAgentComplete` with no matching `onAgentSpawn` (a known edge case).
- **Structured step** (`schema` present) — `promptForStructured(session, prompt, schema,
{ maxRetries: attempt === 0 ? 3 : 1 })`. On structured-output failure, the step returns a
  **fail-safe critical rejection** rather than throwing.
  - `isApproved(result)` defaults to `result.approved === true`.
  - `getFeedback(result)` defaults to `result.feedback ?? 'No feedback provided'`.
- **Non-structured step** — always `{ type: 'approved', output: session.getLastAssistantText() }`.
- On exception, the session is disposed (errors logged, not re-thrown) and the original error
  re-thrown. In `finally`, the session is removed from `activeSessions` and `onAgentComplete`
  fires **always**.

## Prompt builder

Source: `src/pool/prompt-builder.ts`. `buildPrompt(task, step, cwd)` assembles the prompt:

1. Header: `## Task: <title>`, `## Step: <step.name>`.
2. For each path in `task.files`:
   - Skip binary extensions.
   - Resolve relative to `cwd`.
   - Files over 10 KB (`MAX_FILE_BYTES = 10_000`) are read as a buffer and truncated with
     UTF-8-boundary awareness, then suffixed with `... (truncated)`.
   - Emit `### <path>` then a fenced code block with the detected language tag.
   - Read errors are logged to `console.debug` and the file is skipped.
3. Append `task.prompt`.
4. If `task.reviewFeedback` is non-empty, append `## Review Feedback History (please address
all items)` with each entry as `Attempt <n+1>: <feedback>`.

## Validation and severity

Source: `src/pool/validation.ts` and `src/pool/severity.ts`.

- **`assertSafeName(value, label)`** — Throws unless `value` matches `^[a-zA-Z0-9_-]+$`. Used
  on task IDs and step names that appear in file paths.
- **`Severity`** — `'critical' | 'high' | 'medium' | 'low'`.
- **`isFailingSeverity(severity)`** — True for `critical` or `high`. Used to decide whether a
  task that exhausted retries fails outright or is submitted with feedback.
- **`extractSeverity(output)`** — Reads `output.severity` if it is a string; otherwise
  `'medium'`.

## Where to go next

- [Building a new workflow](../guides/building-workflows.md) — using `LanePool` and
  `runStepTask` together.
- [Event store & status](event-store.md) — what every lifecycle callback becomes.
- [Types reference](types.md) — `LanePoolOptions`, `StepDefinition`, `Task`, `TaskEntity`.
