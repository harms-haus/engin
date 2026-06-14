# Architecture

This document describes how engin's source is layered, what each module is responsible for,
and how status information flows from a running workflow to the TUI and the web mirror.

## Source layout

```
src/
├── index.ts                     # Public API re-exports
├── cli.ts                       # CLI entry point
├── core/                        # Core primitives
│   ├── types.ts                 # Shared types + re-exports from pi packages
│   ├── config.ts                # Config directory + .env resolution
│   ├── profile.ts               # Markdown profile parser, loader, multi-dir merge
│   ├── workflow-loader.ts       # Dynamic workflow module loading + listing
│   ├── harness-factory.ts       # AgentSession construction from a profile
│   ├── phase-tasks.ts           # runStepTask — single-agent, one-step task
│   ├── structured-output.ts     # JSON extraction + Zod-validated prompting
│   ├── agent-loop.ts            # Loop / parallel / sequential agent patterns
│   ├── schema-describe.ts       # Zod schema → human-readable description
│   ├── title-generator.ts       # Task title generation helper
│   ├── utils.ts                 # Shared helpers + DEFAULT_TOOLS
│   ├── setup.ts                 # initDefaultConfig — first-time directory setup
│   ├── git.ts                   # Git utilities (worktree support)
│   ├── worktree-lifecycle.ts    # Worktree create/branch/merge/PR lifecycle
│   └── network.ts               # LAN IP auto-detection
├── cli/                         # CLI command machinery
│   ├── parse-args.ts            # Argument parsing
│   ├── commands.ts              # run / resume / init orchestration
│   ├── tui-setup.ts             # Shared EventStore + observer + TUI wiring
│   ├── console-status.ts        # Console StatusCallbacks + TUI detection
│   ├── session-selector.ts      # Interactive run selection for resume
│   ├── post-worktree.ts         # Post-worktree action prompter
│   ├── sigint.ts                # Cooperative SIGINT cancellation
│   └── slash-command-parser.ts  # Interactive-composer slash parsing
├── pool/                        # Concurrent task execution
│   ├── index.ts                 # Re-exports
│   ├── types.ts                 # StepDefinition, LanePoolOptions, etc.
│   ├── lane-pool.ts             # LanePool — the executor
│   ├── task-processor.ts        # Runs a task's steps with retry
│   ├── step-execution.ts        # Runs one step (profile, session, approval)
│   ├── prompt-builder.ts        # Builds prompt text with file contents
│   ├── severity.ts              # Severity helpers
│   └── validation.ts            # Task/step name validation
├── tracking/                    # Status, events, persistence
│   ├── event-types.ts           # EventType, entities, projection, LogEntry
│   ├── event-store.ts           # EventStore — the source of truth
│   ├── evolve.ts                # Pure projection reducer
│   ├── store-callbacks.ts       # StatusCallbacks → EventStore.append
│   ├── task-status.ts           # TaskTracker — DAG of tasks (write model)
│   ├── workflow-status.ts       # WorkflowStatusTracker — persisted state
│   ├── workflow-serializer.ts   # Atomic JSON save/load
│   └── audit-log.ts             # JSONL audit log
├── tui/                         # Terminal dashboard
│   ├── workflow-tui.ts          # TUI lifecycle manager
│   ├── status-callbacks.ts      # Subscribe widgets to an EventStore
│   ├── composer.ts              # Interactive composer
│   ├── theme.ts                 # ANSI styling helpers
│   ├── format-tool-call.ts      # Tool-call display formatting
│   ├── format-workflow-event.ts # EventRecord → human-readable line
│   └── components/              # Dashboard, EventLog, PhaseBar, TaskList, AgentLog, QR
└── web/                         # Observer server + protocol
    ├── observer-server.ts       # Bun HTTP + WebSocket server
    ├── protocol-types.ts        # ServerMessage / ClientMessage
    └── status-bridge.ts         # Store → WebSocket broadcast
```

## Layers at a glance

| Layer        | Path                        | Responsibility                                                                                                                                   |
| ------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Core**     | `src/core/`                 | Profiles, config, the agent harness, structured output, and the `runStepTask` primitive. The reusable building blocks.                           |
| **Pool**     | `src/pool/`                 | Concurrent task execution. `LanePool` claims tasks from a `TaskTracker` and runs each through a sequence of steps, with reviewer feedback loops. |
| **Tracking** | `src/tracking/`             | The event-sourced status store (`EventStore`), the pure reducer (`evolve`), the write-model `TaskTracker`, and persisted workflow state.         |
| **CLI**      | `src/cli/` and `src/cli.ts` | Argument parsing, command orchestration, TUI-vs-console detection, SIGINT handling, resume, and worktree post-actions.                           |
| **TUI**      | `src/tui/`                  | The terminal dashboard: widget tree, keyboard input, console interception, and the QR overlay for mobile.                                        |
| **Web**      | `src/web/`                  | The observer server: static file serving, `/ws` upgrade, and the snapshot/delta broadcast bridge.                                                |

The React frontend that consumes the web layer lives under `web/` (a sibling of `src/`).

## How status flows

The `EventStore` is the single source of truth. Workflows never mutate a projection directly —
they fire callbacks, and every callback becomes an event.

```
                ┌─────────────────────────────────────────────┐
   workflow     │  onStatus (StatusCallbacks)                 │
   run()  ─────►│  ── createStoreCallbacks(store) ─► append() │
                └─────────────────────────────────────────────┘
                                   │  EventRecord (append-only, durable to events.jsonl)
                                   ▼
                       ┌────────────────────────┐
                       │  EventStore            │
                       │  - ring buffer         │     evolve()
                       │  - WorkflowProjection  │ ◄──────────────
                       │    (pure reducer)      │
                       └────────────────────────┘
                          │                    │
            subscribe()   │                    │ subscribe()
                          ▼                    ▼
            ┌──────────────────────┐   ┌──────────────────────┐
            │  TUI widgets         │   │  StatusBridge        │
            │  (dashboard, log)    │   │  ─► WebSocket        │
            └──────────────────────┘   │     snapshot/delta   │
                                       └──────────────────────┘
                                                  │
                                                  ▼
                                       ┌──────────────────────┐
                                       │  Browser / mobile     │
                                       │  (React + Zustand)    │
                                       │  replays via its own  │
                                       │  evolveClient()       │
                                       └──────────────────────┘
```

1. A workflow calls `options.onStatus.onPhaseStart(...)` (or any other callback).
2. `createStoreCallbacks(store)` maps that callback 1:1 to an `EventType` and calls
   `store.append(type, data, metadata)`.
3. `append` assigns the next monotonic `seq`, pushes the record into a bounded ring buffer
   (default 1000 entries), evolves the projection, coalesces a durable write to `events.jsonl`,
   and notifies subscribers synchronously.
4. The TUI (`createStoreBackedTui`) and the `StatusBridge` each receive the new projection.
   The TUI syncs widgets; the bridge coalesces events into a single `events` WebSocket message
   per microtask (and sends terminal lifecycle signals immediately).
5. Connected web clients replay the raw events through their own `evolveClient()` reducer — the
   same logic as the server's `evolve`.

Because everything is derived from the event log, a resumed run simply replays
`events.jsonl` (and an optional snapshot) to rebuild the projection before the workflow
continues. See [Event store & status](../reference/event-store.md).

## Write model vs read model

Two parallel representations of tasks exist by design:

| Aspect           | Write model (`Task` / `TaskTracker`)                          | Read model (`TaskEntity` / projection)         |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| Lives in         | `TaskTracker` (executor side)                                 | `WorkflowProjection.tasks`                     |
| Carries          | prompt, files, dependencies, review feedback, executor status | title, phaseId, status, steps, activeStepIndex |
| Mutated by       | `LanePool`, lane workers, `claimTasks`/`completeTask`/...     | `evolve()` reducer (immutable)                 |
| Kept in sync via | events fired by `runStepTask` / `LanePool` / `task-processor` | replaying those events                         |

A subtle consequence: `rejectTask` on the write model keeps the task `active` (the lane still
owns it and will retry the previous step), but the corresponding `task_rejected` event maps to
status `failed` in the projection. Both are correct — the executor view supports retry, the
projection view shows the latest outcome.

## The agent lifecycle, end to end

When a workflow runs an agent (via `runStepTask` or a `LanePool` step), this happens:

1. **Profile load.** The profile is loaded from the configured directories (local overrides
   global). Read-only steps strip `write`/`edit` from the toolset.
2. **Harness creation.** `createHarness` resolves the model, loads credentials via
   `AuthStorage`, builds the tool allowlist from the profile, constructs a
   `DefaultResourceLoader` with the profile's system prompt, and creates an `AgentSession`.
3. **Lifecycle callbacks.** `onTaskRegister` → `onTaskStart` → `onAgentSpawn` → `onStepStart`
   fire (each becomes an event in the store).
4. **Prompt.** The prompt is sent. If the step has a Zod `schema`, the response is parsed and
   validated with up to 3 attempts; otherwise the raw assistant text is returned. Turn-level
   and tool-level events (`onTurnStart`, `onToolCallStart`, …) stream back through the store.
5. **Teardown.** `onAgentComplete` fires, the harness is disposed, and (on success)
   `onTaskComplete` fires. On error, `onTaskRejected` fires and the error re-throws.

For multi-step tasks in a `LanePool`, step 4 is wrapped in a retry loop: a rejected step backs
up exactly one step, appends the reviewer feedback to the task, and re-runs (up to
`maxStepRetries`, default 5). See [Task pool & execution](../reference/task-pool.md).

## Where to go next

- [Event store & status](../reference/event-store.md) — the reducer, the projection, durability.
- [Task pool & execution](../reference/task-pool.md) — lanes, steps, retries.
- [Building a new workflow](../guides/building-workflows.md) — use all of this in anger.
