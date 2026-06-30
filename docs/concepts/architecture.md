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
│   ├─ evolve.ts             the pure reducer dispatcher (delegates to per-domain handlers)
│   ├─ evolve-utils.ts       sessionKey, resolveSession, clone, capLog, MAX_SESSION_LOG
│   ├─ *-handlers.ts         workflow/phase/session/task/tool/log/retry event handlers
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
│   ├─ core/                 profiles, config, agent lifecycle (spawnAgent), agent plugin contract + registry, worktree lifecycle, git, network
│   ├─ pool/                 SessionScheduler + TaskGraph + session primitive + SessionGate + composable runners
│   │   ├─ session-scheduler.ts  SessionScheduler — task-DAG-driven greedy tiered drain loop (T1 active affinity → T2 parked → T3 ready/lazy-activate)
│   │   ├─ task-graph.ts     TaskGraph — task DAG with status tracking, blocking-pressure ranking, cycle detection
│   │   ├─ session-gate.ts   SessionGate — two-level (total + per-model) FIFO RAII concurrency gate
│   │   ├─ session.ts        runSession — the single-step session primitive
│   │   ├─ runners/          composable runner factories (singleSession, linear, parallel, review, council, map, branch, coordinator, coalescing)
│   │   ├─ runners/runner-utils.ts   defaultExecute + delegateToChild — shared gate-free helpers for runners
│   │   ├─ constants.ts      DEFAULT_MAX_ROUNDS
│   │   └─ validation.ts     assertSafeName, severity helpers
│   └─ tracking/             EventStore, evolve re-export, store-callbacks, audit-log, persistence
│      └─ task-status (TaskTracker) — now a thin read-only shim; scheduling lives in pool/task-graph.ts
│
├── tui/       @harms-haus/engin-tui  (PRIVATE — Ink/React CLIENT)
│   Depends on @harms-haus/engin-shared (workspace) + ink + react +
│   @harms-haus/ink-overlay (linked via tsconfig path alias) + ink-scroll-view + qrcode.
│   Must NOT depend on engine.
│   ├─ index.ts              public exports (components, theme, WorkflowTUI, createWsBackedTui, TuiStore)
│   ├─ workflow-tui.ts       entry: takes a ClientStore + onDetach/onKill callbacks
│   ├─ ws-backed-tui.ts      wires ClientStore → TuiStore → Ink React tree (replaces createStoreBackedTui)
│   ├─ tui-store.ts          TuiStore — useSyncExternalStore adapter over the shared ClientStore
│   ├─ app.tsx               root Ink <App> component
│   ├─ theme.tsx             Ink theme tokens
│   ├─ layout-constants.ts   layout sizing constants
│   ├─ hooks/use-tui-store.ts   React hook binding components to TuiStore
│   ├─ test-harness.tsx      ink-testing-library harness
│   └─ components/*.tsx      Dashboard, EventLog, PhaseBar, TaskList, AgentLog, detach-kill-prompt, qr-overlay
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

| Package  | May import                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| `shared` | only itself (and pure type-only zod). No `node:*`, `bun`, `react`, or `pi-*`.                                        |
| `engine` | `shared` + pi execution packages + node + bun.                                                                       |
| `tui`    | `shared` + `ink` + `react` + `@harms-haus/ink-overlay` + `ink-scroll-view` + `qrcode`. **Must not import `engine`.** |
| `cli`    | `shared`, `tui`, `engine` (spawns the daemon; re-exports the public API).                                            |
| `web`    | `shared` only.                                                                                                       |

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
                                web: zustand workflow-store ◄── │   → TuiStore              │
                                (applySnapshot/applyEvents,     │     (useSyncExternalStore)│
                                 reconcileSelection, runs list) │   → Ink React tree        │
                                                                │ (replays via shared       │
                                                                │  evolve, same follow rules)│
                                                                └───────────────────────────┘
```

The workflow's `options.onStatus` is not the raw `createStoreCallbacks` surface. The engine's
`RunExecutor` first composes it through `composeHooks(storeCallbacks, workflow.hooks)`
([Hooks](../reference/hooks.md)). The composed `onStatus` forwards every callback **verbatim**
to the store — the store is the terminal sink and **always** fires — while the returned
`HookRegistry` is threaded into the engine primitives (`SessionScheduler`, `PhaseRunner`,
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

| Aspect           | Write model (`Task` / `TaskGraph`)                                           | Read model (`TaskEntity` / projection)       |
| ---------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Lives in         | `TaskGraph` (executor side, server)                                          | `WorkflowProjection.tasks`                   |
| Carries          | prompt, files, dependencies, review feedback, worktree mode, executor status | title, phaseId, status, dependencies, timing |
| Mutated by       | `SessionScheduler` (drives `TaskGraph` status transitions via the gate)      | `evolve()` reducer (immutable)               |
| Kept in sync via | events fired by `runSession` / `SessionScheduler` / task processing          | replaying those events                       |

A subtle consequence: `rejectTask` on the write model keeps the task `active` (the
pool still owns it and will retry), but the corresponding `task_rejected` event maps
to status `failed` in the projection. Both are correct — the executor view supports
retry, the projection view shows the latest outcome.

## The session lifecycle, end to end

When a runner calls `ctx.runSession(...)` — all server-side — this happens:

1. **Idempotency check.** The session primitive checks for a `.complete` sentinel +
   valid `result.json` in the session directory. If present, returns the cached result
   without spawning. If `.complete` exists but the result is corrupt (checksum/length
   mismatch), throws a permanent `SessionError`.
2. **Profile resolution.** The profile is looked up from `ctx.profiles` by
   `spec.profile`. Read-only sessions add `write`/`edit` to the profile's `excludeTools`.
3. **Agent session creation.** The profile's configured agent plugin is resolved
   (via `requireAgentPlugin`) and its `createSession` is called directly (not via
   `spawnAgent`). The session is registered on `activeSessions` immediately after
   creation (before any `await`) so abort listeners reach it.
4. **Lifecycle callback.** `onSessionStart` fires with `{ agentId, profile, phaseId,
sessionId, sessionPath, contextWindow?, runnerRole, attempt }`.
5. **Prompt.** Depending on `spec.outputMode`:
   - `'text'` — `session.prompt(promptText)` then extract last assistant text; fail-fast
     on empty/error.
   - `'structured'` — `promptForStructured(session, promptText, schema, { maxRetries: 3 })`;
     validated JSON returned as `{ mode: 'structured', data }`.
   - `'filesystem'` — prompt the agent; files are written during the turn; returns
     `{ mode: 'filesystem', files: [] }`.
     A watchdog timer (when `watchdogTimeoutMs` is set) aborts the session on inactivity.
6. **Persist + complete.** The result is atomically persisted (`result.json` +
   `.complete` sentinel with SHA-256 checksum). `onSessionComplete` fires. The session
   is disposed and removed from `activeSessions` in `finally`.

For tasks in a `SessionScheduler`, each task is fulfilled by a `SessionPlanRunner` —
an async generator that yields batches of `SessionSpec`s. The scheduler acquires gate
slots, executes the specs (one or more sessions per spec), and advances the generator
with the batch results once every spec settles. Per-task failures (generator errors,
worktree merge failures) route the task through `failTask`; resource deadlocks
(remaining non-terminal tasks with nothing in-flight) are escalated to task failures.
See [Task pool & execution](../reference/task-pool.md).

## Where to go next

- [Server reference](../reference/server.md) — the daemon, `RunManager`, the multi-run
  protocol, auth attach-points, and the `--lan` guard.
- [CLI reference](../reference/cli.md) — `run`, `resume`, `server up/down/status`,
  flags, and the detach/kill semantics.
- [Event store & status](../reference/event-store.md) — the reducer, the projection,
  durability, and the `log` event type.
- [Web reference](../reference/web.md) — the React client, the runs frame, and the
  shared `EngineClient`.
- [Task pool & execution](../reference/task-pool.md) — `SessionScheduler`, `TaskGraph`,
  `SessionGate`, runners.
- [Building a new workflow](../guides/building-workflows.md) — use all of this in anger.
