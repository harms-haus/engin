# Architecture

This document describes the engin package layout, the client/server process model,
and how status information flows from a workflow running on the server to the TUI
and web clients over WebSocket.

## Process model at a glance

engin is a **client/server system**. A single long-lived **server daemon**
(`engin server up`, auto-started by `engin run`) owns _all_ workflow execution.
The CLI's TUI and the web UI are both **network clients** of that server:

- **Server** (`@harms-haus/engin-engine`) — a detached daemon hosting N concurrent
  runs. Each run has its own `EventStore`, `StatusBridge`, `AbortController`, and
  workflow execution. The server exposes a multi-run WebSocket protocol, serves the
  web UI bundle, and provides a `GET /health` readiness endpoint.
- **CLI** (`@harms-haus/engin`, the published package) — a client that ensures the
  server is up, submits a run via `start_run`, then **attaches** a TUI (TTY) or
  stdout renderer (non-TTY) that consumes the run's event stream over WebSocket. It
  blocks until the run reaches a terminal state, runs the optional two-prompt
  final-merge UX (git-repo runs), and exits — leaving the server running.
- **Web UI** (`@harms-haus/engin-web`) — a React SPA served by the engine that lists
  active runs, selects/views a run's live projection, and can cancel one. Starting
  runs is CLI-only in this iteration.

```
┌──────────────────── engin server (long-lived daemon) ────────────────────┐
│  HTTP + WebSocket on :3619 (localhost; one per machine)                  │
│   ├─ RunManager — registry of active runs                                │
│   │     └─ per run: EventStore(workDir) + workflow.run()                 │
│   │                 + AbortController + StatusBridge(runId)              │
│   ├─ Control API over /ws (multi-run): list_runs, start_run,             │
│   │   subscribe, unsubscribe, resync, cancel_run, worktree_action        │
│   ├─ serves packages/web/dist (the web UI)                               │
│   └─ GET /health (readiness)                                             │
└───────▲──────────────────────────────────────────────▲────────────────────┘
        │ one WS connection, multi-run multiplexed     │
   ┌────┴───────────┐                          ┌────────┴─────────┐
   │ engin (TUI)    │                          │ web UI (React)   │
   │  EngineClient  │                          │  EngineClient    │
   │  ClientStore   │                          │  zustand store   │
   │  (plain TS)    │                          │  runs frame      │
   └────────────────┘                          └──────────────────┘
                  ▲
                  │ packages/shared  (pure TS — no Node fs/net, no React, no pi)
                  │   protocol-types, event-types, WorkflowProjection, evolve,
                  │   formatWorkflowEventLine, EngineClient, ClientStore
                  └── imported by engine, tui, cli, web
```

## Package layout

engin is a 5-package workspace rooted at `engin-workspace`. The dependency rules are
enforced by an ESLint `no-restricted-imports` rule.

```
packages/
├── shared/    @harms-haus/engin-shared  (PRIVATE, pure TS)
│   The single source of truth for types shared across client and server.
│   NO Node fs/net, NO Bun, NO React, NO pi packages. Its only runtime API is
│   the global WebSocket constructor (used by EngineClient).
│   ├─ protocol-types.ts     ClientMessage / ServerMessage / RunSummary (multi-run)
│   ├─ event-types.ts        EventType, EventRecord, entities, WorkflowProjection, LogEntry
│   ├─ evolve.ts             the pure reducer (only `import type`)
│   ├─ types.ts              StepDefinition, StepEntity, TaskEntity, TaskStatus
│   ├─ format-workflow-event.ts   EventRecord → human-readable line
│   ├─ format-tool-call.ts   tool-call display formatting
│   ├─ engine-client.ts      EngineClient: WS connect, reconnect/backoff, resync, run multiplex
│   ├─ client-store.ts       plain-TS projection store (applySnapshot/applyEvents/reconcile)
│   └─ index.ts              barrel re-export (resolves name collisions explicitly)
│
├── engine/    @harms-haus/engin-engine  (PRIVATE — THE SERVER + ALL EXECUTION)
│   Depends on shared (+ pi execution packages, node, bun).
│   ├─ server/
│   │   ├─ daemon.ts         spawn/detach, pidfile, lock, port-probe, /health, logs, token path
│   │   ├─ server-entry.ts   in-daemon entrypoint: starts observer server + RunManager + signal handlers
│   │   ├─ run-manager.ts    registry of active runs; per-run EventStore + workflow.run + AbortController
│   │   ├─ control-server.ts HTTP+WS server (absorbed observer-server); /ws routing + web/dist serving
│   │   ├─ status-bridge.ts  per-run store→WS bridge (runId-tagged snapshot/events/run_complete/run_failed)
│   │   ├─ auth.ts           authorize(msg) chokepoint — capability-token gen/validate (disabled now)
│   │   └─ bind-guard.ts     isWildcardHost() — refuses 0.0.0.0/::/* binding until auth exists
│   ├─ core/                 profiles, config, agent lifecycle (spawnAgent), agent plugin contract + registry, runStepTask, worktree lifecycle, git, network
│   ├─ pool/                 LanePool + step execution + retry runners
│   └─ tracking/             EventStore, evolve, store-callbacks, task-status, audit-log, persistence
│
├── tui/       @harms-haus/engin-tui  (PRIVATE — pi-tui CLIENT)
│   Depends on shared + @earendil-works/pi-tui. Must NOT depend on engine.
│   ├─ client-store          → imported from shared (ClientStore)
│   ├─ ws-backed-tui.ts      syncs widgets from the ClientStore (replaces createStoreBackedTui)
│   ├─ workflow-tui.ts       refactored: takes a ClientStore + onDetach/onKill callbacks
│   ├─ components/           Dashboard, EventLog, PhaseBar, TaskList, AgentLog, QR, detach-kill-prompt
│   └─ theme.ts, format-*.ts
│
├── cli/       @harms-haus/engin  (PUBLISHED — the `engin` binary, v0.2.0)
│   Depends on shared + tui + engine. Spawns the engine daemon; re-exports the public API.
│   ├─ index.ts              re-exports the stable workflow-facing API from engine+shared
│   ├─ cli.ts                entry point; dispatches run / resume / init / server / help / version
│   └─ cli/
│       ├─ parse-args.ts     CliOptions, USAGE, parseArgs
│       ├─ commands.ts       runCommand / resumeCommand / serverUp/Down/Status + executeViaDaemon
│       ├─ console-status.ts formatTime, shouldUseTui
│       ├─ stdout-renderer.ts   non-TTY WS-consuming event renderer (replaces callback path)
│       ├─ sigint.ts         non-TTY cooperative SIGINT (cancel_run / force-exit)
│       ├─ session-selector.ts  interactive resume picker (active runs first, then disk)
│       └─ post-worktree.ts  interactive two-prompt final merge → worktree_action to server
│
└── web/       @harms-haus/engin-web  (PRIVATE — REACT CLIENT)
    Depends on shared only. Vite-built; output served by the engine.
    ├─ store/workflow-store.ts   zustand store: applySnapshot/applyEvents + runs list + cancelRun
    ├─ store/evolve-client.ts    re-exports evolve from shared
    ├─ hooks/useWebSocket.ts     thin React adapter over the shared EngineClient (singleton, ref-counted)
    └─ components/               RunsFrame (list/select/cancel), Dashboard, EventLog, PhaseBar, TaskList, AgentLog
```

### Dependency rules

| Package  | May import                                                                    |
| -------- | ----------------------------------------------------------------------------- |
| `shared` | only itself (and pure type-only zod). No `node:*`, `bun`, `react`, or `pi-*`. |
| `engine` | `shared` + pi execution packages + node + bun.                                |
| `tui`    | `shared` + `@earendil-works/pi-tui`. **Must not import `engine`.**            |
| `cli`    | `shared`, `tui`, `engine` (spawns the daemon; re-exports the public API).     |
| `web`    | `shared` only.                                                                |

Path aliases (`@engin/shared`, `@engin/shared/*`) resolve to `packages/shared/src`.
The engine, tui, and cli reference `@harms-haus/engin-engine` / `@harms-haus/engin-tui`
as workspace dependencies.

## How status flows

The `EventStore` is the single source of truth — but it now lives **inside the
server**, one per run. Workflows never mutate a projection directly: they fire
callbacks, and every callback becomes an event appended to that run's store. A
per-run `StatusBridge` broadcasts run-scoped messages to subscribed WebSocket
clients, which each maintain their own projection by replaying events through the
shared `evolve` reducer.

```
 SERVER (one EventStore per run)                      CLIENTS (TUI / web)
 ┌─────────────────────────────────────┐
 │ workflow.run()                      │
 │   onStatus ◄── composeHooks ───────►│ append()
 │     (storeCallbacks, workflow.hooks)│
 │   hookRegistry ─► engine primitives │
 │                                     │   EventRecord (durable to events.jsonl)
 │                                     ▼
 │                          ┌────────────────────┐
 │                          │  EventStore        │   evolve() (shared)
 │                          │  - ring buffer     │ ◄────────────────
 │                          │  - projection      │
 │                          └────────────────────┘
 │                                │ subscribe()
 │                                ▼
 │                          ┌────────────────────┐    runId-tagged
 │                          │  StatusBridge      │ ── snapshot/events ──►  EngineClient (WS)
 │                          │  (per run)         │    run_complete/       (reconnect/backoff/resync)
 │                          └────────────────────┘    run_failed/log              │
 └───────────────────────────────────────────────────────────────────────────────┘
                                                                                ▼
                                                                ┌───────────────────────────┐
                                                                │ TUI: ClientStore          │
                                web: zustand workflow-store ◄── │ web: zustand store        │
                                (applySnapshot/applyEvents,     │ (replays via shared       │
                                 reconcileSelection, runs list) │  evolve, same follow rules)│
                                                                └───────────────────────────┘
```

The workflow's `options.onStatus` is not the raw `createStoreCallbacks` surface. The engine's
`RunExecutor` first composes it through `composeHooks(storeCallbacks, workflow.hooks)`
([Hooks](../reference/hooks.md)). The composed `onStatus` forwards every callback **verbatim**
to the store — the store is the terminal sink and **always** fires — while the returned
`HookRegistry` is threaded into the engine primitives (`LanePool`, `PhaseRunner`, `Scheduler`,
`WorktreeManager`) so influence/observe hooks fire at their lifecycle seams. Hooks compose **on
top of** `StatusCallbacks` without replacing it: a workflow with no `hooks` field gets an
`onStatus` behaviorally identical to `storeCallbacks` and an empty registry. Observe hooks
(`onStructuredOutput`, `onDecision`, …) are a _secondary_ fan-out into separate sinks (e.g.
the `AuditLog`); the audit-log `onDecision` hook and the event-store `StatusCallbacks.onDecision`
callback fire independently. See
[Event store & status → Composition with workflow hooks](../reference/event-store.md#composition-with-workflow-hooks-composehooks).

1. A workflow calls `options.onStatus.onPhaseStart(...)` (or any other callback).
2. `createStoreCallbacks(store)` maps that callback 1:1 to an `EventType` and calls
   `store.append(type, data, metadata)`.
3. `append` assigns the next monotonic `seq`, pushes the record into a bounded ring
   buffer (default 1000 entries), evolves the projection, coalesces a durable write
   to `events.jsonl`, and notifies subscribers synchronously.
4. The per-run `StatusBridge` receives the projection change. Terminal transitions
   (`→ complete` / `→ failed`) are broadcast **immediately** as `run_complete` /
   `run_failed` (not coalesced); everything else is coalesced into one `events`
   message per microtask tick, tagged with the run's `runId`.
5. Only WebSocket clients that have `subscribe`d to that `runId` receive the
   messages. Each client replays raw events through its own copy of the shared
   `evolve` reducer — identical logic on both sides.

Because everything is derived from the event log, a transient disconnect is
recoverable: the client reconnects with exponential backoff and sends
`resync { runId, lastSeq }` to catch up. A resumed run replays `events.jsonl`
(and an optional snapshot) to rebuild the projection before the workflow continues.
See [Event store & status](../reference/event-store.md).

## Multi-run multiplexing

A single WebSocket connection carries messages for **many concurrent runs**. Every
projection/event/lifecycle message is tagged with `runId` (the work-directory name,
e.g. `1781118746110-develop`).

- Clients `subscribe` / `unsubscribe` to individual runs by `runId`.
- `start_run` auto-subscribes the requesting client to the new run.
- The server broadcasts a `runs` message (the active-run list) to all clients
  whenever the set of active runs changes (start / complete / fail / cancel / reap).
- `cancel_run { runId }` aborts exactly one run's `AbortController` — it does not
  affect the server or any other run.

The full protocol (typed in `packages/shared/src/protocol-types.ts`) is documented in
the [Server reference](../reference/server.md#protocol).

## Daemon lifecycle

The server runs as a **detached daemon** that survives the CLI parent process.
Coordination is file-based (POSIX-style pidfile) plus an HTTP readiness probe.

| File / endpoint | Path                                              | Purpose                                                           |
| --------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| pidfile         | `<globalConfigDir>/server.pid`                    | `{ pid, port }`, written atomically (temp + rename).              |
| log             | `<globalConfigDir>/logs/server.log`               | daemon stdout + stderr.                                           |
| token           | `<globalConfigDir>/server.token`                  | capability token (mode `0600`); plumbed but **not enforced** yet. |
| readiness       | `GET /health` → `{ pid, port, activeRuns }` (200) | probed by the CLI before sending `start_run`.                     |

**Startup** (`startDaemon`): refuse wildcard hosts (the `--lan` guard); if the server
is already alive on the port, no-op; clear a stale pidfile (recorded PID dead via
`kill(pid, 0)`); spawn the daemon entrypoint detached with stdio redirected to the
log file; `child.unref()` so the parent can exit; write the pidfile; poll `/health`
every 500 ms for up to 10 s.

**Shutdown** (`stopDaemon`, or `SIGTERM`/`SIGINT` in the daemon): the daemon's
`onShutdown` hook cancels every active run (cooperative abort), flushes every
`EventStore`, and disposes every bridge _before_ the socket closes; then it removes
the pidfile. `stopDaemon` sends `SIGTERM`, waits up to 10 s, and escalates to
`SIGKILL`.

`engin run` and `engin resume` auto-start the daemon the same way when a `/health`
probe finds nothing. See [CLI reference → server](../reference/cli.md#server) and
[Server reference → daemon](../reference/server.md#daemon-lifecycle).

## Write model vs read model

Two parallel representations of tasks exist by design:

| Aspect           | Write model (`Task` / `TaskTracker`)                          | Read model (`TaskEntity` / projection)         |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| Lives in         | `TaskTracker` (executor side, server)                         | `WorkflowProjection.tasks`                     |
| Carries          | prompt, files, dependencies, review feedback, executor status | title, phaseId, status, steps, activeStepIndex |
| Mutated by       | `LanePool`, lane workers, `claimTasks`/`completeTask`/...     | `evolve()` reducer (immutable)                 |
| Kept in sync via | events fired by `runStepTask` / `LanePool` / `task-processor` | replaying those events                         |

A subtle consequence: `rejectTask` on the write model keeps the task `active` (the
lane still owns it and will retry the previous step), but the corresponding
`task_rejected` event maps to status `failed` in the projection. Both are correct —
the executor view supports retry, the projection view shows the latest outcome.

## The agent lifecycle, end to end

When a workflow runs an agent (via `runStepTask` or a `LanePool` step) — all
server-side now — this happens:

1. **Profile load.** The profile is loaded from the configured directories (local
   overrides global). Read-only steps strip `write`/`edit` from the toolset.
2. **Agent session creation.** The profile's configured agent plugin is resolved
   (via `requireAgentPlugin`) and its `createSession` is called (orchestrated by
   `spawnAgent` in `core/agent-lifecycle.ts`). This resolves the model, loads
   credentials via `AuthStorage`, builds the tool allowlist from the profile,
   constructs a `DefaultResourceLoader` with the profile's system prompt, and
   creates the agent session — returning a neutral `AgentRuntime`.
3. **Lifecycle callbacks.** `onTaskRegister` → `onTaskStart` → `onAgentSpawn` →
   `onStepStart` fire (each becomes an event in the store, broadcast to clients).
4. **Prompt.** The prompt is sent. If the step has a Zod `schema`, the response is
   parsed and validated with up to 3 attempts; otherwise the raw assistant text is
   returned. Turn-level and tool-level events (`onTurnStart`, `onToolCallStart`, …)
   stream back through the store and out to subscribers.
5. **Teardown.** `onAgentComplete` fires, the agent session (`AgentRuntime`) is
   disposed, and (on success) `onTaskComplete` fires. On error, `onTaskRejected`
   fires and the error re-throws.

For multi-step tasks in a `LanePool`, step 4 is wrapped in a retry loop: a rejected
step backs up exactly one step, appends the reviewer feedback to the task, and
re-runs (up to `maxStepRetries`, default 5). See
[Task pool & execution](../reference/task-pool.md).

## Where to go next

- [Server reference](../reference/server.md) — the daemon, `RunManager`, the multi-run
  protocol, auth attach-points, and the `--lan` guard.
- [CLI reference](../reference/cli.md) — `run`, `resume`, `server up/down/status`,
  flags, and the detach/kill semantics.
- [Event store & status](../reference/event-store.md) — the reducer, the projection,
  durability, and the new `log` event type.
- [Web reference](../reference/web.md) — the React client, the runs frame, and the
  shared `EngineClient`.
- [Task pool & execution](../reference/task-pool.md) — lanes, steps, retries.
- [Building a new workflow](../guides/building-workflows.md) — use all of this in anger.
