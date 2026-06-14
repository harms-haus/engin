# @harms-haus/engin-web

A Vite + React web client that observes a running engin workflow in real time
over WebSocket. It connects to the engine's [`ObserverServer`](../src/web/observer-server.ts),
receives an initial **snapshot** followed by incremental **event batches**, and
renders a live view of phases, the task lane pool, per-agent logs, and a merged
event feed.

This package ships as the static frontend served by the engine's observer
server (built output goes to `web/dist/`). It can also run standalone against a
dev Vite proxy during development.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
   - [2.1 Zustand + Immer store](#21-zustand--immer-store-workflow-storets)
   - [2.2 Client-side evolve](#22-client-side-evolve-evolve-clientts)
   - [2.3 WebSocket transport](#23-websocket-transport-usewebsocketts)
3. [The Snapshot / Delta Protocol](#3-the-snapshot--delta-protocol)
4. [Components](#4-components)
5. [Dev / Build](#5-dev--build)

---

## 1. Overview

The web client is a single-page React 19 app (Vite 6, TypeScript). Its only
domain concern is **rendering** the projection of a running workflow — it holds
no orchestration or inference logic. All state originates from the engine via
the WebSocket protocol defined in [`src/protocol-types.ts`](src/protocol-types.ts).

```
 Browser (React + Zustand)                  Engine (Bun)
 ┌─────────────────────────┐               ┌──────────────────────────┐
 │  useWebSocket ── ws ────┼───────────────┼── ObserverServer (/ws)   │
 │      │                  │  resync       │      │                    │
 │      ▼ snapshot/events  │ ◀─────────────┤   StatusBridge           │
 │  WorkflowStore (Zustand)│               │      │                    │
 │      │                  │               │   EventStore             │
 │      ▼ selectors         │               │   evolve()  ◀── events   │
 │  React components        │               │                          │
 └─────────────────────────┘               └──────────────────────────┘
```

Data flow on the client:

```
ServerMessage ──▶ useWebSocket.handleServerMessage()
                      │
                      ├─ snapshot          ─▶ store.applySnapshot(state, seq)
                      ├─ events            ─▶ store.applyEvents(events)
                      ├─ workflow_complete ─▶ store.setStatus('complete')
                      └─ workflow_failed   ─▶ store.setFailed(error, phase)

store.applyEvents() folds each EventRecord through evolveClient() (the pure
projection reducer), then writes the resulting WorkflowProjection back into the
normalized store. Components read via memoized selector hooks.
```

---

## 2. Architecture

The client is organized into three layers, each with a single responsibility:

| Layer         | File                                                         | Responsibility                                                 |
| ------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| **Store**     | [`src/store/workflow-store.ts`](src/store/workflow-store.ts) | Normalized projection state + selector hooks (Zustand + Immer) |
| **Reducer**   | [`src/store/evolve-client.ts`](src/store/evolve-client.ts)   | Pure `WorkflowProjection` transition per `EventRecord`         |
| **Transport** | [`src/hooks/useWebSocket.ts`](src/hooks/useWebSocket.ts)     | WebSocket lifecycle + message routing (no domain state)        |

### 2.1 Zustand + Immer store (`workflow-store.ts`)

A single vanilla Zustand store (`useWorkflowStore`) created outside React,
wrapped in the Immer middleware for safe structural updates.

**Normalized state** — agents and tasks are stored in `Record<string, Entity>`
lookup maps keyed by a stable composite key (see [2.2](#22-client-side-evolve-evolve-clientts)).
Scalars track the workflow envelope:

| Field                   | Type                                  | Notes                                            |
| ----------------------- | ------------------------------------- | ------------------------------------------------ |
| `agentsById`            | `Record<string, AgentEntity>`         | Keyed `agentId::taskId` or `agentId`             |
| `tasksById`             | `Record<string, TaskEntity>`          | Keyed by `taskId`                                |
| `currentPhase`          | `string`                              | Active phase id                                  |
| `completedPhases`       | `string[]`                            | Append-only, de-duplicated                       |
| `sidebar`               | `{ title, indicator, phases? }`       | Phase descriptors + status indicator             |
| `status`                | `'running' \| 'complete' \| 'failed'` | Top-level lifecycle                              |
| `taskPrompt`            | `string`                              | Original prompt                                  |
| `error` / `failedPhase` | `string?`                             | Populated on failure                             |
| `seq`                   | `number`                              | Monotonic event sequence cursor (sync watermark) |
| `stats`                 | `{ totalTokens, agentCount }`         | Aggregate counters                               |

**Mutation entry points** (the only setters; everything else is read-only):

| Action          | Signature              | Behavior                                                                                          |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `applySnapshot` | `(snapshot, seq)`      | Full replace of all fields; runs `capAgentLogs` defensively                                       |
| `applyEvents`   | `(events)`             | Reconstructs the projection, folds each event through `evolveClient`, writes back; advances `seq` |
| `setStatus`     | `(status)`             | Sets `status` only                                                                                |
| `setFailed`     | `(error, failedPhase)` | Sets `status='failed'`, `error`, `failedPhase`                                                    |

`applyEvents` internally calls `toProjection(s)` to reshape the store's
denormalized fields (`agentsById`/`tasksById`) back into the
`WorkflowProjection` shape (`agents`/`tasks`) that `evolveClient` operates on,
then spreads the result back into Immer-drafted state.

**Selector hooks** — components never read the store directly; they use
fine-grained selector hooks so a single-entity update re-renders only the
affected component:

| Hook                              | Returns                                                         |
| --------------------------------- | --------------------------------------------------------------- |
| `useAgentIds()`                   | `string[]` (stable via `useShallow`)                            |
| `useAgentById(id)`                | `AgentEntity \| undefined`                                      |
| `useTaskIds()`                    | `string[]` (stable via `useShallow`)                            |
| `useTaskById(id)`                 | `TaskEntity \| undefined`                                       |
| `useCurrentPhase()`               | `string`                                                        |
| `useCompletedPhases()`            | `string[]`                                                      |
| `useSidebar()`                    | sidebar object                                                  |
| `useStatus()`                     | status string                                                   |
| `useError()` / `useFailedPhase()` | error / failed phase                                            |
| `useHasSnapshot()`                | `boolean` — `seq > 0`                                           |
| `useSeq()`                        | `number`                                                        |
| `useRecentLogEntries(limit=100)`  | merged, timestamp-sorted `LogEntry[]` (stable via `useShallow`) |

ID-list and derived-array selectors wrap their selector in `useShallow` so the
returned array reference is stable across renders unless the underlying content
actually changed — this prevents cascading re-renders.

`useRecentLogEntries` flattens every agent's `log` array into one list, sorts
by ISO-8601 timestamp (oldest-first, matching the event log's auto-scroll-bottom
behavior), and caps at `limit` entries.

A non-hook helper is also exported:

```ts
export const getSeq = () => useWorkflowStore.getState().seq;
```

`getSeq()` reads `seq` **without subscribing** — used by the transport to attach
the sync watermark to `resync` messages without triggering re-renders.

#### Adding a selector

```ts
// src/store/workflow-store.ts
export const useActiveAgents = () =>
  useWorkflowStore(
    useShallow((s) =>
      Object.values(s.agentsById)
        .filter((a) => a.active)
        .map((a) => a.uid),
    ),
  );
```

Rules: return a primitive or stable reference for scalar reads; wrap any
derived array/object in `useShallow` to preserve referential stability.

### 2.2 Client-side evolve (`evolve-client.ts`)

`evolveClient(state, event)` is a **pure, immutable** state transition: it takes
a `WorkflowProjection` and an `EventRecord`, and returns a new
`WorkflowProjection`. It handles all 19 `EventType` variants (workflow/phase/
agent/task lifecycle, turns, tool calls, decisions, errors, sidebar updates).

> ⚠️ **Sync hazard.** This module is a hand-maintained **mirror** of the
> engine's [`src/tracking/evolve.ts`](../src/tracking/evolve.ts). The web client
> cannot import the engine package, so the reducer is duplicated. **Any change
> to the engine's `evolve.ts` MUST be mirrored here.** A shared parity fixture
> (below) guards against drift.

**Composite agent key.** Agents are keyed `agentId::taskId`, or just `agentId`
when no task is associated:

```ts
function agentKey(agentId: string, taskId?: string): string {
  return taskId ? `${agentId}::${taskId}` : agentId;
}
```

**Agent resolution.** When only `agentId` is available (e.g. `turn_ended`,
`tool_call_started` callbacks that omit `taskId`), `resolveAgent` performs a
best-effort lookup: exact key match first (fast path), then a scan preferring
the active agent for that `agentId`.

**Re-spawn UPSERT (kb-11).** When `agent_spawned` targets an existing key, the
entity is **updated** (profile, phase, sessionId, `active=true`,
`completedAt=undefined`) while preserving accumulated `log`, `inputTokens`,
`outputTokens`, and `toolCallCount`. `stats.agentCount` is **not** incremented
on re-spawn — only on first spawn. This was a past regression root cause and is
covered by dedicated tests.

**Log cap.** Each agent's `log` is capped at `MAX_AGENT_LOG` (**500** entries)
via `capLog()` on every append. The store additionally applies `capAgentLogs`
on snapshot application as a defensive measure.

**Shared parity fixture — the drift guard.** The JSON file
[`tests/fixtures/evolve-parity.json`](../tests/fixtures/evolve-parity.json) (in
the engine repo) contains an array of scenarios, each with a `name`, an ordered
`events` array, and an `expect` object:

```jsonc
{
  "name": "agent_spawned re-spawn preserves accumulated log/tokens/toolCallCount (kb-11)",
  "events": [
    /* …ordered EventRecord objects… */
  ],
  "expect": {
    "seq": 6,
    "stats": { "agentCount": 1 },
    "agents": {
      "a1::t1": { "toolCallCount": 1, "log": { "length": 3 } },
    },
  },
}
```

This fixture is consumed by **both** test suites:

| Consumer | Test file                                                            | Reads fixture from                           |
| -------- | -------------------------------------------------------------------- | -------------------------------------------- |
| Engine   | [`tests/tracking/evolve.test.ts`](../tests/tracking/evolve.test.ts)  | `../fixtures/evolve-parity.json`             |
| Web      | [`src/store/evolve-client.test.ts`](src/store/evolve-client.test.ts) | `../../../tests/fixtures/evolve-parity.json` |

Each scenario is folded through the respective `evolve` / `evolveClient`
function and the result is checked against `expect` via a recursive **subset
assertion** (`assertSubset`). The `{ "length": N }` sentinel asserts array
length without enumerating every entry. If either implementation drifts, one of
the two suites fails.

**Adding a parity scenario:** append an object to the `events`/`expect` array
in `tests/fixtures/evolve-parity.json`, then run both `bun test` (engine) and
`npm test` (web) to confirm both implementations agree.

### 2.3 WebSocket transport (`useWebSocket.ts`)

A thin React hook that owns the WebSocket connection and routes inbound
messages into the store. It holds **no domain state** — all projection logic
lives in the store and reducer.

```ts
function useWebSocket(): { send; connected; hasConnectedOnce };
```

| Return             | Type                           | Description                                                                                |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `send`             | `(msg: ClientMessage) => void` | JSON-serializes and sends if socket is `OPEN` (silently drops otherwise)                   |
| `connected`        | `boolean`                      | Live connection state                                                                      |
| `hasConnectedOnce` | `boolean`                      | `true` after the first successful open (drives the "Connecting…" vs "Reconnecting…" label) |

**Message routing** (`handleServerMessage`):

| `ServerMessage.type` | Store action                              |
| -------------------- | ----------------------------------------- |
| `snapshot`           | `store.applySnapshot(msg.state, msg.seq)` |
| `events`             | `store.applyEvents(msg.events)`           |
| `workflow_complete`  | `store.setStatus('complete')`             |
| `workflow_failed`    | `store.setFailed(msg.error, msg.phase)`   |

Inbound messages are validated with the `isServerMessage` type guard before
processing; unparseable or unrecognized messages are silently ignored.

**Resync on (re)connect.** In `ws.onopen`, the hook sends a catch-up request
carrying the store's current sequence cursor:

```ts
ws.onopen = () => {
  setConnected(true);
  setHasConnectedOnce(true);
  backoffRef.current = BACKOFF_INITIAL; // reset backoff
  const lastSeq = useWorkflowStore.getState().seq;
  ws.send(JSON.stringify({ type: 'resync', lastSeq } satisfies ClientMessage));
};
```

**Exponential backoff.** On unclean close (not triggered by component unmount),
the hook schedules a reconnect with exponential backoff:

| Parameter     | Value                                  |
| ------------- | -------------------------------------- |
| Initial delay | `1000` ms                              |
| Multiplier    | `1.5×` per attempt                     |
| Max delay     | `30 000` ms                            |
| Reset         | back to initial on successful `onopen` |

Unmount sets a `manualCloseRef` flag, clears any pending reconnect timer, and
closes the socket — guaranteeing no reconnect fires after teardown.

**URL derivation** (`deriveWsUrl`):

1. If `window.__WS_ENDPOINT__` is set and is **not** the literal placeholder
   `'{{WS_ENDPOINT}}'`, use it directly.
2. Otherwise derive from `window.location`: `wss:` if the page is `https:`,
   else `ws:`, followed by `//{host}/ws`.

The placeholder is injected by the engine's observer server at serve time (see
[`observer-server.ts`](../src/web/observer-server.ts) `serveStatic`), which
replaces `{{WS_ENDPOINT}}` in `index.html` with a real `ws://`/`wss://` URL.

---

## 3. The Snapshot / Delta Protocol

Defined in [`src/protocol-types.ts`](src/protocol-types.ts) — a **mirror** of
the engine's [`src/web/protocol-types.ts`](../src/web/protocol-types.ts). Both
copies must stay in sync; the engine file is canonical.

### Server → Client (`ServerMessage`)

```ts
type ServerMessage =
  | { type: 'snapshot'; seq: number; state: WorkflowProjection }
  | { type: 'events'; seq: number; events: EventRecord[] }
  | { type: 'workflow_complete' }
  | { type: 'workflow_failed'; error: string; phase: string };
```

| Message             | When sent                                                                   | Contains                                                  |
| ------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `snapshot`          | On connect, or on full resync when the event ring buffer can't fill the gap | Complete `WorkflowProjection` + `seq`                     |
| `events`            | Coalesced per microtask tick by the engine's `StatusBridge`                 | Batch of raw `EventRecord`s since the client's last `seq` |
| `workflow_complete` | Terminal — broadcast **immediately** on status transition (not coalesced)   | (no payload)                                              |
| `workflow_failed`   | Terminal — broadcast **immediately**                                        | `error`, `phase`                                          |

### Client → Server (`ClientMessage`)

```ts
type ClientMessage = { type: 'terminate_server' } | { type: 'resync'; lastSeq?: number };
```

| Message            | Purpose                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `resync`           | Sent on every (re)connect with `lastSeq` = store's current `seq`; requests catch-up |
| `terminate_server` | Requests graceful workflow termination (two-click confirm in the UI)                |

### `EventRecord`

```ts
interface EventRecord {
  seq: number;
  type: EventType; // 19 variants — see protocol-types.ts
  data: Record<string, unknown>;
  metadata: {
    timestamp: string; // ISO-8601
    agentId?: string;
    taskId?: string;
    phase?: string;
  };
}
```

### Connection lifecycle

```
connect ──▶ onopen ──▶ send { resync, lastSeq }
                         │
   ┌─────────────────────┴──── server response ────────────────────┐
   │                                                                │
   │  events contiguous from lastSeq+1?  ──▶ events batch(es)       │
   │  otherwise (gap / ring-buffer eviction) ──▶ fresh snapshot     │
   │                                                                │
   └──▶ incremental events batches … ──▶ workflow_complete │ workflow_failed
```

The server-side `handleResync` (in
[`status-bridge.ts`](../src/web/status-bridge.ts)) decides: if the first
available event's `seq` equals `lastSeq + 1`, it returns an `events` batch;
otherwise it falls back to a full `snapshot` so the client gets a clean
baseline. This means a client that disconnects long enough for the engine's
ring buffer to evict the intervening events will transparently re-snapshot.

> **Cross-reference:** for the server-side implementation of this protocol
> (snapshot construction, event coalescing, terminal broadcast), see the
> engine's `StatusBridge` in [`src/web/status-bridge.ts`](../src/web/status-bridge.ts)
> and `ObserverServer` in [`src/web/observer-server.ts`](../src/web/observer-server.ts).

---

## 4. Components

All components live in [`src/components/`](src/components) and are composed by
[`App.tsx`](src/App.tsx). Each component **self-subscribes** to the store via
fine-grained selector hooks — they receive **no data props**. This keeps the
component tree decoupled from the store shape and limits re-renders to the
slices each component actually reads.

| Component                                 | Selectors used                                                                                 | Renders                                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`EventLog`](src/components/EventLog.tsx) | `useRecentLogEntries(100)`, `useHasSnapshot`                                                   | Merged, timestamp-sorted feed of all agent log entries (text, thinking, tool calls, decisions, errors); auto-scrolls to bottom unless the user scrolls up |
| [`PhaseBar`](src/components/PhaseBar.tsx) | `useSidebar`, `useCurrentPhase`, `useCompletedPhases`                                          | Horizontal phase tabs with completed/current highlighting from sidebar phase descriptors                                                                  |
| [`LanePool`](src/components/LanePool.tsx) | `useTaskIds`, `useHasSnapshot`, `useTaskById` (per lane), `useWorkflowStore(s => s.tasksById)` | Sorted task lanes by status priority; each `Lane` is `React.memo`'d for re-render isolation                                                               |
| [`AgentLog`](src/components/AgentLog.tsx) | `useAgentIds`, `useAgentById`, `useHasSnapshot`, `useStatus`, `useWebSocket`                   | Selected agent's detail log with token/tool-call stats, prev/next navigation, and a two-click terminate control                                           |

`App.tsx` additionally subscribes to `useStatus`, `useError`, and
`useFailedPhase` to render the connection-status indicator and the
complete/failed status banners.

#### Per-item re-render isolation

`LanePool` demonstrates the memoization pattern: the parent subscribes to the
task-id list (and `tasksById` for sorting), while each `Lane` is a
`React.memo` component that subscribes to its own `useTaskById(taskId)`. A
status change on one task re-renders only that `Lane`, not its siblings.

#### Adding a component / selector

1. Create the component in `src/components/`, importing only the selector
   hooks it needs (no props for store data).
2. Subscribe at the narrowest granularity — prefer `useEntityById(id)` over
   subscribing to the whole map.
3. Wrap any component that renders a list item in `React.memo` if sibling
   isolation matters.
4. Mount it in `App.tsx`.

```tsx
// Example: a component that reads a single task by id
import { useTaskById } from '../store/workflow-store';

const TaskCard = React.memo(function TaskCard({ taskId }: { taskId: string }) {
  const task = useTaskById(taskId);
  if (!task) return null;
  return (
    <div>
      {task.title} — {task.status}
    </div>
  );
});
```

---

## 5. Dev / Build

### Scripts

| Command              | Description                                                          |
| -------------------- | -------------------------------------------------------------------- |
| `npm run dev`        | Start the Vite dev server (with `/ws` → `ws://localhost:3619` proxy) |
| `npm run build`      | Production build to `dist/` (sourcemaps enabled)                     |
| `npm test`           | Run the Vitest suite once (`--passWithNoTests`)                      |
| `npm run test:watch` | Vitest in watch mode                                                 |

### WebSocket endpoint

The dev Vite config proxies `/ws` to the engine's observer server:

```ts
// vite.config.ts
server: {
  host: true,
  proxy: { '/ws': { target: 'ws://localhost:3619', ws: true } },
}
```

In production, the engine's observer server replaces the `{{WS_ENDPOINT}}`
placeholder in `index.html` with the real `ws://` or `wss://` URL (see
[`observer-server.ts`](../src/web/observer-server.ts) `serveStatic` /
`getWsScheme`). The client's `deriveWsUrl()` picks this up from
`window.__WS_ENDPOINT__`.

### Running against a live workflow

1. Start the engine with the web observer enabled (it serves `web/dist/` and
   the `/ws` endpoint).
2. For dev iteration, run `npm run dev` in this directory and start the engine
   separately — the Vite proxy forwards WebSocket traffic to `localhost:3619`.

### Testing

Tests use Vitest with jsdom (`@testing-library/react`). Three suites mirror the
three architecture layers:

| Suite                                                                  | Covers                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`src/store/evolve-client.test.ts`](src/store/evolve-client.test.ts)   | Per-event transitions, re-spawn UPSERT parity (kb-11), log cap, and the **shared parity fixture** |
| [`src/store/workflow-store.test.ts`](src/store/workflow-store.test.ts) | `applySnapshot` / `applyEvents` / `setStatus`, selector hooks, `seq` advancement                  |
| [`src/hooks/useWebSocket.test.ts`](src/hooks/useWebSocket.test.ts)     | URL derivation, connection state, exponential backoff, cleanup, message routing, resync, `send()` |

The shared parity fixture is the critical cross-implementation guard — see
[§2.2](#22-client-side-evolve-evolve-clientts) for how to add scenarios.
