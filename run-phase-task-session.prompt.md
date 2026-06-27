# Run / Phase / Task / Session — Session-First Engine Redesign

> **This is a task prompt, not a plan.** It contains the goal, locked technical
> decisions, and research findings to seed the **develop** workflow. The workflow
> must first **scout** the codebase to **verify the claims below**, then **plan**
> atomic implementation tasks from those verified findings. Treat every factual
> claim in this document as something to confirm, not assume.

---

## 1. Goal

Invert engin's unit of work. Today the **task** is the unit of scheduling and the
**step** is the unit of agent work, with a single non-composable `TaskRunner`
per task owning a fixed `steps[]` loop. This redesign makes the **session** the
atomic unit — of agent work, of concurrency, of resume, and of the UI — and
introduces **composable runners** that orchestrate sessions.

### The new ontology

- **Run** — a complete workflow; succeeds or fails. **Hanging is not allowed.**
- **Phase** — a set of tasks. A phase completes only when **all** its tasks
  succeed. If any task fails too many times, the phase fails, which bubbles up
  and fails the run.
- **Task** — can succeed or fail; has dependencies and dependents (a task
  cannot be claimed while any dependency has not succeeded: `blocked` → `ready`
  when all dependencies are `complete`). **A task produces no output, only a
  success/fail signal.** A task owns one composable **runner** and one optional
  per-task worktree.
- **Agent Session** — the atomic unit of agent work. Belongs to a task. May
  produce output that the runner feeds into other sessions. **May fail with an
  error.** If a session fails in a way the runner does not recover, the task
  fails, which blocks downstream dependents.
- **Runner** — orchestrates one or more sessions for a task. Composable: a
  runner may contain other runners. Runner types:
  - `singleSession` — one session (the atomic case; replaces inline `runStepTask`).
  - `linearRunner([…])` — runs children in order, feeding each child's result
    into the next.
  - `reviewRunner(execute, review)` — execute → review loop; resumes the execute
    session when review returns `{approved:false}`, up to `maxRounds`.
  - `councilRunner([workers], synthesizer)` — workers run in parallel → one
    consolidating synthesizer session.
  - `coordinatorRunner(coordinator)` — one coordinator session decides an array
    of child sessions → children run → result is the coordinator's combined output.
  - `parallelRunner([…])` — runs children in parallel, results concatenated to an array.
  - `coalescingRunner(coordinator)` — coordinator decides an array of sessions →
    they run in parallel → coordinator decides whether done or should generate
    more sessions (loop, up to `maxRounds`).
  - `mapRunner({items, runner, concurrency?})` — fan-out over a dynamic
    collection (sourced from task context / filesystem) — **retained**.
  - `branchRunner({branches, default?})` — conditional dispatch to a sub-runner
    — **retained**.

  Composed examples:
  1. `linearRunner([reviewRunner(execute1, review1), reviewRunner(execute2, review2)])`
  2. `reviewRunner(parallelRunner(coordinatorRunner(coordinator)), review)` —
     coordinator generates children → parallelRunner runs them → reviewRunner
     reviews the array (reject → re-run coordinator → parallel → review → …).
  3. `parallelRunner([reviewRunner(parallelRunner(coordinatorRunner(cr1)), sr1), …])`
     — per-branch: coordinator → parallel → success-review decides another round.

### Separation of concerns (authoritative)

- **RUNNERS decide the output format** of each session they declare:
  `outputMode: 'text' | 'structured' | 'filesystem'`, where `'structured'` is
  enforced by a Zod schema. (The session's own message stream is always
  persisted; `outputMode` governs what the runner extracts and what gets
  persisted as the session's _result_ for replay.)
- **PROFILES decide the agent/provider/model and the system prompt.**
- **WORKFLOWS decide the prompt** for a session (the runner carries the prompt
  per declared session spec).

---

## 2. Locked technical decisions (already made — do not relitigate)

### 2.1 Concurrency authority — `SessionGate` + coroutines, **no lanes**

Lanes are abolished entirely. Runners are **unbounded cheap coroutines**; each
session call does `await gate.run(profile, async (session) => { … })`. The gate
is the **sole** concurrency authority:

- **Total cap** (`defaultMaxConcurrentSessions`) + **per-model cap**
  (`modelConcurrency: Record<'provider:model', number>`, optionally keyed
  `'provider:model:agent'`). A session runs only when both its total slot and
  its model slot are free.
- Admission ordering is **per-model FIFO inside the gate**. (Task-priority
  ordering via `getReadyTasks()` becomes cosmetic because runners are cheap and
  immediately block on the gate — do not invest in it, but do not break it.)

### 2.2 The deadlock-safety rule is **structural**, via RAII

The one invariant that makes a coroutine + gate model deadlock-free is: **a
runner must never hold a session slot across another acquire.** This is enforced
**by API, not by convention**: the only gate primitive is

```ts
gate.run(profile, async (session: SessionHandle) => R): Promise<R>
```

which acquires before invoking the callback and releases in a `finally`. There is
**no manual `acquire`/`release`**. `parallelRunner` is safe because its siblings
are independent `gate.run` calls awaited together — none of them holds a slot
while waiting for a sibling. `coordinatorRunner`/`coalescingRunner` are safe
because the coordinator session **completes and releases** before its children
are spawned. **Do not expose a manual acquire/release API** — that would let
authors footgun a nested-held deadlock (e.g. five coordinators each holding a
slot and each trying to spawn a worker under total cap 5).

### 2.3 Run-level resume = **deterministic replay from persisted sessions**

On process restart, each task's runner is re-instantiated and re-walks its
control flow. **Before spawning any session, the runner checks whether a
persisted output already exists for that session's deterministic ID.** If so, it
is reused **without a model call**. Because runners are deterministic functions
of prior session outputs, they naturally re-arrive at their pending state. This
**same mechanism** powers intra-run resume (e.g. `reviewRunner` re-prompting the
execute session) and run-level replay resume — there is exactly one resume
mechanism.

Requirements this imposes:

- **Deterministic session IDs:** `${taskId}/${runnerPath}/${role}#${attempt}`,
  where `runnerPath` encodes composition position
  (e.g. `linear[0].review`, `coordinator`, `coordinator.worker[2]`), `role` is
  the runner-assigned role (`execute`, `review`, `worker`, `synthesizer`, …),
  and `attempt` increments on loops/rejections.
- **Coordinator / coalescing children are indexed `worker[i]`, never named by
  content.** This is safe on replay because the coordinator's _decision_ (which
  children to spawn, with what prompts) is itself a persisted session, so the
  index assignment is identical on replay.
- **Idempotent re-execution:** calling a session whose ID already has a
  persisted result is a no-op returning the cached result. (The classic
  `{execCount}-{stepIndex}-{stepName}` session-dir naming convention from
  `step-execution.ts` generalizes to runner-assigned roles.)

**Do not** add per-runner internal-state serialization. Replay is the resume
strategy.

### 2.4 Session failures vs session results (crisp distinction)

- A session **result** is its structured/text/filesystem output, encoded by the
  runner and the Zod schema. Approval is _part of the result_ (e.g.
  `{approved: false, feedback}`) and is normal control flow consumed by the
  runner — **not a failure**.
- A session **failure** is a thrown `SessionError` (a model/API error, a
  timeout, a schema-validation exhaustion). The existing `error-classifier.ts`
  classifies it (`transient` vs permanent).
- **Runners catch `SessionError` and decide.** Default behavior: rethrow → the
  pool's retry valve handles it (→ task failure / task retry). Loop runners may
  catch a transient error and retry-in-place instead of burning the task budget.
  There is no "any session error instantly fails the task" rule — the runner is
  the decider.

### 2.5 Task outcome — runner **returns** `TaskOutcome`, never calls setters

```ts
type TaskOutcome = { status: 'completed' } | { status: 'failed'; error?: string };

type Runner = (ctx: RunnerContext) => Promise<TaskOutcome>;
```

The runner never touches the `TaskTracker`. It resolves/rejects; the
**RunnerPool's retry valve** calls `completeTask` / `failTask`. (Today's
`completeTask`/`failTask` setters in `TaskRunnerContext` are removed from the
runner contract.)

### 2.6 Phase completion is **strict** (all-or-nothing), with phase rounds on top

A phase completes only when **all** its tasks are `complete`. Any task that
exhausts its retry budget and stays `failed` fails the phase → fails the run.
The existing `shouldRetryPhase` / `maxRounds` loop sits **on top**: before
declaring phase failure, the whole phase may be re-run up to `maxRounds`.
**Delete the soft `minPhaseCompletions` tolerance** — partial-success phases are
no longer permitted. (Confirm during scouting where `minPhaseCompletions` is
referenced and remove it.)

### 2.7 Full rename: `Agent*` → `Session*` across the data model and wire protocol

This is the larger-diff / cleaner-ontology choice.

- `AgentEntity` → **`SessionEntity`**: drop `stepIndex`; add `runnerRole:
string` and `attempt: number`; keep `sessionId`, `sessionPath`, `profile`,
  `phaseId`, `taskId`, `active`, `log: LogEntry[]`, `toolCallCount`,
  `inputTokens`, `outputTokens`, `contextWindow`, `startedAt`, `completedAt`.
- Events: `agent_spawned` → **`session_started`**, `agent_completed` →
  **`session_completed`**. Delete `step_started` and the `activeStepIndex`
  concept entirely. `tool_call_started`/`tool_call_ended`, `turn_started`/
  `turn_ended`, `auto_retry_started`/`auto_retry_completed` stay (they are
  already keyed by agent/session id, not step index). The rename ripples through
  the `EventType` union, every `evolve` handler, `protocol-types.ts`, the TUI
  widgets, the web store/components, and all their tests.
- **`SessionEntity` is first-class per task.** "The session list can grow" = more
  sessions appended to the task (coordinator/coalescing spawn at runtime).
  "Sessions may resume" = a session gets a second `session_started` on re-prompt
  (the existing upsert in the agent handler carries over to the session handler).
- The UI's per-task "session list" = `sessions` filtered by `taskId`. Tab /
  Shift+Tab cycles sessions. There is **no fixed step array and no
  `activeStepIndex`** anywhere.

### 2.8 Task shape — no profile, no output

```ts
interface Task {
  id: string;
  title: string;
  phaseId: string;
  dependencies: string[];
  status: TaskStatus; // unchanged union
  worktree: 'none' | 'code'; // replaces isCode; 'code' => per-task worktree, merged on completion
}
```

Tasks carry **no `profile`** (profiles live on session specs) and **no `output`**
(a task is a pure success/fail signal). Cross-task data flows via **filesystem
only** (as today: plan.json, scout reports, etc.). Within a task, the runner
pipes session→session (structured output injected into prompts, or filesystem).

### 2.9 Session spec — the new atomic declaration

```ts
interface SessionSpec {
  id: string; // deterministic, see §2.3
  profile: string; // profile id
  prompt: string; // workflow-supplied
  schema?: ZodType; // when outputMode === 'structured'
  outputMode: 'text' | 'structured' | 'filesystem';
  isReadOnly?: boolean;
}
```

Structured sessions use `promptForStructured` + Zod (the existing agent-agnostic
text-extraction path — do not introduce native structured output). `filesystem`
sessions produce no parsed output; the runner inspects files afterward. **All
three modes persist** (session message stream / structured JSON / files) so
replay (§2.3) works for every session.

### 2.10 Task retry wipes the task's sessions (sharpest replay edge)

When a task fails and its retry budget remains: **delete
`{sessionBaseDir}/{taskId}/` recursively**, `resetTaskForRetry`, re-instantiate
the runner from entry. Replay then finds nothing and starts fresh. (Today's
`clearTaskSessions` + `resetTaskForRetry` + `cullTaskWorktree` carry over; the
only addition is that the runner is re-instantiated rather than a closure being
re-entered.) Test this explicitly as one unit.

### 2.11 Watchdog retargets step → session (5-min no-activity)

Per-session idle timer, reset on every forwarded activity event
(`onTurnStart`/`onToolCallStart`/`onTurnEnd` via the existing
`forwardAgentStatus`/`createAgentEventForwarder`). 5 minutes of silence →
`session.abort()` → **transient `SessionError`** fed through the runner-decides
path (§2.4). After **N resumes of the same session ID** still stall, escalate to
a **permanent** `SessionError` (configurable N, default 3). This is the
step-level watchdog design, retargeted from step to session. The classifier
already routes timeouts to `retryable:'transient'`. Clear the timer on every
exit path (approve, reject, throw, dispose); guard the 4:59→5:00 double-abort
race.

### 2.12 Full unification — one model replaces both execution paths

The `develop` workflow uses **both** execution paths today: inline
`runStepTask`/`runMultiStepTask` (in `phase-tasks.ts`, used by
initialization/scouting/planning) **and** `getStepsForTask` (LanePool, used by
implementation). Under this redesign there is **one** session/runner model:

- Inline `runStepTask` → a `singleSession` runner.
- Inline `runMultiStepTask` → a `linearRunner` of sessions.
- `getStepsForTask` step arrays → a `linearRunner` (or `reviewRunner` where the
  workflow's review semantics apply).

Migrate `~/.config/engin/workflows/.lib/*.ts` and **their test suites** to the
new model. **Delete** `linear-steps-runner.ts`, `step-execution.ts`'s step loop,
`phase-tasks.ts`'s `runStepTask`/`runMultiStepTask`, `StepEntity`,
`activeStepIndex`, and the step tab bar.

### 2.13 Meta concerns stay out-of-phase

Title generation and similar meta concerns (today: inline `runStepTask` in
`run-executor`, no phase, no worktree) **remain special out-of-phase
single-session calls** in `run-executor`. They use the **new session primitive**
(`gate.run` + `SessionSpec` + the renamed session events) but are **not** routed
through the RunnerPool / TaskTracker and are **invisible** to the task UI. (Do
not promote them to real tasks in a hidden phase.)

### 2.14 Hooks — deletions, rename, and survivors

- **Delete:** `claimPolicy`, `concurrencyKey`, `onLaneStall` (no lanes, no
  per-key task mutex — concurrency lives in the gate).
- **Rename:** `beforeStepPrompt` → **`beforeSessionPrompt`** (pipeline; transforms
  a session's prompt before sending).
- **Keep:** `beforeTask` (first-wins; may return `{skip:true}` /
  `{runner: Runner}` / abstain — note it can now rewrite the _runner_, not just
  steps), `collectContext` (all-run; per-session context blocks),
  `onDecision` (observe), and all phase hooks (`beforePhase`, `afterPhase`,
  `beforePhaseTransition`, `shouldRetryPhase`, `onPhaseSettled`). `isPoolDone()`
  - the deadlock side-effect (`blocked`→`failed` with `deadlocked:` prefix) are
    retained unchanged.

### 2.15 RunnerPool replaces LanePool (drain loop, no lane workers)

`LanePool` → **`RunnerPool`**. There is no fixed lane-worker pool and no
`runLane` loop. The drain loop:

1. For each task that is `ready` (dependencies satisfied) and not yet started,
   instantiate its runner coroutine (cheap — it will block on the gate almost
   immediately). There is no cap on simultaneously-started runners; the gate is
   the only cap.
2. `await` the set of in-flight runners.
3. As tasks settle, dependents become `ready` (via `recalculateStatuses`); start
   their runners.
4. `isPoolDone()` decides termination (retained). Abort/`AbortSignal` flows into
   every active `gate.run`.

The `TaskTracker` dependency graph, `getReadyTasks()` (transitive-pressure
ordering — now cosmetic but retained), `recalculateStatuses`, and the
deadlock detector are retained.

### 2.16 Loop runners carry `maxRounds` caps

`reviewRunner`, `coalescingRunner`, and any runner that can loop **must** carry a
`maxRounds` cap (coalescing can loop forever otherwise). Replay handles any
reached round; the cap bounds cost. On exhaustion, the runner fails the task
(returns `{status:'failed'}`).

---

## 3. Current architecture — what exists (verify during scouting)

All paths relative to repo root. The execution core is entirely in
`packages/engine/src`; the data model is split between `packages/engine/src` and
`packages/shared/src`; the clients are `packages/tui` and `packages/web`.

### 3.1 Execution core — `packages/engine/src/pool/`

- **`types.ts`** — `TaskRunner = (ctx: TaskRunnerContext) => Promise<TaskOutcome>`;
  `TaskRunnerContext` (carries `task`, `profiles`, `activeSessions`,
  `completeTask`, `failTask`, `sessionBaseDir`, `cwd`, `worktreeCwd`, hooks,
  etc.); `LanePoolOptions` (`maxConcurrentLanes`, `maxStepRetries`,
  `maxTaskRetries`, `getStepsForTask`, `getRunnerForTask`, …); `TaskOutcome`.
- **`scheduler.ts`** — the `Scheduler`: spawns `maxConcurrentLanes` lanes via
  `Promise.allSettled`; each `runLane` loops `claimNextTask → acquireKey →
runTask`. `claimPolicy` (first-wins) and `concurrencyKey` (first-wins) hooks.
  `acquireKey` is a **per-key mutex hardcoded to cap 1** with FIFO waiters
  (`releaseKey` "passes the slot"). Wake listeners on `TaskReady`/`TaskSettled`.
  **This entire file is deleted.**
- **`lane-pool.ts`** — `LanePool`: lifecycle firing, retry budgeting
  (`maybeRetryFailedTask`), runner resolution (`resolveRunner`: `beforeTask` hook
  → `getRunnerForTask` → `linearStepsRunner(steps)` fallback), worktree setup,
  profile loading, binds `processTask` as the Scheduler's `runTask`. Closure-local
  `taskRetries`, `activeSessions`, `pendingSkipReason`. **Rewritten as
  `RunnerPool`** (§2.15).
- **`linear-steps-runner.ts`** — `linearStepsRunner(steps)`: sequential loop,
  backs up one step on rejection, retries up to `maxStepRetries` per step.
  **Closure-local** `stepAttempts`, `stepExecutions`, `taskSessions` (die on
  return). **Deleted** (replaced by `linearRunner` over sessions).
- **`step-execution.ts`** — `runStep`: spawns agent, builds prompt, decides
  approve/reject, session dir `{sessionBaseDir}/{taskId}/{execCount}-{stepIndex}
-{stepName}`. Also `clearTaskSessions`. The agent-spawn / prompt / structured
  -output mechanics are **reused** by the new session primitive; the step loop
  is deleted.
- **`reflection-runner.ts`, `council-runner.ts`, `map-runner.ts`,
  `branch-runner.ts`** — existing composable-ish runners (today they cannot
  compose because the pool picks exactly one). `reflectionRunner` ≈ the new
  `reviewRunner`; `councilRunner` maps directly; `mapRunner`/`branchRunner` are
  retained. They share primitives in **`runner-utils.ts`**
  (`createSessionTracker`/`createSessionMap`/`buildExecCtx`/`handleRunnerError`/
  `settleResult`/`settleBySeverity`).
- **`phase-tasks.ts`** (barrel; impls in `one-step-task.ts`, `multi-step-task.ts`)
  — the **second** execution path: `runStepTask` / `runMultiStepTask`, used
  directly by workflow authors, not integrated with LanePool. **Deleted under
  full unification** (§2.12).

### 3.2 Data model & events

- **`packages/shared/src/types.ts`** — `TaskStatus` union
  (`'ready'|'blocked'|'active'|'complete'|'failed'|'cancelled'`), `StepEntity`
  (deleted), `TaskEntity` (drop `steps`/`activeStepIndex`; see §2.8),
  `PhaseEntity`, `RunEntity`.
- **`packages/shared/src/event-types.ts`** — `EventType` union, `EventRecord`,
  `WorkflowProjection`, `AgentEntity` (→ `SessionEntity`, §2.7).
- **`packages/shared/src/evolve.ts`** + per-type handlers
  (`agent-handlers.ts`, `task-handlers.ts`, `phase-handlers.ts`,
  `tool-handlers.ts`, `retry-handlers.ts`, …) — the pure reducer. Retarget onto
  the renamed events; delete `step_started` handling.
- **`packages/engine/src/tracking/task-status.ts`** — `TaskTracker`: status
  machine, `getReadyTasks()` (transitive-pressure ordering), `recalculateStatuses`,
  `resetTaskForRetry`, `failTask`/`completeTask`, `isPoolDone()` with the
  deadlock side-effect. **Largely retained** (§2.15).
- **`packages/engine/src/tracking/event-store.ts`** — `EventStore` (append-only
  `events.jsonl` + snapshot, ring buffer, subscribe). **Retained unchanged.**
- **`packages/engine/src/core/phase-runner.ts`** — `PhaseRunner`: phase
  transitions, `minPhaseCompletions` guard (§2.6 — delete the soft guard, make
  strict), `shouldRetryPhase`/`maxRounds` (retained, sits on top of strict).
- **`packages/engine/src/server/run-executor.ts`** — run start, phase/task
  construction, LanePool wiring, `onWorkflowResume` / `resetStuckTasks` /
  `resetFailedTasks`, meta concerns (title-gen). **Rewired** to RunnerPool;
  resume path rebuilt around replay (§2.3).

### 3.3 Agent / harness layer (depends on the agent-plugin-system work)

Runners and sessions talk to the **neutral `AgentRuntime`** interface from the
agent-plugin-system redesign (`agent-plugin-system.prompt.md`), not to pi
directly. If that work has not landed, the session primitive wraps today's
`createHarness`/`spawnAgent` and is retargeted onto `AgentRuntime` later.
Reused as-is: `error-classifier.ts` (`classify`), `structured-output.ts`
(`promptForStructured` + `parseJsonWithRepair`), `core/utils.ts`
(`forwardAgentStatus`/`createAgentEventForwarder` — the activity signal the
watchdog resets on), `write-sandbox.ts`, profile loading, per-task worktrees
(`worktree-manager.ts`, serialized merge via git lock).

### 3.4 Clients

- **`packages/tui/src/`** — `WorkflowTUI`, `Dashboard` (`PhaseBar`/`TaskList`/
  `AgentLog`), `EventLog`. Selection state `DashboardSelection`
  (`selectedPhaseId`/`selectedTaskId`/`selectedStepIndex`/`userPinnedPhase`/
  `userPinnedStep`). Keybindings: left/right = phases; up/down = tasks (when log
  collapsed) / log scroll (when expanded); tab/shift-tab = cycle steps with an
  `agentKey`; space = toggle log; shift+up/down = log scroll ×10; pgup/pgdn/home/
  end = event log. **`selectedStepIndex` → `selectedSessionId`; the step tab bar
  (`renderTabBar`) renders sessions; `stepLabel()`/`activeStepIndex` deleted.**
- **`packages/web/src/`** — React client, zustand `workflow-store`
  (`selectedStepIndex`), `TaskList.tsx` (`stepLabel`), `AgentLog.tsx` (step-bar).
  Same rename.
- **`packages/shared/src/protocol-types.ts`** — wire messages (`snapshot`/
  `events`/`run_complete`/`run_failed`/`log`). Projection carried in `snapshot`;
  the rename flows through automatically once the projection type changes.

### 3.5 Workflow library — `~/.config/engin/workflows/.lib/`

`config.ts` (`WorkflowConfig.defaultMaxConcurrentTasks` →
`defaultMaxConcurrentSessions`; add `modelConcurrency`), `implementation.ts`,
`final-review.ts`, `scouting.ts`, `planning.ts`, `initialization.ts`, `spir.ts`,
`steps.ts`, `helpers.ts`, `renderers.ts`, `schemas.ts` — and their **large test
suites**. These use `getStepsForTask`, `runStepTask`, `runMultiStepTask` today;
all migrate to runner expressions (§2.12).

---

## 4. Research findings — the burden & the seams (verify the claims)

### 4.1 Runners cannot compose today — by construction

`resolveRunner` (`lane-pool.ts`) is first-wins: `beforeTask` hook →
`getRunnerForTask` → `linearStepsRunner(steps)` fallback. The pool picks
**exactly one** `TaskRunner`. The existing `reflectionRunner`/`councilRunner`/
`mapRunner`/`branchRunner` are leaf factories that never call each other. The
proposal's `linearRunner([reviewRunner(…), reviewRunner(…)])` is **impossible**
today. Confirm `resolveRunner` and the runner factories.

### 4.2 Two execution paths diverge

`LanePool` (multi-task, dependency graph, retry budgeting, worktree merge) vs
`phase-tasks.ts` `runStepTask`/`runMultiStepTask` (inline, one-shot, own
worktree lifecycle, no LanePool integration, no retry budget beyond per-step).
The `develop` workflow uses **both**. Full unification (§2.12) collapses them.
Confirm which `.lib/*.ts` files use which path.

### 4.3 Concurrency is on the wrong object

`acquireKey` is a per-key **mutex (cap 1)**, blocking, with FIFO waiters. Lanes
claim **whole tasks** and hold them for the entire run. There is **no
`modelConcurrency` anywhere** today. The proposal's "8 sessions attempt, cap 5 →
5 run, 3 wait" and "glm cap 2, deepseek cap 10" examples have no representation.
Confirm `acquireKey`'s cap-1 hardcode and the absence of per-model caps.

### 4.4 The step abstraction is overloaded and UI-coupled

`StepEntity` + `activeStepIndex` drive: the TUI step-progress column
(`task-list-widget.ts`), the web `stepLabel()` (`TaskList.tsx`), the step tab bar
(`renderTabBar` / `AgentLog.tsx` step-bar), `computeNextAgentStepIndex`
(`agent-log-widget.ts`), `reconcileSelection()` (shared projection-helpers), and
the `step_started` event/handler. **All assume a fixed step array known up
front.** A `coordinatorRunner` that spawns N sessions at runtime has nowhere to
live. Confirm each coupling.

### 4.5 There is no `SessionEntity` today

Sessions are implicit: one `AgentEntity` per step (carrying `sessionId`,
`sessionPath`, `log`, tokens). The agent handlers already **upsert on re-spawn**
(`agent-handlers.ts`), which is exactly the "session may resume" semantics
needed. The full rename (§2.7) is mechanical but wide.

### 4.6 Resume is invisible to the UI today

No TUI/web rendering references "resume". `workflow_started` carries `resumed:
boolean` (→ one log line). `resumeSessionPath` is server-side only. Under replay
resume (§2.3), the UI naturally reflects resumed sessions (they re-emit
`session_started`), so no special resume UI is required — but verify nothing in
the clients assumes a session is spawned exactly once.

### 4.7 `getReadyTasks()` ordering becomes cosmetic

Transitive-pressure ordering mattered when lanes were a scarce worker pool
contended by whole tasks. Under gate + coroutines, runners are cheap and block
on the gate immediately; per-model FIFO **inside the gate** is what orders
admission. Do not remove the ordering (it is a documented invariant with tests),
but do not invest in it.

### 4.8 The watchdog mechanics already exist

`forwardAgentStatus`/`createAgentEventForwarder` surface `onTurnStart`/
`onToolCallStart`/`onTurnEnd` — the activity signal. `session.abort()` exists.
The classifier routes timeouts to `transient`. The step-level watchdog design
transfers to sessions verbatim with the unit renamed.

---

## 5. Implementation tasks

This repo is heavily test-driven — **every module ships a `.test.ts` and the
suite will not merge without coverage.** Author tests alongside each task
(`bun:test`). The existing `scheduler.test.ts`, `lane-pool` tests,
`linear-steps-runner` tests, and the `.lib/*.test.ts` suites are the models to
imitate; many will be **rewritten** rather than patched.

### Task 1 — `SessionGate` (the concurrency authority)

New module (e.g. `packages/engine/src/pool/session-gate.ts`) + test.

- `gate.run(profile, fn)` RAII primitive: resolves the model key
  `${profile.provider}:${profile.model}` (or `${provider}:${model}:${agent}`
  when a per-agent limit is configured), awaits a free total slot AND a free
  model slot (FIFO per model), then invokes `fn(sessionHandle)`, releasing both
  slots in a `finally`.
- Constructed from `{ total: number; perModel: Record<string, number> }`.
- **No manual acquire/release API.** The only public method is `run`.
- `AbortSignal` integration: an aborted gate rejects pending `run` calls.
- Tests: total cap enforced; per-model cap enforced independently; FIFO ordering
  per model; release-on-throw (`finally`); abort drains waiters; the
  composed-runner safety cases (`parallelRunner` siblings, coordinator-then-
  children) do not deadlock under a tight total cap.

### Task 2 — The session primitive (replaces `runStep`)

New module (e.g. `packages/engine/src/pool/session.ts`) + test. Refactor
`step-execution.ts` into it.

- `runSession(spec: SessionSpec, ctx): Promise<SessionResult>` where
  `SessionResult` is the persisted output (text / structured-JSON / filesystem).
- **Idempotent:** if `{sessionBaseDir}/{deterministic-id}/` already holds a
  result, return it without spawning an agent. (This is the replay mechanism,
  §2.3. The deterministic id is supplied by the runner via the spec.)
- Spawns via the agent layer (`createHarness`/`spawnAgent` today; `AgentRuntime`
  post-plugin-system), tracks in `activeSessions`, builds the prompt (via the
  `beforeSessionPrompt` hook pipeline when subscribers exist, else direct), runs
  structured (`promptForStructured`+Zod) or text or filesystem.
- **Watchdog** (§2.11): per-session 5-min idle timer reset on forwarded activity;
  on timeout `session.abort()` → throw transient `SessionError`; permanent after
  N resumes of the same id.
- Throws `SessionError` on any failure (classified). **Never** decides
  approve/reject — approval is part of the structured result, consumed by the
  runner.
- Fires `session_started`/`session_completed` (renamed) with
  `runnerRole`/`attempt`/`sessionId`/`sessionPath`.
- `clearTaskSessions(sessionBaseDir, taskId)` retained for the retry valve
  (§2.10).

### Task 3 — Composable runners

New module(s) under `packages/engine/src/pool/runners/` + tests each.

- Define `Runner = (ctx: RunnerContext) => Promise<TaskOutcome>` and
  `RunnerContext` (carries `task`, `gate`, `runSession`, `profiles`,
  `sessionBaseDir`, `cwd`/`worktreeCwd`, hooks, `signal`, **no** `completeTask`/
  `failTask` — §2.5).
- Implement `singleSession`, `linearRunner`, `reviewRunner` (with `maxRounds`),
  `councilRunner`, `coordinatorRunner`, `parallelRunner`, `coalescingRunner`
  (with `maxRounds`), and retain/retarget `mapRunner`, `branchRunner`.
- **Deterministic session IDs** (§2.3): each runner assigns
  `${taskId}/${runnerPath}/${role}#${attempt}`. Coordinator/coalescing children
  indexed `worker[i]`.
- **Replay-correctness:** every runner consumes prior session results from the
  primitive's idempotent path; re-walking control flow on resume re-arrives at
  the pending session with no model calls. Test resume for each runner type
  (especially coordinator/coalescing/review).
- **Session-error handling (§2.4):** default rethrow; loop runners may catch
  transient errors and retry-in-place. `maxRounds`/`maxRetries` caps.
- Reuse `runner-utils.ts` primitives; delete `linear-steps-runner.ts` and the
  old `reflectionRunner` once `reviewRunner` covers them.

### Task 4 — Data model & event rename (`Agent*` → `Session*`)

- `packages/shared/src/event-types.ts`: `AgentEntity` → `SessionEntity`
  (drop `stepIndex`; add `runnerRole`, `attempt`); `EventType`:
  `agent_spawned`→`session_started`, `agent_completed`→`session_completed`;
  delete `step_started`.
- `packages/shared/src/types.ts`: delete `StepEntity`; `TaskEntity` drop
  `steps`/`activeStepIndex` (per §2.8).
- `packages/shared/src/evolve.ts` + handlers: retarget; delete `step_started`
  handling; the session handler retains the upsert-on-respawn semantics.
- `packages/shared/src/protocol-types.ts`: the projection type change flows
  through the `snapshot` message.
- Update every test that references the old names/shapes.

### Task 5 — `RunnerPool` (replaces `LanePool` + `Scheduler`)

New `packages/engine/src/pool/runner-pool.ts` + test. Delete `scheduler.ts` and
rewrite `lane-pool.ts` (or replace it).

- Drain loop (§2.15): instantiate a runner coroutine per `ready` task
  (unbounded — the gate is the only cap), await the set, start dependents as
  tasks settle via `recalculateStatuses`. `isPoolDone()` decides termination.
- **Retry valve (§2.10):** on `{status:'failed'}`, classify, check
  `maxTaskRetries` budget, backoff for transient, then
  `clearTaskSessions` + `resetTaskForRetry` + (if `worktree:'code'`)
  `cullTaskWorktree` + re-instantiate runner. Permanent failure → leave `failed`
  → strict phase semantics (§2.6).
- `AbortSignal` flows into every active `gate.run`.
- Retain `TaskTracker` (status machine, dependency graph, deadlock side-effect).
  `getReadyTasks()` ordering retained but cosmetic.
- Delete `claimPolicy`, `concurrencyKey`, `onLaneStall` hooks.

### Task 6 — Phase strictness + rounds

- `phase-runner.ts`: delete `minPhaseCompletions` tolerance; a phase completes
  only when **all** tasks are `complete`. Any `failed` task (after
  `maxTaskRetries`) fails the phase.
- `shouldRetryPhase`/`maxRounds` retained on top: before declaring phase
  failure, re-run the phase up to `maxRounds`.
- Failure bubbles phase → run (run fails if any phase fails).
- Update phase tests.

### Task 7 — Config plumbing

- `WorkflowConfig`: `defaultMaxConcurrentTasks` → **`defaultMaxConcurrentSessions`**;
  add `modelConcurrency: Record<string, number>` (keyed `provider:model` or
  `provider:model:agent`).
- Thread into `RunnerPoolOptions` and construct the `SessionGate`.
- Update `.lib/config.ts` and its tests.

### Task 8 — Client migration (TUI + web)

- TUI: `DashboardSelection.selectedStepIndex` → `selectedSessionId`; the log
  widget renders the task's session list (`sessions` filtered by `taskId`);
  Tab/Shift+Tab cycles sessions; delete the step tab bar, `stepLabel`,
  `activeStepIndex`, `computeNextAgentStepIndex` (→ session equivalent),
  `reconcileSelection` step-follow.
- Web: `workflow-store.selectedStepIndex` → `selectedSessionId`; `TaskList.tsx`
  `stepLabel` → session count / latest-session status; `AgentLog.tsx` step-bar
  → session-bar.
- Left/right = phases, up/down = tasks, tab/shift-tab = sessions (per the spec).

### Task 9 — Workflow migration (`.lib/*.ts`)

- Map each phase's authoring to runner expressions: `runStepTask`→`singleSession`,
  `runMultiStepTask`→`linearRunner`, step arrays→`linearRunner`/`reviewRunner`.
- `getStepsForTask` → `getRunnerForTask` returning a runner tree.
- Title-gen and meta concerns → out-of-phase `gate.run` calls in `run-executor`
  (§2.13), invisible to the task UI.
- Rewrite the `.lib/*.test.ts` suites against the new model.

### Task 10 — `run-executor` resume + meta

- Resume path rebuilt around replay (§2.3): re-instantiate runners, let the
  idempotent session primitive skip completed work. `resetStuckTasks`/
  `resetFailedTasks` coordinate with the new model (a stuck `active` task's
  runner is re-instantiated; its sessions are preserved so replay continues —
  do **not** wipe unless retrying).
- Meta concerns routed through the new session primitive without
  RunnerPool/TaskTracker.

### Task 11 — Invariants, docs, regression sweep

- **Deadlock-freedom:** assert the gate + coroutine model never deadlocks for
  every runner composition in §1 (especially coalescing/coordinator under a
  total cap of 1).
- **Replay correctness:** for each runner type, kill+resume mid-run and assert
  no redundant model calls and correct resumption position.
- **Strict phase semantics:** a single exhausted task fails the phase → run.
- **Rename sweep:** `rg -i 'agent_spawned|agent_completed|AgentEntity|stepIndex|
activeStepIndex|StepEntity|step_started'` returns nothing in `packages/` or
  `.lib/`.
- Update `docs/concepts/overview.md` (ontology), `docs/concepts/architecture.md`
  (status flow, pool model), `docs/reference/task-pool.md`, `docs/reference/
event-store.md`, `docs/reference/types.md`, `docs/reference/tui.md`,
  `docs/reference/web.md`, `docs/guides/building-workflows.md` (runner
  authoring), `.lib/README.md`.
- Full `bun test` green across `packages/engine`, `packages/shared`,
  `packages/tui`, `packages/web`, and `~/.config/engin/workflows/.lib`.

---

## 6. Behavior that MUST be preserved (do not regress)

Scout should confirm each works today; the planner must carry them through.

- **Dependency gating** — `blocked` → `ready` only when all dependencies are
  `complete`; deadlock side-effect for missing deps.
- **Per-task worktrees** — create on claim (for `worktree:'code'`), merge on
  completion, cull on failure/retry; serialized via the git lock.
- **Structured output** — `promptForStructured` + Zod + retry, agent-agnostic.
- **Error classification** — transient vs permanent, with backoff.
- **Status event flow** — turn/tool/token/retry events reach TUI/web.
- **Abort / cancellation** — SIGINT aborts all active sessions; step/session
  timeouts reach a freshly-spawned session (TOCTOU safety in `spawnAgent`).
- **Resume** — a killed run resumes and completes (now via replay, §2.3).
- **Profile loading & override semantics** — global+local merge, cache.

---

## 7. Things the workflow should explicitly NOT do

- **Do not plan before scouting completes** and the claims in §3–§4 are verified.
- **Do not introduce lanes, work-stealing, parked-task projections, or a manual
  acquire/release gate API.** The gate is RAII `gate.run` only (§2.2).
- **Do not add per-runner internal-state serialization.** Replay from persisted
  sessions is the resume strategy (§2.3).
- **Do not keep `minPhaseCompletions` or any partial-phase tolerance.** Phases
  are strict (§2.6).
- **Do not keep both execution paths.** Inline `runStepTask`/`runMultiStepTask`
  and `linear-steps-runner` are deleted under full unification (§2.12).
- **Do not promote meta concerns (title-gen) to real tasks.** They stay
  out-of-phase (§2.13).
- **Do not fake session data.** If a session can't emit usage/turn-end, leave it
  `undefined`.
- **Do not touch `@earendil-works/pi-tui`** (the TUI framework).
- **Do not couple runners to any one agent runtime.** Runners/sessions target
  the neutral `AgentRuntime` (or today's `createHarness` until the
  agent-plugin-system lands).

---

## 8. Definition of done

- `rg -i 'agent_spawned|agent_completed|\bAgentEntity\b|stepIndex|activeStepIndex|
StepEntity|step_started|linearStepsRunner|runStepTask|runMultiStepTask|
claimPolicy|concurrencyKey|onLaneStall|minPhaseCompletions'` returns nothing
  in `packages/` or `~/.config/engin/workflows/.lib/` (except possibly
  historical/git).
- `packages/engine/src/pool/scheduler.ts` is deleted; `lane-pool.ts` is gone or
  fully replaced by `runner-pool.ts`.
- The `SessionGate` exposes only `run`; the deadlock rule is structurally
  unbreakable; every runner composition in §1 is proven deadlock-free under a
  total cap of 1.
- A run with a coordinator/coalescing runner resumes after kill with **zero**
  redundant model calls (replay correctness).
- A single task exhausting its retry budget fails its phase → fails the run
  (strict semantics).
- TUI and web show a per-task **session list** that grows (coordinator) and
  reflects resume; Tab/Shift+Tab cycles sessions; left/right = phases, up/down =
  tasks.
- The `develop` workflow runs end-to-end under the new model, green tests.
- Docs updated per Task 11.

---

## 9. Suggested scouting targets (to speed up the scout phase)

**Codebase:**

- `packages/engine/src/pool/`: `types.ts`, `scheduler.ts`, `lane-pool.ts`,
  `linear-steps-runner.ts`, `step-execution.ts`, `reflection-runner.ts`,
  `council-runner.ts`, `map-runner.ts`, `branch-runner.ts`, `runner-utils.ts`.
- `packages/engine/src/core/`: `phase-tasks.ts` (+ `one-step-task.ts`,
  `multi-step-task.ts`), `phase-runner.ts`, `agent-lifecycle.ts`,
  `harness-factory.ts`, `structured-output.ts`, `error-classifier.ts`,
  `utils.ts` (`forwardAgentStatus`), `types.ts`.
- `packages/engine/src/tracking/`: `task-status.ts`, `event-store.ts`.
- `packages/engine/src/server/run-executor.ts`.
- `packages/engine/src/hooks/types.ts` (hook catalog + composition rules).
- `packages/shared/src/`: `types.ts`, `event-types.ts`, `evolve.ts` (+ handlers),
  `protocol-types.ts`, `projection-helpers.ts`.
- `packages/tui/src/`: `workflow-tui.ts`, `dashboard.ts`, `task-list-widget.ts`,
  `agent-log-widget.ts`, `ws-backed-tui.ts`.
- `packages/web/src/`: `workflow-store.ts`, `TaskList.tsx`, `AgentLog.tsx`.
- `~/.config/engin/workflows/.lib/`: `config.ts`, `implementation.ts`,
  `final-review.ts`, `scouting.ts`, `planning.ts`, `initialization.ts`,
  `spir.ts`, `steps.ts` — and their test suites.

**Validate early (de-risk before full implementation):**

- A spike `SessionGate` with a tight total cap proving `parallelRunner`-style
  composition cannot deadlock but a (forbidden) nested-held acquire would.
- A spike `linearRunner` of two sessions, killed between sessions, resumed via
  replay with no redundant model calls.
