# TUI dashboard

When the CLI detects an interactive terminal (TTY) without `--verbose`, it attaches a
`WorkflowTUI` dashboard to the run instead of plain stdout output. The TUI is a
**WebSocket client**: it renders a `ClientStore` projection that is fed from the
shared `EngineClient` over `ws://127.0.0.1:<port>/ws`, not from an in-process store.

It is built on [Ink](https://github.com/vadimdemedes/ink) (React 19 + Yoga layout)
with overlays from [`@harms-haus/ink-overlay`](https://github.com/harms-haus/ink-overlay)
and scrolling via [`ink-scroll-view`](https://github.com/sindresorhus/ink-scroll-view).
It does **not** expose `StatusCallbacks` — the server wires
`createStoreCallbacks(store)` into the workflow's `onStatus`, and the TUI receives
projection updates via the WS stream.

> **Package:** [`@harms-haus/engin-tui`](../../packages/tui) (private workspace
> package). See the package [README](../../packages/tui/README.md) for the public
> contract, dev-setup constraints (symlink resolution, React singleton, serial tests),
> and the role of the TUI within engin
> ([architecture overview](../concepts/architecture.md)).

---

## `WorkflowTUI` — the CLI contract

Source: `packages/tui/src/workflow-tui.ts`.

`WorkflowTUI` is an imperative shell that manages the lifecycle of the Ink-based
terminal UI. All user-visible state lives in a [`TuiStore`](#tuistore--react-bridge)
(wrapping a `ClientStore`); the Ink/React tree re-renders reactively from that store.

```typescript
class WorkflowTUI {
  constructor(options?: WorkflowTUIOptions);
  start(): void;
  stop(): void;
  getEventLog(): string[];
  getDashboard(): TuiStore | null;
  prepareQrCode(url: string): Promise<void>;
  showQrCode(url: string): Promise<void>;
  pauseForInspection(signal?: AbortSignal): Promise<void>;
  setRunId(runId: string): void;
}
```

| Method                        | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                     | Create a `TuiStore` (which subscribes to the `ClientStore`), render the Ink `App` tree with `incrementalRendering: true`, `exitOnCtrlC: false`, `patchConsole: false`, and set the running flag. No-op if already running or if no `clientStore` was supplied.                                                                                                                                                                                                                                                                                                                                          |
| `stop()`                      | Unmount the Ink tree and dispose the `TuiStore` (unsubscribes from the `ClientStore`). Independent `try`/`catch` blocks ensure an unmount failure does not prevent dispose or null-assignment (subscription-leak safety). Safe to call multiple times — subsequent calls are no-ops.                                                                                                                                                                                                                                                                                                                    |
| `prepareQrCode(url)`          | Pre-generate the QR overlay string (dynamic import of `generateQrString`) and stash it on the store via `setQrString`. The QR is **not** rendered by default — it is revealed on `Ctrl+Q`. **Call before `start()`** so the overlay is ready for the first render. No-op if the TUI has not been started.                                                                                                                                                                                                                                                                                               |
| `showQrCode(url)`             | Prepare the QR string and immediately make it visible (`setQrVisible(true)`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pauseForInspection(signal?)` | Keep the TUI alive and fully navigable after the run completes so you can inspect the final state. Sets an `inspecting` flag and awaits a promise resolved **only** by `Ctrl+C` delivered through the Ink input handler (graceful exit) or the optional `signal` aborting. `Escape` no longer resolves it; reaching a terminal `ClientStore` status no longer auto-resolves it. `Ctrl+D` continues to detach immediately (unchanged). Prints one hint line: `Workflow complete — Ctrl+C to exit · Ctrl+D to detach`. An already-aborted `signal` resolves immediately without entering inspecting mode. |
| `getEventLog()`               | Returns the current event-log lines (a `string[]`), or `[]` if the TUI was never started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `getDashboard()`              | Returns the live `TuiStore` (or `null`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `setRunId(runId)`             | Update the runId (once `run_started` is received) so the detach/kill prompt can display it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### `WorkflowTUIOptions`

```typescript
interface WorkflowTUIOptions {
  agentLogLines?: number; // accepted for backward compatibility, never read
  clientStore?: ClientStore; // the shared projection store the TUI syncs from
  runId?: string; // server run id; updateable later via setRunId()
  onDetach?: () => void; // user chose to detach (leave run on server, exit client)
  onKill?: () => void; // user chose to kill (cancel run, then exit)
  renderFn?: RenderFn; // custom render fn (defaults to Ink's render); for tests
}
```

| Field            | Type                           | Default        | Description                                                                                                                                                                              |
| ---------------- | ------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentLogLines?` | `number`                       | —              | Accepted for backward compatibility but **ignored** — never read. Agent-log row counts are governed by `layout-constants.ts` (`AGENT_LOG_COLLAPSED_LINES` / `AGENT_LOG_EXPANDED_LINES`). |
| `clientStore?`   | `ClientStore`                  | —              | The shared projection store the widgets sync from (fed by the `EngineClient`). If omitted, `start()` is a no-op.                                                                         |
| `runId?`         | `string`                       | —              | Server run identifier, shown in the detach/kill prompt. Updateable later via `setRunId`.                                                                                                 |
| `onDetach?`      | `() => void`                   | —              | Called when the user chooses to detach (leave run running, exit the client).                                                                                                             |
| `onKill?`        | `() => void`                   | —              | Called when the user chooses to kill (send `cancel_run`, then exit once terminal).                                                                                                       |
| `renderFn?`      | `(node, options?) => Instance` | Ink's `render` | Custom render function (intended for tests that want to avoid spinning up a real terminal).                                                                                              |

### Typical CLI lifecycle call order

```
new WorkflowTUI({ clientStore, onDetach, onKill })
  → prepareQrCode(serverUrl)        // optional, before start
  → start()
  → setRunId(runId)                 // when run_started arrives
  → showQrCode(serverUrl)           // optional, immediate QR
  → pauseForInspection(signal)      // after run completes
  → stop()                          // on final exit
```

### Console interception (removed)

The TUI no longer monkey-patches `console.warn`/`console.error` — it is a client in
a separate process from the server, where the workflow actually runs. Runtime
warnings/errors are captured **server-side** and delivered as `log` events (see
[Event store & status → The `log` event type](event-store.md#the-log-event-type)).
The `TuiStore` drains them from the `ClientStore`'s `runLog` into the `EventLog`
with the existing ⚠️/❌ prefixes.

---

## Architecture & data flow

```
EngineClient (WebSocket: ws://127.0.0.1:<port>/ws)
  │  applyEvents / snapshot / resync
  ▼
ClientStore (shared projection, @harms-haus/engin-shared)
  │  clientStore.subscribe(notify)  — fires on every mutation
  ▼
TuiStore ── useSyncExternalStore bridge ──► Ink/React tree
  │  • drains workflowEventLog + runLog → eventLogLines (FIFO cap 10 000)
  │  • owns isLogExpanded-aware session-follow
  │  • holds UI-only state: expand/collapse, QR overlay, detach/kill
  │    prompt, inspecting flag
  ▼
Ink render(App, { incrementalRendering, exitOnCtrlC:false, patchConsole:false })
```

The `TuiStore` subscribes to the `ClientStore` in its constructor and is the single
bridge between the WS-driven projection and the React tree. React components read
the store via the [`useTuiStore`](#usetuistore-hook) hook, which wraps
`useSyncExternalStore`. A `_version` counter on the store increments on every
`_notify()`; Ink's incremental renderer then re-renders only the changed subtrees.

---

## Component tree

Source: `packages/tui/src/app.tsx`.

```
App (root, wrapped in <OverlayHost>)
├── EventLog               (scrollable workflow-level event log)
├── separator              (dim horizontal line of ─ chars)
├── Dashboard              (bordered Box)
│     ├── PhaseBar
│     ├── separator
│     ├── TaskList
│     ├── separator
│     └── AgentLog         (header + scrollable entries + SessionTabBar)
├── DetachKillPrompt       (overlay, centered Layer)
├── QrOverlay              (overlay, top-right Layer)
└── WorkflowInput          (renders nothing — two useInput hooks)
```

### `App`

The root Ink component. Subscribes to the `TuiStore` via `useTuiStore`, reads the
terminal dimensions (`useWindowSize`), and estimates the dashboard height so the
`EventLog` can fill the remaining rows:

```
dashboardHeight = 1 (phase bar)
                + 1 (separator)
                + min(TASK_LIST_MAX_VISIBLE, phaseTaskCount)
                + 1 (separator)
                + (expanded ? AGENT_LOG_EXPANDED_LINES : AGENT_LOG_COLLAPSED_LINES)
                + 2 (border top + bottom)

eventLogMaxLines = max(3, rows − dashboardHeight − 1)
```

`App` wraps everything in `<OverlayHost>` (from `@harms-haus/ink-overlay`) so the
overlays and the `WorkflowInput` component can use `useInputCaptureState` for
overlay-aware input gating. It renders the two overlays (`DetachKillPrompt`,
`QrOverlay`) and the invisible `WorkflowInput` component.

### `WorkflowInput` (internal)

A renderless component inside `<OverlayHost>` that registers **two** `useInput`
hooks (see [Input dispatch](#input-dispatch) below).

### `Dashboard`

Source: `packages/tui/src/components/dashboard.tsx`. A purely presentational
component that reads the `TuiStore` and composes `PhaseBar` + `TaskList` +
`AgentLog` inside a single-bordered `Box`. It filters tasks and sessions by the
**effective phase** (`selectedPhaseId ?? currentPhaseId`) and computes per-task
session counts (also phase-filtered). Input is **not** handled here — all keyboard
navigation is dispatched by `WorkflowInput` through store methods.

---

## Widgets

### `EventLog`

Source: `packages/tui/src/components/event-log.tsx`.

Scrollable log of timestamped event lines. Props: `{ lines: string[];
maxLines: number }`.

- The viewport is anchored on a **logical line index** (`topLineIndex`), not a pixel
  offset. When `autoScroll` is true, `topLineIndex` tracks the tail; when false, it
  stays stable across line-array growth (the pinned view does not drift as new lines
  arrive — constraint C2).
- When scrolled up, the first visible line is a dim indicator:
  `↑ <N> more lines below (PgUp/PgDn)`.
- Input (gated by `useInputCaptureState`): `PgUp`/`PgDn` (page = `maxLines − 1`),
  `Home` (jump to oldest), `End` (jump to newest, re-enables auto-scroll).
- Completion summary. When the run completes, the `ClientStore` appends a two-line
  aggregate summary (computed by `formatWorkflowSummary`) to `workflowEventLog`
  immediately after the per-event `workflow_completed` line:
  `📊 Tokens: ↑<in> in · ↓<out> out` and
  `⏱ Time: <total>s total · <session>s session (<pct>%)`. Both summary entries share the
  `workflow_completed` event's `seq` so they drain from the log together. Emitted
  only when `totalDurationMs` is a positive number.

### `PhaseBar`

Source: `packages/tui/src/components/phase-bar.tsx`. Single-line phase progress
indicator. Props: `{ phases, currentPhaseId, completedPhaseIds, selectedPhaseId,
indicator? }`.

Markers: `✓` (completed, green), `●` (running, cyan + bold), `·` (pending, dim).
The selected phase is underlined; the running phase is bold. Segments joined with
`│` (dim). When there are no phases, a fallback line shows the `indicator` and
`currentPhaseId`.

### `TaskList`

Source: `packages/tui/src/components/task-list.tsx`. Table of tasks in the current
phase, one row per task, listed in creation/registration order (the order tasks
arrive). Tasks are **not** sorted or grouped by status. Props: `{ tasks:
TaskEntity[], selectedTaskId, sessionCounts }`.

Each row is a fixed set of columns separated by 2-space gaps; every cell is padded
to the width of the widest cell in its column:

1. **Icon** — `statusIconMap[status]`.
2. **ID** — a compact cross-referenceable label (e.g. `t-01`) assigned in
   creation/registration order, dimmed. (The raw task id is not shown.)
3. **Title** — `statusColorMap[status]` colour, followed by a dash and the elapsed
   time (dimmed) for `active`/`parked`/`complete`/`failed`/`cancelled` tasks that
   have a `startedAt`. Elapsed is frozen at `completedAt` when present, otherwise it
   is wall-clock (updated every second by an isolated `<TaskElapsed>` sub-component
   so the parent `TaskList` does not re-render on each tick).
4. **Step/session** — shown only for `active`/`parked` tasks. If the task has a
   `sessionPlan`, renders `●<done>/<total>`; otherwise renders `<N> session(s)` when
   the count is non-zero.
5. **Dependencies** — the dependency labels joined with comma-space, using the same
   `t-01` labels as the ID column. Completed dependencies are dimmed; incomplete or
   unknown dependencies are plain. A dependency id not present in the current task
   set (e.g. a cross-phase dep) falls back to its raw id. There is no `deps:` prefix.

The step and dependencies columns are omitted entirely when no visible task uses
them, so there are no trailing gaps. The selected task's entire row is rendered in
**bold**.

#### Viewport (20-line cap)

When a phase contains more than `TASK_LIST_MAX_VISIBLE` (20) tasks, only 20 lines
are rendered. A dim indicator is shown above the window when scrolled down
(`↑ <N> more above (↑/↓)`) and/or below it when more tasks remain (`↓ <N> more below (↑/↓)`).
The viewport:

- **resets to the top** when the set of task ids changes (e.g. a phase switch);
- **auto-scrolls** to maximise visible `active`/`parked` tasks when a task
  transitions into one of those statuses (difference-array algorithm);
- **edge-scrolls** so the selected task stays visible when the user moves the
  selection with ↑/↓.

`getViewportTaskCount` returns the number of tasks that **fit** in the viewport
given `scrollOffset` and indicator slots (`Math.min(slots, remaining)`), not the
total. `App` does **not** call it — `App` computes its own `phaseTaskCount`
(via a `count++` loop over the current phase's tasks) and applies
`Math.min(TASK_LIST_MAX_VISIBLE, phaseTaskCount)` for layout.

### `AgentLog`

Source: `packages/tui/src/components/agent-log.tsx`. Detail view for the agent
fulfilling the selected session of the selected task. Props: `{ sessions,
selectedSessionId, expanded, collapsedLines, expandedLines }`.

- **Header** (`AgentLogHeader`) — shows the task title / profile, tool-call count,
  and input/output token totals (formatted compactly via `formatTokenCount`, e.g.
  `↑4k • ↓1.2k`). When the selected agent has a `contextWindow`, a
  cumulative-consumption multiple is appended: `• ctx N×` where
  `N = round(((inputTokens + outputTokens) / contextWindow) * 100) / 100` (the ratio
  of cumulative in+out tokens to the per-request model context window, rounded to 2
  decimals). This is a multiplicative ratio, **not** a bounded fill percentage — it
  can exceed 1× because token totals accumulate across turns while `contextWindow`
  is a per-request cap. The right side shows a controls hint
  (`Tab session space expand` when collapsed; `↑↓scroll x10⇧↑↓ space collapse` when
  expanded).
- **Entries** — rendered inside a `<ControlledScrollView>` from `ink-scroll-view`.
  Entry lines are built from the session's `log` array (memoised on
  `uid + log.length + lastEntry.id` for performance — the log is append-only).
  `tool_call_end` entries are hidden (the `tool_call_start` line already shows the
  formatted call). Multi-line entries are split on `\n`. Scroll offset convention:
  `0` = at bottom (newest), positive = scrolled up. When expanded and scrolled up,
  a dim `↓ <N> more lines below (↑/↓ scroll)` indicator takes one slot.
- **Session tab bar** (`SessionTabBar`) — one tab per session, shown at the bottom.
  Each tab shows the session's `runnerRole` (e.g. `write-tests`, `execute`, `review`)
  or falls back to the profile name. The selected session is bold + underlined. When
  the bar overflows the terminal width, a contiguous window centred on the selected
  session is shown with dimmed `…+N` / `+N…` indicators.

Entry type → icon / colour:

| Type                            | Icon | `<Text color>` | `dimColor` |
| ------------------------------- | ---- | -------------- | ---------- |
| `text`                          | 💬   | —              | —          |
| `thinking`                      | 🧠   | —              | ✓          |
| `tool_call` / `tool_call_start` | 🔧   | `cyan`         | —          |
| `tool_call_end`                 | ✅   | `green`        | — (hidden) |
| `error`                         | ⚠️   | `red`          | —          |
| `decision`                      | 🤝   | —              | —          |
| `render`                        | 📋   | —              | —          |

---

## Input dispatch

Input is handled by a two-`useInput`-handler pattern in the internal `WorkflowInput`
component (rendered inside `<OverlayHost>`), plus per-component `useInput` hooks in
`EventLog` and `AgentLog`. There is **no** `useFocus`-based focus navigation — `Tab`
cycles sessions, not focus.

| Handler | `isActive`      | Keys & behaviour                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1**   | `true` (always) | **`Ctrl+D`** → `store.invokeDetach()`. Works even when an overlay captures input (so detach is always reachable).                                                                                                                                                                                                                                                                                |
| **2**   | `!isCaptured`   | **`Ctrl+C`** → if `store.inspecting`, call `store.resolvePause()` (graceful exit); else `store.showPrompt()`. **`Ctrl+Q`** → `store.toggleQr()`. **`←`/`→`** → phase navigation (wraps). **`↑`/`↓`** → task navigation **when collapsed** (wraps; AgentLog handles its own scroll when expanded). **`Tab`/`Shift+Tab`** → cycle sessions forward/backward. **`Space`** → toggle expand/collapse. |

Per-component `useInput` hooks (all gated by `useInputCaptureState` so overlays take
precedence):

| Component  | `isActive`                | Keys                                                                            |
| ---------- | ------------------------- | ------------------------------------------------------------------------------- |
| `EventLog` | `!isCaptured`             | `PgUp`/`PgDn` (page scroll), `Home` (top), `End` (bottom, resumes auto-scroll). |
| `AgentLog` | `!isCaptured && expanded` | `↑`/`↓` (scroll 1 line), `Shift+↑`/`Shift+↓` (scroll 10 lines).                 |

### Disconnect semantics

| Input                            | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+C`                         | Show the **detach/kill prompt** overlay (showing the `runId`). **Detach** (default) leaves the run running on the server and exits the client; **Kill** sends `cancel_run { runId }` and stays attached until terminal state is observed. Exception: after the run completes and `pauseForInspection()` is active (inspecting mode), Ctrl+C instead resolves the pause for a graceful exit — the detach/kill prompt is not shown. |
| `Ctrl+D`                         | **Detach immediately** (no prompt).                                                                                                                                                                                                                                                                                                                                                                                               |
| Esc / 2nd Ctrl+C (at the prompt) | Dismiss the prompt; the run is unaffected and the client stays attached.                                                                                                                                                                                                                                                                                                                                                          |

Disconnect/reconnect is handled **transparently** by the `EngineClient` at
the transport layer (silent reconnect + `resync { runId, lastSeq }`). There is
**no** TUI-level reconnect banner — the TUI simply keeps the last `ClientStore`
projection visible until new events resume. See [CLI reference → Disconnect semantics](cli.md#disconnect-semantics-tty).

### Keyboard shortcuts (summary)

| Key                   | Action                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+C`              | Show the detach/kill prompt (↑/↓ select · Enter confirm · Esc cancel). After the run completes (inspecting mode), Ctrl+C gracefully exits instead. |
| `Ctrl+D`              | Detach immediately.                                                                                                                                |
| `Ctrl+Q`              | Toggle the QR code overlay.                                                                                                                        |
| `←` / `→`             | Select phase (cycle through registered phases, wraps).                                                                                             |
| `↑` / `↓`             | Select task and edge-scroll the task list into view (when the agent log is collapsed) or scroll the agent log (when expanded).                     |
| `Tab` / `Shift+Tab`   | Cycle sessions within the selected task (forward/backward). **Not** focus navigation.                                                              |
| `Space`               | Expand/collapse the agent log widget.                                                                                                              |
| `Shift+↑` / `Shift+↓` | Scroll the agent log by 10 lines (expanded only).                                                                                                  |
| `PgUp` / `PgDn`       | Scroll the event log up / down.                                                                                                                    |
| `Home` / `End`        | Jump to top / bottom of the event log (resumes auto-scroll).                                                                                       |

> In TUI mode the process-level SIGINT handler is suppressed; Ink's raw-mode input
> listener handles Ctrl+C. In non-TTY (stdout renderer) mode the SIGINT handler
> runs instead (first Ctrl+C → `cancel_run`, second → force-quit). They are never
> simultaneously active.

---

## Follow rules

The `TuiStore` owns the **session-follow** logic (see below). Phase-follow and
task-follow are driven by the `ClientStore`'s built-in `reconcileSelection`, which
the `TuiStore` observes and overrides for session selection.

- **Phase follow** — if `selectedPhaseId` is set, not completed, and differs from
  `currentPhaseId`, the `ClientStore` advances to `currentPhaseId` and resets
  task/session selection. If `selectedPhaseId` is `null`, it is set to
  `currentPhaseId`. If it is completed, it is left as-is (reviewing history).
- **Task follow** — if `selectedTaskId` is `null` or no longer in the selected
  phase's tasks, the `ClientStore` auto-selects the first `active` task (or the first
  task) and resets session selection. When a selected task completes and a new task
  becomes active, selection advances.
- **Session follow** (owned by `TuiStore._applySessionFollow`) — when
  `selectedTaskId` is set, `!userPinnedSession`, **and** `!isLogExpanded`, filter
  sessions by **both** `taskId === selectedTaskId` **and** `phaseId ===
effectivePhaseId`, pick the most-recently-started (greatest `startedAt`), and set
  `selectedSessionId`. When no match, set `null`.

  > **Why `TuiStore` owns this:** `ClientStore.selectPhase` / `selectTask` /
  > `applyEvents` all call `reconcileSelection(state)` **without** an `isLogExpanded`
  > parameter, so session-follow would always run — even when the agent log is
  > expanded, resetting the user's browsing context. `TuiStore` re-applies
  > session-follow with the correct `isLogExpanded` gate after every `ClientStore`
  > mutation, overriding the unconditional result. It also adds a `phaseId` filter
  > (the shared helper filters by `taskId` only) so sessions from other phases are
  > never auto-selected when reviewing a specific phase.

---

## `TuiStore` — React bridge

Source: `packages/tui/src/tui-store.ts`.

`TuiStore` wraps a `ClientStore`, holds all UI-only state, and exposes a
`useSyncExternalStore`-compatible interface (`subscribe` / `getVersion`). On every
`ClientStore` notification (and once at construction) it runs `_processStoreUpdate`:

1. **Drain `workflowEventLog`** — scan from the end to find the first entry whose
   `seq` exceeds the watermark (`_lastSeq`), then append only that contiguous tail's
   `line` strings to `_eventLogLines` (O(new) instead of O(all)).
2. **Drain `runLog`** — `warn` → `"⚠️ " + message`, `error` → `"❌ " + message`;
   `info` is silent. The cursor resets to 0 if the `ClientStore` trimmed the array
   (caps at 200) to avoid losing entries.
3. **Cap** `_eventLogLines` at `MAX_EVENT_LOG_LINES` (10 000), FIFO.
4. **Session-follow** — when `isLogExpanded`, pin the current selection; otherwise
   run `_applySessionFollow` (see [Follow rules](#follow-rules)).
5. **Notify** React subscribers — but only when something observable changed (a
   `dirty` flag avoids driving full React-tree re-renders at WebSocket frequency when
   no event-log lines were added and session-follow found no change).

### UI-only state held by `TuiStore`

| State                      | Description                                                         |
| -------------------------- | ------------------------------------------------------------------- |
| `_eventLogLines`           | Pre-formatted event + run-log lines (FIFO cap 10 000).              |
| `_isLogExpanded`           | Whether the agent log is expanded.                                  |
| `_qrString` / `_qrVisible` | QR overlay content and visibility.                                  |
| `_promptVisible`           | Detach/kill prompt visibility.                                      |
| `_inspecting`              | Pause-for-inspection flag.                                          |
| `_runId`                   | Run id for the detach/kill prompt.                                  |
| `_resolvePause`            | Resolver for the `pauseForInspection` promise.                      |
| `_sessionPinnedByUser`     | Tracks explicit Tab-pinning (vs. implicit pin from `toggleExpand`). |

### User-action methods

`selectPhase(id)`, `selectTask(id)`, `selectNextSession(direction)`,
`toggleExpand()`, `toggleQr()`, `setQrString(str)`, `setQrVisible(visible)`,
`showPrompt()`, `dismissPrompt()`, `invokeDetach()`, `invokeKill()`,
`addEventLogLine(line)`, `setRunId(id)`, `dispose()`.

When `isLogExpanded` is true, `selectPhase` / `selectTask` save the previous
`selectedSessionId` before delegating to the `ClientStore` and restore it afterwards
(pinning it so future `reconcileSelection` calls won't override the user's expanded
browsing context).

### `useTuiStore` hook

Source: `packages/tui/src/hooks/use-tui-store.ts`. Subscribes a React component to a
`TuiStore` via `useSyncExternalStore` and returns the store instance. The component
re-renders whenever the store's version counter increments (i.e. after every
`_notify()`).

```tsx
const store = useTuiStore(tuiStore);
const { eventLogLines, isLogExpanded } = store;
```

---

## Overlays

Both overlays use `<Layer>` from `@harms-haus/ink-overlay`.

### `DetachKillPrompt`

Source: `packages/tui/src/components/detach-kill-prompt.tsx`. A centered, bordered
dialog with two options — **Detach** (default, highlighted) and **Kill** — showing
the run's `runId`. Each option shows a description line — Detach: "Leave run running,
exit client"; Kill: "Cancel run, then exit".

Built on a **bare `<Layer>`** (not `<Modal>`): Modal's default `role='dialog'`
auto-dismisses on any non-Escape/non-Tab input, which would break arrow-key
navigation of the two-option menu. The `<Layer>` uses `anchor="center"`, `capture`,
`backdrop="dim"`, `z={100}`.

Props: `{ open, runId?, onConfirm: (action) => void, onDismiss: () => void }`.
Selection resets to Detach whenever the prompt re-opens (destructive-action safety).
Input: ↑/↓ or ←/→ to navigate (wraps); Enter to confirm; Escape or Ctrl+C to
dismiss.

### `QrOverlay`

Source: `packages/tui/src/components/qr-overlay.tsx`. Renders a QR code in a
non-capturing top-right overlay (`anchor="top-right"`, `capture={false}`,
`backdrop="none"`, `margin={{ top: 1, right: 1 }}`) so the underlying dashboard
remains interactive. Props: `{ open, qrString }`.

`generateQrString(url): Promise<string>` — async helper that uses
`qrcode.toString(url, { type: 'terminal', small: true })` to produce the QR matrix
as ANSI block characters, then appends an OSC-8 clickable hyperlink line containing
the URL. Called by `WorkflowTUI.prepareQrCode` / `showQrCode`.

---

## Theme

Source: `packages/tui/src/theme.tsx`. The theme is **declarative** — it exports
lookup maps that feed Ink `<Text>` props (`color`, `bold`, `dimColor`), not ANSI
escape-sequence strings.

**Status helpers:**

| Status      | `statusColorMap`  | `statusIconMap` |
| ----------- | ----------------- | --------------- |
| `active`    | `yellow`          | `▶`             |
| `complete`  | `green`           | `✓`             |
| `failed`    | `red`             | `✗`             |
| `cancelled` | `undefined` (dim) | `⊘`             |
| `ready`     | `cyan`            | `○`             |
| `blocked`   | `#af5f5f`         | `·`             |
| `parked`    | `magenta`         | `⏸`             |

A `statusColor` value of `undefined` means the component should use Ink's `dimColor`
prop instead of a specific colour (e.g. for `cancelled`).

**Exports:** `statusColorMap`, `statusIconMap`, `statusColor(status)`,
`statusIcon(status)`.

---

## Layout constants

Source: `packages/tui/src/layout-constants.ts`. Central reference for how many
terminal rows each panel reserves. Used by `App` (height estimation) and `TaskList`
(viewport cap).

| Constant                    | Value | Description                                          |
| --------------------------- | ----- | ---------------------------------------------------- |
| `TASK_LIST_MAX_VISIBLE`     | `20`  | Maximum task rows visible in the task-list viewport. |
| `AGENT_LOG_COLLAPSED_LINES` | `20`  | AgentLog row count when collapsed (default).         |
| `AGENT_LOG_EXPANDED_LINES`  | `40`  | AgentLog row count when expanded.                    |

---

## Formatting helpers

### `formatToolCall(toolName, args)`

Source: `packages/shared/src/format-tool-call.ts` (exported by `@engin/shared`).
Plain-text, per-tool formatting with icons:

| Tool                    | Format                                                             |
| ----------------------- | ------------------------------------------------------------------ |
| `read`                  | `📖 read → <path>` (with `:offset`/`:offset+limit`)                |
| `write`                 | `📝 write → <path> +<lineCount>`                                   |
| `edit`                  | `✏️ edit → <path> (<N> edits)`                                     |
| `bash`                  | `💻 bash → <cmd>` (truncated 60)                                   |
| `grep`                  | `🔍 grep → <pattern>` (`→ <path>` when a path/glob arg is present) |
| `find`                  | `🔍 find → <pattern> in <path>`                                    |
| `ls`                    | `📂 ls → <path>`                                                   |
| `delegate_to_subagents` | `🤝 delegate → <N> tasks [<names>]`                                |
| `fetch_content`         | `🌐 fetch → <url>`                                                 |
| `web_search`            | `🔍 search → "<query>"`                                            |
| `workflow_step`         | `▶️ workflow → <action>`                                           |
| `ask_user_question`     | `❓ ask → <N> questions`                                           |
| process tools           | `⚙️ <toolName>`                                                    |
| default                 | `🔧 <toolName>` (+ `→ <args truncated 50>` if args)                |

Commands are truncated to 60 chars, arg blobs to 50.

### `formatWorkflowEventLine(ev)`

Source: `packages/shared/src/format-workflow-event.ts`. Maps an `EventRecord` to a
human-readable emoji line for the event log. Returns `null` for silent types
(`decision`, `turn_started`, `turn_ended`, `tool_call_started`, `tool_call_ended`, `log`).

### `formatTokenCount(n)`

Source: `packages/shared/src/format-token-count.ts` (exported by `@engin/shared`).
Formats an integer token count into a compact human-readable string:

| Input range    | Output                                  | Example                        |
| -------------- | --------------------------------------- | ------------------------------ |
| n <= 0         | `'0'`                                   | 0 → `'0'`                      |
| n < 1000       | plain integer                           | 56 → `'56'`                    |
| 1000 <= n < 1M | `Nk` (1 decimal, trailing `.0` trimmed) | 4000 → `'4k'`, 2500 → `'2.5k'` |
| n >= 1_000_000 | `Nm` (1 decimal, trailing `.0` trimmed) | 1_500_000 → `'1.5m'`           |

### `formatWorkflowSummary(sessions, totalDurationMs)`

Source: `packages/shared/src/format-workflow-summary.ts` (exported by `@engin/shared`).
Pure function that computes a two-line aggregate summary shown in the TUI event log
when a workflow completes:

- Line 1 — `📊 Tokens: ↑<in> in · ↓<out> out` where `<in>`/`<out>` are
  `formatTokenCount` of the summed `inputTokens`/`outputTokens` across every session.
- Line 2 — `⏱ Time: <total>s total · <session>s session (<pct>%)` where `<total>` is
  `totalDurationMs/1000`, `<session>` is the summed active time of sessions that have
  **both** `startedAt` and `completedAt`, and `<pct>` is
  `round(sessionTimeMs / totalDurationMs * 100)` (can exceed 100% due to parallel
  sessions).

Returns `[]` when `totalDurationMs` is not a positive number. Token counts are
routed through `formatTokenCount`.

---

## Internal exports

`packages/tui/src/index.ts` re-exports the public surface plus the component, theme,
and store modules for internal consumers:

```typescript
export * from './components/index.js'; // AgentLog, Dashboard, DetachKillPrompt, EventLog, PhaseBar, QrOverlay, TaskList, …
export * from './theme.js'; // statusColorMap, statusIconMap, statusColor, statusIcon
export { WorkflowTUI, type WorkflowTUIOptions } from './workflow-tui.js';
export { createWsBackedTui } from './ws-backed-tui.js';
export { TuiStore } from './tui-store.js';
```

Only `WorkflowTUI` and `WorkflowTUIOptions` are the stable consumer contract; the
rest is internal and may change without notice.

### `createWsBackedTui(deps)`

Source: `packages/tui/src/ws-backed-tui.ts`. A thin backward-compatibility wrapper
that returns `{ dispose }` for callers that already have a `TuiStore`. Since
`TuiStore` subscribes to the `ClientStore` in its constructor, this wrapper simply
forwards `dispose()` to `tuiStore.dispose()`.

```typescript
function createWsBackedTui(deps: { clientStore: ClientStore; tuiStore: TuiStore }): { dispose: () => void };
```

---

## Where to go next

- [CLI reference](cli.md) — how the TUI is attached and the detach/kill semantics.
- [Web client](web.md) — the same projection, rendered in a browser.
- [Event store & status](event-store.md) — the substrate the store is fed from.
- [`@harms-haus/engin-tui` README](../../packages/tui/README.md) — public contract and dev-setup constraints.
- [Architecture overview](../concepts/architecture.md) — the TUI package's role within engin.
