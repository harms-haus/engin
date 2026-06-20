# Task pool & execution

The pool layer (`packages/engine/src/pool/`) executes tasks concurrently. A `LanePool` spins up N workers
("lanes") that each claim tasks from a shared `TaskTracker` and process them through a
configurable sequence of steps, with reviewer feedback loops. Every step is one agent.

This document covers the `TaskTracker` (write model), the `LanePool` executor, step execution
and retries, and the prompt builder.

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

Source: `packages/engine/src/pool/lane-pool.ts`.

```typescript
class LanePool {
  constructor(options: LanePoolOptions);
  run(): Promise<LanePoolResult;
}
```

### `LanePoolOptions` — worktree & hook fields

| Field              | Type              | Description                                                                                                                                                                                                                      |
| ------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktreeManager?` | `WorktreeManager` | Per-run worktree manager enabling per-task worktree isolation (create on claim, squash-merge on success, cull on failure).                                                                                                       |
| `hookRegistry?`    | `HookRegistry`    | Optional registry of workflow hooks. Forward `options.hookRegistry` (engine-assembled via `composeHooks`) to activate the pool/step/scheduler hooks. When absent, `runStep` calls `buildPrompt` directly — zero behavior change. |
| `auditLog?`        | `AuditLog`        | Audit log. When present **alongside** `hookRegistry`, `LanePool.run()` auto-registers the default auditor so `structured_output` / `decision` events land in the log without any manual `auditLog.append` call in workflow code. |

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
   4a. **Per-task worktree (when `worktreeManager` is set).** Before calling the runner, the
   lane calls `worktreeManager.createTaskWorktree(task.id, task.prompt)` and overrides
   `runnerCtx.cwd` to the returned worktree path so the agent runs inside an isolated
   branch. On a `completed` outcome, the lane calls `worktreeManager.mergeTaskBranch(task.id)`
   (serialized squash-merge into the main-wt branch); the task's `completeTask` settlement is
   deferred until the merge succeeds, so a failed merge flips the outcome to `failed`. On a
   successful merge, the deferred result is first **relativized** against the task worktree
   path and `mainWorktreePath` before being settled into the tracker, so any absolute
   worktree paths the agent emitted (e.g. an `issues[].file`) become repo-relative for
   downstream tasks (see [Worktrees reference → Task succeeds](worktrees.md#task-succeeds)).
   On failure/retry and on permanent failure, `maybeRetryFailedTask` force-culls the task
   worktree + branch. When `worktreeManager` is absent, none of this runs and tasks execute
   against `cwd` directly.
5. **If nothing claimed** — `await wakePromise` (resolves on a task event, the timeout, or
   abort).

There is **no exponential backoff**. The lane idle poll is a fixed `laneWaitTimeoutMs`
(default `60000` ms). A lane warns **once** if it stalls for `STALL_WARN_THRESHOLD` (5)
consecutive timeouts.

See the [Worktrees reference](worktrees.md) for the full per-task worktree lifecycle,
`.worktreecopy` population, and merge serialization.

## Step execution and retries

Source: `packages/engine/src/pool/linear-steps-runner.ts` and `packages/engine/src/pool/step-execution.ts`.

### Linear step execution (linearStepsRunner)

Runs a task's ordered steps. Defaults: `maxStepRetries = options.maxStepRetries ?? 5`. If there
are no steps, the task fails with `'No steps defined for task'`.

Per-step state maps track the rejection count (`stepAttempts`), execution count
(`stepExecutions`), and persisted session (`taskSessions`) for each step index.

The loop:

1. The LanePool fires `onTaskStart` once before calling the runner (the runner itself does not fire it).
2. For the current step, call `runStep(...)`. `runStep` fires `onAgentSpawn` and then `onStepStart` (in that order, so the step always has an `agentKey` linkage before `step_started` is recorded). Any existing session for the
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
5. **All steps approved** — dispose sessions, submit as complete. On success the LanePool fires
   `onTaskComplete`; on failure it fires `onTaskRejected`.

### `runStep(task, step, agentId, ctx, profiles, execCtx, existingSessionPath?)`

Runs a single step. The session directory is
`{sessionBaseDir}/{taskId}/{execCount}-{stepIndex}-{step.name}` — note the first segment is
the per-step **execution count**, not the rejection attempt.

- **Event ordering.** `runStep` fires `onAgentSpawn` first, then `onStepStart` (with `{ taskId, stepIndex, stepName, agentId }`), so the EventStore always records `agent_spawned` before `step_started`. This ordering also guarantees the step's `agentKey` is populated before clients see the step start.
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

## Pool-level hooks

The pool layer is the primary consumer of the engine's hook system. Hooks are an **extension
seam** that lets a workflow influence and observe execution without forking the engine; the
full catalog, composition rules (`observe` / `pipeline` / `first-wins` / `all-run`), and known
wiring gaps are documented in [Hooks](hooks.md). This section covers only the seams that fire
inside the pool layer.

A workflow **declares** hooks on its `WorkflowModule` via the optional `hooks` field; the
engine composes them with the store callbacks via `composeHooks` and exposes the assembled
registry as `options.hookRegistry`. To activate pool/step/scheduler hooks, the workflow
**forwards** that registry into its `LanePool` (or `runStepTask`):

```typescript
const pool = new LanePool({
  // …
  hookRegistry: options.hookRegistry, // ← activates beforeStepPrompt / beforeTask / auditor
});
```

When `hookRegistry` is absent (or has no subscribers for a given name), every seam below
short-circuits to the legacy code path — zero behavior change.

### `beforeStepPrompt` (pipeline, fires in `runStep`)

Source: `packages/engine/src/pool/step-execution.ts`. When the threaded `hookRegistry` has at
least one `beforeStepPrompt` subscriber, `runStep` produces the prompt by invoking the
**pipeline** hook (seeded with `task.prompt`) **instead of** calling `buildPrompt` directly.
The pipeline's final return value replaces the prompt sent to the agent. The hook receives
both `cwd` and an optional `worktreeCwd` so file context resolves against the per-task
worktree when one is in use (see [§7 of hooks.md](hooks.md#7-the-two-cwd-world)). When no
subscriber is registered, `buildPrompt` runs unchanged.

### `beforeTask` (first-wins, fires in `resolveRunner`)

Source: `packages/engine/src/pool/lane-pool.ts`. For each claimed task, `resolveRunner`
invokes the `beforeTask` **first-wins** hook seeded with `{ task, steps }` (the seed step list
from `getStepsForTask`). A subscriber may return:

- `{ skip: true }` → the task is **cancelled** in the tracker; no steps run, no worktree is
  created, no merge lifecycle fires, no retry is budgeted.
- `{ steps: [...] }` → **override** the seed step list.
- `undefined` → **abstain**; the seed is kept (`getRunnerForTask`, if provided, still takes
  precedence over steps).

> **NOTE — Step definitions shown at task registration** (`onTaskRegister`, used by the TUI/web AgentLog + step-progress) come from `getStepsForTask`. A `beforeTask` hook resolves steps at CLAIM time (later) and its result does **NOT** retroactively populate the registration-time step list — so for visible step/agent layout, also provide `getStepsForTask` as the synchronous seed.

### `auditLog` + the default auditor (registered by `LanePool.run()`)

When `LanePool.run()` is constructed with **both** `auditLog` and `hookRegistry`, it registers
the default auditor (`createDefaultAuditor(auditLog)`) as a subscriber for `onStructuredOutput`
and `onDecision` **before** spawning lanes. Because both are **observe** hooks (fan-out), a
workflow that provides its own subscribers under the same names sees **both** fire — the
workflow's subscriber AND the auditor — with no manual `auditLog.append` call required. When
either option is absent, no auditor is registered (backward compat).

### Scheduler hooks

The lane-scheduling core lives in `packages/engine/src/pool/scheduler.ts` (constructed by
`LanePool.run()`, which forwards `hookRegistry`). The Scheduler owns three hook seams:

| Hook             | Rule       | Args                                         | Default (no subscriber)                                                                |
| ---------------- | ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `claimPolicy`    | first-wins | `{ tracker, laneId, maxClaim }`              | `claimTasks(1, laneId)` (claim one ready task).                                        |
| `concurrencyKey` | first-wins | `{ task }`                                   | No concurrency limit (tasks run concurrently across lanes).                            |
| `onLaneStall`    | observe    | `{ laneId, consecutiveTimeouts, threshold }` | `console.warn` the historical stall warning (fires once after `threshold`, default 5). |

**`claimPolicy` limitation.** The hook may return a batch of `Task[]`; the Scheduler marks
**every** returned task `active`. However, the lane loop currently consumes only `claimed[0]`
per wake cycle, so a batch of _N_ is processed one at a time across successive wakes rather
than concurrently in a single claim. Treat the batch contract as "select the next task(s); the
Scheduler still drains one at a time."

**Known wiring gaps (consistent with [hooks.md](hooks.md#known-wiring-gaps-honest-summary)).**
`onLaneIdle` and `wakeStrategy` are declared in `types.ts` but are **not invoked** from the
Scheduler today — registering a subscriber is harmless but will not fire. They are reserved
for future scheduler work.

### `fixLoop` — single-task review → fix → re-review

Source: `packages/engine/src/pool/fix-loop.ts`. `fixLoop` is a composable **single-task**
review/fix primitive (not a hook) that a task runner calls. It composes with `runStep` for
**both** the review and the fixer steps — it does not re-implement agent spawning or session
management. Loop contract:

1. Run the review step via `runStep`. If approved → `{ status: 'completed', output }`.
2. If rejected, enter the fix loop (up to `maxRounds`, default 3):
   - **Before** each fixer attempt, invoke `shouldIsolate` (first-wins) with the latest review
     feedback as the `error`. A `true` result **isolates**: the fixer is not run, the worktree
     is **preserved** (cull skipped), and `{ status: 'failed', feedback }` is returned.
   - Run each fixer step via `runStep` in order. A fixer step that **rejects or throws** fires
     `onLaneError` (observe) — but does **not** abort the round. Review rejections do not fire
     `onLaneError` (they are the loop's normal control-flow signal).
   - Re-run the review. If approved → `{ status: 'completed', output }`.
3. On exhaustion → `{ status: 'failed', feedback }`, and (when a worktree is in use) **cull**
   the task worktree via `cullTaskWorktree(task.id)` — **unless** `shouldIsolate` returned
   `true`, in which case the worktree is **preserved** for inspection. Cull failures are
   swallowed + warned.

`fixLoop` uses **inline fallbacks** (`shouldIsolate` → `false`, lane errors swallowed) when no
subscriber is registered, so a caller that passes no `hookRegistry` gets the exact pre-hook
behavior. The bundled **final-review** phase does **not** use `fixLoop` — it is a
multi-dimensional, per-finding parallel review built on `LanePool` + `runStepTask`; see the
[appendix in hooks.md](hooks.md#appendix-the-fixloop-primitive-and-the-final-review-boundary)
for the design boundary.

## Task runners — polymorphic task bodies

The body of a task — what actually executes when a lane claims it — is now
represented by a `TaskRunner` function. This replaces the old hard-coded linear
step loop with a pluggable interface, enabling different execution topologies
while keeping the pool, DAG, event store, and TUI unchanged.

### `TaskRunner` interface

Source: `packages/engine/src/pool/types.ts`.

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

Source: `packages/engine/src/pool/types.ts`.

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
  /** Optional registry of custom output renderers keyed by profile name */
  rendererRegistry?: RendererRegistry;
  /** Optional registry of workflow hooks. Forwarded into the
   *  {@link StepExecutionContext} so `runStep` can invoke `beforeStepPrompt`
   *  (and the observe hooks `onStructuredOutput` / `onDecision`) when
   *  subscribers are present. */
  hookRegistry?: HookRegistry;
  /** Audit log for recording events. Forwarded into the
   *  {@link StepExecutionContext}. The default auditor
   *  ({@link createDefaultAuditor}) is registered against `hookRegistry` by
   *  `LanePool.run()` when BOTH `auditLog` and `hookRegistry` are present on
   *  {@link LanePoolOptions}, so structured-output / decision events land in
   *  the durable log WITHOUT any manual `auditLog.append` call in workflow
   *  code. */
  auditLog?: AuditLog;
  /** Per-task worktree path (set by LanePool when a worktree is created for
   *  this task). Distinct from `cwd` (the run/pool cwd): forwarded into the
   *  {@link StepExecutionContext} so the `beforeStepPrompt` hook can resolve
   *  files against the isolated worktree. */
  worktreeCwd?: string;
  /** Abort signal for cooperative cancellation (e.g. SIGINT). Forwarded into the
   *  {@link StepExecutionContext} so runStep can re-check the abort state before
   *  starting a prompt, closing the TOCTOU window between session creation and
   *  `session.prompt()`. */
  signal?: AbortSignal;
  worktreeManager?: WorktreeManager;
  /** Safely settle the task as complete. Returns true on success. */
  completeTask: (result?: unknown) => boolean;
  /** Safely settle the task as failed. */
  failTask: (result?: unknown) => void;
}
```

- **`completeTask(result?)`** — Calls `taskTracker.completeTask(id, result)` safely. The optional `result` is stored on the task so downstream phases can read it via `task.result`. Returns `true` if the settlement succeeded, `false` if the tracker threw (e.g. invalid state transition / the task was cancelled).
- **`failTask(result?)`** — Calls `taskTracker.failTask(id, result)` safely.
  The `result` can carry `{ completed, error, feedback, severity }`.

### `TaskOutcome`

Source: `packages/engine/src/pool/types.ts`.

```typescript
type TaskOutcome = { status: 'completed'; output?: unknown } | { status: 'failed'; error?: string; feedback?: string };
```

The `LanePool` dispatches lifecycle events based on the outcome:

- `{ status: 'completed' }` → fires `onTaskComplete`.
- `{ status: 'failed', feedback }` → fires `onTaskRejected`.
- `{ status: 'failed', error }` → reports via `onError` / `console.error`.

### Lifecycle event ownership

Responsibilities are split between the pool and runners to avoid duplication:

| Event                              | Owner     | When                                                       |
| ---------------------------------- | --------- | ---------------------------------------------------------- |
| `onTaskRegister`                   | LanePool  | Before any task starts (during `run()`)                    |
| `onTaskStart`                      | LanePool  | After claiming, before calling the runner                  |
| `onStepStart`                      | `runStep` | Inside runStep, after onAgentSpawn, before the prompt runs |
| `onDecision`                       | Runner    | On rejection (with retry reason)                           |
| `onAgentSpawn` / `onAgentComplete` | `runStep` | Before / after each agent session                          |
| `onTaskComplete`                   | LanePool  | When runner returns `{ status: 'completed' }`              |
| `onTaskRejected`                   | LanePool  | When runner returns `{ status: 'failed', feedback }`       |

Runners fire `onDecision` during execution. `runStep` fires `onAgentSpawn`,
`onStepStart` (after the spawn), and `onAgentComplete`. The `LanePool` fires `onTaskStart`,
`onTaskComplete`, and `onTaskRejected`.

Separately from these events, in **worktree mode** a successful task's captured result is
**relativized** to repo-relative paths between agent output and settlement — a data transform
(not a lifecycle event) that strips absolute worktree paths before they cross a task boundary
(see [Worktrees reference → Task succeeds](worktrees.md#task-succeeds)).

### Session management

All built-in runners track their `TrackedSession` objects and call `dispose()`
on every exit path (success, failure, error). Sessions are also registered on
`activeSessions` so an abort signal can cancel in-progress LLM calls.

### Built-in runners

All factories are in `packages/engine/src/pool/`.

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

#### `councilRunner(options)`

```typescript
import { councilRunner } from '../pool/council-runner.js';

const runner = councilRunner({
  workers: [
    { name: 'architect', profileId: 'architect', isReadOnly: true },
    { name: 'engineer', profileId: 'engineer', isReadOnly: false },
  ],
  synthesizer: { name: 'merge', profileId: 'synthesizer', isReadOnly: true, schema: mergeSchema },
});
```

**Description.** Runs N worker agents in parallel, then passes all worker
outputs to a synthesizer step that merges them into a single result. Useful
for ensembles, multi-perspective analysis, council voting, or any pattern
where independent agents contribute and a single output is needed. Workers
that fail individually are recorded — only if **all** workers fail does the
task fail outright.

**Options.** `councilRunner` accepts a `CouncilRunnerOptions` object with `workers` (the parallel worker steps) and `synthesizer` (the merge step), plus an optional `composeSynthesizerPrompt?: (task: Task, workerOutputs: unknown[]) => Task`. When `composeSynthesizerPrompt` is omitted, the runner uses the built-in `composeWorkerOutputsPrompt`, which appends a `## Worker Outputs` section (one `### Worker <n>` block per output) to the original task prompt — preserving the default behavior. Supply a custom composer to control how worker outputs are formatted into the synthesizer prompt (the composer must return a new `Task`; the original `ctx.task` is never mutated).

**When to use.** Multiple perspectives that need to be merged into one
coherent result.

---

#### `reflectionRunner(options)`

```typescript
import { reflectionRunner } from '../pool/reflection-runner.js';

const runner = reflectionRunner({
  draftStep: { name: 'generate', profileId: 'writer', isReadOnly: false },
  criticStep: { name: 'critique', profileId: 'critic', isReadOnly: true, schema: reviewSchema },
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

#### `mapRunner(options)`

```typescript
import { mapRunner } from '../pool/map-runner.js';

const runner = mapRunner({
  items: (task) => task.files ?? [],
  step: { name: 'process-file', profileId: 'file-processor', isReadOnly: false },
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

#### `branchRunner(options)`

```typescript
import { branchRunner } from '../pool/branch-runner.js';

const runner = branchRunner({
  branches: [
    {
      condition: (task) => task.prompt.includes('fix'),
      step: { name: 'fix-bug', profileId: 'fixer', isReadOnly: false },
    },
    {
      condition: (task) => task.prompt.includes('feature'),
      step: { name: 'implement', profileId: 'developer', isReadOnly: false },
    },
  ],
  default: { name: 'triage', profileId: 'triage', isReadOnly: true },
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

Source: `packages/engine/src/pool/prompt-builder.ts`. `buildPrompt(task, step, cwd)` assembles the prompt:

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

Source: `packages/engine/src/pool/validation.ts` and `packages/engine/src/pool/severity.ts`.

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
- [Hooks](hooks.md) — the full hook catalog, composition rules, and the `fixLoop` boundary.
- [Types reference](types.md) — `LanePoolOptions`, `StepDefinition`, `Task`, `TaskEntity`.
