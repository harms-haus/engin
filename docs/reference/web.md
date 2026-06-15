# Web mirror

engin ships an HTTP + WebSocket server (the **observer server**) and a React + Zustand
single-page app (the **web mirror**) that renders the same projection as the TUI in a browser
or on a phone. This document covers the server, the protocol, the broadcast bridge, and the
frontend.

## `startObserverServer(options)`

Source: `src/web/observer-server.ts`. A Bun HTTP + WebSocket server.

```typescript
interface ObserverServer {
  server: ReturnType<typeof Bun.serve>;
  broadcast: (msg: ServerMessage) => void;
  url: string;
  stop: () => Promise<void>;
}
```

### Options

| Field           | Description                                                           |
| --------------- | --------------------------------------------------------------------- |
| `host`          | Bind hostname.                                                        |
| `port`          | Port.                                                                 |
| `displayHost?`  | Host to use in the displayed/QR URL (defaults to the bound hostname). |
| `onTerminate?`  | Called when a client sends `terminate_server`.                        |
| `getSnapshot?`  | Returns a `snapshot` `ServerMessage` to send on connect.              |
| `handleResync?` | `(ws, lastSeq?) => void` to handle `resync` from a client.            |

### Server behaviour

- **HTTP idle timeout disabled** (`idleTimeout: 0`) so slow mobile WebSocket upgrades aren't
  killed. WebSocket-level idle timeout remains Bun's default.
- `websocket.open` adds the client to a `Set` and immediately sends `getSnapshot()` if provided.
- `websocket.message` parses JSON; `type === 'terminate_server'` → `onTerminate?.()`;
  `type === 'resync'` → `handleResync?.(ws, msg.lastSeq)`. Invalid JSON is swallowed.
- `broadcast(msg)` stringifies once and sends to every client, dropping any that throw.
- `url` is `http://<displayHost ?? hostname>:<port>`.

### Static file serving

`serveStatic` serves files from `web/dist` (resolved relative to the server module):

- `/` or `''` → `/index.html`.
- Existing files are served with a MIME from a small `MIME_MAP` (`.html`, `.css`, `.js`,
  `.mjs`, `.json`, images, fonts, `.map`).
- For `index.html` specifically, the `{{WS_ENDPOINT}}` placeholder is replaced with the
  appropriate `ws://` or `wss://` URL (`wss` when the request URL protocol is HTTPS).
- Missing files fall back to `index.html` (SPA fallback), or to a built-in placeholder page if
  `index.html` is absent. The placeholder also gets `{{WS_ENDPOINT}}` substituted.

### Origin validation

`validateWebSocketOrigin(req)` guards `/ws` upgrades:

- `isLocalhost` is true if the `Host` header starts with `localhost`, `127.0.0.1`, `::1`, or
  `[::1]`.
- If `Origin` is present **and** the host is **not** localhost: parse the origin URL
  (non-http/https schemes like `capacitor://`, `file://`, `ionic://` are **allowed**), then
  compare hostname (and port, when both are present) against the request `Host` header.
- If `Origin` is absent **or** the host is localhost: **allowed**.

> **Known limitation.** Clients without an `Origin` header (curl, scripts) bypass the check
> entirely. The primary protection is the default localhost binding; exposing the server
> broadly is opt-in via `--host` or `--lan`.

## Protocol

Source: `src/web/protocol-types.ts`. Re-exports state types
(`WorkflowProjection`, `EventRecord`, `EventType`, entities, `LogEntry`) from
`src/tracking/event-types.ts`.

### Server → Client (`ServerMessage`)

| Type                | Shape                                | Description                                                                                                |
| ------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `snapshot`          | `{ seq, state: WorkflowProjection }` | Full projection — sent on connect or full resync.                                                          |
| `events`            | `{ seq, events: EventRecord[] }`     | Batch of raw events since the client's last seq. The client replays them through its own `evolveClient()`. |
| `workflow_complete` | `{}`                                 | Terminal signal — broadcast immediately, not coalesced.                                                    |
| `workflow_failed`   | `{ error, phase }`                   | Terminal signal — broadcast immediately, not coalesced.                                                    |

### Client → Server (`ClientMessage`)

| Type               | Shape                  | Description                                             |
| ------------------ | ---------------------- | ------------------------------------------------------- |
| `terminate_server` | `{}`                   | Request workflow cancellation (triggers `onTerminate`). |
| `resync`           | `{ lastSeq?: number }` | Request catch-up after reconnect.                       |

`isServerMessage(data)` is a type guard checking the `type` tag is one of the four server
variants.

## `StatusBridge`

Source: `src/web/status-bridge.ts`. A thin view over the `EventStore` that broadcasts
`ServerMessage`s whenever the store changes.

```typescript
class StatusBridge {
  constructor(broadcast: (msg: ServerMessage) => void, store: EventStore);
  getSnapshot(): ServerMessage & { type: 'snapshot' };
  handleResync(lastSeq?: number): ServerMessage;
  dispose(): void;
}
```

### Behaviour

- **Initialisation.** `lastSentSeq = store.getSnapshot().seq` so pre-subscribe history is not
  re-broadcast (late joiners get it via `getSnapshot`). `prevStatus = snap.state.status`.
- **On projection change:**
  - If `status` changed and is now `complete` → immediately broadcast `workflow_complete`.
  - If `status` changed and is now `failed` → immediately broadcast `workflow_failed`
    (`error: projection.error ?? ''`, `phase: projection.failedPhase ?? ''`).
  - Always `scheduleFlush()`.
- **Coalescing.** `scheduleFlush` queues a microtask if one isn't pending; multiple synchronous
  `store.append`s collapse into a single `events` message. `flush` reads
  `store.getEventsSince(lastSentSeq)` and broadcasts them, advancing `lastSentSeq`.
- **`handleResync(lastSeq)`** — if `lastSeq` is provided and `>= 0`, attempt event catch-up:
  if the buffer is contiguous (`events[0].seq === lastSeq + 1`), return an `events` message;
  otherwise fall back to a full `snapshot`. Gap or empty buffer → snapshot fallback.

## Frontend (the web mirror)

Source: `web/`. A React + Zustand SPA that maintains its own copy of the `WorkflowProjection`
by replaying events through `evolveClient()` — the same pure reducer logic as the server's
`evolve()`.

| File                              | Responsibility                                                               |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `web/src/App.tsx`                 | Top-level layout: connection banner, EventLog, PhaseBar, TaskList, AgentLog. |
| `web/src/components/PhaseBar.tsx` | Clickable phase tabs; selecting a completed phase pins the view.             |
| `web/src/components/TaskList.tsx` | Phase-filtered, click-to-select task list, sorted by status priority.        |
| `web/src/components/AgentLog.tsx` | Agent detail log with step tab bar and terminate-workflow button.            |
| `web/src/components/EventLog.tsx` | Scrollable workflow-level event log.                                         |
| `web/src/store/workflow-store.ts` | Zustand store: projection + selection state + follow rules.                  |
| `web/src/store/evolve-client.ts`  | Client-side pure reducer (mirrors server `evolve`).                          |
| `web/src/hooks/useWebSocket.ts`   | WebSocket lifecycle: snapshot/events/terminal handling, resync, terminate.   |
| `web/src/protocol-types.ts`       | Re-exports protocol + state types.                                           |

### Centralised selection model

Both the TUI and the web mirror use the **same five-piece selection model** with the **same
follow rules** (phase / task / step). See [TUI reference → Dashboard](tui.md#dashboard--the-selection-model).

| State               | TUI                    | Web                    |
| ------------------- | ---------------------- | ---------------------- |
| `selectedPhaseId`   | `Dashboard._selection` | `workflow-store` field |
| `selectedTaskId`    | `Dashboard._selection` | `workflow-store` field |
| `selectedStepIndex` | `Dashboard._selection` | `workflow-store` field |
| `userPinnedPhase`   | `Dashboard._selection` | `workflow-store` field |
| `userPinnedStep`    | `Dashboard._selection` | `workflow-store` field |

These rules keep the UI focused on live activity while letting you pin to a specific phase or
step for inspection.

## Where to go next

- [TUI reference](tui.md) — the terminal view of the same data.
- [Event store & status](event-store.md) — the source of the projection.
- [CLI reference → Worktree runs](cli.md#worktree-runs) — where the observer URL comes from.
