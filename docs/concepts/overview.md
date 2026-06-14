# Overview

**engin** orchestrates multi-agent AI workflows for software development. It uses
`AgentSession` from `@earendil-works/pi-coding-agent` as its inference layer and provides a
phase-based approach to breaking down, planning, implementing, and reviewing work.

Workflows and profiles are **user-authored** and loaded dynamically from config directories.
You create your own workflows and agent profiles and place them under `~/.config/engin/`
(global) or `.engin/` (per-project). Agent profiles are plain Markdown files with YAML
frontmatter, so you can customise agent behaviour without touching engin's source.

> engin is a **pure library**. It ships no built-in workflows and no built-in profiles. It
> provides the building blocks — harness creation, profile loading, structured output, agent
> loop patterns, the task pool, the event-sourced status store, a TUI dashboard, and a
> WebSocket observer server — that your workflow scripts compose into pipelines.

## The rigid hierarchy: workflow → phases → tasks → steps

engin models execution as a **rigid four-level hierarchy**. The structure is enforced by the
event model and the projection, and it is reflected everywhere — the event stream, the
read-model, the TUI dashboard, and the web mirror all navigate the same tree.

- A **Workflow** owns an ordered list of **Phases**. Phases execute one at a time; each phase
  must complete before the next begins.
- A **Phase** owns an ordered list of **Tasks** (its `taskIds`). Within a phase, tasks may run
  concurrently (via a `LanePool`) or one at a time (via `runStepTask`).
- A **Task** owns a linear sequence of **Steps** (its `steps`). Steps execute in order within
  a single task.
- A **Step** is fulfilled by exactly one **Agent**. **Every agent in the system is a
  step-of-a-task.** There are no free-floating agents.

A `PhaseEntity` lists its `taskIds`; a `TaskEntity` lists its `steps`; each `StepEntity` links
to the `AgentEntity` that fulfils it via `agentKey`.

## Two views of the same lifecycle

engin keeps two views of the task lifecycle, and it is worth understanding the difference
upfront:

- **Write model (executor side).** The `TaskTracker` holds `Task` objects — the full records
  including prompts, files, dependencies, review feedback, and the executor-only `status`
  field. Lanes claim and mutate these. This is what the `LanePool` operates on.
- **Read model (projection side).** The `WorkflowProjection` holds `TaskEntity` objects — a
  slimmed-down view derived purely by replaying events through the `evolve` reducer. This is
  what the TUI and web render.

The two views are kept in sync by **events**: every meaningful state change is recorded as an
append-only `EventRecord`, and the projection is derived by replaying them. A `rejectTask`
call on the write model keeps the task `active` (the lane still owns it and will retry), while
the corresponding `task_rejected` event maps to `failed` in the projection. Both are correct
for their audience.

See [Event store & status](../reference/event-store.md) and
[Task pool & execution](../reference/task-pool.md) for the details.

## Key properties

- **Rigid hierarchy** — workflow → phases → tasks → steps, with every agent a step-of-a-task.
- **Dynamic workflow loading** — workflows are discovered from config directories and loaded
  at runtime by name.
- **Layered config resolution** — profiles and workflows resolve from `~/.config/engin/`
  (global) and `.engin/` (local), with local overriding global on name conflicts.
- **Agent profiles as Markdown** — frontmatter for configuration, body for the system prompt.
  Add or modify agents without touching code.
- **Structured output enforced by Zod** — request typed, validated JSON from any agent, with
  automatic repair-and-retry.
- **DAG task dependencies** — tasks declare dependencies; the `TaskTracker` detects cycles and
  serves ready tasks in a deterministic order.
- **Event-sourced status** — every status change is an append-only `EventRecord`; the
  in-memory `WorkflowProjection` is derived by a pure reducer. Both the TUI and the web mirror
  subscribe to the same store.
- **Full audit trail** — agent starts, ends, decisions, and errors are logged for post-hoc
  analysis.
- **Live observability** — a terminal dashboard (TUI) and a browser/mobile web mirror both
  render the same projection in real time over a snapshot/delta WebSocket protocol.

## Where to go next

- [Architecture](architecture.md) — how the source is layered and how status flows.
- [Getting started](../guides/getting-started.md) — install and run.
- [Building a new workflow](../guides/building-workflows.md) — author your first workflow.
