# Overview

**engin** orchestrates multi-agent AI workflows for software development. It uses
`AgentSession` from `@earendil-works/pi-coding-agent` as its inference layer and provides a
phase-based approach to breaking down, planning, implementing, and reviewing work.

Workflows and profiles are **user-authored** and loaded dynamically from config directories.
You create your own workflows and agent profiles and place them under `~/.config/engin/`
(global) or `.engin/` (per-project). Agent profiles are plain Markdown files with YAML
frontmatter, so you can customise agent behaviour without touching engin's source.

> engin is a **pure library**. It ships no built-in workflows and no built-in profiles. It
> provides the building blocks — harness creation, profile loading, structured output, the
> session primitive, the `SessionScheduler` (task-DAG-driven scheduling), the `TaskGraph`
> (task DAG with dependency ranking), the `SessionGate` concurrency authority,
> composable `SessionPlanRunner`s, the event-sourced status store, a TUI dashboard, and a
> WebSocket server — that your workflow scripts compose into pipelines.

## The rigid hierarchy: workflow → phases → tasks → sessions

engin models execution as a **rigid four-level hierarchy**. The structure is enforced by the
event model and the projection, and it is reflected everywhere — the event stream, the
read-model, the TUI dashboard, and the web client all navigate the same tree.

- A **Workflow** owns an ordered list of **Phases**. Phases execute one at a time; each phase
  must complete before the next begins.
- A **Phase** owns an ordered list of **Tasks** (its `taskIds`). Within a phase, tasks run
  concurrently through a `SessionScheduler`, gated by a `SessionGate`.
- A **Task** is fulfilled by a **SessionPlanRunner** — an async generator that yields
  batches of `SessionSpec`s, each resolved by the scheduler into one or more agent
  **Sessions** in any topology (linear, parallel, review-loop, council, …). The runner
  returns a `TaskOutcome`.
- A **Session** is a single agent prompt turn with a lifecycle: the session primitive
  (`runSession`) creates the agent, fires `onSessionStart`, delivers the prompt, persists the
  result, and fires `onSessionComplete`. Every session is associated with a task via a
  `SessionSpec` carrying `runnerRole` and `attempt`.

A `PhaseEntity` lists its `taskIds`. Each task in the projection (`TaskEntity`) tracks status
and timing. Each session is a `SessionEntity` keyed by
`sessionKey(agentId, taskId, runnerRole, attempt)`.

### Run / Phase / Task / Session / Runner

| Concept     | What it is                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run**     | One invocation of a workflow — from `workflow_started` to `workflow_completed` / `workflow_failed`. Owns the work directory, the `EventStore`, and the `AbortController`.                                                                       |
| **Phase**   | A named stage in the workflow. Phases execute sequentially. A phase typically instantiates a `SessionScheduler` to process its tasks concurrently.                                                                                              |
| **Task**    | A unit of work with a prompt, files, dependencies, and a `worktree` mode (`'none'` or `'code'`). Resolved by a `SessionPlanRunner`. Tracked on the write model by the `TaskGraph`.                                                              |
| **Session** | One agent prompt turn. Created by the session primitive (`runSession`) from a `SessionSpec`. Identified by `(agentId, taskId, runnerRole, attempt)`. Projected as `SessionEntity`.                                                              |
| **Runner**  | A `SessionPlanRunner` with a `plan(ctx)` async generator (yields `SessionSpec[]` batches) and an `execute(ctx, spec)` method. The scheduler owns the gate; runners never acquire or release gate slots. Built from composable runner factories. |

## Two views of the same lifecycle

engin keeps two views of the task lifecycle, and it is worth understanding the difference
upfront:

- **Write model (executor side).** The `TaskGraph` holds `Task` objects — the full records
  including prompts, files, dependencies, review feedback, and the executor-only `status`
  field. The `SessionScheduler` drives these through the gate and mutates their status.
  This is what the scheduler operates on.
- **Read model (projection side).** The `WorkflowProjection` holds `TaskEntity` objects — a
  slimmed-down view derived purely by replaying events through the `evolve` reducer. This is
  what the TUI and web render.

The two views are kept in sync by **events**: every meaningful state change is recorded as an
append-only `EventRecord`, and the projection is derived by replaying them. A `rejectTask`
call on the write model keeps the task `active` (the pool still owns it and will retry), while
the corresponding `task_rejected` event maps to `failed` in the projection. Both are correct
for their audience.

See [Event store & status](../reference/event-store.md) and
[Task pool & execution](../reference/task-pool.md) for the details.

## Key properties

- **Rigid hierarchy** — workflow → phases → tasks → sessions, with every session associated
  with a task via `runnerRole` and `attempt`.
- **Dynamic workflow loading** — workflows are discovered from config directories and loaded
  at runtime by name.
- **Layered config resolution** — profiles and workflows resolve from `~/.config/engin/`
  (global) and `.engin/` (local), with local overriding global on name conflicts.
- **Agent profiles as Markdown** — frontmatter for configuration, body for the system prompt.
  Add or modify agents without touching code.
- **Structured output enforced by Zod** — request typed, validated JSON from any session,
  with automatic repair-and-retry.
- **DAG task dependencies** — tasks declare dependencies; the `TaskGraph` detects cycles and
  serves ready tasks in a deterministic order (sorted by transitive blocking pressure).
- **Session-first execution** — the session primitive (`runSession`) is the sole building
  block for agent prompt turns. `SessionPlanRunner`s compose sessions freely; the
  `SessionGate` is the sole concurrency authority (two-level: total + per-model, FIFO, RAII).
- **Composable `SessionPlanRunner`s** — `singleSession`, `linearRunner`, `parallelRunner`,
  `reviewRunner`, `councilRunner`, `mapRunner`, `branchRunner`, `coordinatorRunner`,
  `coalescingRunner` — each yields batches of `SessionSpec`s that the `SessionScheduler`
  executes through the gate and nests inside other runners.
- **Event-sourced status** — every status change is an append-only `EventRecord`; the
  in-memory `WorkflowProjection` is derived by a pure reducer. The TUI and the web client
  each rebuild the projection from the event stream over WebSocket.
- **Client/server architecture** — a long-lived engine server hosts concurrent runs; the
  CLI's TUI and the web UI are both network clients of it.
- **Full audit trail** — session starts, completions, decisions, and errors are logged for
  post-hoc analysis.
- **Live observability** — a terminal dashboard (TUI) and a browser/mobile web client both
  render the same projection in real time over a multi-run WebSocket protocol (snapshot/delta/resync).

## Where to go next

- [Architecture](architecture.md) — the client/server process model, the package layout, and how status flows.
- [Getting started](../guides/getting-started.md) — install and run.
- [Building a new workflow](../guides/building-workflows.md) — author your first workflow.
- [Task pool & execution](../reference/task-pool.md) — `SessionScheduler`, `TaskGraph`,
  `SessionGate`, runners.
