# Hooks reference

Hooks are the **extension seam** that lets a workflow influence and observe the engine
without forking it. A workflow exports an optional `hooks` field (a plain object or an
array of objects); the engine composes those hooks with its own status callbacks and
invokes them at well-defined lifecycle seams.

There are two categories of hook:

- **Influence hooks** change what the engine _does_ — transform a prompt, decide whether to
  retry a phase, veto a merge, provide a runner. They are composed under one of three
  rules: `pipeline`, `first-wins`, or `all-run`.
- **Observe hooks** watch what the engine _did_ — fire-and-forget fan-out with no return
  value, mirroring the existing `StatusCallbacks` model.

Source:

- Types (every hook signature, args, return, `CompositionRule`): `packages/engine/src/hooks/types.ts`.
- Declarations (composition rule + reducer for every hook): `packages/engine/src/hooks/declarations.ts`.
- Registry (`HookRegistry` + `createHookRegistry`): `packages/engine/src/hooks/registry.ts`.
- Composition seam (`composeHooks`): `packages/engine/src/hooks/compose.ts`.
- All-run reducers (`CONTEXT_BLOCK_REDUCER`, `PHASE_RESULTS_REDUCER`): `packages/engine/src/hooks/reducers.ts`.
- Default implementations: `packages/engine/src/hooks/defaults/*.ts`.
- Run wiring (the zero-behavior-change seam): `packages/engine/src/server/run-executor.ts`.

> **Accuracy note.** If anything in this document ever disagrees with
> `packages/engine/src/hooks/types.ts` (the canonical `WorkflowHooks` interface), the
> declarations in `declarations.ts`, or the source files above, **the code wins**. The
> hook catalog below is regenerated against `types.ts` + `declarations.ts`; the "Wired?"
> column reflects the engine source at the time of writing.

---

## 1. Overview

A hook is a function (or array of functions) registered against a well-known name on the
engine's `HookRegistry`. At each lifecycle seam the engine builds a `HookContext` and calls
the matching `invoke*` method:

```ts
interface HookContext {
  registry: HookRegistry; // the registry the hook was registered on
  cwd: string; // original repo cwd (NOT the per-task worktree path)
  workDir: string; // the run dir (.engin/work/{run-id})
  signal?: AbortSignal; // the run's AbortController signal
}
```

The registry implements four composition rules, one per `invoke*` method:

| Rule         | Method            | Behaviour                                                                                                                                                                                |
| ------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe`    | `invokeObserve`   | `Promise.all` fan-out. Every subscriber runs; per-subscriber errors are swallowed + `console.warn`'d so one bad subscriber cannot break the fan-out.                                     |
| `pipeline`   | `invokePipeline`  | Ordered, sequential value transform. Seed with `initialValue`; each subscriber receives the previous subscriber's output and returns the next. Order matters (NOT `Promise.all`).        |
| `first-wins` | `invokeFirstWins` | Sequential. The first subscriber to return a non-`undefined` value decides and short-circuits. Returning `undefined` abstains. Note `false`/`0`/`''` are **not** `undefined` — they win. |
| `all-run`    | `invokeAllRun`    | `Promise.all` of every subscriber, then the results are folded through the hook's reducer (accumulator seeded with `undefined`).                                                         |

Every `invoke*` method is generic over `keyof WorkflowHooks`, so callers are restricted to
declared hook names at compile time.

### The composition seam: `composeHooks`

`composeHooks(storeCallbacks, hookProviders)` is the single seam where a workflow's hooks
meet the engine's status surface. It returns two things:

- **`onStatus`** — a `StatusCallbacks` object that forwards every one of the
  `STATUS_CALLBACK_METHODS` verbatim to the matching `storeCallbacks[method]`. It is
  **behaviorally identical** to `storeCallbacks` — the firmest guarantee in the system
  (existing workflows are unaffected).
- **`registry`** — a fresh `HookRegistry` carrying every influence/observe hook from
  `hookProviders` (normalized from a single provider or an array, registered in order).

A critical design decision pins this seam: **observe/influence firing is NOT done inside
`onStatus`**. It is deferred to the engine primitives (`runStep`, `SessionScheduler`, `PhaseRunner`,
`WorktreeManager`) that own a proper `HookContext` (cwd, workDir, signal).
Routing firing through those primitives keeps `onStatus` synchronous (matching today's store
behaviour), avoids fabricating a hollow context, and leaves the fan-out decision in the
hands of the code that owns a real one.

Consequence: **store callbacks ALWAYS fire**, even when a hook shares the same conceptual
name. `onStatus` never reaches into the registry. The two sinks are independent.

`RunExecutor.execute` (in `run-executor.ts`) calls `composeHooks` and threads the resulting
`registry` into `WorkflowRunOptions.hookRegistry`, from which it flows into `SessionScheduler`,
`PhaseRunner`, and `WorktreeManager`. When `workflow.hooks` is `undefined`,
`workflow.hooks ?? []` yields an empty provider list → an empty registry AND an `onStatus`
identical to `storeCallbacks` → zero behaviour change.

---

## 2. How to register hooks

A workflow module exposes hooks via the optional `hooks` field. It accepts a single
`WorkflowHooks` object **or** an array of them (registered in array order). Each field may
itself be a single function or an array of functions — both are appended to the hook's
subscriber list in order.

```ts
import type { WorkflowModule } from '@harms-haus/engin-engine';

const workflow: WorkflowModule = {
  // …run, name, etc.…

  hooks: [
    {
      // A pipeline hook: rewrite the session prompt before it reaches the agent.
      beforeSessionPrompt: async (value, args) => {
        return `${value}\n\nNote: this repo uses tabs, not spaces.`;
      },

      // An observe hook: log every structured (review) result for analytics.
      onStructuredOutput: [
        async (args) => metrics.record(args.agentId, args.output),
        async (args) => console.log('[review]', args.taskId, args.output),
      ],
    },
    // A second provider object is appended after the first (array order).
    {
      // A first-wins hook: veto merges for tasks flagged 'do-not-merge'.
      onTaskMerge: async (args) => (args.task.metadata?.doNotMerge ? { proceed: false } : undefined),
    },
  ],
};
```

The registry tolerates anything you throw at `register`:

- A single function or an array of functions per field — both work.
- Non-function, non-array field values (`null`, `undefined`, strings, …) are silently
  ignored.
- An unknown hook name is auto-declared as `'observe'` and never throws (defensive — the
  engine declares its own hooks during setup, but a stray field must not crash registration).

### Composition with the engine defaults

The engine registers its own default subscribers into the **same** registry `composeHooks`
builds, **after** the workflow's providers. Because the workflow's subscribers are
registered first:

- **observe** hooks fan out to both (the workflow's subscriber AND the engine default).
- **pipeline** hooks run the workflow's transform first, then the default.
- **first-wins** hooks let the workflow's earlier-registered subscriber decide; the default
  only decides when the workflow abstains (returns `undefined`).

See [§5 — Default implementations](#5-default-implementations) for which defaults the engine
auto-registers versus which it ships for workflows to adopt.

---

## 3. Hook catalog

Every field of the `WorkflowHooks` interface from `types.ts` is listed below, grouped by
level. **22 hooks total.** The `Wired?` column records whether the engine actually invokes
the hook today, and where.

Legend for **Type**: `obs` = observe, `pipe` = pipeline, `fw` = first-wins, `all` = all-run.
Legend for **Wired?**: ✓ = invoked from engine source; ⚠ = declared in `types.ts` but
**not yet wired** (a known gap — see the notes under the table).

### Workflow level

| Name                 | Type | Args                     | Returns                           | Default                                                             | Wired?         | When to use                                                                                 |
| -------------------- | ---- | ------------------------ | --------------------------------- | ------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `onWorkflowResume`   | obs  | `OnWorkflowResumeArgs`   | `void`                            | no-op (`defaultOnWorkflowResume`)                                   | ✓ run-executor | Side effects when resuming a persisted run (restore sidebar, clear sessions).               |
| `onWorkflowAbort`    | obs  | `OnWorkflowAbortArgs`    | `void`                            | `console.warn(reason)` (`defaultOnWorkflowAbort`)                   | ✓ run-executor | Cooperate with a hard-stop abort (tear down child processes) before the terminal broadcast. |
| `onPersist`          | pipe | `OnPersistArgs`          | `WorkflowState`                   | `tracker.save()` then `tracker.toJSON()` (`createDefaultOnPersist`) | ✗¹             | Transform the workflow state before it is persisted.                                        |
| `onRestore`          | pipe | `OnRestoreArgs`          | `WorkflowState`                   | `WorkflowStatusTracker.load(workDir)` (`createDefaultOnRestore`)    | ✗¹             | Transform the restored workflow state before it is used.                                    |
| `beforeRunMerge`     | fw   | `BeforeRunMergeArgs`     | `RunMergeDecision \| undefined`   | `{ proceed: true, strategy: 'squash' }` (`defaultBeforeRunMerge`)   | ⚠ run-executor | Decide whether/how to run-end-merge the main worktree branch into real `main`.              |
| `onRunMergeConflict` | fw   | `OnRunMergeConflictArgs` | `ConflictResolution \| undefined` | `{ strategy: 'agent' }` (`createDefaultOnRunMergeConflict`)         | ⚠ run-executor | Decide how to resolve a conflict in the run-end final merge.                                |

> ¹ `onPersist` / `onRestore` defaults are **shipped but not engine-registered** — the
> `WorkflowStatusTracker` they capture is created by the _workflow_ (e.g. `spir.ts`), so the
> workflow registers those defaults itself. The engine only fires/registers hooks it owns; it
> does not fabricate a tracker.

### Phase level

| Name                    | Type | Args                        | Returns                                                | Default                                                                                                | Wired?         | When to use                                                                      |
| ----------------------- | ---- | --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------- |
| `beforePhase`           | fw   | `BeforePhaseArgs`           | `BeforePhaseResult \| undefined`                       | _(none shipped — abstain = phase runs normally; `PhaseRunner` applies `statePatch` / honours `skip`)_  | ✓ phase-runner | Skip a phase and/or patch the shared workflow-state bag.                         |
| `afterPhase`            | obs  | `AfterPhaseArgs`            | `void`                                                 | fires `onSidebarUpdate` (`createDefaultAfterPhase`)                                                    | ✓ phase-runner | React to a phase completing (sidebar indicator, status event).                   |
| `beforePhaseTransition` | fw   | `BeforePhaseTransitionArgs` | `PhaseTransition \| undefined`                         | `{ type: 'advance' }` (`defaultBeforePhaseTransition`)                                                 | ✓ phase-runner | Choose the next transition: `advance` / `loop` / `jump` (with `target`).         |
| `shouldRetryPhase`      | fw   | `ShouldRetryPhaseArgs`      | `boolean \| undefined`                                 | `true` when `{ retry: true }` or legacy `'scouting'` AND `round < 3` (`defaultShouldRetryPhase`)       | ✓ phase-runner | Decide whether to re-run the phase (bounded by `maxRounds`, default 3).          |
| `onPhaseSettled`        | all  | `OnPhaseSettledArgs`        | `unknown` (default contributes `{ [taskId]: result }`) | `{ [taskId]: result }` for complete tasks (`defaultOnPhaseSettled`); folded by `PHASE_RESULTS_REDUCER` | ✓ phase-runner | Collect per-phase task results into the shared state bag once all tasks settled. |

### Task level

| Name         | Type | Args             | Returns                         | Default                                                         | Wired?              | When to use                                                        |
| ------------ | ---- | ---------------- | ------------------------------- | --------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| `beforeTask` | fw   | `BeforeTaskArgs` | `BeforeTaskResult \| undefined` | _(none shipped — abstain = task runs normally via runner pool)_ | ✓ session-scheduler | Skip a task (`{ skip: true }`) or override its `runner` / `files`. |

> **§2.14 — `BeforeTaskResult.runner`.** In the session-first engine,
> `SessionScheduler.resolveRunner` interprets the hook result dynamically: when a
> subscriber returns `{ runner: <Runner> }`, that `Runner` function is used for
> the task (takes precedence over the default runner resolution via `resolveRunner`). The `{ steps: [...] }`
> field is legacy (left over from the `LanePool` + `getStepsForTask` era, now
> removed) and is **not read** by `SessionScheduler` — use `runner` instead.
> `BeforeTaskArgs` carries only `{ task }`; the legacy `steps` array is no
> longer seeded into the hook invocation.

### Session level

| Name                  | Type | Args                      | Returns                     | Default                                                                                        | Wired?           | When to use                                                             |
| --------------------- | ---- | ------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `beforeSessionPrompt` | pipe | `BeforeSessionPromptArgs` | `string`                    | legacy `buildPrompt` assembly (`defaultBeforeSessionPrompt`)                                   | ✓ step-execution | Transform the session prompt before it is sent to the agent.            |
| `collectContext`      | all  | `CollectContextArgs`      | `ContextBlock \| undefined` | inline `task.files` contents (`defaultCollectContext`); concatenated by `CONTEXT_BLOCK_REDUCER | ✗²               | Contribute labeled context blocks (file contents, diffs) to the prompt. |

> ² `beforeSessionPrompt` was wired in the removed `step-execution.ts` (the legacy
> step-execution path). The new session primitive (`runSession` / `SessionScheduler`)
> builds the prompt from the `SessionSpec` directly and does **not** consult
> `beforeSessionPrompt`. `collectContext` is **declared but not yet invoked** — the
> shipped `defaultCollectContext` is inlined into `defaultBeforeSessionPrompt`
> instead. Treat `collectContext` as the documented extension
> point for additional context providers; the engine does not yet fan it out independently.

### Worktree lifecycle

| Name                       | Type | Args                     | Returns                                 | Default                                                                                       | Wired?             | When to use                                                                           |
| -------------------------- | ---- | ------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| `beforeTaskWorktreeCreate` | fw   | `BeforeTaskWorktreeArgs` | `BeforeTaskWorktreeResult \| undefined` | `{ skip: true }` for read-only profiles `['scout']` (`createDefaultBeforeTaskWorktreeCreate`) | ✓ worktree-manager | Skip isolation (run against the main worktree) or override base branch / extra files. |
| `afterTaskWorktreeCreate`  | obs  | `AfterTaskWorktreeArgs`  | `void`                                  | no-op (`defaultAfterTaskWorktreeCreate`)                                                      | ✓ worktree-manager | React to a freshly-created task worktree.                                             |
| `populateWorktree`         | pipe | `PopulateWorktreeArgs`   | `void`                                  | `.worktreecopy` copy + symlink (`createDefaultPopulateWorktree`)                              | ✓ worktree-manager | Populate a worktree (`bun install`, copy secrets, check out branches).                |
| `onTaskMerge`              | fw   | `OnTaskMergeArgs`        | `TaskMergeDecision \| undefined`        | `{ proceed: true, strategy: 'squash' }` (`defaultOnTaskMerge`)                                | ✓ worktree-manager | Veto or steer a task-branch merge into the main worktree branch.                      |
| `onMergeConflict`          | fw   | `OnMergeConflictArgs`    | `ConflictResolution \| undefined`       | `{ strategy: 'agent' }` (`createDefaultOnMergeConflict`)                                      | ✓ worktree-manager | Decide how to resolve a task-branch merge conflict.                                   |
| `onCommitFailure`          | fw   | `OnCommitFailureArgs`    | `CommitFailureResolution \| undefined`  | `{ strategy: 'agent' }` (`createDefaultOnCommitFailure`)                                      | ✓ worktree-manager | Decide how to handle a commit failure (lint errors, hook rejection).                  |

### Audit observe hooks

| Name                 | Type | Args                     | Returns | Default                                              | Wired?           | When to use                                                             |
| -------------------- | ---- | ------------------------ | ------- | ---------------------------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `onStructuredOutput` | obs  | `OnStructuredOutputArgs` | `void`  | append `structured_output` AuditEvent (`auditor.ts`) | ✓ step-execution | Observe every structured (e.g. review) result before the approval gate. |
| `onDecision`         | obs  | `OnDecisionArgs`         | `void`  | append `decision` AuditEvent (`auditor.ts`)          | ✓⁴               | Observe a decision (rejection, retry, escalation) into the audit log.   |

> ⁴ `onDecision` is **fired from multiple engine runner sites** (`linear-steps-runner`,
> `reflection-runner`, `phase-tasks`) rather than a single centralized seam, and is registered
> by `SessionScheduler` when an `auditLog` + `hookRegistry` are present. It is distinct from
> `StatusCallbacks.onDecision`, which writes a `decision` event into the **event store** (a
> separate sink). The audit-log hook and the event-store callback fire independently into
> different consumers.

### Known wiring gaps (honest summary)

| Hook                                    | Status                                                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collectContext`                        | Declared in `types.ts`; inlined into `defaultBeforeSessionPrompt` rather than fanned out independently.                                                                                                                         |
| `beforeSessionPrompt` (session path)    | Wired in `step-execution.ts` (legacy step path). NOT yet wired in the new `runSession` / `SessionScheduler` session path.                                                                                                       |
| `onPersist` / `onRestore`               | Defaults shipped; engine does not auto-register them (the tracker is workflow-owned).                                                                                                                                           |
| `beforeRunMerge` / `onRunMergeConflict` | Defaults shipped + registered in `run-executor.ts`, but **not yet invoked** — `RunManager.handleWorktreeAction` calls `finalMergeToMain()` directly without consulting the hooks. The final-merge gate UX is still being built. |

> **Removed hooks.** The following hooks have been **deleted** from
> `WorkflowHooks` in `types.ts` as part of the session-first redesign:
> `claimPolicy`, `concurrencyKey`, `wakeStrategy`, `onLaneIdle`, `onLaneStall`,
> `onLaneError`, `shouldIsolate`.
> Their functionality is now handled internally by `SessionScheduler` +
> `SessionGate` (concurrency is enforced by the gate, not by hooks) and by
> the `SessionPlanRunner` review/fix loop contract (lane-error observation and
> worktree isolation are runner-internal concerns, no longer exposed as hooks).
> Registering them is a no-op. The legacy `LanePool` / `Scheduler` that once
> consumed `claimPolicy` has also been removed; `SessionScheduler` claims all
> ready tasks and gates them via `SessionGate`.

---

## 4. Composition rules explained

### observe — fan-out, errors swallowed

```ts
registry.register({
  onStructuredOutput: async (a) => metrics.record(a),
});
// invokeObserve runs every subscriber via Promise.all; if one throws, the others
// still run and the error is console.warn'd — never propagated.
```

When to reach for it: side effects that must not break the engine (telemetry, audit logging,
status events). `invokeObserve` returns `void` (well, `Promise<void>`).

### pipeline — ordered value transform

```ts
registry.register({
  beforeSessionPrompt: [async (value) => value.toUpperCase(), async (value) => `${value}\n— signed, engin`],
});
// invokePipeline seeds with the session prompt; subscriber 1 upper-cases it; subscriber 2
// appends the sign-off. The agent receives the final string. Sequential — order matters.
```

When to reach for it: transforming a value through stages (prompt assembly, state shaping).
Returns the final value; with no subscribers it returns the seed unchanged.

### first-wins — short-circuit decision

```ts
registry.register({
  onTaskMerge: [
    async (a) => (a.task.metadata?.doNotMerge ? { proceed: false } : undefined),
    async (_a) => ({ proceed: true, strategy: 'squash' }), // the engine default, appended later
  ],
});
// invokeFirstWins returns the first non-undefined result and stops. The first subscriber
// wins for do-not-merge tasks; otherwise it abstains (undefined) and the default decides.
```

When to reach for it: a single decision with optional abstention (veto a merge, decide a
transition, isolate a failure, provide a runner for a task). Remember: `false`, `0`, and
`''` are **decisions**, not abstentions — only `undefined` abstains.

### all-run — everyone contributes, reducer folds

```ts
registry.register({
  collectContext: [
    async (a) => ({ label: 'files', content: await readFiles(a) }),
    async (a) => ({ label: 'diff', content: await getDiff(a) }),
  ],
});
// invokeAllRun runs every subscriber via Promise.all, then folds the ContextBlock[]
// through CONTEXT_BLOCK_REDUCER (array concatenation). The final folded value is returned.
```

When to reach for it: aggregating independent contributions into one value (context blocks,
per-phase result maps). The reducer is required for `'all-run'` hooks; the accumulator is
seeded with `undefined` (the reducer's identity). With no reducer, the last contribution is
returned.

---

## 5. Default implementations

The engine ships reference defaults in `packages/engine/src/hooks/defaults/`. They reproduce
prior behaviour exactly so a workflow that registers no hooks is unaffected. Two questions
matter: **what does each default do**, and **who registers it**.

### Engine-registered defaults (automatic)

These are registered into the `composeHooks` registry by engine code, so every run gets them:

| Default                                                               | Registered by            | Behaviour it reproduces                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDefaultAuditor(auditLog)` → `onStructuredOutput`, `onDecision` | `SessionScheduler.run()` | Appends `structured_output` / `decision` AuditEvents to the durable AuditLog (registered only when `auditLog` + `hookRegistry` are present). |
| `defaultOnWorkflowResume`                                             | `run-executor`           | No-op (resume logic stays in the workflow).                                                                                                  |
| `defaultOnWorkflowAbort`                                              | `run-executor`           | `console.warn(reason)` (the old `'Workflow cancelled'` string-match, now data-driven).                                                       |
| `defaultBeforeRunMerge`                                               | `run-executor` (git)     | `{ proceed: true, strategy: 'squash' }` (legacy run-end final merge).                                                                        |
| `createDefaultOnRunMergeConflict(profilesDirs, apiKeys)`              | `run-executor` (git)     | `{ strategy: 'agent' }` marker — delegates to the tooled agent resolver downstream.                                                          |
| `createDefaultBeforeTaskWorktreeCreate()`                             | `run-executor` (git)     | `{ skip: true }` for read-only profiles `['scout']` (scouts run against the main worktree).                                                  |
| `createDefaultPopulateWorktree(sourceCwd)`                            | `run-executor` (git)     | Delegates to `core/git.ts::populateWorktree` (the `.worktreecopy` copy + symlink primitive).                                                 |
| `defaultAfterTaskWorktreeCreate`                                      | `run-executor` (git)     | No-op (post-create state stays internal to `WorktreeManager`).                                                                               |
| `defaultOnTaskMerge`                                                  | `run-executor` (git)     | `{ proceed: true, strategy: 'squash' }` (legacy per-task squash merge).                                                                      |
| `createDefaultOnMergeConflict(profilesDirs, apiKeys)`                 | `run-executor` (git)     | `{ strategy: 'agent' }` marker — delegates to the tooled conflict resolver.                                                                  |
| `createDefaultOnCommitFailure(profilesDirs, apiKeys)`                 | `run-executor` (git)     | `{ strategy: 'agent' }` marker — delegates to the tooled fix-up primitive.                                                                   |

### Shipped defaults (workflows / inline fallbacks own the wiring)

These ship in `defaults/` but the engine does **not** auto-register them. Workflows adopt
them explicitly, or the engine provides an **inline fallback** at the seam when no
subscriber fires:

| Default                                    | Behaviour it reproduces                                                                                                                | Wiring                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `defaultBeforeSessionPrompt`               | Legacy `buildPrompt` assembly: task header, step header, inlined file context, prompt body, review-feedback history.                   | `step-execution` falls back to calling `buildPrompt` directly when no subscriber is registered.     |
| `defaultCollectContext`                    | Reads `task.files`, skips binaries, inlines each as a fenced block (10 KB cap).                                                        | Inlined into `defaultBeforeSessionPrompt`; not independently fanned out (see §3 note ²).            |
| `defaultShouldRetryPhase`                  | `true` when result is `{ retry: true }` or legacy `'scouting'` AND `round < 3`; else abstains.                                         | `PhaseRunner` has an inline `this.defaultShouldRetry(result)` fallback used when the hook abstains. |
| `defaultBeforePhaseTransition`             | `{ type: 'advance' }` (linear progression).                                                                                            | `PhaseRunner` falls back to `{ type: 'advance' }` when the hook abstains.                           |
| `defaultOnPhaseSettled`                    | Contributes `{ [task.id]: task.result }` for `complete` tasks; folds via `PHASE_RESULTS_REDUCER`; writes `state[`${phaseId}Results`]`. | Reference implementation; the bundled `spir.ts` workflow registers its own per-phase variant.       |
| `createDefaultAfterPhase(onSidebarUpdate)` | Fires the captured `onSidebarUpdate` status callback with `Phase: <phaseId>` (sidebar indicator).                                      | Reference implementation (factory — needs the `StatusCallbacks.onSidebarUpdate` dependency).        |
| `createDefaultOnPersist(tracker)`          | `await tracker.save()` then returns `tracker.toJSON()` (ignores the incoming pipeline value).                                          | Workflow-owned (the tracker is created by the workflow, e.g. `spir.ts`).                            |
| `createDefaultOnRestore(workDir)`          | `WorkflowStatusTracker.load(args.workDir)`; the disk-loaded state wins.                                                                | Workflow-owned.                                                                                     |

### Reducers (`hooks/reducers.ts`)

| Reducer                 | Hook             | Fold                                                                                                                                                             |
| ----------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_BLOCK_REDUCER` | `collectContext` | Array concatenation: `[...(acc ?? []), next]`.                                                                                                                   |
| `PHASE_RESULTS_REDUCER` | `onPhaseSettled` | Shallow-merge per-subscriber `{ [taskId]: result }` records; later contributions win on conflicts. Seeded from `undefined` as `{}`. Always returns a new object. |

---

## 6. Constraints

The hook system is governed by a set of invariants that keep it safe to adopt incrementally:

1. **Backward compatibility is absolute.** A workflow that exports no `hooks` field is
   byte-for-byte unchanged in behaviour. Every seam is gated on `hasSubscribers(name)`; an
   empty or no-subscriber registry short-circuits to the legacy path (direct `buildPrompt`
   call, default runner from `SessionScheduler.resolveRunner()`, `console.warn` lane error, etc.) without a
   pointless `invoke*` round-trip.

2. **`StatusCallbacks` stays the default/terminal sink.** Observe hooks are a _secondary_
   fan-out, never a replacement for the event store. Store callbacks ALWAYS fire; `onStatus`
   never reaches into the registry. The audit-log `onDecision` hook and the event-store
   `StatusCallbacks.onDecision` callback fire **independently into different sinks** — do not
   conflate them.

3. **Rigid execution hierarchy.** Hooks are invoked at fixed lifecycle seams only
   (workflow → phase → task → step → worktree → scheduler). A hook cannot reorder the
   hierarchy or bypass a seam. The two observable exceptions to "single decision" — observe
   fan-out and pipeline chaining — are the only multi-subscriber composition models.

4. **Observability is additive.** Observe hooks (`onStructuredOutput`, `onDecision`,
   `afterPhase`, …) never mutate control flow. A throwing observe subscriber
   is swallowed + `console.warn`'d — one bad subscriber cannot break the fan-out or the run.

5. **`evolve` stays pure.** The event-store reducer (`@engin/shared/evolve`, imported by
   `packages/engine/src/tracking/event-store.ts`) is a pure function of `(projection, event) →
projection`. Hooks must never touch it; the projection is derived solely from appended
   events. Workflow-level influence lives in hooks, never in the evolve reducer.

6. **A hook context is built by the engine, not the workflow.** `HookContext` carries the
   real `cwd` / `workDir` / `signal`. Workflows receive it as a parameter; they do not
   construct it. This is why firing is deferred to the engine primitives rather than done
   inside `onStatus`.

---

## 7. The two-cwd world

When worktrees are in use, every task runs inside its **own worktree** checkout — a
different filesystem path from the run cwd. Hooks that resolve files must honour this:

- `BeforeSessionPromptArgs` and `CollectContextArgs` carry both `cwd` (the run cwd) and an
  optional `worktreeCwd` (the per-task worktree path).
- The resolution rule is **`worktreeCwd ?? cwd`**: files are read from the per-task worktree
  when present, falling back to the run cwd otherwise.
- `defaultCollectContext` and `defaultBeforeSessionPrompt` (in `defaults/prompt-context.ts`)
  implement this via the shared `resolveFileCwd(args)` helper, delegating per-file formatting
  to `pool/file-context.ts::collectFileSection` — the single source of truth shared with the
  legacy `buildPrompt`, guaranteeing byte-identical file sections when `value === task.prompt`
  and `worktreeCwd` is absent.
- `HookContext.cwd` itself is the **original** repo cwd (not the worktree path). Hooks that
  need the worktree path receive it through their **args** (e.g.
  `BeforeRunMergeArgs.worktree`, `PopulateWorktreeArgs.worktreePath`). The `WorktreeManager`
  builds its own `HookContext` with `cwd = sourceCwd` (the user's repo).

This is the single behavioural difference from legacy `buildPrompt(task, step, cwd)`: files
resolve against the worktree the task is actually executing in.

---

## Appendix: the final-review phase and the review/fix loop boundary

> **Note.** The legacy `fixLoop` primitive (`packages/engine/src/pool/fix-loop.ts`)
> and its associated hooks (`onLaneError`, `shouldIsolate`) have been **removed** as
> part of the `SessionPlanRunner` redesign. Review/fix loops are now expressed
> entirely within `SessionPlanRunner` implementations (e.g. `reviewRunner` in the
> workflow `.lib`), which own the review → fix → re-review cycle internally. The
> record below is retained for historical context.

### Why the final-review phase uses per-lane `SessionPlanRunner` loops (t-40 decision record)

The bundled **final-review** phase (`~/.config/engin/workflows/.lib/final-review.ts`) is a
**multi-dimensional** review that runs several specialized reviewers in **parallel** as
independent lanes (by default: efficiency, code-quality, ui-ux, security, documentation).
Each lane runs its **own** focused loop over a single dimension:

```
review ──▶ (no actionable findings? done)
         (actionable findings) ──▶ fixer ──▶ review-fixes ──┐
                                    ▲                        │
                                    └── still actionable? ───┘
                                    (loop, up to MAX_FIX_ROUNDS)
```

A single-task primitive like the former `fixLoop` is the wrong abstraction for this
workload because:

- **Multi-dimension fan-out.** Each reviewer dimension is an independent lane; findings from
  one dimension must never mix into another dimension's fixer. The final-review phase spawns
  a **per-lane fixer `SessionScheduler`** and uses `runSession` for per-finding work — a
  parallel-fan-out model a single-task signature cannot express.
- **History-aware verify prompts.** Each lane maintains its **own per-dimension history**
  (all prior review AND review-fixes results) so a reviewer never re-reports already-fixed
  items. The `review-fixes` pass is verify-focused ("confirm your prior findings were
  resolved; report unresolved ones and any new issues the fix introduced").
- **Severity gating.** Only findings rated `medium` / `high` / `critical` spawn fixers;
  `low` findings are recorded but skipped. The fixer itself fans out **per finding**.

This is a **deliberate design boundary**: single-task review/fix loops are now expressed
within `SessionPlanRunner` implementations, while multi-dimensional, per-finding parallel
review stays in workflow code built on `SessionScheduler` + `runSession`. Documenting this
boundary here is the required record of the skipped t-40 migration.
