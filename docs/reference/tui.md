# TUI dashboard

When the CLI detects an interactive terminal (TTY) without `--verbose`, it attaches a
`WorkflowTUI` dashboard to the run instead of plain stdout output. The TUI is a
**WebSocket client**: it renders a `ClientStore` projection that is fed from the
shared `EngineClient` over `ws://127.0.0.1:<port>/ws`, not from an in-process store.

It is built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui).
It does **not** expose `StatusCallbacks` — the server wires
`createStoreCallbacks(store)` into the workflow's `onStatus`, and the TUI receives
projection updates via the WS stream.

## `WorkflowTUI`

Source: `packages/tui/src/workflow-tui.ts`.

```typescript
class WorkflowTUI {
  constructor(options?: WorkflowTUIOptions);
  start(): void;
  stop(): void;
  getEventLog(): EventLog;
  getDashboard(): Dashboard;
  prepareQrCode(url: string): Promise<void>;
  showQrCode(url: string): Promise<void>;
  pauseForInspection(signal?: AbortSignal): Promise<void>;
  setRunId(runId: string): void;
}
```

| Method                        | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                     | Create a `ProcessTerminal`, build the widget tree (EventLog → separator → Dashboard), fit the event log to the terminal height, focus the event log, wire the input listener (including the detach/kill prompt), and start rendering. No-op if already running.                                                                                                                                                                                                                                                   |
| `stop()`                      | Unsubscribe the store bridge + input listener, hide any QR / detach-kill overlays, and stop the TUI. Safe to call multiple times.                                                                                                                                                                                                                                                                                                                                                                                 |
| `prepareQrCode(url)`          | Pre-generate the QR overlay. **Call before `start()`** so the overlay attaches during the first (scrollback-safe) render.                                                                                                                                                                                                                                                                                                                                                                                         |
| `showQrCode(url)`             | Generate (if needed) and display the QR overlay for the server's web URL.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pauseForInspection(signal?)` | Keep the TUI alive and fully navigable after the run completes so you can inspect the final state. Sets an inspecting flag and awaits a promise resolved ONLY by Ctrl+C delivered through the main input listener (graceful exit) or the optional signal aborting. Escape no longer resolves it, and reaching a terminal `ClientStore` status no longer auto-resolves it. Ctrl+D continues to detach immediately (unchanged). Prints a single hint line: `Workflow complete — Ctrl+C to exit · Ctrl+D to detach`. |
| `setRunId(runId)`             | Update the runId (once `run_started` is received) so the detach/kill prompt can display it.                                                                                                                                                                                                                                                                                                                                                                                                                       |

### `WorkflowTUIOptions`

| Field            | Type          | Default | Description                                                                             |
| ---------------- | ------------- | ------- | --------------------------------------------------------------------------------------- |
| `agentLogLines?` | `number`      | `20`    | Collapsed height of the agent detail log (expanded shows 40).                           |
| `clientStore?`   | `ClientStore` | —       | The shared plain-TS projection store the widgets sync from (fed by the `EngineClient`). |
| `runId?`         | `string`      | —       | Server run identifier, shown in the detach/kill prompt. Set later via `setRunId`.       |
| `onDetach?`      | `() => void`  | —       | Called when the user chooses to detach (leave run on the server, exit the client).      |
| `onKill?`        | `() => void`  | —       | Called when the user chooses to kill (send `cancel_run`, then exit once terminal).      |

### Console interception (removed)

The TUI no longer monkey-patches `console.warn`/`console.error` — it is a client in
a separate process from the server, where the workflow actually runs. Runtime
warnings/errors are captured **server-side** and delivered as `log` events (see
[Event store & status → The `log` event type](event-store.md#the-log-event-type)).
The TUI renders them into the `EventLog` with the existing ⚠️/❌ prefixes.

### Disconnect semantics

| Input                            | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+C`                         | Show the **detach/kill prompt** overlay (showing the `runId`). **Detach** (default) leaves the run running on the server and exits the client; **Kill** sends `cancel_run { runId }` and stays attached until terminal state is observed. Exception: after the run completes and `pauseForInspection()` is active (inspecting mode), Ctrl+C instead resolves the pause for a graceful exit — the detach/kill prompt is not shown. |
| `Ctrl+D`                         | **Detach immediately** (no prompt).                                                                                                                                                                                                                                                                                                                                                                                               |
| Esc / 2nd Ctrl+C (at the prompt) | Dismiss the prompt; the run is unaffected and the client stays attached.                                                                                                                                                                                                                                                                                                                                                          |

On a transient `EngineClient` disconnect, the TUI shows a "reconnecting…" banner and
keeps the last projection visible; on reconnect it sends
`resync { runId, lastSeq }`. See [CLI reference → Disconnect semantics](cli.md#disconnect-semantics-tty).

### Keyboard shortcuts

| Key                   | Action                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+C`              | Show the detach/kill prompt (↑/↓ select · Enter confirm · Esc cancel). After the run completes (inspecting mode), Ctrl+C gracefully exits instead. |
| `Ctrl+D`              | Detach immediately.                                                                                                                                |
| `←` / `→`             | Select phase (cycle through registered phases).                                                                                                    |
| `↑` / `↓`             | Select task and edge-scroll the task list into view (when the agent log is collapsed) or scroll the agent log (when expanded).                     |
| `Tab` / `Shift+Tab`   | Cycle sessions within the selected task (forward/backward).                                                                                        |
| `Space`               | Expand/collapse the agent log widget.                                                                                                              |
| `Shift+↑` / `Shift+↓` | Scroll the agent log by 10 lines (expanded only).                                                                                                  |
| `PgUp` / `PgDn`       | Scroll the event log up / down.                                                                                                                    |
| `Home` / `End`        | Jump to top / bottom of the event log (resumes auto-scroll).                                                                                       |

> In TUI mode the process-level SIGINT handler is suppressed; the raw-mode input
> listener handles Ctrl+C. In non-TTY (stdout renderer) mode the SIGINT handler
> runs instead (first Ctrl+C → `cancel_run`, second → force-quit). They are never
> simultaneously active.

## Widget tree

```
WorkflowTUI
├── EventLog               (scrollable workflow-level event log)
├── separator              (dim horizontal line)
└── Dashboard
    ├── PhaseBar           (phase progress indicator)
    ├── TaskListWidget     (tasks in the selected phase)
    └── AgentLogWidget     (log for the selected session's agent, with session tab bar)
```

All widgets implement the `Component` interface from `@earendil-works/pi-tui`:
`render(width): string[]`, `invalidate(): void`, `handleInput(data): void`.

## `createWsBackedTui(deps)`

Source: `packages/tui/src/ws-backed-tui.ts` (replaces the former
`createStoreBackedTui`). Subscribes the TUI widgets to a **`ClientStore`** (the
shared plain-TS projection store), not an `EventStore`.

On each store notification:

1. Read new entries from `workflowEventLog` and write them into the `EventLog`
   (lines are pre-formatted by `formatWorkflowEventLine`).
2. Push the new projection into the `Dashboard` (`syncFromProjection`).
3. Call `requestRender()`.

`deps`: `{ clientStore, eventLog, dashboard, requestRender }`. Returns
`{ dispose }`.

## `Dashboard` — the selection model

Source: `packages/tui/src/components/dashboard.ts`. Owns the **centralised selection
model** and the follow rules that keep the view focused on live activity.

| State               | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `selectedPhaseId`   | The phase whose tasks are displayed.                              |
| `selectedTaskId`    | The task whose agent log is shown.                                |
| `selectedSessionId` | The session tab highlighted in AgentLog.                          |
| `userPinnedPhase`   | True when the user clicked a completed phase (reviewing history). |
| `userPinnedSession` | True when the user pinned a specific session via Tab.             |

### `syncFromProjection(projection)`

Pushes projection state into all child widgets, then runs the follow rules:

- **Phase follow** — if `selectedPhaseId` is set, not completed, and differs from
  `currentPhaseId`, advance to `currentPhaseId` and reset task/session selection. If
  `selectedPhaseId` is `null`, set it to `currentPhaseId`. If it is completed, leave
  it (reviewing history).
- **Task follow** — if `selectedTaskId` is `null` or no longer in the selected
  phase's tasks, auto-select the first `active` task (or the first task). Reset session
  selection.
- **Session follow** — if not user-pinned, sync `selectedSessionId` to the
  most-recently-started session for the selected task.

### `handleInput(data)` routing

- `←`/`→` → PhaseBar; recompute `selectedPhaseId` (wraps); set `userPinnedPhase`;
  reset task/session selection.
- `↑`/`↓` → if the agent log is expanded, scroll it; else TaskList (and reset session
  selection if the task changed).
- `Shift+↑`/`Shift+↓` → only when expanded, scroll the agent log.
- `Tab`/`Shift+Tab` → AgentLog; set `userPinnedSession`; cycle `selectedSessionId`
  forward/backward over the task's sessions.

`getComputedHeight()` = phase bar (1) + min(20, visible task count) + expanded
agent log lines + 4 border lines. The task-count term is capped at 20 to match the
TaskListWidget viewport.

## Widgets

### `EventLog`

Scrollable log of timestamped event lines. Constructor: `EventLog(maxLines = 20)`.
Storage is unbounded — every added line is retained for the lifetime of the widget
(the previous 5000-entry ring buffer was removed so events are never silently
dropped before reaching the TUI).

- `addLine(text)` appends to an unbounded internal list. Scroll accounting operates
  on rendered (wrapped) lines, not raw logical lines: when not auto-scrolling, the
  scroll offset is bumped by the number of wrapped rows the new line will occupy at
  the cached width, so the pinned view stays stable. When auto-scrolling, the
  offset stays at 0.
- `handleInput` — PgUp/PgDn/Home/End navigation.
- When scrolled up, the first visible line becomes a dim indicator:
  `↑ <N> more lines above (PgUp/PgDn)`.
- Completion summary. When the run completes, the ClientStore appends a two-line aggregate summary (computed by formatWorkflowSummary) to workflowEventLog immediately after the per-event workflow_completed line: 📊 Tokens: ↑<in> in · ↓<out> out and ⏱ Time: <total>s total · <agent>s agent (<pct>%). Both summary entries share the workflow_completed event's seq so they drain from the log together. Emitted only when totalDurationMs is a positive number.

### `PhaseBar`

Single-line phase progress indicator.

- `setPhases`, `setCurrentPhaseId` (also resets the selected phase),
  `setSelectedPhase`, `setCompletedPhaseIds`, `setIndicator`.
- Markers: `✓` (completed, green), `●` (running, cyan), `·` (pending, dim). Selected
  phase is underlined. Segments joined with `│`.

### `TaskListWidget`

Table of tasks in the current phase, one row per task, listed in creation/registration
order (the order tasks arrive via `updateTasks`). Tasks are **not** sorted or grouped by
status.

Each row is a fixed set of columns separated by 2-space gaps; every cell is padded to
the width of the widest cell in its column:

1. **ID** — a compact cross-referenceable label (e.g. `t-01`) assigned in
   creation/registration order, dimmed. (The raw task id is not shown.)
2. **Icon** — `statusIcon(status)` with no colour wrapper.
3. **Title** — `statusColor(status)(title)`, followed by a dash and the elapsed time
   (dimmed) for `active`/`complete`/`failed`/`cancelled` tasks that have a `startedAt`.
   Elapsed is frozen at `completedAt` when present, otherwise it is wall-clock.
4. **Sessions** — a compact session count badge, shown **only** for tasks that have
   **more than one session**. Single-session tasks show no badge.
5. **Dependencies** — the task dependency labels joined with comma-space, using the
   same `t-01` labels as the ID column so the two can be cross-referenced. Completed
   dependencies are dimmed; incomplete or unknown dependencies are plain text. A
   dependency id that is not present in the current task set (e.g. a cross-phase dep)
   falls back to its raw id. There is no `deps:` prefix.

The step and dependencies columns are omitted entirely when no task in the phase uses
them, so there are no trailing gaps. The selected task's entire row is rendered in
**bold**. Rows wider than the terminal are truncated with an ellipsis; rows are never
padded out to the full terminal width.

#### Viewport (20-line cap)

When a phase contains more than 20 tasks, only 20 lines are rendered. A dim ellipsis
(`...`) indicator is shown above the window when scrolled down and/or below it when
more tasks remain off-screen. Moving the selection with the up/down arrows
edge-scrolls the window so the selected task stays visible. The viewport resets to the
top when the set of task ids changes (e.g. a phase switch) but is preserved across
status-only refreshes. `getVisibleTaskCount` still reports the total number of tasks;
the dashboard applies `min(20, count)` for layout.

### `AgentLogWidget`

Detail view for the agent fulfilling the selected session of the selected task.

- Renders a **session tab bar** at the bottom — one tab per session. Each tab shows the
  session's `runnerRole` (e.g. `write-tests`, `execute`, `review`) or falls back to the
  profile name. The selected session is bold + underlined; the active (most-recently-started)
  session is marked. When the bar overflows the terminal width, a contiguous window centered
  on the selected session is shown with dimmed `…+N` / `+N…` indicators.
- Header shows profile, tool-call count, and input/output token totals (formatted compactly via `formatTokenCount`, e.g. ↑4k · ↓1.2k). When the selected agent has a `contextWindow`, a cumulative-consumption multiple is appended: ` • ctx N×` where `N = round(((inputTokens + outputTokens) / contextWindow) * 100) / 100` (the ratio of cumulative in+out tokens to the per-request model context window, rounded to 2 decimals). This is a multiplicative ratio, NOT a bounded fill percentage — it can exceed 1× because token totals accumulate across turns while `contextWindow` is a per-request cap.
- Right-side controls hint at the available keys (scroll/expand/cycle sessions).

Entry type → icon/colour:

| Type                            | Icon | Colour |
| ------------------------------- | ---- | ------ |
| `text`                          | 💬   | none   |
| `thinking`                      | 🧠   | dim    |
| `tool_call` / `tool_call_start` | 🔧   | cyan   |
| `tool_call_end`                 | ✅   | green  |
| `error`                         | ⚠️   | red    |
| `decision`                      | 🤝   | none   |

`tool_call_end` entries are hidden from the rendered log (the `tool_call_start` line
already shows the formatted call).

### Detach/kill prompt

Source: `packages/tui/src/components/detach-kill-prompt.ts`. A center-anchored
overlay with two options — **Detach** (default, highlighted) and **Kill** — showing
the run's `runId`. Each option shows a description line — Detach: "Leave run
running, exit client"; Kill: "Cancel run, then exit". Input: ↑/↓ or ←/→ to
navigate (wraps); Enter to confirm (`onConfirm('detach' | 'kill')`); Escape or
Ctrl+C to dismiss (`onDismiss`).

## Theme

Source: `packages/tui/src/theme.ts`. ANSI escape-sequence helpers. All colour
helpers have signature `(str: string) => string`.

**Foreground:** `normal` (identity — no ANSI wrapping, for unstyled cells),
`cyan`, `dim`, `bold`, `underline`, `green`, `red`, `yellow`, `blue`, `magenta`,
`darkRed` (256-colour 131).

**Background:** `bgDark` (256-colour 236), `bgStatusBar` (256-colour 237).

**Status helpers:**

| Status      | `statusColor` | `statusIcon` |
| ----------- | ------------- | ------------ |
| `active`    | `yellow`      | `▶`          |
| `complete`  | `green`       | `✓`          |
| `failed`    | `red`         | `✗`          |
| `cancelled` | `dim`         | `⊘`          |
| `ready`     | `cyan`        | `○`          |
| `blocked`   | `darkRed`     | `·`          |

**Other helpers:** `borderLine(left, fill, right, innerWidth)`, `stripAnsi(str)`,
`formatElapsed(ms)` (`<1s`, `Ns`, `Nm`/`Nm Ns`, `Nh`/`Nh Nm`).

## Formatting helpers

### `formatToolCall(toolName, args)`

Source: `packages/shared/src/format-tool-call.ts` (exported by `@engin/shared`).
Plain-text, per-tool formatting with icons:

| Tool                           | Format                                              |
| ------------------------------ | --------------------------------------------------- |
| `read`                         | `📖 read → <path>` (with `:offset`/`:offset+limit`) |
| `write`                        | `📝 write → <path> +<lineCount>`                    |
| `edit`                         | `✏️ edit → <path> (<N> edits)`                      |
| `bash`                         | `💻 bash → <cmd>` (truncated 60)                    |
| `grep`                         | `🔍 grep → <pattern>`                               |
| `find`                         | `🔍 find → <pattern> in <path>`                     |
| `ls`                           | `📂 ls → <path>`                                    |
| `delegate_to_subagents`        | `🤝 delegate → <N> tasks [<names>]`                 |
| `fetch_content` / `web_search` | `🌐` / `🔍`                                         |
| `workflow_step`                | `▶️ workflow → <action>`                            |
| `ask_user_question`            | `❓ ask → <N> questions`                            |
| process tools                  | `⚙️ <toolName>`                                     |
| default                        | `🔧 <toolName>` (+ `→ <args truncated 50>` if args) |

Commands are truncated to 60 chars, arg blobs to 50.

### `formatWorkflowEventLine(ev)`

Source: `packages/shared/src/format-workflow-event.ts`. Maps an `EventRecord` to a
human-readable emoji line for the event log. Returns `null` for silent types
(`decision`, `turn_started`, `turn_ended`, `tool_call_started`, `tool_call_ended`).

### `formatTokenCount(n)`

Source: `packages/shared/src/format-token-count.ts` (exported by `@engin/shared`). Formats an integer token count into a compact human-readable string:

| Input range    | Output                              | Example                    |
| -------------- | ----------------------------------- | -------------------------- |
| n <= 0         | '0'                                 | 0 → '0'                    |
| n < 1000       | plain integer                       | 56 → '56'                  |
| 1000 <= n < 1M | Nk (1 decimal, trailing .0 trimmed) | 4000 → '4k', 2500 → '2.5k' |
| n >= 1_000_000 | Nm (1 decimal, trailing .0 trimmed) | 1_500_000 → '1.5m'         |

### `formatWorkflowSummary(agents, totalDurationMs)`

Source: `packages/shared/src/format-workflow-summary.ts` (exported by `@engin/shared`). Pure function that computes a two-line aggregate summary shown in the TUI event log when a workflow completes:

- Line 1 — 📊 Tokens: ↑<in> in · ↓<out> out where <in>/<out> are formatTokenCount of the summed inputTokens/outputTokens across every agent.
- Line 2 — ⏱ Time: <total>s total · <agent>s agent (<pct>%) where <total> is totalDurationMs/1000, <agent> is the summed active time of agents that have BOTH startedAt and completedAt, and <pct> is round(agentTimeMs / totalDurationMs \* 100) (can exceed 100% due to parallel agents).

Returns [] when totalDurationMs is not a positive number. Token counts are routed through formatTokenCount.

## QR overlay

Source: `packages/tui/src/components/qr-overlay.ts`. `createQrOverlayComponent(url)`
generates a QR code (small terminal style) plus an OSC-8 clickable hyperlink line.
Anchored top-right, non-capturing. Used so you can open the server's web URL on a
phone.

## Where to go next

- [CLI reference](cli.md) — how the TUI is attached and the detach/kill semantics.
- [Web client](web.md) — the same projection, rendered in a browser.
- [Event store & status](event-store.md) — the substrate the store is fed from.
