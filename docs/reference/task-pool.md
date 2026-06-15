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
   before spawning any lanes. For each task it calls `getStepsForTask` (if provided) and maps
   the steps to `{ name, profileId, isReadOnly }`. This lets the UI render the full task
   layout immediately. When only `getRunnerForTask` is provided (no `getStepsForTask`), the
   steps array will be empty; the runner is resolved later when the lane claims the task.
3. **Load profiles.** `clearProfileCache()` then `loadProfilesFromDirs(profilesDirs)` — loaded
   fresh on every `run()`.
4. **Register an abort listener** on the signal that aborts every active session.
5. **Spawn lanes.** `maxConcurrentLanes` workers run in parallel via `Promise.allSettled`. Lane
   failures are isolated and reported via `onError` (agentId `lane-<index>`).
6. **Resolve runners.** For each claimed task, `resolveRunner(task)` picks a `TaskRunner`:
   `getRunnerForTask` takes precedence; otherwise `getStepsForTask` is wrapped in
   `linearStepsRunner`; if neither is provided, a runtime error is thrown.
7. **Result counts.** Filter `getAllTasks()` by `status === 'complete'` and `=== 'failed'`.

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

## Task runners — polymorphic task bodies

The body of a task — what actually executes when a lane claims it — is now
represented by a `TaskRunner` function. This replaces the old hard-coded linear
step loop with a pluggable interface, enabling different execution topologies
while keeping the pool, DAG, event store, and TUI unchanged.

### `TaskRunner` interface

Source: `src/pool/types.ts`.

```typescript
type TaskRunner = (ctx: TaskRunnerContext) => Promise<TaskOutcome>;
```

A runner receives a `TaskRunnerContext` and returns a `TaskOutcome`. Runners
**must not re-throw** — all errors are caught internally and surfaced via
`ctx.failTask` / the returned outcome. The `LanePool` catch block is a safety
net for truly unexpected errors.

### `getRunnerForTask` vs `getStepsForTask`

`LanePoolOptions` supports two optional fields (at least one is required):

- **`getStepsForTask?: (task: Task) => StepDefinition[]`** — The original
  interface. Returns a flat list of steps. The pool wraps them in
  `linearStepsRunner` automatically. Kept for backward compatibility.
- **`getRunnerForTask?: (task: Task) => TaskRunner`** — Returns a custom runner
  that controls the full execution of the task. When provided, takes precedence
  over `getStepsForTask`.

If neither is provided, the lane throws at runtime.

### `TaskRunnerContext`

Source: `src/pool/types.ts`.

```typescript
interface TaskRunnerContext {
  task: Task;
  agentId: string;
  profiles: Map<string, AgentProfile>;
  onStatus: StatusCallbacks | undefined;
  activeSessions: Set<{ abort(): Promise<void> }>;
  phaseId: string;
  sessionBaseDir: string;
  cwd: string;
  apiKeys?: Record<string, string>;
  maxStepRetries: number;
  /** Safely settle the task as complete. Returns true on success. */
  completeTask: () => boolean;
  /** Safely settle the task as failed. */
  failTask: (result?: unknown) => void;
}
```

- **`completeTask()`** — Calls `taskTracker.completeTask(id)` safely. Returns
  `true` if the settlement succeeded, `false` if the tracker threw (e.g. invalid
  state transition).
- **`failTask(result?)`** — Calls `taskTracker.failTask(id, result)` safely.
  The `result` can carry `{ completed, error, feedback, severity }`.

### `TaskOutcome`

Source: `src/pool/types.ts`.

```typescript
type TaskOutcome = { status: 'completed'; output?: unknown } | { status: 'failed'; error?: string; feedback?: string };
```

The `LanePool` dispatches lifecycle events based on the outcome:

- `{ status: 'completed' }` → fires `onTaskComplete`.
- `{ status: 'failed', feedback }` → fires `onTaskRejected`.
- `{ status: 'failed', error }` → reports via `onError` / `console.error`.

### Lifecycle event ownership

Responsibilities are split between the pool and runners to avoid duplication:

| Event                              | Owner     | When                                                 |
| ---------------------------------- | --------- | ---------------------------------------------------- |
| `onTaskRegister`                   | LanePool  | Before any task starts (during `run()`)              |
| `onTaskStart`                      | LanePool  | After claiming, before calling the runner            |
| `onStepStart`                      | Runner    | Before each step execution                           |
| `onDecision`                       | Runner    | On rejection (with retry reason)                     |
| `onAgentSpawn` / `onAgentComplete` | `runStep` | Before / after each agent session                    |
| `onTaskComplete`                   | LanePool  | When runner returns `{ status: 'completed' }`        |
| `onTaskRejected`                   | LanePool  | When runner returns `{ status: 'failed', feedback }` |

Runners fire `onStepStart` and `onDecision` during execution. `runStep` fires
`onAgentSpawn` and `onAgentComplete`. The `LanePool` fires `onTaskStart`,
`onTaskComplete`, and `onTaskRejected`.

### Session management

All built-in runners track their `TrackedSession` objects and call `dispose()`
on every exit path (success, failure, error). Sessions are also registered on
`activeSessions` so an abort signal can cancel in-progress LLM calls.

### Built-in runners

All factories are in `src/pool/`.

---

#### `linearStepsRunner(steps)`

```typescript
import { linearStepsRunner } from '../pool/linear-steps-runner.js';

const runner = linearStepsRunner([
  { name: 'code', profileId: 'coder', isReadOnly: false, schema: undefined },
  { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: reviewSchema },
]);
```

**Description.** Sequential steps with reviewer back-up retry and severity-based
fail/approve. Reproduces the exact pre-runner behavior of `processTask`. The
loop runs each step in order; if a step is rejected, the runner backs up one
step (clamped at 0) and retries, up to `maxStepRetries` per step. When retries
are exhausted, `isFailingSeverity` decides whether to fail the task or accept
it with caveats.

**When to use.** Default for any task that needs a linear pipeline with
reviewer feedback loops.

---

#### `councilRunner(workers, synthesizer)`

```typescript
import { councilRunner } from '../pool/council-runner.js';

const runner = councilRunner({
  workers: [
    { name: 'architect', profileId: 'architect' },
    { name: 'engineer', profileId: 'engineer' },
  ],
  synthesizer: { name: 'merge', profileId: 'synthesizer', schema: mergeSchema },
});
```

**Description.** Runs N worker agents in parallel, then passes all worker
outputs to a synthesizer step that merges them into a single result. Useful
for ensembles, multi-perspective analysis, council voting, or any pattern
where independent agents contribute and a single output is needed. Workers
that fail individually are recorded — only if **all** workers fail does the
task fail outright.

**When to use.** Multiple perspectives that need to be merged into one
coherent result.

---

#### `reflectionRunner(draftStep, criticStep, maxRounds?)`

```typescript
import { reflectionRunner } from '../pool/reflection-runner.js';

const runner = reflectionRunner({
  draftStep: { name: 'generate', profileId: 'writer' },
  criticStep: { name: 'critique', profileId: 'critic', schema: reviewSchema },
  maxRounds: 5,
});
```

**Description.** Draft-critique loop that extracts the reviewer-loop pattern
into a reusable primitive. The `draftStep` produces work; the `criticStep`
reviews it. If the critic rejects, feedback is appended to the task and the
draft runs again (with session resume). The loop continues until the critic
approves or `maxRounds` (default 3) is exhausted. When rounds are exhausted,
severity-based fail/approve follows the same logic as `linearStepsRunner`.

**When to use.** Iterative refinement where a critic reviews drafts and
requests changes — code review, content editing, any generate-then-critique
workflow.

---

#### `mapRunner(items, step, concurrency?)`

```typescript
import { mapRunner } from '../pool/map-runner.js';

const runner = mapRunner({
  items: (task) => task.files ?? [],
  step: { name: 'process-file', profileId: 'file-processor' },
  concurrency: 3,
});
```

**Description.** Fan-out over a collection. Extracts items from the task at
runtime via the `items(task)` function, then runs one step per item. When
`concurrency` is set, at most that many items run in parallel; otherwise all
items run simultaneously. Each item is injected into the task prompt. The
output is an array of results; partial failures are collected and reported.

**When to use.** Processing a list of independent items — files in a
directory, database records, search results — where each item runs the same
agent logic.

---

#### `branchRunner(branches, default?)`

```typescript
import { branchRunner } from '../pool/branch-runner.js';

const runner = branchRunner({
  branches: [
    {
      condition: (task) => task.prompt.includes('fix'),
      step: { name: 'fix-bug', profileId: 'fixer' },
    },
    {
      condition: (task) => task.prompt.includes('feature'),
      step: { name: 'implement', profileId: 'developer' },
    },
  ],
  default: { name: 'triage', profileId: 'triage' },
});
```

**Description.** Conditional routing. Evaluates `branches` in order; the first
whose `condition(task)` returns true wins and its step runs. If no branch
matches and a `default` step is provided, that step runs instead. If no match
and no default, the task fails immediately.

**When to use.** Routing tasks to different agents based on task metadata —
prompt content, title, file types, or any other property.

### Decision guide

| Pattern                                          | Runner                        |
| ------------------------------------------------ | ----------------------------- |
| Linear pipeline with review cycles               | `linearStepsRunner` (default) |
| Multiple perspectives merged into one            | `councilRunner`               |
| Iterative refinement with critic feedback        | `reflectionRunner`            |
| Process a list of items independently            | `mapRunner`                   |
| Route to different agents based on task metadata | `branchRunner`                |

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
