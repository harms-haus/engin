# Step-Level Model-Aware Scheduling

> **Goal.** Evolve engin's task-based lane scheduler into a **step-level, model-aware** scheduler so that two subscriptions with limited concurrent-agent capacity no longer throttle throughput. A task with N steps on N models should run each step on its own model independently: when step 1 (GLM-5.2) finishes, another task can start on GLM-5.2 while step 2 (DeepSeek v4 flash) of the first task runs concurrently.

## Background — how scheduling works today

Read these files first; the design below is an evolution of them, not a rewrite:

- `packages/engine/src/pool/scheduler.ts` — the `Scheduler` core. Spawns `maxConcurrentLanes` "lanes" (workers); each lane loops **claim a whole Task → run it to completion → settle**. The lane holds the task for its entire life. Already has extension seams: a `claimPolicy` first-wins hook (decides which task to claim) and a `concurrencyKey` first-wins hook (serializes same-key tasks, **cap hardcoded to 1**). Neither hook is subscribed to by any workflow today.
- `packages/engine/src/pool/lane-pool.ts` — `LanePool`. Owns lifecycle firing, retry budgeting (`maybeRetryFailedTask`), runner resolution (`resolveRunner`, including the `beforeTask` hook that can rewrite a task's step list), worktree setup, profile loading. Binds `processTask` as the Scheduler's `runTask`.
- `packages/engine/src/pool/linear-steps-runner.ts` — `linearStepsRunner`. Runs a task's steps sequentially. **Critically:** `stepAttempts`, `stepExecutions`, and `taskSessions` are **closure-local variables** that die when the runner closure returns. Backs up one step on rejection, retries up to `maxStepRetries` per step.
- `packages/engine/src/pool/step-execution.ts` — `runStep`. Loads the profile, creates a harness session, prompts, decides approve/reject. Session dirs are named `{sessionBaseDir}/{taskId}/{execCount}-{stepIndex}-{stepName}`. The `existingSessionPath` arg supports resume from a persisted session file.
- `packages/engine/src/tracking/task-status.ts` — `TaskTracker`. Status union is `'ready'|'blocked'|'active'|'complete'|'failed'|'cancelled'`. `getReadyTasks()` orders by **transitive blocking pressure** (desc), ties broken by insertion order via stable sort — a documented invariant ("do NOT add secondary keys"). `isPoolDone()` returns false on any non-settled task and **side-effects** deadlocked `blocked` tasks to `failed`.
- `packages/engine/src/core/agent-lifecycle.ts` — `spawnAgent`. Creates a session, tracks it in `activeSessions` (before any callback — TOCTOU safety), returns a handle with `session`, `dispose()`, `complete()` (fires `onAgentComplete` + untracks). `session.abort()` exists.
- `packages/engine/src/core/utils.ts` — `forwardAgentStatus`. Forwards `onTurnStart` / `onToolCallStart` / `onTurnEnd` (etc.) from the pi plugin via `onAgentStatus`. **This is the activity signal the watchdog resets on.**
- `packages/engine/src/core/error-classifier.ts` — `classify`. `TRANSIENT_RE` matches `timed? out|timeout|terminated` → `kind:'transient', retryable:true`. `PROVIDER_LIMIT_RE` / `CONFIG_ERROR_RE` → permanent, non-retryable.
- `packages/engine/src/core/types.ts` — `AgentProfile { provider, model, agent?, ... }`; `Task { ...no activeStepIndex... }`; `WorkflowStatusCallbacks`.
- `packages/shared/src/types.ts` — `TaskStatus`; `StepEntity` (read-model, has `activeStepIndex` derived state); `TaskEntity`.
- `~/.config/engin/workflows/.lib/config.ts` — `WorkflowConfig.defaultMaxConcurrentTasks` (default 5). Composed into phases via `.lib/*.ts`.

## Design decisions (locked — do not relitigate)

1. **Unified model, one gate family.** Not "two schedulers." A **total step cap** (`maxConcurrentLanes` == max concurrent in-flight steps) AND a **per-model cap** (per `provider:model`, optionally `provider:model:agent`). Either or both may be configured; a step runs only when both its total slot and its model slot are free.
2. **Lanes become step-workers (work-stealing).** A lane does NOT hold a task across a blocking wait. Per iteration a lane claims the best **runnable `(task, its next step)` pair**: an active task whose current step's model slot is free. A task whose next step's model is saturated is **parked** (stays `active`) and the lane grabs other work. Per-model caps are enforced at **claim selection** (non-blocking `tryAcquire`), not via today's blocking `acquireKey`.
3. **Priority = transitive blocking pressure (primary), FIFO by `startedAt` (tiebreak).** Preserves today's documented ordering invariant; `startedAt` only breaks ties. (Started tasks do NOT get absolute priority — confirm this is acceptable; it's the chosen answer.)
4. **No new top-level `TaskStatus`.** "Waiting" is a **projection-only derived field** (e.g. `waitingOn: "zai:glm-5.2"`), computed when a task's current step is parked on a saturated model. No change to the `TaskStatus` union, the `evolve` reducer, `isPoolDone()`, the deadlock detector, or resume's status machine. TUI/web surface it as a display nicety only.
5. **Per-task runner state moves into a persisted, pool-owned store.** This replaces the closure-local `stepAttempts`/`stepExecutions`/`taskSessions` so state survives lane handoffs and (as a new capability) resume. Keyed by `taskId`. This is the single source of truth for `(activeStepIndex, execCount, stepAttempts, per-step session refs)`.
6. **Starvation without blocking is accepted** (model queues drain eventually). No starvation recovery needed; the existing `onLaneStall` hook remains the telemetry seam if observation is wanted.
7. **Stuck-step watchdog: 5-minute no-activity timeout.** A timer resets on every forwarded activity event (`onTurnStart`/`onToolCallStart`/`onTurnEnd`). If 5 minutes elapse with no activity, the step is booted: `session.abort()` + `dispose()` + untrack from `activeSessions`, then **re-queued to resume from its last persisted session state** with a "resume work" prompt. (Generous; 5 min is plenty for first-token latency on resume.)
8. **Resume policy on timeout: resume same session, NOT restart-fresh.** The session is presumed transiently hung; resume it. Pressure valve: if resumes keep stalling, the step eventually `failTask`s → the existing `maybeRetryFailedTask` system kicks in (`clearTaskSessions` + `resetTaskForRetry` + cull worktree) → whole-task restart. The classifier already routes timeouts to `retryable:'transient'`, so this fires correctly.
9. **Resume-cap scope: PER STEP.** The resume-after-timeout cap resets when the step advances. It does NOT compound across task retries. (Cost-bound concern noted but accepted.)
10. **Resume operates on steps** (new capability). A resumed run restores step position from the persisted store. **Exception:** on whole-task failure (`failTask` → `resetTaskForRetry`), step progress resets and the worktree is culled — existing behavior, preserved.

## Implementation tasks

This repo is heavily test-driven — **every module ships a `.test.ts` and the suite will not merge without coverage.** Author tests alongside each task. Use `bun:test`. The existing `scheduler.test.ts` is the model to imitate (fixture helpers, deferred gates, mock trackers).

### Task 1 — Persisted per-task step-state store

Create a pool-owned store that replaces `linearStepsRunner`'s closure-local state. Keyed by `taskId`. Holds `{ activeStepIndex, execCount, stepAttempts: Map<stepIndex, number>, perStepSessions: Map<stepIndex, { sessionPath, dispose }> }`. Must be:

- **The single source of truth** for step position — `linearStepsRunner` reads/writes through it instead of closure vars.
- **Clearable per task** — a `reset(taskId)` that zeroes it, called from the retry path (see Task 6).
- **Resumable** — serializable or reconstructable so a resumed run can rebuild it (the `{execCount}-{stepIndex}-{stepName}` session-dir naming convention gives a fallback reconstruction path for `sessionPath`).

Files: new module (e.g. `packages/engine/src/pool/step-state-store.ts`) + test. Refactor `linearStepsRunner.ts` to consume it.

### Task 2 — Generalize `acquireKey` from cap=1 to cap=N per key

`scheduler.ts`'s `inFlightByKey.set(key, 1)` hardcodes the limit. Generalize to a counter with a **per-key max** resolved via a new resolver (e.g. a `concurrencyLimits: (key) => number | undefined` hook or a static map). Keep the existing FIFO-waiter `releaseKey` "pass the slot" semantics (they prevent a racing acquirer stealing a slot between release and waiter wake). **Note:** this blocking-acquire path is retained for any caller that wants it, but the **step-level matchmaker (Task 3) uses non-blocking tryAcquire** — do not force blocking semantics into the new flow. Update `scheduler.test.ts` (the concurrencyKey spec cases).

### Task 3 — Step-level matchmaker via `claimPolicy` + non-blocking model semaphores

Implement a `claimPolicy` subscriber (registered by `LanePool.run()` or the workflow) that selects the next runnable `(task, step)` pair:

- Build the candidate set: every non-settled task, paired with its **next step** (from the persisted store's `activeStepIndex`).
- For each candidate, compute its **model key** = `${profile.provider}:${profile.model}` (or `${provider}:${model}:${agent}` when a per-agent limit is configured). Profiles load once in `LanePool.run()`, so keying is cheap.
- **Non-blocking `tryAcquire`** on the model semaphore: a step whose model is at cap is skipped (its task stays parked). Also respect the total step cap (a free lane _is_ a free total slot, so total is implicit — but make the two gates composable and explicit in tests).
- Order runnable candidates by **transitive blocking pressure (desc), then FIFO by `startedAt`**. Add a `startedAt` field to the executor `Task` type if not already settable (check `claimTasks` / `processTask` — `onTaskStart` already receives `startedAt`; persist it on the Task).
- Return the best claimable pair; the lane runs that single step, then releases both slots and loops.
- **`beforeTask` re-validation:** `resolveRunner` can rewrite the step list via the `beforeTask` hook. After `beforeTask` resolves, **re-validate** the rewritten step's model slot — if now saturated, park the task again (do not over-admit).

This is the core redesign. The lane loop changes from "claim task → run all steps" to "claim (task, step) → run one step → release → loop." Tasks stay `active` across the whole run; only individual steps are claimed/released. New test file; mirror `scheduler.test.ts`'s concurrency-key cases but assert per-model and total caps, plus the parking/skipping behavior.

### Task 4 — `waitingOn` projection field

Add a derived field to the read-model (e.g. `TaskEntity.waitingOn?: string` or on `StepEntity`) surfaced when a task's current step is parked on a saturated model. Set it when the matchmaker skips a task; clear it when the step runs. No `TaskStatus` change. Wire `onStatus`/projection projection-helpers in `packages/shared/src/projection-helpers.ts` (or wherever the read-model is built) and surface in the TUI/web as a display-only nicety. Tests for the derivation.

### Task 5 — Stuck-step watchdog (5-min activity timeout)

In `step-execution.ts`'s `runStep`, add an idle timer that:

- **Resets** on every forwarded activity event: hook into the `onAgentStatus` forwarding (the same `onTurnStart`/`onToolCallStart`/`onTurnEnd` that `forwardAgentStatus` already surfaces). **Do not** reset on the "resume work" dispatch itself (a stuck dispatch shouldn't look healthy).
- **Fires at 5 minutes of silence**: `session.abort()` → `dispose()` → untrack from `activeSessions`, then re-queue the step to **resume from its last persisted session state** with a `"resume work"` prompt (increment `execCount`; keep prior steps' results).
- **Clears on every exit path** — approve, reject, throw, dispose. Replicate the `clearTimeout`-in-`finally` pattern already used by `stepTimeoutMs`. Guard the 4:59→5:00 race against double-abort on an already-completing session.
- **Per-step resume cap** (Task 1's store tracks attempts): after N resumes of the same step still stall, call `failTask({ error: 'step stalled (no activity timeout)' })` so the existing retry valve (Task 6) takes over. Make N configurable, default reasonable (e.g. 3).

Tests: simulate activity events to assert the timer resets; assert abort+dispose+requeue on timeout; assert resume-cap-then-failTask path. Add the timeout message to the classifier if it isn't already matched (it is — `TRANSIENT_RE` covers it — but add a regression test).

### Task 6 — Wire the retry valve to clear the step-state store

In `lane-pool.ts`'s `maybeRetryFailedTask`, the existing path already does `clearTaskSessions` + `resetTaskForRetry` + `cullTaskWorktree`. **Add:** also call `stepStateStore.reset(taskId)` so the whole-task restart begins at `activeStepIndex=0, execCount=0` with an empty session map — otherwise the runner would try to resume a step whose session dir was just `rm -rf`'d (EISDIR/ENOENT). This is the sharpest edge of the whole change; test it explicitly as one unit (simulate: task at step 2, force `failTask` → `maybeRetryFailedTask` → assert store is zeroed AND `resetTaskForRetry` ran AND worktree culled).

Also make `resetStuckTasks` (resume path) **step-aware**: today it safely flips `active`→`ready` because there's nothing to lose; under the new model it would silently nuke step position. It must either preserve the store (preferred — resume picks up where it left off) or coordinate with the store. Trace the resume path in `run-executor.ts` (`onWorkflowResume`) and confirm which.

### Task 7 — Config plumbing

Add per-model limit configuration, composed with the existing total cap:

- Extend `WorkflowConfig` (`.lib/config.ts`) and/or run options with a `modelConcurrency?: Record<string, number>` map keyed by `provider:model` (or `provider:model:agent`). Example: `{ "zai:glm-5.2": 3, "deepseek:v4-flash": 2 }`.
- `defaultMaxConcurrentTasks` remains the **total step cap** (rename in docs/comments to `defaultMaxConcurrentSteps` semantically — the field name can stay for back-compat, but document the new meaning).
- Thread the limits through `.lib/implementation.ts`, `.lib/final-review.ts`, `.lib/scouting.ts`, `.lib/spir.ts` into `LanePoolOptions` and the matchmaker. Update the `.lib` tests that assert on `maxConcurrentLanes`.

### Task 8 — Invariants, docs, regression sweep

- **`isPoolDone()` correctness under parked tasks:** parked tasks are non-settled → keep lanes alive. Verify the matchmaker always finds runnable work while any non-settled task exists (the "all parked" paradox is impossible: a full model slot requires a step running somewhere). Add a test that a run with all-but-one tasks parked on a saturated model still drains.
- **Deadlock detector untouched:** confirm no parked `active` task is ever confused with `blocked`. The deadlock side-effect (blocked→failed with missing deps) must not fire for parked tasks.
- **Listener cleanup:** the Scheduler's wake-listener teardown (TaskReady/TaskSettled/abort) must still be leak-free under the new step-claim loop. Re-run the existing `listenerCount` tests.
- **Update docs:** `docs/concepts/architecture.md` (status flow), `.lib/README.md` (concurrency section), the workflow authoring guide. Document the two gates as **layered and composable**, not switchable strategies.
- **Full `bun test` green** across `packages/engine`, `packages/shared`, and `~/.config/engin/workflows/.lib`.

## Non-goals / out of scope

- No new top-level `TaskStatus`.
- No change to the `evolve` reducer or event store.
- No worktree merge parallelization (merges stay serialized via the WorktreeManager git lock).
- No starvation recovery / preemption (accepted).
- No change to the agent/plugin layer beyond reading the existing activity events.
