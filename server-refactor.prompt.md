# Task: Refactor engin from a run-and-done CLI into a central WebSocket server with TUI + Web clients

You are working on **engin**, an AI workflow orchestrator for software development. Today engin is a
"run-and-done" CLI: each `engin run` is a single Bun process that simultaneously hosts the workflow
execution, the terminal dashboard (TUI), and a WebSocket observer server for an optional web UI — all
in one process, for one run, which dies when the run finishes.

This task refactors engin into a **central, long-lived WebSocket server** that hosts workflow runs, with
the CLI's TUI and the web UI both becoming _network clients_ of that server. This unlocks concurrent
runs, a single shared observability surface for two clients, and the foundation for remote/multi-client
use later.

**You cannot ask the owner questions during this task.** Every decision is specified below. Read the
entire prompt before writing any code, and read every file listed in §3 before designing anything.

---

## 1. Mission

Transform engin from a single-process run-and-done tool into a client/server system:

- A **central server** (`engin server up`) runs as a detached daemon, hosts N concurrent workflow runs,
  owns **all** execution (agent sessions, lane pools, event stores, worktree lifecycle), and exposes a
  **multi-run WebSocket protocol**.
- The **CLI** becomes a client: `engin run <wf> <task>` ensures the server is up (auto-starting it if
  down), submits the run, and **attaches** a TUI client that views the run over WebSocket, **blocking
  until the run reaches terminal state**, then runs post-run interaction (worktree prompt) and exits
  (leaving the server running).
- The **web UI** (React) becomes a client that lists/selects/views active runs and can cancel one.
  Starting runs stays CLI-only in this iteration.
- Shared types, the projection reducer, the protocol, and a framework-agnostic WS transport live in a
  **shared package** imported by the server, the TUI, and the web UI.

The north star, restated: **today the CLI _is_ the server (it feeds the TUI natively and broadcasts to
the web); after this task, the server is a separate daemon and both the TUI and the web are clients of
it.**

---

## 2. Non-negotiable constraints

1. **The workflow-author contract must not break.** Existing workflows
   (`<cwd>/.engin/workflows/<name>/main.ts` and global ones) that do
   `import { ... } from '@harms-haus/engin'` and export
   `{ run(taskPrompt: string, options: WorkflowRunOptions): Promise<void> }` must continue to compile
   and run **unchanged**. A workflow only ever talks to the engine via `options.onStatus` callbacks and
   reads `options.cwd`/`options.workDir`/`options.signal` — it is already process-agnostic. Keep it so.

2. **There is exactly ONE execution path: the server.** No in-process execution fallback in the CLI.
   Even non-TTY `engin run` submits to the server and renders the resulting event stream to stdout.

3. **`evolve.ts` stays pure** (only `import type`). It already runs in the browser today; this refactor
   formalizes it as a shared module. Do not introduce Node/React/pi dependencies into anything in the
   shared package.

4. **Event-sourced core is the substrate.** `EventStore` + `evolve` + `WorkflowProjection` is already a
   server-broadcast model (snapshot/delta/resync). You are generalizing a correct design, not inventing
   one. Preserve the snapshot/delta/resync semantics; only add run-multiplexing on top.

5. **The published package remains `@harms-haus/engin`.** Workflow authors keep importing from that
   exact name. Internally it re-exports from the new engine/shared packages.

---

## 3. Current architecture you must understand first

Read these before designing anything. Do not skip.

**Entry & command orchestration:**

- `src/cli.ts` — entry point; dispatches `run` / `resume` / `init` / `help` / `version`, plus an
  interactive-composer branch (which this task **removes**).
- `src/cli/commands.ts` — `runCommand` / `resumeCommand`. This is the heart of what changes: today it
  loads the workflow, sets up the TUI + observer server + EventStore **in one process**, then calls
  `workflow.run({ onStatus: storeCallbacks })`.
- `src/cli/parse-args.ts` — `CliOptions`, `USAGE`, `parseArgs`. Note current flags.
- `src/cli/tui-setup.ts` — `setupTuiAndObserver()`: creates the `EventStore`, `StatusBridge`, observer
  server, and `WorkflowTUI` **in-process**, wiring them to the same store. This is the seam that splits
  into "server-side run orchestration" vs "client-side view setup."
- `src/cli/sigint.ts` — cooperative SIGINT cancellation via `AbortController`. Today Ctrl+C aborts the
  in-process run; semantics must change to per-run client cancel.
- `src/cli/console-status.ts` — `createStatusCallbacks(verbose)`: the non-TTY console path. Becomes a
  WS-consuming renderer.
- `src/cli/post-worktree.ts` — interactive merge/PR/discard prompt after a worktree run. Stays
  client-side; the _action_ is sent to the server.
- `src/cli/session-selector.ts` — interactive past-run picker for `resume`. Stays client-side (disk
  scan of `<cwd>/.engin/work/`).

**Execution engine (barely changes — this is your biggest de-risking):**

- `src/core/workflow-loader.ts` — `loadWorkflow()` dynamic `require()`; `listWorkflows()`.
- `src/core/harness-factory.ts` — `createHarness()`: builds an `AgentSession` from a profile
  (model, `AuthStorage` from `~/.pi/agent/auth.json`, tool allowlist, resource loader).
- `src/core/agent-loop.ts`, `src/core/phase-tasks.ts`, `src/core/structured-output.ts`.
- `src/pool/*` — `LanePool`, `linearStepsRunner`, `branchRunner`, `councilRunner`, `mapRunner`,
  `reflectionRunner`, `step-execution`, `task-processor`. The executor. Consumes `options.onStatus`.
- `src/core/types.ts` — `WorkflowRunOptions`, `StatusCallbacks`, `WorkflowModule`, `WorktreeInfo`,
  `StepDefinition`, `Task`/`TaskEntity`. **The workflow-facing contract lives here.**
- `src/core/config.ts` — `getGlobalConfigDir()`, `getDefaultWorkDir(cwd, wfName)`,
  `resolveWorkflowsDirs`, `resolveProfilesDirs`, `loadEnvFiles`, past-run scanning.
- `src/core/worktree-lifecycle.ts`, `src/core/git.ts`, `src/core/network.ts` (LAN IP).

**Event-sourced status (the substrate — already nearly a server model):**

- `src/tracking/event-store.ts` — `EventStore`: ring buffer + projection + durable `events.jsonl` +
  `subscribe()`. **Already the single source of truth.**
- `src/tracking/event-types.ts` — `EventType`, `EventRecord`, entities, `WorkflowProjection`,
  `createInitialProjection`.
- `src/tracking/evolve.ts` — the pure reducer. **Runs in the browser today.**
- `src/tracking/store-callbacks.ts` — `createStoreCallbacks(store)`: maps every `StatusCallbacks`
  method 1:1 to `store.append(type, data, metadata)`.

**TUI (becomes a WS client):**

- `src/tui/workflow-tui.ts` — `WorkflowTUI`: takes an `EventStore` today and subscribes natively via
  `createStoreBackedTui`. Must instead take a **client store**. Note it also monkey-patches
  `console.warn/error` to route them into the event log — that trick dies (the server is a different
  process); runtime console output must become server-emitted `log` events (see §11).
- `src/tui/status-callbacks.ts` — `createStoreBackedTui`: subscribes widgets to the store. Becomes a
  WS-backed equivalent.
- `src/tui/components/*` — `Dashboard`, `EventLog`, `PhaseBar`, `TaskList`, `AgentLog`, QR overlay.
  These consume a `WorkflowProjection`; they barely change.
- `src/tui/format-workflow-event.ts` — `formatWorkflowEventLine(event)`. **Moves into shared** (the web
  already imports it from `@engin/tui/...`, which is a layering inversion to fix).
- `src/tui/composer.ts` — the interactive first-screen. **Removed entirely** in this task.

**Web observer + protocol (the reference client — already complete):**

- `src/web/observer-server.ts` — `startObserverServer()`: `Bun.serve` HTTP+WS on :3619; serves
  `web/dist`; `/ws` upgrade; static + SPA fallback. Generalize from one-run to run-multiplexed.
- `src/web/status-bridge.ts` — `StatusBridge`: subscribes to a store, coalesces events per microtask,
  broadcasts snapshot/delta, sends terminal lifecycle signals immediately. Becomes per-run.
- `src/web/protocol-types.ts` — `ServerMessage` / `ClientMessage`. **This becomes the multi-run
  protocol** (see §7).
- `web/src/hooks/useWebSocket.ts` — module-singleton WS transport with reconnect/backoff + `resync`.
  This is the reference for the shared `EngineClient`.
- `web/src/store/workflow-store.ts` — vanilla zustand store: `applySnapshot`, `applyEvents`,
  `reconcileSelection`. **This is the reference for the TUI's plain client store.**
- `web/src/store/evolve-client.ts` — `export { evolve } from '@engin/tracking/evolve'`. Already shared.
- `web/src/protocol-types.ts` — `export * from '@engin/web/protocol-types'`. Already shared via alias.

**Reference docs to read:**

- `docs/concepts/architecture.md` — the layering and the "how status flows" diagram. Update it.
- `docs/reference/event-store.md`, `docs/reference/web.md`, `docs/reference/cli.md`.
- `tests/web/protocol-types-parity.test.ts` — compile-time structural parity guard. Keep it working.

**Key existing facts to internalize:**

- Work dirs / run identity already exists: `getDefaultWorkDir(cwd, wfName)` →
  `<cwd>/.engin/work/<timestamp>-<slug>/`. Past runs live there. **`runId` = that directory's name.**
- The web client already reconnects with exponential backoff and resends `{type:'resync', lastSeq}`.
- The `StatusBridge` already sends terminal `workflow_complete`/`workflow_failed` immediately
  (not coalesced) so clients can surface a banner without waiting for the batch flush. Preserve this.
- `observer-server.ts` resolves `web/dist` via `import.meta.dir/../web/dist`, but `package.json` `files`
  only ships `dist` + `src` — globally-installed engin **cannot** serve the web UI today. Fix this
  (ship `web/dist`, resolve robustly). It matters more once the server is long-lived.

---

## 4. Target architecture

```
┌──────────────────────── engin server (long-lived daemon: `engin server up`) ────────────────────────┐
│  HTTP + WebSocket on :3619 (global; one per machine)                                                  │
│   ├─ RunManager  — registry of active runs                                                            │
│   │     └─ per run: EventStore(workDir) + workflow.run() + AbortController + StatusBridge(runId)      │
│   ├─ Control API over /ws: list_runs, start_run, subscribe, unsubscribe, resync, cancel_run,          │
│   │                       worktree_action   (auth interceptor: allow-all for now — see §13)            │
│   ├─ serves packages/web/dist (the web UI)                                                            │
│   ├─ GET /health (readiness)                                                                          │
│   └─ captures server-side console.warn/error → emits `log` events to run subscribers                  │
└──────────▲───────────────────────────────────────────▲─────────────────────────────────────────────────┘
           │ one WS connection, multi-run multiplexed  │ one WS connection, multi-run multiplexed
   ┌───────┴────────┐                           ┌───────┴──────────┐
   │ engin (TUI)    │                           │ web UI (React)   │
   │  - EngineClient│                           │  - EngineClient  │
   │    (WS+reconnect+resync, from shared)      │    (from shared) │
   │  - client store│                           │  - zustand store │
   │    (plain TS)  │                           │  - runs frame    │
   │  - pi-tui render                           │    (list/select/ │
   └────────────────┘                           │    cancel)       │
                                                └──────────────────┘
                                ▲
                                │ packages/shared  (pure TS, no Node fs/net, no React, no pi)
                                │   protocol-types, event-types, WorkflowProjection, evolve,
                                │   formatWorkflowEventLine, EngineClient, RunSummary,
                                │   ClientMessage / ServerMessage
                                └── imported by engine, tui, cli, web
```

`engin run` becomes: **ensure server up (auto-start if down) → `start_run` → `subscribe` → attach TUI
(or stdout renderer if non-TTY) → block until `run_complete`/`run_failed` → post-run worktree prompt →
exit (server keeps running).**

---

## 5. Decisions (all of them — confirmed by the owner)

**Process & CLI semantics:**

- `engin run` is **block-and-attach** (always blocks until terminal state, in TTY and non-TTY alike).
- **Remove the interactive TUI composer.** The only run entry is `engin run <wf> <task>`.
- `engin resume [runId]`: if `runId` is active on the server → attach; otherwise re-run it on the server
  from its `.engin-state.json` state file, then attach.
- **Server scope is global/central**: one daemon per machine, one port (default 3619). Runs from any
  `cwd` coexist. The server knows each run's `cwd`.
- `engin server down` warns about in-flight runs, prompts **y/N**, then cancels all runs and kills the
  daemon. `--force` / `-y` skips the prompt for scripts.
- `engin server up` is idempotent (no-op if already up). `engin server status` reports up/down, pid,
  port, active-run count, log path.
- **Auth is deferred** (localhost only for now) but **attach-points must be plumbed** (see §13). `--lan`
  / binding `0.0.0.0` is **refused with a clear message** until real auth exists.

**Run identity & storage:**

- `runId` **= the work-directory name** (e.g. `1781118746110-develop`), exactly as
  `getDefaultWorkDir` already produces. Runs are stored at `<cwd>/.engin/work/<runId>/` — **unchanged**.
- `list_runs` (this iteration) returns the server's **in-memory registry of runs it is hosting**
  (active; plus just-completed runs still in registry), each as a `RunSummary` carrying `runId`, `cwd`,
  `workflowName`, truncated `taskPrompt`, `status`, `currentPhaseId`, `startedAt`. Full **past-runs-per-cwd
  browsing + archiving is explicitly future work — do not build it** (see §16).
- On a `runId` collision (the default work dir is already an active run): **refuse** with an error
  pointing the user to `engin resume <runId>`.

**Transport & completion:**

- One WS connection per client, **multi-run multiplexed** by `runId`. Clients `subscribe`/`unsubscribe`
  to individual runs. `start_run` auto-subscribes the requesting client to the new run.
- Completion is driven by `run_complete` / `run_failed` for the attached `runId`. On transient WS drop,
  the client reconnects with exponential backoff and `resync`s (sending its last `seq`); the TUI shows a
  "reconnecting…" banner and preserves the last projection. If the server is truly gone (run lost), the
  CLI errors out with a clear message.
- Remove the old global `terminate_server` message entirely. Replace with per-run `cancel_run { runId }`.

**Worktree lifecycle:**

- Worktree **creation runs server-side** (the server has repo context for the run).
- The **interactive merge/PR/discard prompt runs client-side** in the attached TUI after terminal state;
  the chosen action is sent to the server via `worktree_action`.
- If the client detaches mid-run (force-quit), the worktree is **left in place** for a later client to
  act on (do not auto-destruct).

**Defaults baked in (the owner did not object — treat as decisions):**

- Framework-agnostic `EngineClient` (WS connect + reconnect/backoff + resync + run multiplexing) lives
  in **shared**. Web wraps it in zustand; the TUI wraps it in a plain-TS store.
- `formatWorkflowEventLine` moves **into shared**.
- `.env` is loaded **by the server, per run, from that run's `cwd`** (via the existing `loadEnvFiles`).
  `--api-key` values are forwarded from the CLI to the server inside the `start_run` message over
  localhost.
- Non-TTY `engin run` renders formatted event lines to stdout from the WS stream (port
  `createStatusCallbacks` to consume WS events, not in-process callbacks). **One execution path.**
- Daemon files: pidfile at `<globalConfigDir>/server.pid`, logs at `<globalConfigDir>/logs/server.log`.
- No global concurrency cap on runs initially (per-run `maxConcurrentTasks` only).
- The published `@harms-haus/engin` package preserves its current workflow-facing export surface
  (re-exported from engine/shared) so existing workflows keep compiling.

**Flag redistribution:**

| Command               | Flags                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `engin server up`     | `--port` (default 3619), `--host` (default 127.0.0.1), `--lan` (guarded/refused until auth)                                                  |
| `engin server down`   | `--force` / `-y`                                                                                                                             |
| `engin server status` | (none)                                                                                                                                       |
| `engin run`           | `<wf> <task>`, `--port` (connect/auto-start), `--cwd`, `--work-dir`, `--max-concurrent`, `--api-key` (repeatable), `--worktree`, `--verbose` |
| `engin resume`        | `[runId]`, `--port`, `--cwd`                                                                                                                 |

`--host` and `--lan` no longer apply to `run`/`resume` (server binding is `server up`'s concern).

**TUI client disconnect inputs (in the attached `engin run`):**

| Input                         | Behavior                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ctrl+C                        | Prompt the user: **Detach** (leave the run running on the server, exit the client) or **Kill** (send `cancel_run { runId }`, then exit once terminal state is observed). Default selection: Detach. |
| Ctrl+D                        | **Detach** immediately (no prompt) — leave the run running on the server, exit the client.                                                                                                          |
| (second Ctrl+C at the prompt) | Cancels the prompt (does nothing to the run). Esc at the prompt behaves the same.                                                                                                                   |

---

## 6. Package layout (5-package workspace)

Convert the repo to a workspace. Exact tooling is your call (bun workspaces or npm workspaces), but the
package graph and dependency rules are fixed:

```
packages/
├── shared/        PURE TS — no Node fs/net, no React, no pi. Imports only itself + zod types.
│   ├─ protocol-types.ts     ClientMessage / ServerMessage / RunSummary (multi-run)
│   ├─ event-types.ts        EventType, EventRecord, entities, WorkflowProjection, LogEntry
│   ├─ evolve.ts             the pure reducer (moved as-is)
│   ├─ format-workflow-event.ts   formatWorkflowEventLine (moved from src/tui/)
│   └─ engine-client.ts      EngineClient: WS connect, reconnect/backoff, resync, run multiplex
│
├── engine/        THE SERVER + ALL EXECUTION. Depends on shared.
│   ├─ server/
│   │   ├─ daemon.ts         spawn/detach, pidfile, lockfile, port-probe, /health, logs
│   │   ├─ run-manager.ts    registry of active runs; per-run EventStore + workflow.run + AbortController
│   │   ├─ control-server.ts HTTP+WS server (absorbs observer-server.ts); /ws control + run fan-out
│   │   ├─ status-bridge.ts  per-run store→WS bridge (runId-tagged)
│   │   └─ auth.ts           authorize(msg) interceptor — allow-all now, capability-token attach-point
│   ├─ core/  pool/  tracking/   (moved from src/; tracking/event-types + evolve move to shared)
│   ├─ web-dist serving       resolves and serves packages/web/dist (+ placeholder fallback)
│   └─ serves the daemon entrypoint used by the CLI to auto-start
│
├── tui/           pi-tui CLIENT. Depends on shared + @earendil-works/pi-tui. Does NOT depend on engine.
│   ├─ client-store.ts       plain-TS projection store: applySnapshot/applyEvents/reconcileSelection
│   │                        (ported from web/src/store/workflow-store.ts, React-stripped)
│   ├─ ws-backed-tui.ts      replaces createStoreBackedTui; syncs widgets from the client store
│   ├─ workflow-tui.ts       refactored: takes a client store (NOT an EventStore)
│   └─ components/           Dashboard, EventLog, PhaseBar, TaskList, AgentLog, QR overlay (moved)
│
├── cli/           THE `engin` BINARY. Published as @harms-haus/engin. Depends on shared + tui + engine.
│   ├─ index.ts (or similar) re-exports the stable workflow-facing API from engine+shared (public surface)
│   ├─ parse-args.ts, commands.ts (run/resume/init/server up|down|status), sigint.ts (client cancel)
│   └─ bin entrypoint: engin
│
└── web/           REACT CLIENT. Depends on shared. Vite-built; output served by engine.
    ├─ EngineClient usage wrapped in zustand (existing workflow-store, adapted for runId)
    ├─ components/ (existing, adapted)
    └─ NEW: runs frame (list active runs, select one, cancel) — see §12
```

**Dependency rules (enforce with an eslint `no-restricted-imports` rule):**

- `shared` may import **only** itself (and pure type-only zod). No `node:fs`, `node:net`, `bun`, `react`,
  or `@earendil-works/pi-*`. `EngineClient` uses the global `WebSocket` (a web standard; available in
  Bun, Node 22+, and browsers) — that is the only runtime API it touches.
- `engine` depends on `shared` (+ pi execution packages, node, bun).
- `tui` depends on `shared` + `@earendil-works/pi-tui`. **Must not depend on `engine`** (it's a client).
- `cli` depends on `shared`, `tui`, and `engine` (it spawns the engine daemon and re-exports the public
  API). The engine daemon runs as a **separate process** invoked via the engine entrypoint.
- `web` depends on `shared` only.

**Build/tooling:**

- Root `package.json` declares the workspace; root scripts delegate (`build`, `test`, `typecheck`,
  `lint`, `format`). Keep `bun test` as the test runner and `tsc --noEmit` for typechecking.
- TypeScript: path mappings (`@engin/shared/*`, etc.) are the minimum; project references are
  acceptable if you prefer. Existing `@engin/*` alias usage in `web/` should resolve to `packages/shared`.
- The **published** `@harms-haus/engin` is the `cli` package. Its `main`/`types`/`exports` point at an
  index that re-exports the stable workflow API; its `bin` is `engin`; its `files` must include the
  built CLI **and** the web dist bundle (so a global install can serve the web UI). Decide and document
  how `packages/web/dist` is produced and included at publish time.
- Preserve existing hooks (`simple-git-hooks`, `lint-staged`, prettier, eslint).

---

## 7. The multi-run WebSocket protocol (lives in `packages/shared/protocol-types.ts`)

Every projection/event/lifecycle message is **tagged with `runId`**. The protocol is JSON over the wire.

```ts
interface RunSummary {
  runId: string; // == work-directory name, e.g. "1781118746110-develop"
  cwd: string;
  workflowName: string;
  taskPrompt: string; // may be truncated for display
  status: 'running' | 'complete' | 'failed';
  currentPhaseId?: string;
  startedAt: string; // ISO 8601
}

// Server → Client
type ServerMessage =
  | { type: 'runs'; runs: RunSummary[] } // active-run list (on subscribe + on change)
  | { type: 'run_started'; runId: string; summary: RunSummary }
  | { type: 'snapshot'; runId: string; seq: number; state: WorkflowProjection }
  | { type: 'events'; runId: string; seq: number; events: EventRecord[] }
  | { type: 'run_complete'; runId: string } // terminal, sent immediately (not coalesced)
  | { type: 'run_failed'; runId: string; error: string; phase: string }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; message: string; timestamp: string }
  | { type: 'auth_required' } // AUTH ATTACH-POINT (future; not enforced now)
  | { type: 'error'; runId?: string; code: string; message: string }; // protocol-level errors (unknown runId, bad message, etc.)

// Client → Server
type ClientMessage =
  | { type: 'auth'; token?: string } // AUTH ATTACH-POINT (future)
  | { type: 'list_runs' }
  | {
      type: 'start_run';
      workflowName: string;
      taskPrompt: string;
      cwd: string;
      workDir?: string;
      maxConcurrent?: number;
      apiKeys?: Record<string, string>;
      worktree?: boolean;
    }
  | { type: 'subscribe'; runId: string }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'resync'; runId: string; lastSeq?: number }
  | { type: 'cancel_run'; runId: string }
  | { type: 'worktree_action'; runId: string; action: 'merge' | 'pr' | 'discard' | 'keep' };
```

Notes:

- The old `terminate_server` and the old unscoped `resync` are **gone**.
- The old terminal signals `workflow_complete` / `workflow_failed` become `run_complete` / `run_failed`
  (run-scoped). Keep the "send immediately, not coalesced" behavior from the current `StatusBridge`.
- Add a `log` event type for **server-captured runtime console output** (warn/error/info) so the TUI
  regains the visibility it currently gets by monkey-patching `console.*` in-process (see §11). Add the
  matching `EventType` and a trivial `evolve` case (append to a per-run log buffer, mirroring how agent
  logs are capped).
- Keep a type guard (`isServerMessage`) and a serializer. The web and TUI both consume these via the
  shared `EngineClient`.

---

## 8. Server design (`packages/engine/server/`)

**Daemon lifecycle (`daemon.ts`):**

- Detached process; survives the CLI parent. Invoked via the engine entrypoint (the CLI's `server up`
  spawns it; `engin run` auto-starts it the same way when a port-probe finds nothing).
- Global coordination: pidfile at `<globalConfigDir>/server.pid` (write pid, check-alive on start to
  detect stale pidfiles), lock to prevent two daemons on one port. Logs (stdout+stderr) redirected to
  `<globalConfigDir>/logs/server.log`.
- Readiness: the CLI probes `GET /health` (returns 200 + `{ pid, port, activeRuns }`) with a short
  timeout before declaring the server "up" and sending `start_run`.
- `--lan` / `host 0.0.0.0`: **refuse to bind** unless auth is implemented; print a message pointing to
  §13. Default bind is `127.0.0.1`.
- Graceful shutdown (`server down` / SIGTERM): stop accepting new runs, cancel all active runs
  (cooperative abort + a force timeout), flush all `EventStore`s, remove pidfile, exit.

**RunManager (`run-manager.ts`):**

- In-memory `Map<runId, RunHandle>` where `RunHandle = { runId, cwd, workflowName, taskPrompt,
EventStore, AbortController, summary, subscribers: Set<ws>, status }`.
- `startRun(msg)`: resolve `workDir` (from `msg.workDir` or `getDefaultWorkDir(cwd, wfName)`); **refuse
  on collision** with an active `runId`; `loadWorkflow`; build `EventStore.load(workDir)` +
  `createStoreCallbacks` + per-run `StatusBridge`; `loadEnvFiles(cwd)`; call `workflow.run({ cwd,
workDir, onStatus: storeCallbacks, signal, worktree?, apiKeys? })`. On terminal, keep the handle in
  the registry briefly (so late clients can view the final state) then reap.
- `cancelRun(runId)`: aborts that run's `AbortController` (cooperative). Does **not** kill the server.
- `listRuns()`: returns `RunSummary[]` from the registry.
- Broadcasts a `runs` message to all clients whenever the set of active runs changes (start/complete/
  fail/cancel).
- **No global concurrency cap** in this iteration. Per-run `maxConcurrentTasks` is honored as today.

**Control server (`control-server.ts`, absorbs `observer-server.ts`):**

- `Bun.serve` HTTP+WS. HTTP serves `packages/web/dist` (with the existing `{{WS_ENDPOINT}}` placeholder
  substitution and SPA fallback) + `GET /health`.
- `/ws`: on connect, run the client through the **auth interceptor** (allow-all now; see §13), then
  handle `ClientMessage`s: `list_runs`, `start_run` (→ `run_started` + auto-`subscribe`),
  `subscribe`/`unsubscribe` (track per-`ws` subscribed `runId` set), `resync` (per-run
  `store.getEventsSince`/snapshot), `cancel_run`, `worktree_action`.
- Keep the existing Origin validation for browser WS upgrades (CSRF defense). Note this is a
  **browser** defense only — it does not authenticate server-to-server localhost traffic; that's what the
  §13 attach-point is for.
- Per-run `StatusBridge`: subscribe to each run's `EventStore`, coalesce events per microtask, tag every
  broadcast with `runId`, send `run_complete`/`run_failed` immediately. Only deliver to `ws`s that have
  subscribed to that `runId`.

---

## 9. CLI design (`packages/cli/`)

**`engin run <wf> <task> [opts]`:**

1. Ensure server up: probe `GET /health` on the configured `--port` (default 3619). If down, auto-start
   the daemon detached, wait for readiness (probe with timeout). If it fails to come up, error clearly.
2. Connect `EngineClient`; send `start_run { workflowName, taskPrompt, cwd, workDir?, maxConcurrent?,
apiKeys?, worktree? }`. Receive `run_started { runId }`. (Auto-subscribed.)
3. Attach the view:
   - **TTY**: render the `tui` package's `WorkflowTUI` driven by a `client-store` fed from
     `EngineClient`. Show the QR overlay pointing at the server's web URL (e.g.
     `http://127.0.0.1:<port>/`).
   - **non-TTY**: render formatted event lines to stdout (port `createStatusCallbacks` to consume the
     WS `events`/`log` stream via `formatWorkflowEventLine`). `--verbose` controls turn/tool detail.
4. **Block** until `run_complete` / `run_failed` for `runId`. Handle transient disconnects with
   reconnect/backoff + `resync` + a "reconnecting…" banner (TUI). If the server is truly gone, error out.
5. On terminal: if `--worktree`, run the interactive merge/PR/discard prompt client-side and send the
   chosen `worktree_action` to the server. (Mirror current `promptPostWorktreeAction`.)
6. Exit (the server keeps running). Flush nothing on the client — durability is the server's job.

**Disconnect semantics (rewrite `sigint.ts` and TUI input handling):**

The attached TUI offers two ways to leave a run: **detach** (the run keeps running on the server) and
**kill** (cancel the run). Inputs:

- **Ctrl+C**: surface an in-TUI prompt — _Detach_ (default) or _Kill_. The prompt shows the run's
  `runId` so the user knows what to `resume` later.
  - **Detach**: close the client cleanly. The run continues on the server unchanged. Print a message
    like `Detached. Run <runId> is still active on the server. Re-attach with: engin resume <runId>`.
  - **Kill**: send `cancel_run { runId }`, then keep the client attached until `run_complete`/
    `run_failed` for that `runId` is observed (so the user sees the cancellation complete), then exit.
  - **Second Ctrl+C at the prompt / Esc**: dismiss the prompt (run is unaffected, client stays
    attached). The user can re-trigger with Ctrl+C again.
- **Ctrl+D**: **Detach immediately** (no prompt). Same post-message as the Ctrl+C → Detach path.
- These inputs must **never kill the server** and never affect any other run. The server is a shared
  resource; only `engin server down` stops it.

(Non-TTY `engin run` has no interactive prompt: a single Ctrl+C sends `cancel_run { runId }` and waits
for terminal state; a second Ctrl+C force-exits the client. Document this in `--help`.)

**`engin resume [runId]`:**

- If `runId` is given positionally:
  - If it is in the server's active registry → `subscribe` + attach (same view path as `run`).
  - Else → send `start_run` with the run's existing `workDir` + task prompt (read from its
    `.engin-state.json`) so the server resumes it; then attach.
- If no `runId` is given, launch the **interactive picker** (`session-selector.ts`), which now draws from
  **two sources, in this order**:
  1. **Detached / running runs first** — runs currently in the server's active registry (queried via
     `list_runs`), shown above the historical list and visually distinct (e.g. a 🟢 marker and
     `RUNNING` / `DETACHED` label). Selecting one attaches to it.
  2. **Historical uncompleted runs below** — runs found by the existing disk scan of
     `<cwd>/.engin/work/` that have a resumable `.engin-state.json` and are **not** active on the
     server. Selecting one sends `start_run` to resume it.
  - A run that is both on disk and active should appear **only** in the top (active) section, never
    duplicated in both.
  - If the server is down, the picker shows only the historical (disk) list (and `engin resume` may
    auto-start the server before showing the combined picker — your call; recommended: auto-start so
    active runs are discoverable).

**`engin init`**: unchanged (client-side config dir setup via `initDefaultConfig`).

**`engin server up`**: idempotent daemon start (probe first; no-op if up).

**`engin server down [--force|-y]`**: `list_runs`; if any active and not `--force`, print them and
prompt y/N; on approval send `cancel_run` to each (or a server-side drain), then stop the daemon
(SIGTERM via pidfile), wait for exit, clear pidfile.

**`engin server status`**: print up/down, pid, port, bind host, active-run count, log path, web URL.

---

## 10. TUI client design (`packages/tui/`)

- `client-store.ts`: a plain-TS projection store ported from `web/src/store/workflow-store.ts`
  (vanilla — drop the zustand/React selectors; keep `applySnapshot`, `applyEvents`, the agent-log cap,
  and the selection reconciliation). It exposes the current `WorkflowProjection` plus a workflow event
  log and the runtime `log` entries.
- `ws-backed-tui.ts` (replaces `createStoreBackedTui`): given a `client-store`, sync `Dashboard`,
  `EventLog`, etc. from it on each update (the widgets already consume a projection — minimal change).
- `WorkflowTUI`: constructor takes a **client store** (and an `EngineClient` or its unsubscribe), not an
  `EventStore`. Input handling, pause-for-inspection, QR overlay — all stay. `pauseForInspection` is now
  driven by `run_complete`/`run_failed` for the attached `runId` (plus the existing Escape/Ctrl+C).
- **Disconnect UX**: on `EngineClient` disconnect, show a "reconnecting…" banner, keep the last
  projection visible, and on reconnect send `resync { runId, lastSeq }`. On permanent loss, show an
  error and exit.
- **Console interception removed.** The TUI no longer monkey-patches `console.warn/error` — it's a
  client; the server's console is a different process. Runtime warnings/errors are delivered as `log`
  events and rendered into the `EventLog` (deduped, as today).

---

## 11. Runtime console output (server-side capture → `log` events)

The current TUI gains visibility into library/runtime warnings by monkey-patching `console.warn`/
`console.error` in-process. That can't work across processes. Replace it:

- In the **server**, within each run's execution scope, capture `console.warn`/`console.error`/`console.info`
  (a scoped override active for the duration of that run, restored after) and emit a `log` event
  `{ runId, level, message, timestamp }` to that run's subscribers.
- Add `log` to `EventType` and a trivial `evolve` case (append to the projection's run-level log, capped
  like agent logs). Add `log` to `ServerMessage`.
- Both clients render `log` entries into their event log (TUI: with the existing ⚠️/❌ prefixes and
  dedup; web: into its event log).
- Do **not** route `console.log` (library noise like dotenv) — match current behavior.

---

## 12. Web client design (`packages/web/`)

- Adopt `runId` throughout the store (snapshot/events/run_complete/run_failed/log all carry it).
- Wrap the shared `EngineClient` in the existing zustand store. The transport/reconnect/resync logic
  moves **out** of `web/src/hooks/useWebSocket.ts` and into `EngineClient`; the hook becomes a thin
  React wrapper over it (preserve the module-singleton/ref-count behavior).
- **New: a runs "frame"** (per the owner's direction): a persistent sidebar/topbar listing active runs
  from the `runs` message, each showing `workflowName`, truncated `taskPrompt`, status, `currentPhaseId`.
  Selecting a run `subscribe`s and routes the main view to that run's projection; switching runs
  `unsubscribe`s the old one. A **Cancel** button sends `cancel_run { runId }`.
- Keep the existing components (Dashboard/EventLog/PhaseBar/TaskList/AgentLog) — they already consume a
  projection; just scope them to the selected run.
- **No start-run UI in this iteration** (start is CLI-only). **No cwd selector, no past-runs browsing,
  no archiving** (future — see §16).

---

## 13. Auth attach-points (plumbed, disabled)

Real auth is out of scope, but wire the seams so it drops in later:

- On start, the server generates a capability **token** (e.g. random 32-byte hex) and writes it to
  `<globalConfigDir>/server.token` with mode `0600`.
- Every inbound `ClientMessage` passes through `authorize(msg, ws)` in `auth.ts`. **For now it always
  returns `authorized: true`.** This is the single chokepoint where real validation lands later.
- The CLI reads `server.token` and sends `{ type: 'auth', token }` on connect (and/or as a header on
  the WS upgrade). The server's `authorize` ignores it for now but the field exists.
- Reserve the `auth_required` `ServerMessage` for future rejection.
- **Guard `--lan`**: `server up --lan` (or `--host 0.0.0.0`) must **refuse** with a message like
  "LAN binding requires auth, which is not yet implemented. Run on localhost for now." until `authorize`
  is real. This is a safety gate, not a TODO to skip.
- Document in `docs/reference/web.md` (or a new `docs/reference/server.md`) exactly where the real check
  goes and what a minimal implementation looks like (constant-time token compare against `server.token`).

---

## 14. Suggested migration phasing (keep the app working at every step)

Do not attempt the whole thing in one commit. Sequence so each phase ships green:

1. **Extract `packages/shared`** behind path aliases: move `protocol-types`, `event-types`,
   `WorkflowProjection`/entities, `evolve`, `formatWorkflowEventLine` into shared. Add the eslint
   import-boundary rule. Update `web/` aliases and the parity tests. Pure refactor, no behavior change.
2. **Multi-run protocol while still single-process**: add `runId` to every message, add `RunManager`
   (managing exactly one run for now), `runs`/`run_started`/`run_complete`/`run_failed`, `list_runs`,
   `subscribe`/`unsubscribe`, `cancel_run` (replacing `terminate_server`). Keep the TUI native. This
   makes the protocol multi-run-ready without changing the process model.
3. **Split `tui-setup.ts`** into server-side run orchestration vs client-side view setup (still
   in-process). Establish the seam.
4. **Port the web store/transport into the shared `EngineClient` + a plain `client-store`; convert the
   TUI to consume `EngineClient` over `localhost:3619` instead of subscribing in-process** — still a
   single process, but the TUI is now a real WS client. Validate TUI and web behave identically.
5. **Introduce the daemon** (`server up/down/status`, pidfile/lock/port-probe/`/health`, logs) and make
   `engin run` submit-then-attach with auto-start. Now you have two real clients of one server.
6. **Rework cancellation, worktree lifecycle, post-run interaction, and runtime `log` capture** to be
   protocol-mediated (§9, §10, §11).
7. **Add the auth attach-points** (§13) and the `--lan` guard.
8. **Finalize packaging** (5 packages, public API re-exports, `files` includes web dist, build scripts).

Each phase should typecheck, pass tests, and leave a runnable `engin`.

---

## 15. Tests

Expect substantial test churn; update tests as you go (don't delete coverage).

- **Keep** `tests/web/protocol-types-parity.test.ts` and **extend** it to cover the new multi-run
  message variants and `RunSummary` (compile-time `Equal<>` guards + JSON round-trip). Both the engine
  and the web/tui clients import protocol types from `shared` now, so parity is structural.
- Add tests for `RunManager`: start → terminal lifecycle, collision refusal, cancel, list, per-run
  isolation (two concurrent runs don't cross-contaminate event streams).
- Add tests for the daemon: pidfile create/stale-detect, port-probe readiness, `--lan` refusal.
- Add tests for the **shared `EngineClient`**: connect, reconnect/backoff, `resync` catch-up, run
  multiplex (subscribe/unsubscribe routing), terminal handling. (Use a mock/in-process WS server.)
- Port/keep TUI widget tests; the `WorkflowTUI` tests change to feed a client store instead of an
  `EventStore`.
- Port the `createStatusCallbacks` (console) tests to the new WS-consuming stdout renderer.
- Keep all `core/`, `pool/`, `tracking/` engine tests working (they barely change).

---

## 16. Explicitly OUT of scope (do NOT build — future work)

- **Web UI: cwd selector** that populates past runs from an arbitrary `<cwd>/.engin/work/`.
- **Run archiving** (web or CLI).
- **Web start-run UI** (start stays CLI-only this iteration).
- **Real auth enforcement** (only the attach-points in §13).
- **Non-localhost / `--lan` deployment** (guarded off).
- **Global concurrency caps** on number of runs.
- **The interactive TUI composer** (removed entirely).
- **History browsing per cwd** in the web frame (the `runs` list this iteration is the server's
  in-memory active registry only).

If you are tempted to build any of these, stop — it is deferred.

---

## 17. Research guidance

You are expected to research as needed. Useful topics:

- Bun WebSocket server (`Bun.serve` `websocket`) and `WebSocket` client semantics; idle timeouts; the
  existing `idleTimeout: 0` and Origin-validation rationale in `observer-server.ts`.
- Daemon patterns on POSIX: pidfile + `kill(pid, 0)` liveness check, `lockfile`/atomic pidfile write,
  detaching with `setsid`/`detached: true`, redirecting stdio to a log file.
- Capability-token auth for local daemons (how `claude`/`cursor`/jupyter-server style local tokens
  work): random token in a `0600` file, sent on the first frame or as an `Authorization` header.
- Event-sourced snapshot/delta/resync patterns (you already have one; confirm your understanding against
  the existing `StatusBridge` + `evolve`).
- Structurally comparing TypeScript types at compile time (the `Equal<>` trick in the parity test) so
  your new protocol variants stay in lockstep across consumers.

Do not over-engineer. Prefer the simplest design that satisfies this spec.

---

## 18. Definition of done

- The repo is a 5-package workspace (`shared`, `engine`, `tui`, `cli`, `web`) with the dependency rules
  in §6 enforced; `bun run build`, `bun run typecheck`, `bun run lint`, `bun test` all pass at the root.
- `engin server up` starts an idempotent detached daemon with a pidfile, `GET /health`, and logs;
  `engin server status` reports state; `engin server down` warns/confirms/cancels/stops.
- `engin run <wf> <task>` auto-starts the server if down, submits the run, and attaches the TUI
  (stdout renderer if non-TTY), blocking to terminal state, then runs the worktree prompt if
  `--worktree`. The server keeps running after the CLI exits.
- **Two concurrent `engin run`s** host two runs on one server; the web UI lists both, selects either,
  views its live projection, and can cancel it.
- The TUI shows a reconnect banner on a transient WS drop and resyncs correctly on reconnect.
- Existing sample workflows run **unchanged** (no workflow code edits required).
- The multi-run protocol is typed in `shared` and covered by updated parity tests.
- `cancel_run` aborts one run without affecting the server or other runs; Ctrl+C in the TUI cancels the
  attached run (and force-quit exits the client without killing the server).
- Auth attach-points are present and disabled; `--lan` binding is refused with a clear message.
- `docs/concepts/architecture.md` and the relevant `docs/reference/*` are updated to describe the new
  client/server architecture, the daemon, and the multi-run protocol.

When you believe you are done, run the full typecheck + lint + test suite at the root and report any
remaining gaps with concrete file references. Prefer leaving small, clearly-documented TODOs over
silently skipping a requirement.
