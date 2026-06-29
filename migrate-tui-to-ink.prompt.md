# Prompt: Migrate `engin-tui` from `@earendil-works/pi-tui` to Ink

> **This is a task prompt, not a plan.** It contains the goal, locked technical
> decisions, and research findings to seed the **develop** workflow. The workflow
> must first **scout** the codebase and external docs to **verify the claims
> below**, then **plan** atomic implementation tasks from those verified
> findings. Treat every factual claim in this document as something to confirm,
> not assume.
>
> **Note:** This document was refreshed against the codebase as of 2026-06-29.
> The counts, file list, and domain descriptions below were re-derived from the
> current tree, but the workflow should still re-verify them — the codebase
> moves fast (the engine was redesigned to be session-first since this prompt
> was first written; see §3.2).

---

## 1. Goal

Migrate the terminal UI in `packages/tui` from the current thin, retained-mode,
string-based component framework (`@earendil-works/pi-tui`) onto **Ink**
(React + Yoga flexbox). Objectives, in priority order:

1. **Eliminate hand-managed low-level plumbing** — manual ANSI, box/border math,
   width truncation, `invalidate()` render caches, scroll-offset arithmetic, and
   the centralized input dispatcher.
2. **Look better** — leverage flexbox + built-in borders/gaps for cleaner layout.
3. **Perform better** under high-frequency WebSocket state updates.
4. **Preserve all current behavior** — phase bar, task list, expandable agent
   (session) log, event log, overlays (QR + centered confirm prompt), and all
   keybindings.

The migration is an **in-place rewrite of `packages/tui`**, not a new package.
It must remain consumable by `packages/cli` (`@harms-haus/engin`) via the same
public surface the CLI depends on. As of this writing the CLI imports exactly
**one** symbol from `@harms-haus/engin-tui`: the `WorkflowTUI` class (see
`packages/cli/src/cli/run-session-client.ts`). That class + its
`WorkflowTUIOptions` is the entire public surface to preserve — verify during
scouting that no other CLI/engine/web file imports anything else from the TUI
package.

---

## 2. Locked technical decisions (already made — do not relitigate)

- **Target library: Ink** (`ink`), with **React** (`react` / `react-dom` peer
  types) and **Yoga** (`yoga-layout`, brought in by Ink). Pin React 19.x and
  Ink 7.x (verify the latest 7.x on npm during scouting — report the exact
  versions and their `engines.node` requirement).
- **Scrolling: `ink-scroll-view`** (community) for the interactive, navigable,
  expand/collapse agent log and any other virtualized/scrollable region. This is
  a **hard dependency** — verify during scouting that it is still maintained, its
  latest version, its API, and its React/Ink peer-version compatibility.
- **Testing: `ink-testing-library`** for rendering components to a virtual stdout
  and snapshotting frames. Replace the existing `tests/tui/**` /
  `packages/tui/src/components/*.test.ts` harness with Ink-testing-library-based
  tests.
- **External store: `useSyncExternalStore`** to bind the WebSocket-pushed
  `ClientStore` (from `@harms-haus/engin-shared`) into the React tree.
- **Rendering mode: `incrementalRendering: true`** passed to Ink's `render()` —
  it does a line-level diff so only changed lines are written (less CPU, less
  flicker). Verify this option exists and its exact name in the Ink version you
  pin.
- **Runtime: Bun** (currently **Bun 1.3.14**; Node 26.1.0 also installed but the
  project runs under Bun). ⚠️ There is a known, version-sensitive cluster of bugs
  around Ink's `useInput` / raw-mode under the Bun runtime (see §5). Validate
  keyboard input under the project's **exact** Bun version (check root
  `package.json` / `bunfig.toml` / `bun.lock`) **before** full implementation,
  and report the result.

> If scouting proves any locked dependency is unmaintained, incompatible, or
> broken under Bun, **HALT and report** rather than substituting silently.

---

## 3. Current architecture — what exists (verify these during scouting)

All paths are relative to the repo root.

### 3.1 Package layout

- `packages/tui/` — the package being rewritten. `package.json` declares
  `@earendil-works/pi-tui` (`^0.79.7`) and `@harms-haus/engin-shared`
  (`workspace:*`) as deps. Entry: `src/index.ts`.
  - **Note on import paths:** source files import shared code via the **path
    alias `@engin/shared`** (and `@engin/shared/*` for sub-modules like
    `/client-store`, `/projection-helpers`, `/format-tool-call`,
    `/format-token-count`, `/text-utils`), not the package name. The alias is
    defined in `tsconfig.json` / `packages/tui/tsconfig.json` and resolves to
    `@harms-haus/engin-shared` at build/runtime. Keep this alias scheme (or
    migrate to direct package imports — decide during planning, but be
    consistent).
  - **Transitive dep alert:** `packages/tui/src/components/qr-overlay.ts`
    imports `qrcode`, but `packages/tui/package.json` does **not** declare it.
    `qrcode` is currently resolved transitively via `packages/engine` (which
    declares `qrcode ^1.5.4`), and `@types/qrcode` lives at the repo root. The
    rewrite should declare `qrcode` (and `@types/qrcode`) explicitly in
    `packages/tui/package.json` rather than relying on hoisting.
- `packages/cli/` — the consumer. `package.json` depends on
  `@harms-haus/engin-tui`. As of this writing the only import is
  `import { WorkflowTUI } from '@harms-haus/engin-tui'` in
  `packages/cli/src/cli/run-session-client.ts` — that is the public surface to
  keep stable. (Re-verify with `rg '@harms-haus/engin-tui' packages` during
  scouting.)

### 3.2 Source files in `packages/tui/src/` (≈2,281 LOC of non-test source + ≈356 LOC of tests)

> ⚠️ **Major change since the original prompt: the engine is now session-first.**
> What used to be called "steps" (per-task execution steps with
> `activeStepIndex` / `userPinnedStep` / `computeNextAgentStepIndex()`) is now
> **sessions** (`SessionEntity`). The agent log is now a **session log** with a
> session tab bar; Tab/Shift+Tab cycles **sessions**, not steps. Update any
> mental model accordingly.

- `workflow-tui.ts` — `WorkflowTUI` class: lifecycle (`start`/`stop`), the
  WebSocket-backed store wiring, the **centralized input dispatcher** (a
  9-branch key handler for Ctrl+D/C/Q, ←/→, ↑/↓, Tab/Shift+Tab, Space,
  Shift+↑/↓, PgUp/PgDn/Home/End), overlay management (QR + detach/kill prompt),
  and `pauseForInspection()`. Also defines a tiny **stateless separator
  `Component`** (a dim `─` rule) rendered between the event log and the
  dashboard — preserve this divider in the Ink layout (e.g. a `<Box
borderStyle="single">` top, or a `<Text>` rule). This is the orchestrator.
- `ws-backed-tui.ts` — bridges `ClientStore` (WS state from daemon) into the
  `EventLog` + `Dashboard` via the `createWsBackedTui()` factory. **Framework-
  agnostic** (depends on `@engin/shared`, not pi-tui). On each store tick it:
  (1) drains `state.workflowEventLog` entries with `seq > lastSeq`, forwarding
  each entry's pre-formatted `line` text to the event log; (2) drains new
  `state.runLog` entries, prefixing `warn` (`⚠️ `) and `error` (`❌ `), ignoring
  `info`; (3) calls `dashboard.syncFromProjection(toProjection(state))`; (4)
  requests a render. (`ClientStoreState` is `Omit<WorkflowProjection,'runLog'>`
  extended with `runLog: RunLogEntry[]` and `workflowEventLog:
WorkflowEventLogEntry[]`.) **Strong candidate to keep nearly verbatim** — it
  has no pi-tui dependency.
- `theme.ts` — hand-built ANSI color vocabulary (`cyan/dim/bold/underline/
green/red/yellow/blue/magenta/darkRed/normal`, plus `bgDark`/`bgStatusBar`
  backgrounds), status→color + status→icon maps (note: `TaskStatus` now includes
  `parked` → `⏸`/`magenta`, and `active` → `▶`/`yellow`), and a trivial
  `borderLine(left, fill, right, innerWidth)` helper. (The old `stripAnsi` and
  `formatElapsed` have moved to `@engin/shared/text-utils`.)
- `components/dashboard.ts` — `Dashboard` component. Owns the **domain logic**:
  phase-follow, task-follow + completion reselection (now spanning
  `active`/`parked` in-progress states via `pickMostRecentlyStartedActive` /
  `pickMostRecentlyStartedParked`), **session-follow**
  (`selectedSessionId` / `userPinnedSession`), and the `_selection` state
  machine. Composes `PhaseBar` + `TaskListWidget` + `AgentLogWidget` and draws
  the bordered container manually. Exposes `forceReselect()` (resets task/session
  selection, keeps phase) and `getComputedHeight()`.
  - ⚠️ **Duplication to flag:** `@engin/shared/projection-helpers.ts` now
    exports a store-facing `reconcileSelection()` that implements the **same**
    phase/task/session follow rules the TUI re-implements locally in
    `_applySelectionToWidgets()`. The TUI does **not** currently import
    `reconcileSelection`. Planning should decide whether the Ink version keeps a
    local copy or consolidates onto the shared helper (the shared helper also
    writes back into `ClientStoreState` via `writeProjectionToState`, so a
    single source of truth would reduce drift).
- `components/agent-log-widget.ts` — scrollable, expand/collapse **session** log
  with a tab-bar of sessions (not steps). Header line shows the selected
  session's `taskTitle`/`profile`, `toolCallCount`, `↑`/`↓` token counts
  (`formatTokenCount`), and a cumulative **context-window multiple** `ctx N×`
  (not a bounded %). Entries are rendered via per-type icon+color maps and
  `formatToolCall` (for `tool_call`/`tool_call_start`). The session tab bar
  (`renderSessionTabBar`) has an **overflow windowing algorithm** that keeps a
  contiguous window centered on the selected session with `…+N`/`+N…`
  indicators. State: `_selectedSessionId`, `_activeSessionId`, `_scrollOffset`
  (with an `!expanded` reset guard), `dirty`/`cachedWidth`/`cachedLines`,
  `_lastTotalEntryLines`. Tab/Shift+Tab cycle sessions (using the shared
  `selectNextSession` helper in `dashboard.ts`; the widget has a local fallback
  too).
- `components/task-list-widget.ts` — task list with `_autoScrollToActive()` (a
  hand-rolled difference-array over `active`+`parked` tasks, with a documented
  "~2 rows suboptimal" approximation), `_getViewportTaskCount`, a 20-line
  viewport with `↑/↓ more above/below` indicators, compact cross-referenceable
  `t-01` ID labels (built lazily in registration order and reused for the deps
  column), column-width math, a scroll offset, a **session-progress column**
  showing `●{started}/{sessionPlan.length}` when a task declares a
  `sessionPlan` (else a raw `N sessions` count), and a **live active-elapsed
  timer** (`elapsedMs + (now - activeStartedAt)`; frozen for parked/terminal).
- `components/event-log.ts` — append event log with **four parallel caches**
  (`lineWrapCache`/`wrappedCache`/`wrappedWidth`/`_totalRenderedLines`),
  bounded retention (`MAX_STORED_LINES = 10000`), autoscroll + drift fix, and
  PgUp/PgDn/Home/End scrolling. The lines it displays are **pre-formatted** by
  the shared `formatWorkflowEventLine` (the ClientStore builds
  `workflowEventLog`); the TUI only forwards `entry.line`.
- `components/phase-bar.ts` — phase bar with completion (`✓`/green), running
  (`●`/cyan+bold), idle (`·`/dim) markers and an optional sidebar `indicator`
  prefix. (Note: its input handler still compares against raw escape bytes
  `\x1b[D` / `\x1b[C` instead of `matchesKey` — verify still true.)
- `components/detach-kill-prompt.ts` — centered confirm prompt (Detach vs Kill),
  created via the `createDetachKillPrompt()` factory; Up/Down/Left/Right
  navigates, Enter confirms, Escape/Ctrl+C dismisses.
- `components/qr-overlay.ts` — top-right QR code overlay (non-capturing) with an
  OSC-8 hyperlink, built by the async `createQrOverlayComponent(url)` factory
  using the `qrcode` package.
- `components/index.ts` — barrel re-export of all components +
  `AgentLogEntry` (alias of `LogEntry`).

### 3.3 The framework being replaced — `@earendil-works/pi-tui`

The package exposes a **retained-mode, string-based** component model:

- `Component` interface: `render(width: number): string[]`, `invalidate(): void`,
  `handleInput(data: string): void`.
- `TUI` host: `addChild`, `setFocus`, `addInputListener((data) => {consume})`,
  `requestRender`, `showOverlay(component, {anchor, nonCapturing, margin})` →
  `OverlayHandle.hide()`, `start`/`stop`. Anchors used: `'center'` and
  `'top-right'`.
- `ProcessTerminal` — raw stdio binding; `terminal.rows` read directly.
- Helpers: `truncateToWidth`, `wrapTextWithAnsi`, `visibleWidth`, `Key`,
  `matchesKey`, `Key.ctrl(...)`, `Key.shift(...)`, `Key.space`, `Key.enter`.
- Verify the full API surface by reading
  `node_modules/@earendil-works/pi-tui/dist/index.d.ts` during scouting.

### 3.4 Shared helpers the TUI consumes (verify exports in `packages/shared/src/index.ts`)

The TUI imports these from `@engin/shared` / `@engin/shared/*` (resolve to
`@harms-haus/engin-shared`). These are the crown-jewel dependencies and should
be **re-used as-is** (not re-implemented) by the Ink version:

- Projection / follow: `toProjection`, `isTerminalTaskStatus`,
  `pickMostRecentlyStartedActive`, `pickMostRecentlyStartedParked`,
  `selectNextSession`, `reconcileSelection`, `writeProjectionToState`,
  `capSessionLogs`.
- Types: `WorkflowProjection`, `PhaseEntity`, `TaskEntity`, `SessionEntity`,
  `LogEntry`, `TaskStatus`.
- Formatters: `formatWorkflowEventLine`, `formatToolCall`
  (`/format-tool-call`), `formatTokenCount` (`/format-token-count`),
  `formatElapsed` (`/text-utils`).
- Store: `ClientStore`, `ClientStoreState` (`/client-store`).

`formatElapsed` previously lived in `theme.ts`; it has since moved to shared.
`stripAnsi` likewise is gone from the TUI.

---

## 4. Research findings — the burden being eliminated (verify the counts/claims)

A prior analysis of `packages/tui/src/` found that **most of the TUI code is
manual mechanics** and a small slice is genuine domain logic. Scout should
re-derive these numbers with `grep`/`wc` and report discrepancies. Current
counts (re-derived 2026-06-29):

| Manual mechanic (hand-rolled today)   | Evidence to verify                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Manual ANSI styling                   | Count literal `\x1b` occurrences (`rg -c '\\x1b' packages/tui/src`). Currently ~16 in source: ~12 in `theme.ts`, ~3 in `phase-bar.ts`, ~1 in `qr-overlay.ts`. (Down from ~18 — `stripAnsi`/`formatElapsed` moved out.)                                                    |
| Box/border drawing + inner-width math | `borderLine()` uses; `innerWidth = width - 2`; `│…│` row wrapping in `dashboard.render`.                                                                                                                                                                                  |
| Text truncation/wrapping to width     | Count `truncateToWidth` calls. Currently ~26 (agent-log:4, event-log:4, task-list:9, phase-bar:2, dashboard:4, qr-overlay:3). Plus `wrapTextWithAnsi`, `visibleWidth`.                                                                                                    |
| `invalidate()` + render caches        | Count `invalidate()` impls (currently 8: event-log, task-list, phase-bar, detach-kill, dashboard, qr-overlay, agent-log, + the inline separator), cross-call sites, and `dirty`/`cachedWidth`/`cachedLines` refs. `event-log.ts` maintains 4 parallel caches.             |
| Scroll-offset engines                 | Count `scrollOffset` refs (currently ~49: agent-log:14, event-log:14, task-list:21) across ~4 independent scrollers (EventLog, AgentLogWidget, TaskListWidget, + routing in Dashboard).                                                                                   |
| Input routing                         | `WorkflowTUI.start()` 9-branch dispatcher; `Dashboard.handleInput` secondary routing (phase nav, collapsed vs expanded ↑/↓, session Tab cycling, Shift+↑/↓ expanded scroll); ordering-sensitive guards (Ctrl+D before the prompt guard; inspecting-vs-live Ctrl+C split). |
| Layout/height computation             | `Dashboard.getComputedHeight()`; `terminal.rows - getComputedHeight() - 1` pushed into `eventLog.setMaxLines()`; re-run on Space expand/collapse.                                                                                                                         |
| Resize handling                       | **There is NO resize / SIGWINCH listener anywhere** — confirmed `rg -i 'resize                                                                                                                                                                                            | SIGWINCH' packages/tui/src`returns nothing. This is a latent bug: event-log height goes stale after a window resize. Ink's`useWindowSize()` + flexbox would fix this for free. |

### 4.1 What a higher-level library eliminates vs preserves

- **Eliminated entirely** by Ink/flexbox: ANSI styling, box/border math,
  truncation/wrapping, `invalidate()`/caches, layout/height computation, and
  resize handling (flexbox re-flows automatically — **fixing the resize bug for
  free**).
- **Mostly absorbed** (offset arithmetic/clamping goes away; the _policy_
  survives): scroll-offset state, input routing.
- **Not eliminated — must be preserved/ported verbatim** (this is the
  crown-jewel domain logic): the **follow state machines** in
  `dashboard.ts` (phase-follow, task-follow + completion reselection across
  `active`/`parked` via `pickMostRecentlyStartedActive` /
  `pickMostRecentlyStartedParked` + `isTerminalTaskStatus`, **session-follow**
  with `selectedSessionId`/`userPinnedSession`/`setActiveSessionId`), the
  session tab-bar overflow windowing in `agent-log-widget.ts`, and the
  `toProjection()` mapping + event/run-log draining in `ws-backed-tui.ts`.
  This logic depends only on `@engin/shared` types/functions — verify those
  imports/exports in `packages/shared/src`.

### 4.2 Maintenance hotspots to prioritize (verify they're as fragile as claimed)

1. `event-log.ts` — 4 caches kept in lockstep by comments, not types; multiple
   code paths in `addLine`; an "autoscroll drift fix"; bounded-retention
   eviction keeping all four caches consistent.
2. `task-list-widget.ts` `_autoScrollToActive()` — hand-rolled difference-array
   over `active`+`parked` tasks with a documented "~2 rows suboptimal"
   approximation.
3. **Scroll-while-expanded** — `setSelectedSessionId` deliberately guards a
   scroll-reset on `!expanded`; `Dashboard.handleInput` calls only
   `_agentLog.invalidate()` (not `_applySelectionToWidgets`) when expanded, with
   an inline comment explaining why (re-running selection would reset the scroll
   offset).
4. Invalidate-ordering desyncs — every navigation path must manually
   `invalidate()` + `requestRender()` or the screen desyncs until the next store
   tick. (React's reactivity removes this entire class.)
5. **Duplicated follow logic** — `Dashboard._applySelectionToWidgets()` and the
   shared `reconcileSelection()` both implement the phase/task/session follow
   rules. Drift risk (see §3.2).

---

## 5. Ink research findings — fit, gaps, and risks (verify each against current docs)

### 5.1 Where Ink is a clean win

- **Layout:** every `<Box>` is `display:flex`; supports `flexDirection`,
  `flexGrow`/`flexShrink`, `alignItems`/`justifyContent`, `gap`/`columnGap`/
  `rowGap`, `width`/`height` (numbers or `%`), `padding`/`margin`, and **7
  border styles** (`single`/`double`/`round`/… via `cli-boxes`) with per-side
  colors. Verify border-style names + that `position="absolute"` exists
  (reportedly landed via Ink issue #182).
- **Text:** `<Text wrap="truncate"|"truncate-start"|"truncate-middle"|"truncate-end"|"wrap">`
  replaces all `truncateToWidth` usage. Verify the exact `wrap` prop values.
- **Resize:** `useWindowSize()` returns `{columns, rows}` and re-renders on
  resize. Verify this hook name.
- **Input:** `useInput((input, key) => …, { isActive })` — the `key` object
  reportedly exposes `ctrl`, `shift`, `tab`, `return`, `escape`,
  `leftArrow`/`rightArrow`/`upArrow`/`downArrow`, `pageUp`/`pageDown`,
  `home`/`end`, `backspace`, `delete`. Verify these key names cover the full
  current keybinding set (Ctrl+C/D/Q, arrows, Tab/Shift+Tab, Space,
  PgUp/PgDn/Home/End).
- **Focus:** `useFocus({autoFocus, isActive, id})` + `useFocusManager()`
  (`focusNext`/`focusPrevious`/`focus(id)`/`activeId`); Tab→focusNext,
  Shift+Tab→focusPrevious auto-wired. **Caveat:** the current app uses Tab/
  Shift+Tab to cycle **sessions** within the agent log, not to move focus
  between widgets — so auto-focus-wiring may need to be suppressed/overridden.
  Verify.
- **Performance:** React reconciles only changed components; `maxFps` (default 30) throttles commits; `incrementalRendering` does a line-level diff.
- **Testing:** `ink-testing-library` — `render(<App/>).lastFrame()` for
  snapshotting. Verify the import + API.

### 5.2 Where Ink does WORSE than the current framework (the two real gaps)

1. **Overlays/modals — DIY.** Ink reportedly has **no first-party overlay/modal**
   and **no `showOverlay({anchor:'center'|'top-right'})` equivalent**, and
   **no z-index** (paint-order only). The migration must rebuild the centered
   detach/kill prompt and the top-right QR using `<Box position="absolute"
top/right={n|'%'}>` plus `useWindowSize()` centering math, behind a small
   `<Overlay>` wrapper that approximates the current `OverlayHandle`. **Verify
   the absence of a first-party overlay and the presence of
   `position="absolute"`.**
2. **Interactive scroll — DIY (use `ink-scroll-view`).** Ink's only virtualized
   primitive, `<Static>`, is **append-only** — fine for the _completed-event_
   portion of the event log, **wrong** for the navigable, expand/collapse agent
   (session) log. The locked decision is to use **`ink-scroll-view`** for that.
   **Verify `ink-scroll-view`'s maintenance status, latest version, API, and Ink
   peer compatibility.**

### 5.3 The blocker to validate FIRST — Bun + interactive Ink input

There is reportedly a **recurring, version-sensitive cluster of bugs** around
Ink's `useInput` / raw-mode under the Bun runtime:

- Bun issue **#6862** ("Ink not working properly") — `useInput` reportedly stops
  responding under Bun.
- Ink issue **#696** ("Compatibility issue with Bun 1.2") — raw-mode/stdin
  handling reportedly broke again, with fixes referencing "ensure raw mode is
  enabled only once" and "fix process.stdin.ref."

The workflow must **verify the project's exact Bun version (currently 1.3.14)**
and **test keyboard input under Bun early** (e.g. a minimal Ink app with
`useInput` that echoes keys). Report: does input work reliably on the project's
Bun version? If not, document the failure mode. This is the one risk that can
invalidate the entire migration.

### 5.4 Other Ink gotchas to verify

- `patchConsole` (default `true`) rewrites stdout to interleave `console.*` —
  may need `false` if raw writes are used. (Note: `ws-backed-tui`/`workflow-tui`
  currently use `console.error`/`console.warn` for QR + detach/kill callback
  warnings — decide where those go under Ink.)
- `exitOnCtrlC` (default `true`); set `false` to manage Ctrl+C manually (the
  current app has custom Ctrl+C behavior: graceful exit while inspecting,
  otherwise show the detach/kill prompt).
- Re-calling `render()` on the same stdout without `unmount()`/`cleanup()` is
  reportedly unsupported — one Ink instance per stream.
- TTY assumptions: in CI/non-TTY, Ink auto-detects and renders only the final
  frame; piped stdout loses interactivity.
- React 19 + Node 22 floor may force toolchain bumps — check against the
  project's `engines` (currently unset) / Node usage.

---

## 6. Domain behavior that MUST be preserved (do not regress)

Scout should confirm each of these is implemented today and the planner must
carry them forward into the Ink version:

- **Keybindings:** Ctrl+D (immediate detach, works even while prompt is shown),
  Ctrl+C (graceful exit while inspecting via `pauseForInspection`; otherwise
  show detach/kill prompt), Ctrl+Q (toggle top-right QR), ←/→ (phase nav),
  ↑/↓ (task nav when collapsed; scroll agent log when expanded),
  Tab/Shift+Tab (**cycle sessions** in agent log), Space (expand/collapse agent
  log), Shift+↑/Shift+↓ (scroll by 10 when expanded), PgUp/PgDn/Home/End (scroll
  event log).
- **Follow rules:** phase-follow (only auto-advance when user was synced to the
  previous current phase and it advanced); task-follow (auto-select first
  in-progress task — `active` or `parked`; on completion transition re-select
  most-recently-started remaining in-progress task via
  `pickMostRecentlyStartedActive` ?? `pickMostRecentlyStartedParked`);
  **session-follow** (auto-select the most-recently-started session for the
  selected task unless `userPinnedSession` is set or the agent log is expanded
  with an existing selection).
- **Agent log rendering:** header line (title/profile, tool-call count,
  `↑`/`↓` token counts, cumulative `ctx N×` context multiple); per-type
  icon+color entry rendering with `formatToolCall` for tool calls; session tab
  bar with overflow windowing centered on the selected session.
- **Task list rendering:** compact `t-01` ID labels reused for the deps column
  (deps dimmed when complete); status icon + colored title; **active-only
  elapsed timer** (ticks for `active`, frozen otherwise); **session-progress
  column** `●{started}/{sessionPlan.length}` when a `sessionPlan` exists, else
  `N sessions`; 20-line viewport with `↑/↓ more` indicators + auto-scroll to
  maximize visible in-progress tasks.
- **Overlays:** detach/kill prompt centered (shows `runId`, onConfirm dispatches
  detach vs kill, onDismiss closes); QR overlay anchored top-right, toggled by
  Ctrl+Q, pre-generated via `prepareQrCode()` for synchronous toggling.
- **`pauseForInspection(signal?)`** — keep the TUI open and navigable after run
  completion; resolves only on Ctrl+C (via main listener) or signal abort;
  Ctrl+D still detaches.
- **Lifecycle / public surface:** `start()`, `stop()` (cleans up listeners,
  hides overlays), `setRunId()`, `getEventLog()`, `getDashboard()`, async
  `prepareQrCode(url)`, async `showQrCode(url)`, async
  `pauseForInspection(signal?)`. The CLI constructs `WorkflowTUI` with only
  `{ clientStore, onDetach, onKill }` (and calls `setRunId` later) — verify the
  full method/option set against `packages/cli/src/cli/run-session-client.ts`.

---

## 7. Things the workflow should explicitly NOT do

- Do not plan before scouting completes and the claims in §3–§5 are verified.
- Do not preserve the `render(width): string[]` / `invalidate()` / `handleInput`
  pi-tui contract — that model is being abandoned. The new components are React
  function/class components rendering `<Box>`/`<Text>`.
- Do not port the hand-rolled caches (`event-log`'s 4 caches, the
  `dirty`/`cachedWidth`/`cachedLines` trio) — reactivity replaces them.
- Do not introduce a second TUI library or a general "compatibility shim"; the
  only new framework deps should be `ink`, `react`, `ink-scroll-view`, and
  `ink-testing-library` (dev). (`qrcode` already transitively present — declare
  it explicitly, do not swap it out.)
- Do not change `packages/shared` projection/follow helpers
  (`WorkflowProjection`, `toProjection`, `isTerminalTaskStatus`,
  `pickMostRecentlyStartedActive`/`Parked`, `selectNextSession`,
  `reconcileSelection`, `ClientStore`) — they are consumed as-is. (Consolidating
  the TUI's local follow logic onto the shared `reconcileSelection` is allowed
  but optional — see §3.2/§4.2.)

---

## 8. Definition of done (for the eventual review phase)

- `packages/tui` builds and the CLI launches the dashboard under **Bun** with
  keyboard input fully working (every keybinding in §6).
- No remaining `@earendil-works/pi-tui` imports in `packages/tui` (verify with
  `rg '@earendil-works/pi-tui' packages`).
- No remaining hand-written ANSI styling in components (theme becomes declarative
  style data feeding `<Text>` props); no `invalidate()` / render-cache code; no
  `truncateToWidth` / `borderLine` / `wrapTextWithAnsi` usage.
- `ink-testing-library` tests cover each component and the key flows (follow
  rules, session tab cycling, expand/collapse, scroll, overlays, Ctrl+C/D/Q
  handling). The existing `agent-log-widget.test.ts` and
  `agent-log-widget-session-api.test.ts` cover the session API and should be
  ported/replaced.
- High-frequency WebSocket feed updates render without flicker
  (`incrementalRendering` on); terminal resize updates layout correctly (verify
  the resize bug is gone — there is no SIGWINCH handler today).
- All preserved domain behavior in §6 still works (manual checklist during
  review).

---

## 9. Suggested scouting targets (to speed up the scout phase)

- Read: every file in `packages/tui/src/` and `packages/tui/src/components/`.
- `node_modules/@earendil-works/pi-tui/dist/index.d.ts` — full API being replaced.
- `rg '@harms-haus/engin-tui' packages` — public surface to preserve
  (currently just `WorkflowTUI` in `packages/cli/src/cli/run-session-client.ts`).
- `rg '@engin/shared' packages/tui/src` — shared deps the TUI relies on.
- `packages/shared/src/index.ts`, `projection-helpers.ts`, `event-types.ts`,
  `types.ts`, `client-store.ts`, `format-*.ts`, `text-utils.ts` — projection,
  follow helpers, entities, store, formatters.
- `package.json`, `bunfig.toml`, `bun.lock`, `tsconfig.json`,
  `packages/tui/tsconfig.json` (root + `packages/tui`) — exact versions (Bun
  1.3.14, React slot, Node engines, `@engin/shared` path alias).
- npm/GitHub for current versions + maintenance of: `ink`, `react`,
  `yoga-layout`, `ink-scroll-view`, `ink-testing-library`.
- Bun + Ink input issues (§5.3) — verify status against the project's Bun
  version (1.3.14).
