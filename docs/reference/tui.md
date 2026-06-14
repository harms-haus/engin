# TUI dashboard

When the CLI detects an interactive terminal (TTY) without `--verbose`, it uses `WorkflowTUI`
to render a live dashboard instead of plain console output. This document covers the lifecycle
manager, the widget tree, the selection model and follow rules, keyboard shortcuts, and the
theme helpers.

The TUI is built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui).
It does **not** expose `StatusCallbacks` — the engine wires `createStoreCallbacks(store)` into
the workflow's `onStatus`, and the TUI receives projection updates via store subscription.

## `WorkflowTUI`

Source: `src/tui/workflow-tui.ts`.

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
}
```

| Method                        | Behaviour                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start()`                     | Create a `ProcessTerminal`, build the widget tree (EventLog → separator → Dashboard), fit the event log to the terminal height, focus the event log, override `console.warn`/`error`, and start rendering. No-op if already running. |
| `stop()`                      | Restore original `console` methods, unsubscribe input, hide any QR overlay, and stop the TUI. Safe to call multiple times.                                                                                                           |
| `prepareQrCode(url)`          | Pre-generate the QR overlay. **Call before `start()`** so the overlay attaches during the first (scrollback-safe) render.                                                                                                            |
| `showQrCode(url)`             | Generate (if needed) and display the QR overlay for the observer URL.                                                                                                                                                                |
| `pauseForInspection(signal?)` | Keep the TUI alive after the workflow completes so you can inspect the final state. Resolves when `signal` fires or Ctrl+C/Escape is pressed.                                                                                        |

### `WorkflowTUIOptions`

| Field            | Type         | Default | Description                                                                                   |
| ---------------- | ------------ | ------- | --------------------------------------------------------------------------------------------- |
| `agentLogLines?` | `number`     | `20`    | Collapsed height of the agent detail log (expanded shows 40).                                 |
| `abort?`         | `() => void` | —       | Invoked on first Ctrl+C; use to cancel the run.                                               |
| `store?`         | `EventStore` | —       | The canonical store. When provided, the TUI subscribes and syncs widgets from the projection. |

### Console interception

When the TUI is running:

- `console.log` **passes through unchanged** (so library noise like dotenv doesn't clutter the
  event log).
- `console.warn` / `console.error` are routed to the event log **with deduplication** (the most
  recent 50 unique messages are tracked; repeats are suppressed). warn is prefixed `⚠️`, error
  `❌`. They also still call the original.

### Keyboard shortcuts

| Key                   | Action                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------- |
| `Ctrl+C` (1st)        | Calls `abort()`; logs `⏹ Stopping workflow...`                                         |
| `Ctrl+C` (2nd)        | `process.exit(1)`                                                                      |
| `←` / `→`             | Select phase (cycle through registered phases).                                        |
| `↑` / `↓`             | Select task (when the agent log is collapsed) or scroll the agent log (when expanded). |
| `Tab` / `Shift+Tab`   | Cycle steps/agents within the selected task (forward/backward).                        |
| `Space`               | Expand/collapse the agent log widget.                                                  |
| `Shift+↑` / `Shift+↓` | Scroll the agent log by 10 lines (expanded only).                                      |
| `PgUp` / `PgDn`       | Scroll the event log up / down.                                                        |
| `Home` / `End`        | Jump to top / bottom of the event log (resumes auto-scroll).                           |

> In TUI mode the SIGINT handler is suppressed; the raw-mode input listener handles Ctrl+C. In
> non-TUI (console) mode only the SIGINT handler runs. They are never simultaneously active.

## Widget tree

```
WorkflowTUI
├── EventLog               (scrollable workflow-level event log)
├── separator              (dim horizontal line)
└── Dashboard
    ├── PhaseBar           (phase progress indicator)
    ├── TaskListWidget     (tasks in the selected phase)
    └── AgentLogWidget     (log for the selected step's agent, with step tab bar)
```

All widgets implement the `Component` interface from `@earendil-works/pi-tui`:
`render(width): string[]`, `invalidate(): void`, `handleInput(data): void`.

## `createStoreBackedTui(deps)`

Source: `src/tui/status-callbacks.ts`. Factory that subscribes the TUI widgets to an
`EventStore`. It does **not** implement `StatusCallbacks` — it subscribes via
`store.subscribe()` and syncs all widgets from the projection.

On each notification:

1. Read new events via `store.getEventsSince(lastSeq)` and write human-readable lines into the
   `EventLog` (formatted by `formatWorkflowEventLine`).
2. Call `dashboard.syncFromProjection(projection)`.
3. Call `requestRender()`.

Any events already in the store before subscription (e.g. from a resumed run's replay) are
processed immediately on construction.

`deps`: `{ store: EventStore; eventLog: EventLog; dashboard: Dashboard; requestRender: () => void }`.
Returns `{ dispose: () => void }`.

## `Dashboard` — the selection model

Source: `src/tui/components/dashboard.ts`. Owns the **centralised selection model** and the
follow rules that keep the view focused on live activity.

| State               | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `selectedPhaseId`   | The phase whose tasks are displayed.                              |
| `selectedTaskId`    | The task whose agent log is shown.                                |
| `selectedStepIndex` | The step tab highlighted in AgentLog.                             |
| `userPinnedPhase`   | True when the user clicked a completed phase (reviewing history). |
| `userPinnedStep`    | True when the user clicked a specific step.                       |

### `syncFromProjection(projection)`

Pushes projection state into all child widgets, then runs the follow rules:

- **Phase follow** — if `selectedPhaseId` is set, not completed, and differs from
  `currentPhaseId`, advance to `currentPhaseId` and reset task/step selection. If
  `selectedPhaseId` is `null`, set it to `currentPhaseId`. If it is completed, leave it
  (reviewing history).
- **Task follow** — if `selectedTaskId` is `null` or no longer in the selected phase's tasks,
  auto-select the first `active` task (or the first task). Reset step selection.
- **Step follow** — if not user-pinned, sync `selectedStepIndex` to the task's
  `activeStepIndex`.

### `handleInput(data)` routing

- `←`/`→` → PhaseBar; recompute `selectedPhaseId` (wraps); set `userPinnedPhase`; reset
  task/step selection.
- `↑`/`↓` → if the agent log is expanded, scroll it; else TaskList (and reset step selection if
  the task changed).
- `Shift+↑`/`Shift+↓` → only when expanded, scroll the agent log.
- `Tab`/`Shift+Tab` → AgentLog; set `userPinnedStep`; cycle `selectedStepIndex` over steps that
  have an `agentKey`.

`getComputedHeight()` = phase bar (1) + visible task count + expanded agent log lines + 4
border lines.

## Widgets

### `EventLog`

Scrollable log of timestamped event lines. Constructor: `EventLog(maxLines = 20,
maxBufferLines = 5000)`.

- `addLine(text)` writes into a ring buffer; if not auto-scrolling, increments the scroll
  offset to keep the view stable. Oldest lines are pruned beyond `maxBufferLines`.
- `handleInput` — PgUp/PgDn/Home/End navigation.
- When scrolled up, the first visible line becomes a dim indicator:
  `↑ <N> more lines above (PgUp/PgDn)`.

### `PhaseBar`

Single-line phase progress indicator.

- `setPhases`, `setCurrentPhaseId` (also resets the selected phase), `setSelectedPhase`,
  `setCompletedPhaseIds`, `setIndicator`.
- Markers: `✓` (completed, green), `●` (running, cyan), `·` (pending, dim). Selected phase is
  underlined. Segments joined with `│`.

### `TaskListWidget`

Grid of tasks in the current phase, one row per task. Sorted by status priority
(`active` → `ready` → `blocked` → settled).

- Active tasks with a known `activeStepIndex` show `step <i+1>/<len>: <name>`.
- Elapsed time is shown for active/settled tasks with a `startedAt`.
- Left border and icon come from `statusColor` / `statusIcon`.

### `AgentLogWidget`

Detail view for the agent fulfilling the selected step of the selected task.

- Renders a step **tab bar** at the bottom — one tab per step, marked `✓` (done), `▶` (active),
  or `○` (pending). Steps without an agent are dimmed.
- Header shows profile, tool-call count, and input/output token totals.
- Right-side controls hint at the available keys (scroll/expand/cycle).

Entry type → icon/colour:

| Type                            | Icon | Colour |
| ------------------------------- | ---- | ------ |
| `text`                          | 💬   | none   |
| `thinking`                      | 🧠   | dim    |
| `tool_call` / `tool_call_start` | 🔧   | cyan   |
| `tool_call_end`                 | ✅   | green  |
| `error`                         | ⚠️   | red    |
| `decision`                      | 🤝   | none   |

`tool_call_end` entries are hidden from the rendered log (the `tool_call_start` line already
shows the formatted call).

## Theme

Source: `src/tui/theme.ts`. ANSI escape-sequence helpers. All colour helpers have signature
`(str: string) => string`.

**Foreground:** `cyan`, `dim`, `bold`, `underline`, `green`, `red`, `yellow`, `blue`,
`magenta`, `darkRed` (256-colour 131).

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

Source: `src/tui/format-tool-call.ts`. Plain-text, per-tool formatting with icons:

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

Source: `src/tui/format-workflow-event.ts`. Maps an `EventRecord` to a human-readable emoji
line for the event log. Returns `null` for silent types (`decision`, `turn_started`,
`turn_ended`, `tool_call_started`, `tool_call_ended`).

## QR overlay

Source: `src/tui/components/qr-overlay.ts`. `createQrOverlayComponent(url)` generates a QR
code (small terminal style) plus an OSC-8 clickable hyperlink line. Anchored top-right,
non-capturing. Used so you can open the observer URL on a phone.

## Where to go next

- [Web reference](web.md) — the same projection, rendered in a browser.
- [Event store & status](event-store.md) — what the widgets are subscribing to.
