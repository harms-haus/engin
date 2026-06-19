# Task: Add a cohesive hook system to engin

You are working on **engin**, an AI workflow orchestrator for software development built on top of
[pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). engin enforces a
rigid four-level hierarchy — **workflow → phases → tasks → steps** — where every agent is a
step-of-a-task, and runs as a long-lived server daemon over an event-sourced status model.

This task introduces a **cohesive, two-way hook system**: designated seam points where workflow and
engine behavior can be injected — to observe lifecycle events _and_ to influence execution. The goal
is to **drain generic cross-cutting behavior out of workflow code (`.lib/`) and into reusable
engine-level seams**, while keeping SPIR business logic (scouting/planning/review _semantics_) in the
workflow layer.

You are expected to **research** as needed and **validate/refine** the direction below against the
codebase before writing code. Read every file listed in §4 before designing anything.

---

## 1. Mission

engin already has **half** of a hook system: `StatusCallbacks` is a 21-method bag of `on*` lifecycle
methods, wired by the engine into a single composition point and fired across `LanePool` / `runStep` /
`runStepTask`. But today **every callback is observe-only and fire-and-forget** — none can return a
value or alter control flow. So anything that needs to _influence_ execution (rewrite a prompt, inject
file context, decide whether to retry, substitute a profile, isolate a failure) must be hand-coded per
phase in workflow TypeScript.

The result is **duplicative, generic boilerplate** scattered across the SPIR `.lib/` backbone
(`spir.ts`, `scouting.ts`, `planning.ts`, `final-review.ts`) — re-implementing prompt-context inlining,
audit logging, phase transitions, retry loops, and failure isolation that are not develop/improve/debug-
specific and belong in the engine (see §5 for the inventory).

**Your job:** introduce a hook system that makes those seams reusable, then migrate the generic
behavior behind them so a workflow's `main.ts` + `.lib/` shrink toward _behavioral difference only_.
Preserve the rigid hierarchy, the observability contract, and backward compatibility.

---

## 2. Non-negotiable constraints (firm)

1. **The workflow-author contract must not break.** Existing workflows that import from
   `@harms-haus/engin` / `@harms-haus/engin-engine` and export
   `{ run(taskPrompt, options): Promise<void> }` must compile and run unchanged. A workflow that talks
   only to `options.onStatus` keeps working untouched. New capabilities are **additive**.

2. **`StatusCallbacks` stays the default sink.** The event store (`createStoreCallbacks` →
   `EventStore.append`) is the source of truth for the TUI and web. A hook system must compose _on top
   of_ the existing callback fan-out, not replace it. The cheapest, safest first step is to make the
   single `onStatus = storeCallbacks` assignment in `run-executor.ts` into
   `onStatus = composeHooks([storeCallbacks, …workflowHooks])` — zero behavior change, unlocks everything.

3. **Preserve the rigid hierarchy.** workflow → phase → task → step → agent. Every agent is still a
   step-of-a-task. Hooks add seams **within** these levels; they do not introduce a new top level.

4. **Preserve observability.** Every hook-backed execution path must still emit the same lifecycle
   events so the TUI, web mirror, audit log, and `evolve` reducer render correctly. Observe-hooks must
   continue to fire even when an influence-hook short-circuits (e.g. a `beforeTask` that skips a task
   still settles it deterministically in the tracker).

5. **Do NOT redo the orchestration-primitives work.** The composable task-body runners
   (`linearStepsRunner`, `councilRunner`, `reflectionRunner`, `mapRunner`, `branchRunner`) shipped in
   commit `1c3d828` and made the **task body** polymorphic via `getRunnerForTask`. That work is done
   and correct. This task makes **phases and cross-cutting concerns** polymorphic — the genuinely
   un-done, high-leverage gap. Treat the runners as the _model_ for how a hook (`getRunnerForTask`)
   generalizes hardcoded behavior.

6. **Do NOT lift SPIR business logic into the engine.** Scouting/research/planning/review _semantics_
   belong in the workflow layer. Lift only generic cross-cutting concerns (the §5 inventory). The
   `.lib/` refactor already proved SPIR logic is reusable _as workflow code_; the engine's job is to
   give it cheaper seams, not absorb it.

7. **Keep `evolve.ts` pure** (only `import type`). No Node/React/pi dependencies leak into the shared
   package. Hooks are an engine/execution concern, not a status/projection concern — they must never
   affect the event schema or the reducer.

---

## 3. Background — what already exists (do not rebuild)

engin already has several seam points, in three maturity tiers. A hook system should **unify and
extend** these rather than introduce a parallel mechanism:

| Existing seam                                         | Tier            | Where                                                  | Notes                                                                     |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `StatusCallbacks` (21 `on*` methods)                  | observe-only    | `packages/engine/src/core/types.ts`                    | The embryo of the hook system. Composed at `tracking/store-callbacks.ts`. |
| `getRunnerForTask` / `getStepsForTask`                | **influence**   | `packages/engine/src/pool/types.ts`, `LanePoolOptions` | Already a hook — the model to generalize. Returns a `TaskRunner`.         |
| `registerRenderers`                                   | influence       | `core/types.ts` (`WorkflowModule`)                     | Workflow entry hook; called in `run-executor.ts`.                         |
| `titleFormatter`, `finalReviewers`, `fixerSteps`      | config-as-hooks | `workflows/.lib/config.ts`                             | Data-driven behavior.                                                     |
| pi `beforeToolCall` (used by `core/write-sandbox.ts`) | influence       | upstream precedent                                     | Allow/deny/rewrite at the tool layer.                                     |
| `ControlServer.onShutdown`                            | influence       | `server/control-server.ts`                             | Already called a "hook" in comments.                                      |

**Composition seam:** `run-executor.ts::execute()` builds `options.onStatus = storeCallbacks` and
passes it into `workflow.run(...)`. This single assignment is where multi-consumer composition
naturally lives.

---

## 4. Current architecture you must understand first

Read these before designing anything:

### Engine (`packages/engine/src/`)

- `core/types.ts` — `StatusCallbacks` (the 21-method surface), `WorkflowStatusCallbacks` +
  `AgentStatusCallbacks`, `STATUS_CALLBACK_METHODS`, `WorkflowRunOptions`, `WorkflowModule`.
- `server/run-executor.ts` — where `onStatus` is composed and handed to the workflow.
- `tracking/store-callbacks.ts` — `createStoreCallbacks`: maps every callback to an
  `EventStore.append` with the right `EventType`. The default observe-sink.
- `pool/lane-pool.ts` — `LanePool`: bundles (1) scheduler core [lanes + claim + wake + abort],
  (2) lifecycle firing [onTaskRegister/Start/Complete/Rejected], (3) retry budgeting
  [`maybeRetryFailedTask`], and (4) runner resolution [`resolveRunner`]. **This bundling is what a
  hook system should decompose** (see §7).
- `pool/types.ts` — `LanePoolOptions`, `TaskRunner`, `TaskRunnerContext`, `TaskOutcome`.
- `pool/linear-steps-runner.ts`, `council-runner.ts`, `reflection-runner.ts`, `map-runner.ts`,
  `branch-runner.ts` — the shipped polymorphic task bodies. Read them as examples of how a runner
  already owns `onDecision`, session tracking, and `settleResult`/`handleRunnerError`.
- `pool/step-execution.ts` — `runStep`: owns `onAgentSpawn` → `onStepStart` → `onAgentComplete`
  ordering, structured-output fail-safe rejection, abort TOCTOU handling.
- `pool/prompt-builder.ts` — `buildPrompt`: assembles the task prompt header, **inlines
  `task.files` contents** (capped 10 KB, binary-skip, language detection), appends feedback history.
  **Note: this logic is duplicated in `.lib/planning.ts`** — see §5.
- `core/phase-tasks.ts` — `runStepTask` + `runMultiStepTask`: the atomic single/multi-step task
  primitives. These fire the full lifecycle themselves.
- `tracking/task-status.ts` — `TaskTracker`: the write model (DAG, `claimTasks`, `resetTaskForRetry`,
  EventEmitter for `TaskReady`/`TaskSettled`/`TaskClaimed`).

### Workflows (`~/.config/engin/workflows/`)

- `README.md` and `.lib/README.md` — the thin-wrapper + shared SPIR backbone model.
- `.lib/spir.ts` — `runSpir` orchestrator + `executePhase`. **`executePhase` is a hand-written `switch`
  living entirely in workflow code**; the engine has _no_ `PhaseRunner`, no phase-transition logic, no
  cross-phase state threading. This is the largest reusable gap.
- `.lib/implementation.ts`, `.lib/scouting.ts`, `.lib/planning.ts`, `.lib/final-review.ts`,
  `.lib/initialization.ts`, `.lib/helpers.ts`, `.lib/config.ts` — the phase bodies. Read them to find
  the generic concerns catalogued in §5.

### Docs

- `docs/reference/task-pool.md` — the authoritative pool/runners reference (update this for any
  pool-level hook additions).
- `docs/guides/building-workflows.md` — the authoring contract (update for the hook authoring surface).
- `docs/reference/event-store.md`, `docs/concepts/architecture.md`, `docs/concepts/overview.md`.

### The completed predecessor

- `orchestration-primitives.prompt.md` (now removed from the repo root — its work shipped as commit
  `1c3d828`). Read git history if you need the original research synthesis (Mastra / LangGraph /
  AutoGen / Temporal / Inngest delegation-hooks, suspend/resume, etc.). **That prompt deliberately
  deferred** suspend/resume and supervisor/swarm/group-chat topologies; this task does too.

---

## 5. The boilerplate inventory (proof the hooks earn their keep)

These are **generic** behaviors re-implemented in SPIR `.lib/` today. Each is a candidate for an
engine-level hook + default. Validate each against a non-SPIR workflow shape before promoting it.

| #   | Behavior                                                    | Where today                                                                                                                                                       | Target seam                                                                 |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Phase transition: set phase → save → fire `onPhaseComplete` | `spir.ts::completePhase`                                                                                                                                          | `afterPhase` / `beforePhaseTransition` (default impl)                       |
| 2   | Sidebar indicator on phase change                           | scattered `onSidebarUpdate({indicator})` in `runSpir`                                                                                                             | `afterPhase` (default)                                                      |
| 3   | Resume detection + stale-session clearing                   | `implementation.ts` (clears non-`complete` task sessions)                                                                                                         | `onWorkflowResume` / `onResumeTask`                                         |
| 4   | **File-context inlining into prompts**                      | `pool/prompt-builder.ts` **duplicated** by `.lib/planning.ts` (`readContextFile`, `LANG_BY_EXT`, `BINARY_EXTS`, with a comment admitting it "mirrors" the engine) | `collectContext(task, step)` / `beforeStepPrompt` — **single clearest win** |
| 5   | Diff collection before review                               | `final-review.ts::collectDiff` closure                                                                                                                            | `collectContext` keyed to review steps                                      |
| 6   | Audit-log + history appending after structured output       | every phase: `await tracker.auditLog.append(structuredOutputEvent(...))` / `decisionEvent(...)` by hand                                                           | `onStructuredOutput` / `onDecision` observe hook with a default auditor     |
| 7   | review → fixer → review-fixes loop (~400 LOC)               | `final-review.ts`, per dimension, own `LanePool`                                                                                                                  | a `fixLoop` primitive + hooks                                               |
| 8   | Phase retry loops ("scout ≤3 rounds", "plan ≤3 rounds")     | `executePhase` `if (rounds < 3) return "scouting"`                                                                                                                | `shouldRetryPhase`                                                          |
| 9   | Failure isolation (per-lane try/catch + `Promise.all`)      | `final-review.ts` review lanes                                                                                                                                    | `onLaneError` / `shouldIsolate`                                             |
| 10  | Collect completed task results into phase output            | `scouting.ts` collect-loop                                                                                                                                        | `onPhaseSettled` reduce hook                                                |

---

## 6. Recommended direction (validate, then refine)

This is a strong lean, not a mandate. Confirm against the codebase, push back where something fits
better, then implement.

### Core idea: one cohesive hook registry, observe + influence, composed at the existing seam

1. **`HookRegistry`** — a typed registry of named hooks. Each hook has a declared _composition rule_:
   - **observe** hooks (one-way): fan out to all subscribers; no return value. Cheap, many consumers.
     This is exactly today's `StatusCallbacks` model.
   - **influence** hooks (two-way): a small, deliberately-named set with explicit composition:
     - _ordered pipeline_ (e.g. `beforeStepPrompt`): each subscriber transforms the value and passes it
       to the next.
     - _first-defined-wins_ (e.g. `shouldRetryPhase`): the first subscriber returning a non-undefined
       value decides; others are short-circuited.
     - _all-run, aggregate_ (e.g. `onPhaseSettled`): every subscriber contributes; results merged by a
       per-hook reducer.

2. **`composeHooks(callbacks[])`** — turns a list of `StatusCallbacks`/hook-providers into one. The
   single line `options.onStatus = storeCallbacks` in `run-executor.ts` becomes
   `options.onStatus = composeHooks([storeCallbacks, …workflowHooks])`. Observe hooks fan out;
   influence hooks are exposed as additional named seams on the same/adjacent object.

3. **Default implementations** ship in the engine so existing workflows are unchanged. The default
   auditor, default prompt-context inliner, default phase-transition logic, etc. live behind the same
   seams, so a workflow that registers nothing gets today's behavior bit-for-bit.

### Reframe two ideas the owner bundled, and keep them separate

- **(A) Hooks** = the _mechanism_ (designated seams).
- **(B) Breaking apart `LanePool`** = one _application_ of that mechanism, NOT the whole task. The
  task-body decomposition is already done (the runners). What remains bundled in `LanePool` is:
  scheduler core, lifecycle firing, retry budgeting, task registration, claim policy. Decompose those
  behind hooks _after_ the mechanism exists (see §7, §8 ordering).

> The one-liner: **runners made the task body polymorphic; what's still hardcoded is the phase body
> and the cross-cutting concerns. Hooks are how you make _those_ reusable.**

---

## 7. The anchor-point catalog

Organized by hierarchy level. Tagged **[obs]**erve (one-way) vs **[inf]**luence (can return/alter).
`✱` = exists today (promote/unify, don't rebuild).

### Workflow level

- `✱ onWorkflowStart [obs]`
- `onWorkflowResume [obs/inf]` — distinct from start; today conflated via a `resumed` boolean. Lets a
  hook skip init, restore sidebar, clear stale sessions.
- `✱ onWorkflowComplete [obs]` / `✱ onWorkflowFailed [obs]`
- `onWorkflowAbort [obs]` — distinct from fail (Ctrl+C); today bespoke `'Workflow cancelled'`
  string-matching.
- `onPersist(state)` / `onRestore(state) [inf]` — the `tracker.save()/load()` inline in `runSpir`.

### Phase level _(biggest gap — zero engine support today)_

- `✱ onPhaseRegister [obs]`
- `beforePhase(phase, state) [inf]` — mutate inputs, inject context, **skip** the phase, derive state
  (replaces the inline "derive research from saved reports" block).
- `✱ onPhaseStart [obs]`
- `✱ onPhaseComplete [obs]`
- `afterPhase(phase, result) [inf]` — persist state, fire sidebar update.
- `beforePhaseTransition(from, to) [inf]` — **the single seam** deciding advance / loop / jump.
  Generalizes all hand-written scouting/planning retry branches.
- `shouldRetryPhase(phase, result, round) [inf]` — generalize the "≤3 rounds" loops.
- `onPhaseSettled(phase, tasks) [inf]` — reduce task results into phase output (replaces scouting
  collect-loop).

### Task level (LanePool / runner)

- `✱ onTaskRegister [obs]`
- `beforeTask(task) [inf]` — rewrite steps, inject files, skip. Replaces the `getStepsForTask`
  profile-substitution shim in `implementation.ts`.
- `✱ onTaskStart [obs]`
- `✱ resolveRunnerForTask [inf]` — already a hook; the model to generalize.
- `beforeTaskRetry(task, reason) [inf]` — generalize `maybeRetryFailedTask`.
- `✱ onTaskComplete [obs]` / `✱ onTaskRejected [obs]`

### Step level

- `✱ onStepStart [obs]`
- `beforeStepPrompt(prompt, ctx) [inf]` — **highest-leverage new hook.** Pipeline of prompt transforms
  (file inlining, diff, feedback history). Kills the engine/`.lib` duplication (#4).
- `onStepResult(step, result) [obs/inf]` — the structured-output + audit + history-append pattern.
- `shouldRetryStep(step, result, attempts) [inf]` — generalize severity-based fail/approve +
  back-up-one logic baked into `linearStepsRunner`/`reflectionRunner`.

### Agent / tool level

- `✱ onAgentSpawn` / `✱ onAgentComplete` / `✱ onTurnStart` / `✱ onTurnEnd` / `✱ onToolCallStart` /
  `✱ onToolCallEnd` / `✱ onAgentRender [obs]`
- `onToolCall(call) [inf]` — allow/deny/rewrite (the `write-sandbox` and read-only stripping become
  hooks instead of special-case options).
- `onToolResult(result) [inf]` — transform tool results.

### Scheduler / execution level _(the "break apart LanePool" payoff)_

- `claimPolicy(tracker, laneId) [inf]` — generalize `claimTasks(1)` (enables priority, affinity,
  batching).
- `concurrencyKey(task) [inf]` — Inngest-style per-key limits (per-dimension, per-file) so the
  final-review lanes don't need N separate pools.
- `wakeStrategy [inf]` — generalize the TaskReady/TaskSettled + timeout wake.
- `onLaneIdle` / `onLaneStall [obs]` — the hardcoded stall warning.

---

## 8. How `LanePool` decomposes (the application of the mechanism)

The genuinely reusable **core** of `runLane` is tiny: _"N lanes, each claiming from a ready-set,
driving a `TaskRunner`, with abort + wake semantics."_ Everything else is behavior with sensible
defaults that becomes hooks:

```
LanePool today bundles:
  Scheduler      ← CORE: lanes + claim + wake + abort       (keep as primitive)
  Lifecycle      ← onTaskRegister/Start/Complete/Rejected   (→ TaskLifecycle hooks; default: StatusCallbacks)
  RetryPolicy    ← maybeRetryFailedTask                      (→ RetryPolicy hook; default: none)
  ClaimPolicy    ← claimTasks(1)                             (→ ClaimPolicy hook; default: 1, fewest-deps)
  Runner resolve ← getRunnerForTask/getStepsForTask          (already a hook ✓)
```

Decomposed: scouting, implementation, **and** the per-dimension fixer pools in `final-review` all
instantiate the same `Scheduler` with different hooks — instead of three near-identical
`new LanePool({...})` blocks. And `concurrencyKey` removes the need for `final-review` to spawn _five
separate pools_ at all.

**Do this decomposition LAST (step 6 in §10)** — after the hook mechanism and the cheaper wins land.

---

## 9. Caveats — what not to do

1. **Hooks are seams, not substance.** Returning values from a hook doesn't delete boilerplate by
   itself — a _primitive with hook seams_ does. Pair every influence hook with the default impl /
   primitive it customizes (e.g. `beforeStepPrompt` only earns its keep once the prompt-context
   inliner is the default and the `.lib/planning.ts` duplicate is deleted).

2. **Mind the two-way-hook tax.** Influence hooks introduce ordering, composition (first-wins?
   pipeline? all-run?), and error-handling questions that don't exist today. Keep observe-hooks
   one-way and fan-out-many; introduce influence hooks in small, deliberately-named batches with
   explicit, documented composition rules.

3. **Settle deterministically when influence-hooks short-circuit.** A `beforeTask` that skips a task,
   or a `shouldRetryPhase` that loops, must still leave the `TaskTracker`/`WorkflowStatusTracker` in a
   valid, persisted state and fire the expected terminal callbacks, so resume and the TUI stay correct.

4. **Beware the N=3 bias.** develop/improve/debug differ _only_ by config — which is itself evidence
   the SPIR extraction already captured the reusable phase logic at the workflow layer. Validate each
   hook against a genuinely _different_ shape (the `apidoc`/`migrate`/`triage` examples in
   `docs/guides/building-workflows.md`, or an event-driven one) before committing it to the engine API.

5. **Don't entangle hooks with the DAG.** `TaskTracker` is clean and should stay that way. Hooks
   observe/transform at the lifecycle seams; dependency resolution stays in the tracker.

---

## 10. Suggested ordering (lowest risk → highest payoff)

1. **Mechanism + composition seam.** `HookRegistry` / `composeHooks`. Make the single
   `onStatus = storeCallbacks` line a composition. Additive, zero behavior change, unblocks the rest.
2. **`beforeStepPrompt` + `collectContext`.** Deletes the engine/`.lib` prompt-inlining duplication
   (#4) immediately. Contained blast radius, high value.
3. **`onStructuredOutput` / `onDecision` default auditor.** Removes the manual `auditLog.append`
   ceremony from every phase (#6).
4. **Phase-level primitives + `beforePhaseTransition` / `shouldRetryPhase` / `onPhaseSettled`.** The
   big boilerplate win — turns `executePhase`'s hand-written switch + retry branches into data (#1,
   #2, #8, #10). Requires a `PhaseRunner` concept in the engine.
5. **`fixLoop` primitive + `onLaneError` / `shouldIsolate`.** Collapses `final-review.ts` (#7, #9).
6. **`LanePool` decomposition** into `Scheduler` + `ClaimPolicy` + `concurrencyKey` (#7 second-order:
   one pool, not five). Highest churn — do it last, when the seams are proven.
7. **Defer**: tool-level interception hooks (already half-covered by pi's `beforeToolCall`), and
   suspend/resume (the deferred item from the predecessor prompt).

---

## 11. You are expected to research more

The above is a design evaluation, not an implementation spec. Before implementing each tier, read the
authoritative sources for the patterns you are porting and decide how they adapt to engin's event
model and rigid hierarchy. Useful starting points (mirror the predecessor prompt's research):

- **Hook / lifecycle composition patterns**: how frameworks compose ordered pipelines vs.
  first-wins vs. reduce (Mastra delegation hooks, Express/Koa middleware, Fastify hooks,
  webpack/tapable). Decide engin's composition vocabulary deliberately.
- **Inngest concurrency scopes** (`fn/env/account` key-based limits) — for `concurrencyKey`.
- **Temporal's pure-orchestrator vs activity split** — for keeping influence hooks out of the
  deterministic-replay path (analogous to engin's "keep `evolve` pure").
- **CrewAI Flows event model** (`@listen`/`@router`, `and_()`/`or_()` combiners) — for
  `shouldRetryPhase` / `onPhaseSettled` aggregation semantics.

If you find a pattern that fits better than the recommended direction, say so and explain why. If the
direction contradicts something in the codebase, surface it rather than forcing the design.

### Deliver

- Working code under `packages/engine/src/` (likely a new `hooks/` module for the registry +
  `composeHooks`, plus seam additions to `pool/`, `core/phase-tasks.ts`, and wherever phase execution
  gains a `PhaseRunner`).
- Default implementations behind every new seam, so existing workflows are unchanged.
- Migration of the §5 generic behaviors behind the new seams (notably deleting the
  `.lib/planning.ts` prompt-inlining duplicate).
- Tests mirroring the repo's existing style (`packages/engine/src/**/*.test.ts`, `tests/`) covering:
  hook composition rules (pipeline / first-wins / reduce), observe fan-out, default-vs-override
  behavior, deterministic settlement when influence-hooks short-circuit, and backward compatibility
  for workflows that register no hooks.
- Docs updates: `docs/reference/task-pool.md` (pool-level hooks), `docs/guides/building-workflows.md`
  (the hook authoring surface), and a new `docs/reference/hooks.md` describing every seam, its
  composition rule, and when to use it.
