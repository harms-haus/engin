# Prompt: Add a retrospective-council runner (built-in engine runner) and rewire the SPIR review phase onto it

> **This is a task prompt, not a plan.** It contains the goal, locked technical
> decisions, and research findings to seed the **develop** workflow. The workflow
> must first **scout** the codebase to **verify the claims below**, then **plan**
> atomic implementation tasks from those verified findings. Treat every factual
> claim in this document as something to confirm, not assume.

---

## 1. Goal

Add a new built-in engine runner, **`retrospectiveCouncilRunner`**, that lives
alongside the existing `councilRunner` and `reviewRunner` in
`packages/engine/src/pool/runners/`, then rewire the SPIR workflows' **review
phase** (in `~/.config/engin/workflows/.lib/`) to drive it as **5 parallel
tasks** — one per review dimension — instead of the current hand-rolled,
per-lane `finalReviewPhase`.

The runner implements an **agent-driven review/fix/retrospect loop** with a
**convener → (members → retrospective)\*** structure and a pressure-valve
early-exit. It must be generic and schema-agnostic (like `reviewRunner`), with
all workflow-specific meaning supplied by caller-provided transform callbacks.

Objectives, in priority order:

1. **A new first-class engine runner** (`retrospectiveCouncilRunner`) that is a
   peer of `councilRunner`/`reviewRunner` under the `SessionPlanRunner` async-
   generator contract. It owns the loop; the scheduler owns the gate (and thus
   model-cap enforcement).
2. **Rewire the review phase** so it submits 5 `TaskGraph` tasks — one each for
   `efficiency`, `code-quality`, `ui-ux`, `security`, `documentation` — each
   task's `runnerFactory` being a `retrospectiveCouncilRunner` scoped to that
   single dimension.
3. **Reuse existing profiles everywhere.** No new agent profiles are authored.
   The 5 existing reviewer profiles are used for both the convener and the
   retrospective passes; `fixer` (+ `fixer-reviewer`) are used for the council
   members. (See §3 for the role mapping.)
4. **Real global model-cap enforcement across the review phase.** Today the
   review fixers bypass `config.modelConcurrency` entirely (see §6.4); this is a
   concrete bug-class the rewire fixes as a side effect.

This is a **two-repo change**: `packages/engine` (new runner + tests) **and**
`~/.config/engin/workflows/` (`.lib/` review phase + schemas + config + 3
workflow wrappers + structure tests). The engine runner must be shipped/usable
independently of the SPIR workflows.

---

## 2. Locked technical decisions (already made — do not relitigate)

### 2.1 The loop structure: convener → (members → retrospective)\*, with a pressure-valve

Each dimension task runs this generator:

```
batch 1:  [convener]                          ──▶ SessionResult
          members = buildMembers(convenerResult)
          if members.length === 0:  RETURN      ← PRESSURE-VALVE (clean on first pass)

          ┌──▶ batch: [members...]              ──▶ SessionResult[]
          │    batch: [retrospective]           ──▶ SessionResult
          │    { terminate, nextMembers } = interpretRetro(retroResult)
          │    if terminate OR nextMembers.length === 0:  RETURN
          └──── nextMembers ──▶ loop
```

- **The convener runs exactly once** to seed the first findings. There is no
  separate re-convener each round.
- **The retrospective pass of round N is effectively the convener pass of
  round N+1.** Because the convener and the retrospective are the _same_
  reviewer profile for a given dimension task, the retrospective _is_ the
  re-review; its own findings drive the next round's members. No redundant
  review pass.
- **Pressure-valve (two symmetric guard points).** If `buildMembers` returns
  `[]` after the convener, the runner returns before yielding any members or
  retrospective batch. The same empty-members check applies after each
  retrospective: `terminate === true` **OR** `nextMembers.length === 0` ⇒ end.
  "Empty member batch ⇒ terminate" is the single rule, evaluated at both entry
  points to the loop.
- **Hard cap.** `maxRounds` bounds the loop regardless of the agent's decision
  (default supplied by the caller/workflow). Reaching `maxRounds` ends the task
  (it does **not** throw — a review task running out of budget is a normal
  "still has findings" outcome, not a failure).

### 2.2 The runner is generic and schema-agnostic (transform-callback boundary)

The engine runner contains **no council schemas, no finding shapes, no profile
knowledge**. It takes pre-built `SessionSpec`s plus caller-supplied transform
functions. This matches how `reviewRunner` already behaves (it never hardcodes a
schema; it reads `reviewData.approved` generically off the structured result).

Authoritative API (names are the implementer's to refine; the shape is fixed):

```ts
// packages/engine/src/pool/runners/retrospective-council-runner.ts

export interface RetrospectiveCouncilRunnerOptions {
  /** Single convener session spec (one reviewer dimension). */
  convener: SessionSpec;
  /** Turn the convener's structured result into the member (fixer) specs for
   *  the first round. Return [] to trigger the pressure-valve (clean → done). */
  buildMembers: (convenerResult: SessionResult) => SessionSpec[];
  /** Single retrospective session spec (same reviewer dimension as convener). */
  retrospective: SessionSpec;
  /** Interpret the retrospective's structured result: should we stop, and if
   *  not, what members run next round? terminate=true OR nextMembers.length===0
   *  both end the task. */
  interpretRetrospective: (retroResult: SessionResult) => { terminate: boolean; nextMembers: SessionSpec[] };
  /** Hard cap on (members → retrospective) rounds. Default DEFAULT_MAX_ROUNDS. */
  maxRounds?: number;
}

export function retrospectiveCouncilRunner(options: RetrospectiveCouncilRunnerOptions): SessionPlanFactory;
```

The generator yields: `[convener]`; then, per round, `[...members]` and
`[retrospective]`. `execute` delegates to `defaultExecute` (gate-free), exactly
like `councilRunner`/`reviewRunner`. The runner never touches the
`SessionGate`.

### 2.3 The review phase = 5 parallel tasks, one shared scheduler/gate

The SPIR `review` phase body builds a `TaskGraph` and adds **5 tasks** — one per
review dimension. Each task's `runnerFactory` is a `retrospectiveCouncilRunner`
configured for that dimension. A single `SessionScheduler` drains the whole
graph through one shared `SessionGate`.

This means convener + member + retrospective sessions across **all 5
dimensions** compete for the same global gate capacity and respect the same
`provider:model` caps. (Today each lane hand-rolls its own scheduler+gate per
fix round, so lanes do not share capacity and model caps are unenforced on
review fixers — see §6.4.)

### 2.4 Role mapping — reuse existing profiles, no new profiles

| Phase in the loop | Profile(s) used                                                                     | Notes                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Convener**      | the dimension's existing reviewer (e.g. `code-quality-reviewer`)                    | reviews the current diff → structured `FinalReviewResult`. The actionable findings (severity ≥ medium) become the council members.                                                                             |
| **Members**       | `fixer` (+ `fixer-reviewer` verify step, i.e. the workflow's existing `fixerSteps`) | one fixer task per actionable finding, run in parallel, model-capped by the shared gate.                                                                                                                       |
| **Retrospective** | the **same** dimension reviewer                                                     | re-reviews the post-fix diff → a `RetrospectiveDecision` (`{ terminate, findings }`). "work done" ⇒ `terminate=true`; "more work to do" ⇒ `findings` drive the next member batch via `interpretRetrospective`. |

**No `council-convener` or `retrospective-reviewer` profiles are created.** The
only schema addition is `RetrospectiveDecisionSchema` in the workflow `.lib/`;
the convener reuses the existing `FinalReviewResultSchema`.

### 2.5 Not-applicable reviewers count as clean

A reviewer that returns `applicable: false` (e.g. the security reviewer on a
docs-only change) contributes zero findings. It does **not** block termination,
and — once known irrelevant — its dimension task hits the pressure-valve on the
first convener pass and ends immediately.

### 2.6 Opt-in per workflow via `reviewStrategy`, keep the static path

Add `reviewStrategy: 'static' | 'council'` (default `'static'`) and
`maxCouncilRounds?: number` (default `4`) to `WorkflowConfig`. The `spir.ts`
`review` phase body branches on it: `'static'` ⇒ existing `finalReviewPhase`
(unchanged); `'council'` ⇒ new council review phase. `develop`, `improve`, and
`debug` set `reviewStrategy: 'council'`. The battle-tested static path stays as
a fallback and its structure tests stay green.

---

## 3. The role mapping in detail (restated for the scout)

For one dimension task (say `code-quality`), a single
`retrospectiveCouncilRunner` instance runs:

1. **Convener** — a `code-quality-reviewer` session over the current git diff.
   Emits `FinalReviewResult` (existing schema). The workflow's
   `buildMembers(result)` maps each actionable finding (severity ≥ medium) into
   a fixer `SessionSpec` built from the workflow's `fixerSteps`.
2. **Members** — the fixer `SessionSpec[]` from step 1, yielded as one batch.
   The scheduler runs them in parallel through the shared gate.
3. **Retrospective** — a `code-quality-reviewer` session over the now-updated
   diff (review-fixes semantics: "confirm prior findings resolved; report
   unresolved + regressions"). Emits `RetrospectiveDecision`.
4. `interpretRetrospective(retroResult)` returns `{ terminate, nextMembers }`.
   `nextMembers` is derived from the retrospective's own remaining findings —
   it already re-reviewed the current diff, so its findings _are_ the remaining
   work. If `terminate` or `nextMembers.length === 0`, the task ends; otherwise
   loop to step 2 with `nextMembers`.

The other four dimension tasks run the identical structure concurrently against
their own reviewer profile, all on the same `TaskGraph`/`SessionScheduler`/
`SessionGate`.

---

## 4. Scope

### In scope

- **`packages/engine`**
  - New `src/pool/runners/retrospective-council-runner.ts`.
  - Barrel export in `src/pool/runners/index.ts`.
  - `src/pool/runners/retrospective-council-runner.test.ts` (batch/assertion
    style matching the other runner tests — see `council-runner.test.ts`,
    `review-runner.test.ts`).
- **`~/.config/engin/workflows/.lib/`**
  - New `retrospective-council-phase.ts`: builds the 5 dimension tasks, each a
    `retrospectiveCouncilRunner`, and submits them to one shared
    `SessionScheduler`/`SessionGate`. Reuses the existing
    `buildReviewerPrompt`/`buildReviewFixesPrompt` prompt builders (or their
    near-equivalents) from `final-review.ts`.
  - `RetrospectiveDecisionSchema` (+ type) in `schemas.ts`. Convener reuses
    `FinalReviewResultSchema`.
  - `WorkflowConfig` gains `reviewStrategy` + `maxCouncilRounds` in `config.ts`.
  - `spir.ts` `review` phase body branches on `reviewStrategy`.
- **Per-workflow (`develop`, `improve`, `debug`)**
  - `main.ts`: set `reviewStrategy: 'council'` and (optionally) `maxCouncilRounds`.
  - `tests/*.structure.test.ts`: assert the new config fields and the new
    `.lib/` export.

### Out of scope

- Authoring new agent profiles (none are created).
- Changes to `packages/cli`, `packages/tui`, `packages/web`, `packages/shared`.
- Changes to the engine's `SessionGate`, `SessionScheduler`, `TaskGraph`, or the
  `SessionPlanRunner` contract (consumed as-is).
- Changing the scouting, planning, or implementation phases.
- Removing the static `finalReviewPhase` path (kept as fallback).

---

## 5. Verification gates / acceptance criteria

1. `cd packages/engine && bun test src/pool/runners/retrospective-council-runner.test.ts`
   passes, asserting: convener-only path (pressure-valve, clean), one full
   round, multi-round loop, `terminate` ends, empty `nextMembers` ends,
   `maxRounds` ends without throwing, batch contents/order correct.
2. `cd develop && bun test` (and `improve`, `debug`) structure tests pass with
   the new config fields and exports.
3. `cd develop && bunx tsc --noEmit` (and `improve`, `debug`) type-check clean,
   including the shared `.lib/` backbone (per-workflow `tsconfig.json` includes
   `../.lib/**/*.ts`).
4. The new runner is exported from `@harms-haus/engin-engine` (barrel) and
   importable without any workflow dependency.
5. Manual/behavioural: a `develop` run through the review phase spawns 5 tasks
   (one per dimension), each with its own convener→(members→retro) sessions
   visible in the audit log / TUI, and a clean convener (no actionable findings
   for a dimension) ends that dimension's task immediately.

---

## 6. Research findings (verify during scouting)

### 6.1 The `SessionPlanRunner` async-generator contract

File: `packages/engine/src/pool/runners/session-plan-types.ts`.

- A runner is a stateful object with `plan(ctx)` (an async generator yielding
  `SessionSpec[]` batches) and `execute(ctx, spec)` (runs one session).
- **Batch atomicity:** the scheduler does not call `gen.next(results)` until the
  _entire_ current batch has settled. `results` is `SessionResult[]` in spec
  order. The generator uses these to decide what to yield next.
- **The runner never touches the gate.** The scheduler acquires the gate slot
  before calling `execute()` and releases it after. `execute` should delegate to
  `defaultExecute` (`runner-utils.ts`), which calls `runScheduledSession`.
- The generator's `return` value may be a final `SessionResult[] | undefined`;
  `undefined` means the runner does not aggregate terminal results (the
  scheduler tracks them). `retrospectiveCouncilRunner` should `return undefined`.

### 6.2 Existing peers to mirror

- **`council-runner.ts`** — Phase 1 workers (parallel batch) → Phase 2
  synthesizer. Shows the workers-then-synthesize two-phase pattern and the
  `defaultExecute` + `SessionSpec` building idiom.
- **`review-runner.ts`** — execute→review loop until `approved` or `maxRounds`.
  Shows the multi-round loop, stable-id convention (`${taskId}/${role}`),
  `resume:true` on round 2+, and reading `reviewData.approved` generically off
  the structured result. **The retrospective-council runner is essentially a
  fusion of these two:** councilRunner's parallel-members phase +
  reviewRunner's loop/terminate, with the convener seeding the first members and
  the retrospective replacing review's approve/reject.
- **`runner-utils.ts`** — exports `defaultExecute` and `delegateToChild` (an
  async-generator helper for composing runners; not needed here unless the
  members/fixer phase itself delegates to another runner).

### 6.3 Session/scheduler primitives consumed by the workflow layer

- `SessionScheduler`, `SessionGate`, `TaskGraph`, `linearRunner`, `singleSession`,
  `loadProfilesFromDirs`, `runSession` are all exported from
  `@harms-haus/engin-engine`.
- **`SessionGate`** (`session-gate.ts`): two-level (total + per-model) FIFO gate.
  `perModel` keys support `${provider}`, `${provider}:${model}`, and
  `${provider}:${model}:${agent}`. This is the primitive that enforces
  `config.modelConcurrency`. The new council review phase must construct ONE
  gate and seed its `perModel` from `config.modelConcurrency`, then share it
  across all 5 dimension tasks (via the single `SessionScheduler`).
- **`TaskGraph.addTask(task, runnerFactory)`** (`task-graph.ts`): the hook point.
  The review phase adds 5 tasks, each with a `retrospectiveCouncilRunner(...)`
  factory.

### 6.4 The current review phase (what is being replaced) and its limitations

File: `~/.config/engin/workflows/.lib/final-review.ts`.

- `finalReviewPhase` runs each `finalReviewers` entry as an independent
  `runFinalReviewLane` in parallel via `Promise.all`. Each lane:
  `runSingleSessionStructured` (initial review) →
  `runFixersForLane` (fixers) → `runSingleSessionStructured` (review-fixes),
  looping up to `MAX_FIX_ROUNDS = 3`.
- **Limitation 1 (no shared capacity):** `runFixersForLane` constructs a **fresh
  `SessionScheduler` + `TaskGraph` per lane, per fix round**, each with a fresh
  `SessionGate({ total: maxConcurrentTasks, perModel: {} })`. So the 5 lanes do
  not share capacity.
- **Limitation 2 (no model caps on review):** that per-lane gate passes
  `perModel: {}`, so `config.modelConcurrency` is **never applied to review
  fixers**. (`config.modelConcurrency` is only consumed by
  `implementationPhase`.) The rewire fixes both as a side effect of putting all
  5 dimension tasks on one shared scheduler/gate.
- **Reusable assets:** `buildReviewerPrompt`, `buildReviewFixesPrompt`,
  `formatDiffSection`, `formatHistory`, `filePathOnly`, `actionableFindings`,
  `isActionableSeverity`, `ACTIONABLE_SEVERITIES`, `MAX_DIFF_CHARS` are all
  directly reusable (or near-reusable) for building the convener/retrospective
  specs and the `buildMembers`/`interpretRetrospective` transforms. The new
  phase module should import/reuse them rather than duplicate.
- `runSingleSessionStructured` (`session-utils.ts`) is the
  one-shot-structured-session helper used outside the scheduler. The new phase
  should NOT use it for the looping sessions (those go through the scheduler as
  task sessions); it may still be useful if any standalone structured call is
  needed, but prefer expressing everything as task sessions on the shared graph.

### 6.5 Config surface

- `WorkflowConfig` (`config.ts`): currently has `name`,
  `defaultMaxConcurrentSessions`, `modelConcurrency?`, `fixerSteps`,
  `finalReviewers?`, `phases`, `titleFormatter`. Adding `reviewStrategy?` and
  `maxCouncilRounds?` is additive and non-breaking.
- `normalizeOptions` and `SpirRunOptions` are unchanged.

### 6.6 The SPIR orchestrator's review phase hook

File: `.lib/spir.ts`. The `review` entry in `phaseRuns` currently calls
`finalReviewPhase(...)`. The rewire branches here:

```ts
review: async (ctx) => {
  if (config.reviewStrategy === 'council') {
    await retrospectiveCouncilPhase(
      taskGraph,
      profilesDirs,
      cwd,
      workDir,
      maxConcurrentTasks,
      apiKeys,
      onStatus,
      ctx.signal,
      config.finalReviewers,
      config.fixerSteps,
      config.titleFormatter,
      hookRegistry,
      config.modelConcurrency ?? {},
      config.maxCouncilRounds,
    );
  } else {
    await finalReviewPhase(/* …existing args… */);
  }
};
```

`getDiff(cwd)` (from `@harms-haus/engin-engine`) is used to collect the working-
tree diff fresh before each review/retrospective pass (so post-fix state is
seen, not a stale snapshot) — mirror the existing `collectDiff` closure.

---

## 7. Suggested task breakdown (for the planner — verify, don't assume)

1. **Engine: `retrospectiveCouncilRunner` + tests.** The generator, the options
   type, barrel export, and a focused test file. Landable/reviewable
   independently of the workflow changes.
2. **Workflow `.lib/`: `RetrospectiveDecisionSchema`** in `schemas.ts`.
3. **Workflow `.lib/`: `retrospective-council-phase.ts`** — builds 5 dimension
   tasks, shared scheduler/gate, the `buildMembers`/`interpretRetrospective`
   transforms (reusing `final-review.ts` prompt helpers).
4. **Workflow `.lib/`: config + orchestrator wiring** — `reviewStrategy`/
   `maxCouncilRounds` in `config.ts`; `spir.ts` review-phase branch.
5. **Per-workflow wrappers + structure tests** — `develop`/`improve`/`debug`
   `main.ts` set `'council'`; structure tests updated.

Tasks 1 and 2 are independent and can be parallelized once the runner options
interface (§2.2) is pinned. Tasks 3–5 are sequential and depend on 1+2.

---

## 8. Open questions (none blocking — defaults are sensible)

- **Does the retrospective pass need `resume:true` across rounds** (like
  `reviewRunner` does for the execute session) so the reviewer sees its own
  prior pass in-session? _Default: no_ — the workflow already threads prior
  review history into the prompt via `formatHistory` (the engine runner is
  schema-agnostic and doesn't know about history; the workflow's
  `buildMembers`/`interpretRetrospective` closures capture and append it).
  Confirm the workflow can thread history through closures without engine help.
- **`maxCouncilRounds` default.** _Default: `4`_ (vs `MAX_FIX_ROUNDS = 3` today).
  The retrospective agent decides termination; the cap is a pure safety valve.
- **Should reaching `maxRounds` be audited/emitted as a status event**
  (e.g. `onStatus.onError` or an audit entry) so the user sees a lane ran out of
  budget? _Default: yes — emit a non-fatal audit/status note per dimension task
  that hits the cap, mirroring how `finalReviewPhase` records lane failures
  today._ The runner itself stays silent (schema-agnostic); the workflow's
  transform/phase code owns the audit.
