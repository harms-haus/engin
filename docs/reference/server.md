# Server reference

The engine server is a **long-lived daemon** that owns all workflow execution. It is
the single execution path: `engin run` submits runs to it, and the TUI / web UI are
network clients that consume run projections over a multi-run WebSocket protocol.

Source: `packages/engine/src/server/`.

## Daemon lifecycle

Source: `packages/engine/src/server/daemon.ts` and `server-entry.ts`.

The daemon runs as a detached process that survives the CLI parent. Coordination is
file-based (a POSIX-style pidfile) plus an HTTP readiness probe.

### Files

| File    | Path                                | Purpose                                                       |
| ------- | ----------------------------------- | ------------------------------------------------------------- |
| pidfile | `<globalConfigDir>/server.pid`      | `{ pid, port }`, written atomically (temp file + rename).     |
| log     | `<globalConfigDir>/logs/server.log` | daemon stdout + stderr (appended).                            |
| token   | `<globalConfigDir>/server.token`    | capability token (mode `0600`); plumbed but **not enforced**. |

### Lifecycle primitives

| Function                      | Behaviour                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isPidAlive(pid)`             | Liveness check via `process.kill(pid, 0)`. `ESRCH` → dead; `EPERM` → alive (no permission).                                                                                |
| `readPidfile()`               | Returns `{ pid, port }` or `null` (absent / malformed / missing fields). Never throws.                                                                                     |
| `writePidfile(pid, port)`     | Atomic write (temp + rename); `mkdir -p` the parent.                                                                                                                       |
| `removeStalePidfile()`        | Removes the pidfile iff its recorded PID is dead. Returns `true` if removed.                                                                                               |
| `isServerAlive(port)`         | `GET /health` with a 2 s timeout. Resolves `true` iff 200.                                                                                                                 |
| `startDaemon({ port, host })` | Refuse wildcard host; no-op if already alive; clear stale pidfile; spawn detached; `unref()`; write pidfile; poll `/health` (500 ms, up to 10 s). Returns `{ pid, port }`. |
| `stopDaemon()`                | Read pidfile; `SIGTERM`; poll exit up to 10 s; escalate to `SIGKILL`; remove pidfile. Throws if no pidfile.                                                                |

### In-daemon entrypoint (`server-entry.ts`)

Spawned by `startDaemon` as a detached child (`Bun.spawn({ detached: true })`,
stdio redirected to the log file). On startup it:

1. Parses `--port` / `--host` from argv (defaults 3619 / `127.0.0.1`).
2. Writes its own pidfile (re-asserting ownership).
3. Creates a `RunManager` and starts the observer server (`control-server.ts`),
   wiring the manager's `onRunsChanged` callback to a `runs` broadcast.
4. Installs `SIGTERM` / `SIGINT` handlers for graceful shutdown: run `onShutdown`
   (cancel all runs, flush stores, dispose bridges), remove the pidfile, exit.

A belt-and-braces unref'd keepalive interval guards against premature exit.

## `RunManager`

Source: `packages/engine/src/server/run-manager.ts`.

Owns the lifecycle of concurrent workflow runs in an in-memory
`Map<runId, RunHandle>`. Each run is identified by its `runId` (the work-directory
basename, e.g. `1781118746110-develop`).

### `RunHandle`

| Field                               | Description                                       |
| ----------------------------------- | ------------------------------------------------- |
| `runId`                             | `basename(workDir)`.                              |
| `cwd`, `workflowName`, `taskPrompt` | Run provenance.                                   |
| `workDir`                           | Absolute path (event log lives here).             |
| `store`                             | The canonical `EventStore` for this run.          |
| `controller`                        | `AbortController` for cooperative cancellation.   |
| `bridge`                            | Per-run `StatusBridge` (runId-tagged broadcasts). |
| `status`                            | `'running'` \| `'complete'` \| `'failed'`.        |
| `summary`                           | `RunSummary` used in the active-run list.         |
| `subscribers`                       | `Set<ServerWebSocket>` currently subscribed.      |
| `worktree?`, `apiKeys?`             | Optional worktree info and forwarded API keys.    |

### Methods

| Method                                            | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startRun(msg)`                                   | Resolve `workDir` (`msg.workDir` or `getDefaultWorkDir(cwd, wfName)`); **refuse on collision** with an active `runId`; `loadWorkflow`; `EventStore.load(workDir)`; `createStoreCallbacks`; per-run `StatusBridge`; `loadEnvFiles(cwd)`; create worktree if requested; register the handle; call `onRunsChanged`; launch `workflow.run(...)` as a **fire-and-forget** async IIFE; return `{ runId, summary }` immediately (without awaiting). |
| `cancelRun(runId)`                                | Aborts that run's `AbortController` (cooperative). Idempotent no-op if unknown. Does **not** kill the server.                                                                                                                                                                                                                                                                                                                                |
| `handleWorktreeAction(runId, action)`             | Performs `keep` / `discard` / `merge` / `pr` server-side on the run's worktree.                                                                                                                                                                                                                                                                                                                                                              |
| `listRuns()`                                      | Returns `RunSummary[]` from the registry.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `getRun(runId)`                                   | Returns a single `RunSummary` or `undefined`.                                                                                                                                                                                                                                                                                                                                                                                                |
| `subscribe(ws, runId)` / `unsubscribe(ws, runId)` | Track a WebSocket's per-run subscriptions.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `handleResync(ws, runId, lastSeq?)`               | Sends an events catch-up or full snapshot, tagged with `runId`, to the requesting socket.                                                                                                                                                                                                                                                                                                                                                    |
| `shutdownAll()`                                   | Cancels every run, flushes every store, disposes every bridge. Used on graceful shutdown.                                                                                                                                                                                                                                                                                                                                                    |

**Fire-and-forget execution.** The workflow runs inside an async IIFE. On success it
flushes the store _before_ flipping status, marks the run complete, and broadcasts
`run_complete`. On failure it flushes (partial events stay durable), distinguishes
`AbortError` ("Run cancelled") from genuine errors, marks the run failed, and
broadcasts `run_failed`. The `finally` block notifies the control server and
schedules a **60 s reaper** that disposes the bridge and removes the handle — so
late clients can view the final state before the run is reaped.

There is **no global concurrency cap** on the number of runs. Per-run
`maxConcurrentTasks` is honored as before.

### Run identity & storage

`runId` **= the work-directory name** exactly as `getDefaultWorkDir(cwd, wfName)`
produces it: `<cwd>/.engin/work/<timestamp>-<slug>/`. On a `runId` collision (the
default work dir is already an active run), `startRun` **refuses** with an error
pointing the user to `engin resume <runId>`.

## Runtime console capture → `log` events

The TUI used to gain visibility into library/runtime warnings by monkey-patching
`console.warn`/`console.error` in-process. Across processes that no longer works, so
the server replaces it. Within each run's execution scope (`executeWorkflow`),
`console.warn` / `console.error` / `console.info` are scoped overrides that **also**
append a `log` event to the store (the originals still run, so the server log file
captures them too). `console.log` is intentionally **not** overridden (library noise
like dotenv is ignored). The originals are restored in the `finally` block, even on
error or abort.

The `log` event flows through the normal `EventStore → evolve → StatusBridge →
subscriber` pipeline. Both clients render `log` entries into their event log (warn →
⚠️, error → ❌, info → silent in the stdout renderer; deduped in the TUI). See
[Event store & status](event-store.md#the-log-event-type).

## Control server

Source: `packages/engine/src/server/control-server.ts`. A Bun HTTP + WebSocket
server (this absorbed the former `observer-server.ts`).

### `startObserverServer(options)`

```typescript
interface ObserverServer {
  server: ReturnType<typeof Bun.serve>;
  broadcast: (msg: ServerMessage) => void;
  url: string;
  stop: () => Promise<void>;
}
```

| Field          | Description                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `host`, `port` | Bind hostname / port.                                                                            |
| `runManager`   | Owns the run registry; routes WS messages to it.                                                 |
| `onShutdown?`  | Async hook invoked by `stop()` _before_ the server stops (typically `runManager.shutdownAll()`). |

### HTTP

- `GET /health` → `200 { pid, port, activeRuns }`. Must not fall through to static /
  SPA fallback so lifecycle tools receive JSON.
- Static file serving from `packages/web/dist` (resolved once at module load from
  candidate locations: dev working copy, monorepo layout, global install). For
  `index.html`, the `{{WS_ENDPOINT}}` placeholder is substituted with the
  `ws://`/`wss://` URL. Missing files fall back to `index.html` (SPA), or to a
  built-in placeholder page when no frontend bundle exists.
- **HTTP idle timeout disabled** (`idleTimeout: 0`) so slow mobile WebSocket
  upgrades aren't killed.
- **HTML-encoded Host header** — user-influenced `Host` values are HTML-escaped
  (`escapeHtml`) before embedding in served HTML to prevent self-XSS.

### WebSocket (`/ws`)

- **Origin rejection** (`validateWebSocketOrigin`) — while auth is disabled, any
  WebSocket upgrade carrying an `Origin` header (browser-originated) is rejected
  with 403. CLI/engin clients never send an `Origin` header and are unaffected.
  When authentication is enabled in the future, this will be replaced with an
  allowlist validated against the Origin header.
- **maxPayloadLength 1 MiB** — caps inbound WebSocket frames to mitigate
  memory-exhaustion DoS.
- `websocket.open` adds the client and immediately sends the active-run list.
- `websocket.message` parses JSON, routes every `ClientMessage` through the
  **`authorize` chokepoint**, then dispatches: `list_runs`, `start_run` (→
  `run_started` + auto-`subscribe`), `subscribe` (also sends a snapshot when the
  run exists), `unsubscribe`, `resync`, `cancel_run`, `worktree_action`, `auth`
  (no-op now).
- `websocket.close` removes the client and unsubscribes it from all runs.

## Protocol

Source: `packages/shared/src/protocol-types.ts`. JSON over the wire. Every
projection/event/lifecycle message is tagged with `runId`.

### Server → Client (`ServerMessage`)

| Type            | Shape                                  | Description                                              |
| --------------- | -------------------------------------- | -------------------------------------------------------- |
| `runs`          | `{ runs: RunSummary[] }`               | Active-run list (on connect + on change).                |
| `run_started`   | `{ runId, summary }`                   | A new run entered the registry.                          |
| `snapshot`      | `{ runId, seq, state }`                | Full `WorkflowProjection` (connect / resync).            |
| `events`        | `{ runId, seq, events }`               | Batch of raw `EventRecord`s since the client's last seq. |
| `run_complete`  | `{ runId }`                            | Terminal — sent immediately, not coalesced.              |
| `run_failed`    | `{ runId, error, phase }`              | Terminal — sent immediately, not coalesced.              |
| `log`           | `{ runId, level, message, timestamp }` | Server-captured runtime console output.                  |
| `auth_required` | `{}`                                   | Reserved for future auth enforcement.                    |
| `error`         | `{ runId?, code, message }`            | Protocol-level errors.                                   |

### Client → Server (`ClientMessage`)

| Type                        | Shape                                                                              | Description                                    |
| --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| `auth`                      | `{ token? }`                                                                       | Capability token (attach-point; not enforced). |
| `list_runs`                 | `{}`                                                                               | Request the active-run list.                   |
| `start_run`                 | `{ workflowName, taskPrompt, cwd, workDir?, maxConcurrent?, apiKeys?, worktree? }` | Start a run. Auto-subscribes the requester.    |
| `subscribe` / `unsubscribe` | `{ runId }`                                                                        | (Un)subscribe to a run's broadcasts.           |
| `resync`                    | `{ runId, lastSeq? }`                                                              | Request catch-up after reconnect.              |
| `cancel_run`                | `{ runId }`                                                                        | Cancel exactly one run.                        |
| `worktree_action`           | `{ runId, action }`                                                                | `keep` \| `discard` \| `merge` \| `pr`.        |

`isServerMessage(data)` is a type guard checking the `type` tag. The old
`terminate_server` message and the old unscoped `resync` are gone; the old terminal
signals `workflow_complete` / `workflow_failed` are now run-scoped `run_complete` /
`run_failed`.

### `RunSummary`

```typescript
interface RunSummary {
  runId: string; // == work-directory name
  cwd: string;
  workflowName: string;
  taskPrompt: string; // may be truncated for display
  status: 'running' | 'complete' | 'failed';
  currentPhaseId?: string;
  startedAt: string; // ISO 8601
  worktree?: { worktreePath: string; branchName: string; originalCwd?: string };
}
```

> `list_runs` returns the server's **in-memory registry of runs it is hosting**
> (active, plus just-completed runs still in the registry before the 60 s reap).
> Past-runs-per-cwd browsing and archiving are explicitly **future work**.

## `StatusBridge` (per-run)

Source: `packages/engine/src/server/status-bridge.ts`. A thin view over one run's
`EventStore` that broadcasts run-scoped messages to that run's subscribers.

- **Initialisation.** `lastSentSeq = store.getSnapshot().seq` so pre-subscribe
  history isn't re-broadcast (late joiners get it via `getSnapshot`).
- **Terminal transitions** (`→ complete` / `→ failed`) are broadcast **immediately**
  via `run_complete` / `run_failed` (not coalesced), so clients can surface a banner
  without waiting for the batch flush.
- **Coalescing.** Multiple synchronous `store.append`s collapse into a single
  `events` message per microtask tick, forwarding raw `EventRecord`s.
- **`handleResync(lastSeq)`** — if `lastSeq >= 0` and the buffer is contiguous
  (`events[0].seq === lastSeq + 1`), return an `events` catch-up; otherwise fall
  back to a full `snapshot`.
- **`broadcastTerminal(msg)`** — the canonical hook `RunManager` calls on terminal
  lifecycle; broadcasts immediately (synchronously).

## Auth attach-points (plumbed, disabled)

Source: `packages/engine/src/server/auth.ts`. Real auth is out of scope, but the
seams are wired so it drops in later.

| Function                  | Behaviour                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `generateToken()`         | Random 32-byte hex string (`crypto.randomBytes`).                                                                            |
| `writeServerToken(token)` | Writes to `<globalConfigDir>/server.token` with mode `0600`.                                                                 |
| `readServerToken()`       | Returns the stored token or `null` (absent / unreadable). Never throws.                                                      |
| `validateToken(supplied)` | Constant-time compare (`timingSafeEqual`) against the stored token.                                                          |
| `authorize(msg, ws)`      | **The single chokepoint** every inbound `ClientMessage` passes through. Currently **always returns `{ authorized: true }`**. |

- The CLI reads `server.token` and sends `{ type: 'auth', token }` on each
  (re)connect via `EngineClient`. The server's `authorize` ignores it for now.
- `auth_required` `ServerMessage` is reserved for future rejection.
- **Where real enforcement goes:** inside `authorize`, a minimal implementation is a
  constant-time `validateToken(supplied)` against `server.token`. Until that is real,
  the `--lan` guard (below) keeps the server localhost-only.

### `--lan` / wildcard host guard

Source: `packages/engine/src/server/bind-guard.ts`. `isWildcardHost(host)` returns
`true` for `0.0.0.0`, `::`, `[::]`, `::0`, `*`. The guard is checked inside
`startDaemon` (the single chokepoint covering `server up`, `run` auto-start, and
`resume` auto-start) and redundantly in the CLI's `serverUpCommand`. A wildcard
bind is **refused** with a clear message and a non-zero exit. Default bind is
`127.0.0.1`.

## The web UI (served by the server)

The engine serves `packages/web/dist` over HTTP. The React client is a network
client like the TUI: it wraps the shared `EngineClient` in a zustand store, lists
active runs in a **runs frame** (list / select / cancel), and views a selected run's
live projection. Starting runs is CLI-only in this iteration. See
[Web reference](web.md).

## Where to go next

- [Architecture](../concepts/architecture.md) — the process model and status flow.
- [CLI reference](cli.md) — `run` / `resume` / `server` commands.
- [Event store & status](event-store.md) — the substrate the server broadcasts.
- [Web reference](web.md) — the React client.
