# Task: Add composable multi-agent orchestration primitives to engin

You are working on **engin**, an AI workflow orchestrator for software development.
This task asks you to extend engin's execution layer with a small set of composable
**orchestration primitives** so that tasks can do more than run a strict linear sequence
of steps — while preserving engin's existing strengths (rigid hierarchy, DAG readiness,
event-sourced status, TUI/web observability).

You are expected to **research** as needed. A large body of research is already included
below to bootstrap you; treat it as a starting point and go deeper (web_search / fetch the
official docs) on any pattern you intend to implement before writing code.

---

## 1. Mission

engin currently executes every task as a **linear pipeline of steps** with a reviewer-driven
"back up one step and retry" loop. This is good, but it can't express:

- **parallel → synthesize** (a council / map-reduce / ensemble: run N agents, merge results)
- **conditional branching** (route to step A or B based on prior output)
- **fan-out over a collection** (run one step per item, with a concurrency cap)
- **reflection as a reusable primitive** (today it's fused into step-rejection logic)
- **workflow-level suspend/resume** for human-in-the-loop

Your job: introduce a small, composable set of orchestration primitives that fill these gaps
in a way that fits engin's architecture. **Start by validating/refining the recommended
direction below** (it's a strong lean, not a mandate), then implement, with tests.

---

## 2. Current architecture you must understand first

Read these files before designing anything:

- `src/pool/lane-pool.ts` — the executor: N lanes claim tasks from a shared tracker.
- `src/pool/task-processor.ts` — `processTask`: runs a task's ordered steps; reviewer
  feedback backs up exactly one step (clamped at 0); per-step retry counters; severity
  decides fail-vs-accept-with-caveats at `maxStepRetries`.
- `src/pool/step-execution.ts` — `runStep`: one step = one agent (profile load, harness,
  read-only tool stripping, structured-output vs free-text, session resume).
- `src/pool/types.ts` — `StepDefinition`, `LanePoolOptions`, `StepResult`, `TrackedSession`.
- `src/pool/prompt-builder.ts` — assembles prompt from task files + review feedback history.
- `src/core/phase-tasks.ts` — `runStepTask`: the atomic single-agent / single-step primitive.
- `src/core/agent-loop.ts` — existing multi-agent helpers: `agentLoopUntil`,
  `retryAgentUntil`, `parallelAgents` (fan-out, **no reduce**), `sequentialAgents`.
- `src/tracking/task-status.ts` — `TaskTracker`: the write model. DAG of tasks with
  dependency-based readiness, cycle detection, `claimTasks`, `completeTask`, `rejectTask`,
  emits `TaskReady`/`TaskSettled`/`TaskClaimed`. **This is your strongest, best-factored asset.**
- `src/tracking/event-store.ts` + `evolve.ts` — event-sourced read model; the TUI and web
  mirror both replay the same events.
- `docs/concepts/overview.md` and `docs/concepts/architecture.md` — the rigid four-level
  hierarchy: **workflow → phases → tasks → steps**, where _every agent is a step-of-a-task_.
  This constraint is intentional and a feature (deterministic, observable, debuggable).

### What engin already has

| Pattern                            | Where                                     | Notes                                   |
| ---------------------------------- | ----------------------------------------- | --------------------------------------- |
| Atomic single-agent step           | `runStepTask`                             | your `Activity`-equivalent              |
| Prompt-loop until condition        | `agentLoopUntil`                          |                                         |
| Structured-output retry            | `retryAgentUntil` / `promptForStructured` |                                         |
| Parallel fan-out (**no reduce**)   | `parallelAgents`                          | returns raw `PromiseSettledResult[]`    |
| Sequential pipeline                | `sequentialAgents` + steps-within-a-task  |                                         |
| Reflection (generate→critic→retry) | baked into step **rejection**             | clever, but not reusable as a primitive |
| Worker pool over a ready-set       | `LanePool` lanes                          |                                         |
| DAG dependencies / readiness       | `TaskTracker`                             |                                         |
| Event-sourced status               | `EventStore` + `evolve`                   | major strength; most peers lack this    |

### The key structural fact

`LanePool` bundles **three concerns**:

1. **Scheduler** — N lanes, event-driven wake, abort handling.
2. **DAG readiness** — delegated to `TaskTracker` (already clean).
3. **Linear step runner with reviewer-retry** — `processTask`.

The scheduler + DAG are engin's "Core" (analogous to Temporal's worker, Inngest's
concurrency layer, AutoGen's runtime). The part that should become polymorphic is (3):
the _body_ of a task. Today a task declares `getStepsForTask(task): Step[]` — a strictly
linear list. Generalizing this is the high-leverage move.

---

## 3. Research: orchestration patterns across peer libraries

### 3.1 Mastra (mastra.ai)

Mastra's workflow primitives are the closest analogue to what engin wants, because they
compose fluently while keeping a step/schema contract.

**Named patterns and APIs:**

- **Sequential chaining** — `.then(step)`; each step's `outputSchema` must match the next
  step's `inputSchema`.
- **Parallel fan-out** — `.parallel([a, b])`; all receive the same input; next step gets an
  object keyed by step id; **synchronization barrier** (next step waits for all).
- **Conditional branching** — `.branch([[condFn, step], ...])`; first true condition wins;
  exactly one branch runs.
- **Do-until / do-while loops** — wrap a single step with a predicate.
- **ForEach (map-reduce)** — `.foreach(step, { concurrency })`; runs the step per array
  element; output preserves input order; concurrency defaults to 1.
- **Map** — `.map(fn)` reshapes data between steps.
- **Suspend / Resume** — `suspend()` snapshots full execution state to storage;
  `run.resume({ step, resumeData })` re-enters the step with `resumeData` populated.
- **Bail** — exit a step early with success (non-fatal), e.g. human rejection.
- **Sleep / SleepUntil** — pause the whole workflow.
- **Nested workflows** — a `Workflow` implements the `Step` interface, so a workflow can be
  a step inside another workflow (incl. inside `.foreach()`).

**Agent execution model:** an `Agent` is an LLM-with-tools whose loop is model-driven
(generate → tool calls → generate, until stop or `maxSteps`). `agent.generate()` /
`agent.stream()`. Multi-agent: a **supervisor** agent declares `agents: { ... }` and the
LLM delegates via `agent-<name>` tool calls; delegation hooks
(`onDelegationStart`/`onDelegationComplete`) act as middleware. `.network()` turns any agent
into a routing agent. The **council** pattern is explicitly `.parallel([a, b]).then(synth)`.

**Durability:** each `createRun()` yields an isolated `Run` with a `runId`; snapshots on
suspend; `retryConfig` per workflow or per step; **Time Travel** re-executes from any step.
Not deterministic-replay like Temporal.

**Distinctive Mastra ideas worth stealing:**

- _Workflows are steps_ → hierarchical composition for free.
- _Fluent builder with schema-enforced contracts_ between steps (type-checked at link time).
- _Suspend-snapshot as the universal durability primitive_ (HITL, async callbacks, time
  travel, crash-restart all use one mechanism).
- `bail()` vs `suspend()` — two clean non-error ways to end a step.
- _Three-tier data flow_: step `inputData`/`outputData` (sequential), `state` (cross-cutting
  shared store), `resumeData` (injected on resume) — kept separate so no channel is overloaded.
- _Delegation hooks as middleware_ for agent coordination.

### 3.2 LangGraph, CrewAI, AutoGen

| Pattern                | LangGraph                                             | CrewAI                                              | AutoGen                                                   | How control routes                                         |
| ---------------------- | ----------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Supervisor             | cond-edges + `Command`                                | hierarchical process (manager delegates)            | `SelectorGroupChat` (LLM picks speaker)                   | supervisor reads state → routes to worker → worker returns |
| Hierarchical teams     | subgraph-as-node; `Command.PARENT`                    | (none; Flows chain crews linearly)                  | nested group chats / MagenticOne                          | parent graph contains subgraph node                        |
| Swarm / handoff        | `transfer_to_X` tool → `Command(goto=...)`            | (none)                                              | `Swarm` + `HandoffMessage`                                | agent autonomously transfers control                       |
| Group chat             | manual loop                                           | sequential process only                             | canonical: RoundRobin / Selector / MagenticOne            | turn-taking over shared message history                    |
| Map-reduce / fan-out   | `Send(node, state)` from cond-edge (per-branch state) | (none)                                              | topic-based concurrent agents                             | one node emits N `Send`s, results merged by reducer        |
| Reflection             | two nodes + cond-edge                                 | via Flow `@router`                                  | `RoundRobinGroupChat` + critic + `TextMentionTermination` | generate → critique → loop until approve                   |
| Sequential pipeline    | `add_sequence([...])`                                 | `Process.sequential`                                | single-agent loop w/ termination                          | linear chain                                               |
| Event-driven / pub-sub | (Pregel msg-passing, not pub-sub)                     | Flow `@start`/`@listen`/`@router`, `and_()`/`or_()` | Core API `RoutedAgent` + `TopicId` + `TypeSubscription`   | handlers fire on event/method completion                   |
| Human-in-the-loop      | `interrupt()` + `Command(resume=...)`                 | `@human_feedback`                                   | `HandoffTermination("user")` / `ExternalTermination`      | pause at a point, external input resumes                   |

**Distinctive ideas worth stealing:**

- **LangGraph `Send`** — dynamic fan-out where each parallel branch gets its _own copy of
  state_ and results merge via reducers. Most powerful map-reduce primitive of the three.
- **LangGraph per-key reducers** — state keys each have their own merge strategy (overwrite,
  append, custom fn). Lets parallel branches write the same key safely.
- **AutoGen termination-condition algebra** — first-class conditions composed with `|` and
  `&` (e.g. `MaxMessageTermination(25) | TextMentionTermination("APPROVE")`).
- **AutoGen two-layer architecture** — Core (actors/topics/subscriptions, zero AI coupling)
  vs AgentChat (convenience presets). Separation lets you build custom topologies by
  dropping to Core.
- **CrewAI Flows decorator event model** — `@start`/`@listen`/`@router` with `and_()` /
  `or_()` listener combiners ("wait for all of these" / "wait for any").
- **LangGraph `Command`** — one return value combining state-update + routing + parent-graph
  escape + interrupt-resume.
- **AutoGen swarm handoff to `"user"`** — cleanest conversational HITL.

### 3.3 Temporal, Inngest, LlamaIndex Workflows, PydanticAI Graphs

| Concern              | Temporal                                                         | Inngest                                                                | LlamaIndex Workflows                                                     | PydanticAI Graphs                                  |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| Execution model      | deterministic replay                                             | step-ID memoization                                                    | event-type dispatch                                                      | typed FSM graph-walk                               |
| Durability/resume    | full replay from Event History; activities never re-run          | re-invoke fn with prior step results injected                          | none built-in (user-managed `to_dict`/`from_dict`)                       | `BaseStatePersistence` (user implements)           |
| Retries              | activities: exp backoff default                                  | step-level auto-retry                                                  | none                                                                     | none                                               |
| Fan-out / map-reduce | `startChild()`→`handle.result()`; async+signals for huge fan-out | in-fn `Promise.all([step.run])`; cross-fn `step.sendEvent`             | `ctx.send_event()`×N → `ctx.collect_events()` barrier; `num_workers` cap | `map()`+`join(reducer)`; union returns = branching |
| Human-in-the-loop    | `wait_condition()` + Signal; zero compute while blocked          | `step.waitForEvent(event, timeout)`                                    | `ctx.wait_for_event(type, timeout)`                                      | none (manual via `graph.iter()`)                   |
| Concurrency control  | worker slots + task-queue partitioning                           | key-based, scopes fn/env/account, priority queue, throttling, batching | `@step(num_workers=N)`                                                   | n/a (single-threaded)                              |

**Distinctive ideas worth stealing:**

- **Temporal's pure-orchestrator vs side-effectful-work split** (workflow vs activity) —
  prevents accidental non-determinism, gives clean retry semantics.
- **Inngest step-ID memoization** — durability without full replay: memoize each
  `step.run(id, fn)` by ID; on re-invocation, completed steps return cached results.
- **Inngest concurrency scopes** (fn/env/account) — resource limits segmented by tenant/key.
- **Inngest AgentKit runtime detection** (`getStepTools()`) — same agent code runs
  standalone or fully durable.
- **LlamaIndex event-type dispatch** — steps declare input/output event types; runtime
  auto-wires; adding a step is purely additive.
- **LlamaIndex `collect_events` barrier** — a step returns `None` until N events arrive,
  then returns the ordered array; re-entrant, no external orchestration state.
- **PydanticAI return-type-as-edge-declaration** — outgoing edges inferred from `run()`
  return-type union; graph structure is self-documenting and runtime-validated.
- **Temporal `AwaitSignal` + WAIT-sentinel reset** — iterative HITL loops: block → receive
  input → process → block again, all durably.
- **Temporal `signal-with-start`** — start-if-not-exists then signal (agent-per-conversation).
- **PydanticAI `graph.iter()`** — manual step-by-step iteration for debugging / custom HITL.

---

## 4. Recommended direction (validate, then refine)

This is the strong lean from the research — **confirm it against the codebase, push back if
something fits better, then implement.** Don't treat it as gospel.

### Core idea: keep the pool + DAG as your "Core"; make the per-task _body_ polymorphic

Generalize `getStepsForTask(task): Step[]` into
`getRunnerForTask(task): TaskRunner`, where a `TaskRunner` is roughly
`(task, ctx) => Promise<TaskOutcome>`. Ship the current behavior as one runner; add the
missing topologies as siblings:

- `linearStepsRunner(steps)` — **== today** (sequential steps + reviewer back-up + severity).
  Backward-compatible; reproduces current behavior exactly.
- `councilRunner(workers, synthesizer)` — **parallel → synthesize** (the council / ensemble).
- `reflectionRunner(draftStep, criticStep, { maxRounds })` — extract the reviewer-loop logic
  currently fused into step rejection, so it's reusable as a normal task body.
- `mapRunner(items, step, { concurrency })` — fan-out over a collection (map-reduce).
- `branchRunner(branches)` — conditional routing (first matching condition wins).

This mirrors how every strong framework separates orchestration-Core from execution-presets:
Mastra ("workflow is a step"), AutoGen (Core vs AgentChat), Temporal (workflow vs activity).
**Critically, all runners still flow through the DAG, the pool, the `EventStore`, and the
TUI** — you keep the rigid hierarchy and observability; you just unlock non-linear task bodies.

### Suggested ordering

1. **`councilRunner` (parallel→synthesize)** — smallest, highest payoff; directly addresses
   the most-missed primitive. Consider building it on top of the existing `parallelAgents`
   (which already does the fan-out) plus a synthesizer step via `runStepTask`.
2. **Generalize `getStepsForTask` → `getRunnerForTask`** — the refactor that makes (1) and
   everything below first-class instead of one-offs. Keep `linearStepsRunner` as the default.
3. **`reflectionRunner`** — extract from `processTask` so the loop is reusable.
4. **`mapRunner` + `branchRunner`** — completes the static-topology set.
5. **Workflow-level suspend/resume** — your next-biggest capability gap; maps naturally onto
   the existing `EventStore` (snapshot-on-suspend, like Mastra). Can come after the above.
6. **Defer / avoid**: supervisor, swarm, group-chat (different paradigm; clash with
   plan-then-execute). Avoid building a free-form graph DSL — your phase→task→step
   hierarchy is _already_ a constrained graph, and the constraint is a feature.

### Guardrails (these are firm)

- **Preserve the rigid hierarchy**: workflow → phase → task → step. Every agent is still a
  step-of-a-task. New primitives are _task bodies_, not a new top level.
- **Preserve observability**: every primitive must emit the same lifecycle events
  (`onTaskRegister`/`onTaskStart`/`onAgentSpawn`/`onStepStart`/`onTaskComplete`/...) so the
  TUI and web mirror render correctly. This is non-negotiable — it's a core engin property.
- **Backward compatibility**: existing workflows using `getStepsForTask` must keep working.
  Prefer `getRunnerForTask` with `linearStepsRunner` as the default adapter.
- **Keep the DAG and `TaskTracker` as-is** — don't entangle new primitives with dependency
  resolution; that layer is clean and should stay that way.
- **Tests**: the repo has a thorough `tests/` tree (e.g. `tests/core/agent-loop.test.ts`,
  `tests/pool/*` if present). Mirror that style. Cover the new primitives' success, failure,
  and partial-failure paths.

---

## 5. You are expected to research more

The above is a synthesis, not an implementation spec. Before writing each primitive, go read
the authoritative source for the pattern you're porting and decide how it should adapt to
engin's event model and hierarchy. Useful starting points:

- Mastra workflows: `https://mastra.ai/docs/workflows/overview` (and `.parallel`, `.branch`,
  `.foreach`, suspend/resume sub-pages).
- LangGraph: `https://langchain-ai.github.io/langgraph/` — especially the `Send` API and
  multi-agent (supervisor / handoffs) pages.
- AutoGen: `https://microsoft.github.io/autogen/stable/` — termination conditions, teams.
- Temporal: `https://docs.temporal.io/develop/typescript` — child workflows, signals, HITL.
- Inngest: `https://www.inngest.com/docs` — steps, parallelism, `waitForEvent`.

If you find a pattern in the research that you think is a better fit than the recommended
direction, say so and explain why. If the recommended direction contradicts something in the
codebase, surface it rather than forcing the design.

Deliver: working code under `src/pool/` (and/or `src/core/` for primitives that don't need
the pool), tests under `tests/`, and a short note in the relevant docs
(`docs/reference/task-pool.md`) describing the new primitives and when to use each.
