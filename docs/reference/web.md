# Web client

The engine server serves a React + Zustand single-page app (the **web client**) that
renders the same projection as the TUI in a browser or on a phone. The web client is
a **network client** of the server, just like the TUI: it connects over WebSocket,
lists active runs, selects one, and views its live projection.

This document covers the server's static serving + WebSocket routing (see also the
[Server reference](server.md) for the daemon and `RunManager`), the shared
`EngineClient`, the zustand store, and the frontend.

## How the server serves the web UI

The control server (`packages/engine/src/server/control-server.ts`) serves the
built bundle from `packages/web/dist`, resolved once at module load from candidate
locations (dev working copy, monorepo layout, global install). For `index.html`,
the `{{WS_ENDPOINT}}` placeholder is substituted with the appropriate `ws://` /
`wss://` URL. Missing files fall back to `index.html` (SPA), or to a built-in
placeholder page when no frontend bundle exists.

See [Server reference → Control server](server.md#control-server) for the HTTP +
WebSocket routing details, and [Server reference → Protocol](server.md#protocol)
for the multi-run protocol types (`ServerMessage` / `ClientMessage`).

## The shared `EngineClient`

Source: `packages/shared/src/engine-client.ts`. A framework-agnostic, pure-TypeScript
WebSocket client that owns connection lifecycle, exponential-backoff reconnection,
resync, and multi-run subscription (run multiplexing) — with **no** dependency on
React, zustand, Node builtins, or pi packages. Its only runtime API is the global
`WebSocket` constructor.

```typescript
class EngineClient {
  constructor(options: { url: string; authToken?: string; backoff?: {...} });
  connect(callbacks: EngineClientCallbacks): void;
  disconnect(): void;
  isConnected(): boolean;
  send(msg: ClientMessage): void;
  requestRuns(timeoutMs?: number): Promise<RunSummary[]>;
  subscribe(runId: string): void;
  unsubscribe(runId: string): void;
  resync(runId: string, lastSeq?: number): void;
}
```

| Behaviour       | Detail                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Backoff         | Exponential (default initial 1000 ms, ×1.5, max 30 000 ms), reset on a successful open.                                 |
| Handshake       | On each (re)open: send `auth` (if a token was provided), `list_runs`, then re-`subscribe` + `resync` every tracked run. |
| Resync tracking | Keeps the latest `seq` per runId (from `snapshot`/`events`) and replays `resync { runId, lastSeq }` on reconnect.       |
| `disconnect()`  | Clean, manual teardown; clears the reconnect timer and does **not** schedule a reconnect.                               |
| `send(msg)`     | Serializes + sends a `ClientMessage`; no-op when the socket is absent or not open.                                      |
| `requestRuns()` | One-shot `list_runs` + promise that resolves with the `runs` response (or `[]` on timeout/disconnect).                  |

## Frontend store

Source: `packages/web/src/store/workflow-store.ts`. A vanilla zustand store (created
outside React, Immer-backed) that holds the selected run's projection plus a
multi-run `runs` list.

| Action                                                        | Behaviour                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `setRuns(runs)` / `addRun(summary)`                           | Maintain the active-run list (from the `runs` / `run_started` messages).                                                  |
| `selectRun(runId)`                                            | Set the selected run; reset phase/task/step selection.                                                                    |
| `applySnapshot(runId, snapshot, seq)`                         | Full projection replace for the selected run; clears the event log on a fresh start or server reset (seq went backwards). |
| `applyEvents(runId, events)`                                  | Fold a batch through `evolveClient` (the shared `evolve`), reconcile selection, and append formatted event lines.         |
| `setStatus(runId, status)` / `setFailed(runId, error, phase)` | Terminal lifecycle (`run_complete` / `run_failed`).                                                                       |
| `appendRunLog(runId, entry)`                                  | Server-captured console output (`log` message).                                                                           |
| `cancelRun(runId)`                                            | Sends `{ type: 'cancel_run', runId }` via the module-level send bridge.                                                   |
| `selectPhase/Task/Step`                                       | Selection + follow rules (identical to the TUI).                                                                          |

A module-level `_sendFn` is set by `useWebSocket` on acquire / cleared on release so
store actions (e.g. `cancelRun`) can send WS messages without depending on the React
hook layer.

## `useWebSocket` hook

Source: `packages/web/src/hooks/useWebSocket.ts`. A thin React adapter over the
shared `EngineClient`. The transport/reconnect/resync logic lives in `EngineClient`;
this hook wires it into React via `useSyncExternalStore` and routes incoming
`ServerMessage`s into the zustand store.

- The `EngineClient` instance is a **module-level singleton** shared by every caller
  of `useWebSocket()`. The first caller to mount acquires it; the last to unmount
  tears it down — guaranteeing a single live connection per app session.
- The WS URL is derived from the `{{WS_ENDPOINT}}` placeholder (substituted by the
  server) or, failing that, from `window.location`.
- Message routing: `runs` → `setRuns`; `run_started` → `addRun`; `snapshot`/`events`
  → `applySnapshot`/`applyEvents`; `run_complete`/`run_failed` →
  `setStatus`/`setFailed`; `log` → `appendRunLog`; `error` → console.

## Runs frame

Source: `packages/web/src/components/RunsFrame.tsx`. A persistent panel that lists
active runs from the `runs` message, each showing `workflowName`, a truncated
`taskPrompt`, `status`, and `currentPhaseId`. Selecting a run `subscribe`s and
routes the main view to that run's projection; a **Cancel** button (first click
reveals a "Confirm?" prompt; second click sends `cancel_run { runId }`). Shown
when there are active runs; "No active runs"
otherwise.

> Starting runs is **CLI-only** in this iteration. There is no start-run UI, no cwd
> selector, and no past-runs browsing or archiving — those are future work. The
> `runs` list is the server's in-memory active registry only.

## Components

The existing components (Dashboard / EventLog / PhaseBar / TaskList / AgentLog)
already consume a projection; they are scoped to the selected run via the store.

| File                               | Responsibility                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `web/src/App.tsx`                  | Top-level layout: connection banner, RunsFrame, EventLog, PhaseBar, TaskList, AgentLog. |
| `web/src/components/RunsFrame.tsx` | Active-run list: select + cancel.                                                       |
| `web/src/components/PhaseBar.tsx`  | Clickable phase tabs; selecting a completed phase pins the view.                        |
| `web/src/components/TaskList.tsx`  | Phase-filtered, click-to-select task list, sorted by status priority.                   |
| `web/src/components/AgentLog.tsx`  | Agent detail log with step tab bar.                                                     |
| `web/src/components/EventLog.tsx`  | Scrollable workflow-level event log.                                                    |
| `web/src/store/workflow-store.ts`  | Zustand store: projection + selection + runs list.                                      |
| `web/src/hooks/useWebSocket.ts`    | React adapter over the shared `EngineClient`.                                           |
| `web/src/protocol-types.ts`        | Re-exports protocol + state types from `@engin/shared`.                                 |

### Centralised selection model

Both the TUI and the web client use the **same five-piece selection model** with the
**same follow rules** (phase / task / step). See [TUI reference → Dashboard](tui.md#dashboard--the-selection-model).

| State               | TUI           | Web                    |
| ------------------- | ------------- | ---------------------- |
| `selectedPhaseId`   | `ClientStore` | `workflow-store` field |
| `selectedTaskId`    | `ClientStore` | `workflow-store` field |
| `selectedStepIndex` | `ClientStore` | `workflow-store` field |
| `userPinnedPhase`   | `ClientStore` | `workflow-store` field |
| `userPinnedStep`    | `ClientStore` | `workflow-store` field |

These rules keep the UI focused on live activity while letting you pin to a specific
phase or step for inspection.

## Where to go next

- [Server reference](server.md) — the daemon, `RunManager`, and the protocol.
- [TUI reference](tui.md) — the terminal view of the same data.
- [Event store & status](event-store.md) — the source of the projection.
