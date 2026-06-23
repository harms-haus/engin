# Prompt: Migrate `engin-tui` from `@earendil-works/pi-tui` to Ink

> **This is a task prompt, not a plan.** It contains the goal, locked technical
> decisions, and research findings to seed the **develop** workflow. The workflow
> must first **scout** the codebase and external docs to **verify the claims
> below**, then **plan** atomic implementation tasks from those verified
> findings. Treat every factual claim in this document as something to confirm,
> not assume.

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
   log, event log, overlays (QR + centered confirm prompt), and all keybindings.

The migration is an **in-place rewrite of `packages/tui`**, not a new package.
It must remain consumable by `packages/cli` (`@harms-haus/engin`) via the same
public surface the CLI depends on (verify exactly what the CLI imports from
`@harms-haus/engin-tui` during scouting).

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
  and snapshotting frames. Replace the existing `tests/tui/**` harness with
  Ink-testing-library-based tests.
- **External store: `useSyncExternalStore`** to bind the WebSocket-pushed
  `ClientStore` (from `@harms-haus/engin-shared`) into the React tree.
- **Rendering mode: `incrementalRendering: true`** passed to Ink's `render()` —
  it does a line-level diff so only changed lines are written (less CPU, less
  flicker). Verify this option exists and its exact name in the Ink version you
  pin.
- **Runtime: Bun.** This project runs under Bun. ⚠️ There is a known,
  version-sensitive cluster of bugs around Ink's `useInput` / raw-mode under the
  Bun runtime (see §5). Validate keyboard input under the project's **exact** Bun
  version (check `package.json` / `bunfig.toml` / `bun.lock`) **before** full
  implementation, and report the result.

> If scouting proves any locked dependency is unmaintained, incompatible, or
> broken under Bun, **HALT and report** rather than substituting silently.

---

## 3. Current architecture — what exists (verify these during scouting)

All paths are relative to the repo root.

### 3.1 Package layout

- `packages/tui/` — the package being rewritten. `package.json` declares
  `@earendil-works/pi-tui` (`^0.79.7`) and `@harms-haus/engin-shared`
  (`workspace:*`) as deps. Entry: `src/index.ts`.
- `packages/cli/` — the consumer. `package.json` depends on
  `@harms-haus/engin-tui`. Find every import of `@harms-haus/engin-tui` across
  `packages/cli/src/**` to determine the public surface that must stay stable.

### 3.2 Source files in `packages/tui/src/` (≈2,247 LOC of source)

- `workflow-tui.ts` — `WorkflowTUI` class: lifecycle (`start`/`stop`), the
  WebSocket-backed store wiring, the **centralized input dispatcher** (a
  9-branch key handler for Ctrl+D/C/Q, ←/→, ↑/↓, Tab/Shift+Tab, Space,
  Shift+↑/↓, PgUp/PgDn/Home/End), overlay management (QR + detach/kill prompt),
  and `pauseForInspection()`. This is the orchestrator.
- `ws-backed-tui.ts` — bridges `ClientStore` (WS state from daemon) into the
  `EventLog` + `Dashboard`. Contains a `toProjection()`-style mapping. **Mostly
  framework-agnostic** (depends on `@engin/shared`, not pi-tui).
- `theme.ts` — hand-built ANSI color vocabulary (`cyan/dim/bold/…`,
  `\x1b[...m` wrappers), status→color + status→icon maps, a regex `stripAnsi`,
  `borderLine()`, and `formatElapsed()`.
- `components/dashboard.ts` — `Dashboard` component. Owns the **domain logic**:
  phase-follow, task-follow + completion reselection, step-follow rules, and the
  `_selection` state machine. Composes `PhaseBar` + `TaskListWidget` +
  `AgentLogWidget` and draws the bordered container manually.
- `components/agent-log-widget.ts` — scrollable, expand/collapse agent log with
  a tab-bar of steps, scroll-offset state with an `!expanded` reset guard, and
  `computeNextAgentStepIndex()` (step-cycling algorithm).
- `components/task-list-widget.ts` — task list with `_autoScrollToActive()` (a
  hand-rolled difference-array), `_getViewportTaskCount`, column-width math, and
  a scroll offset.
- `components/event-log.ts` — append event log with **four parallel caches**
  (`lineWrapCache`/`wrappedCache`/`wrappedWidth`/`_totalRenderedLines`),
  autoscroll, and PgUp/PgDn/Home/End scrolling.
- `components/phase-bar.ts` — phase bar. (Note: its input handler compares
  against raw escape bytes `\x1b[D` / `\x1b[C` instead of `matchesKey` — verify.)
- `components/detach-kill-prompt.ts` — centered confirm prompt (detach vs kill).
- `components/qr-overlay.ts` — top-right QR code overlay with an OSC-8 hyperlink.

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
  `matchesKey`, `Key.ctrl(...)`, `Key.shift(...)`.
- Verify the full API surface by reading
  `node_modules/@earendil-works/pi-tui/dist/index.d.ts` during scouting.

---

## 4. Research findings — the burden being eliminated (verify the counts/claims)

A prior analysis of `packages/tui/src/` found that **≈79% of the TUI code
(~1,780 of ~2,247 LOC) is manual mechanics**, and **~19% (~430 LOC) is genuine
domain logic**. Scout should re-derive these numbers with `grep`/`wc` and
report discrepancies:

| Manual mechanic (hand-rolled today)   | Evidence to verify                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Manual ANSI styling                   | Count literal `\x1b` occurrences (`rg -c '\\x1b' packages/tui/src`). Expect ~18, mostly in `theme.ts`.                                                                                  |
| Box/border drawing + inner-width math | `borderLine()` uses; `innerWidth = width - 2`; `│…│` row wrapping in `dashboard.render`.                                                                                                |
| Text truncation/wrapping to width     | Count `truncateToWidth` calls. Expect ~25. Plus `wrapTextWithAnsi`, `visibleWidth`.                                                                                                     |
| `invalidate()` + render caches        | Count `invalidate()` impls (expect 8), cross-call sites (expect ~13), and `dirty`/`cachedWidth`/`cachedLines` refs (expect ~61). `event-log.ts` reportedly maintains 4 parallel caches. |
| Scroll-offset engines                 | Count `scrollOffset` refs (expect ~51) across ~4 independent scrollers (EventLog, AgentLogWidget, TaskListWidget, + routing in Dashboard).                                              |
| Input routing                         | `WorkflowTUI.start()` 9-branch dispatcher; `Dashboard.handleInput` secondary routing; ordering-sensitive guards (Ctrl+D before the prompt guard; inspecting-vs-live Ctrl+C split).      |
| Layout/height computation             | `Dashboard.getComputedHeight()`; `terminal.rows - getComputedHeight() - 1` pushed into `eventLog.setMaxLines()`.                                                                        |
| Resize handling                       | **Verify the claim that there is NO resize / SIGWINCH listener anywhere** — this would be a latent bug (event-log height goes stale after window resize). `rg 'resize                   | SIGWINCH' packages/tui/src`. |

### 4.1 What a higher-level library eliminates vs preserves

- **Eliminated entirely** by Ink/flexbox: ANSI styling, box/border math,
  truncation/wrapping, `invalidate()`/caches, layout/height computation, and
  resize handling (flexbox re-flows automatically — **fixing the resize bug for
  free** if it exists).
- **Mostly absorbed** (offset arithmetic/clamping goes away; the _policy_
  survives): scroll-offset state, input routing.
- **Not eliminated — must be preserved/ported verbatim** (this is the
  crown-jewel domain logic): the **follow state machines** in
  `dashboard.ts` (phase-follow, task-follow + completion reselection via
  `isTerminalTaskStatus` + `pickMostRecentlyStartedActive`, step-follow with
  `userPinnedPhase`/`userPinnedStep`), `computeNextAgentStepIndex()` in
  `agent-log-widget.ts`, and the `toProjection()` mapping in `ws-backed-tui.ts`.
  This logic depends only on `@engms-haus/engin-shared` types/functions
  (`WorkflowProjection`, `isTerminalTaskStatus`, `pickMostRecentlyStartedActive`,
  `ClientStore`) — **verify those imports/exports** in `packages/shared/src`.

### 4.2 Maintenance hotspots to prioritize (verify they're as fragile as claimed)

1. `event-log.ts` — 4 caches kept in lockstep by comments, not types; multiple
   code paths in `addLine`; an "autoscroll drift fix."
2. `task-list-widget.ts` `_autoScrollToActive()` — hand-rolled difference-array
   with a documented "~2 rows suboptimal" approximation.
3. **Scroll-while-expanded** — `setSelectedStepIndex` deliberately guards a
   scroll-reset on `!expanded`; `Dashboard.handleInput` calls only
   `_agentLog.invalidate()` (not `_applySelectionToWidgets`) when expanded,
   with an inline `// IMPORTANT` comment explaining why.
4. Invalidate-ordering desyncs — every navigation path must manually
   `invalidate()` + `requestRender()` or the screen desyncs until the next store
   tick. (React's reactivity removes this entire class.)

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
  Shift+Tab→focusPrevious auto-wired. Verify.
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
   log. The locked decision is to use **`ink-scroll-view`** for that. **Verify
   `ink-scroll-view`'s maintenance status, latest version, API, and Ink peer
   compatibility.**

### 5.3 The blocker to validate FIRST — Bun + interactive Ink input

There is reportedly a **recurring, version-sensitive cluster of bugs** around
Ink's `useInput` / raw-mode under the Bun runtime:

- Bun issue **#6862** ("Ink not working properly") — `useInput` reportedly stops
  responding under Bun.
- Ink issue **#696** ("Compatibility issue with Bun 1.2") — raw-mode/stdin
  handling reportedly broke again, with fixes referencing "ensure raw mode is
  enabled only once" and "fix process.stdin.ref."

The workflow must **verify the project's exact Bun version** and **test keyboard
input under Bun early** (e.g. a minimal Ink app with `useInput` that echoes
keys). Report: does input work reliably on the project's Bun version? If not,
document the failure mode. This is the one risk that can invalidate the entire
migration.

### 5.4 Other Ink gotchas to verify

- `patchConsole` (default `true`) rewrites stdout to interleave `console.*` —
  may need `false` if raw writes are used.
- `exitOnCtrlC` (default `true`); set `false` to manage Ctrl+C manually (the
  current app has custom Ctrl+C behavior: graceful exit while inspecting,
  otherwise show the detach/kill prompt).
- Re-calling `render()` on the same stdout without `unmount()`/`cleanup()` is
  reportedly unsupported — one Ink instance per stream.
- TTY assumptions: in CI/non-TTY, Ink auto-detects and renders only the final
  frame; piped stdout loses interactivity.
- React 19 + Node 22 floor may force toolchain bumps — check against the
  project's `engines` / Node usage.

---

## 6. Domain behavior that MUST be preserved (do not regress)

Scout should confirm each of these is implemented today and the planner must
carry them forward into the Ink version:

- **Keybindings:** Ctrl+D (immediate detach, works even while prompt is shown),
  Ctrl+C (graceful exit while inspecting via `pauseForInspection`; otherwise
  show detach/kill prompt), Ctrl+Q (toggle top-right QR), ←/→ (phase nav),
  ↑/↓ (task nav when collapsed; scroll agent log when expanded),
  Tab/Shift+Tab (cycle steps in agent log), Space (expand/collapse agent log),
  Shift+↑/Shift+↓ (scroll by 10 when expanded), PgUp/PgDn/Home/End (scroll
  event log).
- **Follow rules:** phase-follow (only auto-advance when user was synced to the
  previous current phase and it advanced), task-follow (auto-select first active
  task; on completion transition re-select most-recently-started remaining
  active task), step-follow (follow `activeStepIndex` unless `userPinnedStep`
  or agent log expanded).
- **Overlays:** detach/kill prompt centered (shows `runId`, onConfirm dispatches
  detach vs kill, onDismiss closes); QR overlay anchored top-right, toggled by
  Ctrl+Q, pre-generated via `prepareQrCode()` for synchronous toggling.
- **`pauseForInspection(signal?)`** — keep the TUI open and navigable after run
  completion; resolves only on Ctrl+C (via main listener) or signal abort;
  Ctrl+D still detaches.
- **Lifecycle:** `start()`, `stop()` (cleans up listeners, hides overlays),
  `setRunId()`, `getEventLog()`, `getDashboard()`, async `prepareQrCode(url)`,
  async `showQrCode(url)`, async `pauseForInspection(signal?)`. Confirm the full
  public method set the CLI calls (scout the CLI imports).

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
  `ink-testing-library` (dev).
- Do not change `packages/shared` projection/follow helpers
  (`WorkflowProjection`, `isTerminalTaskStatus`, `pickMostRecentlyStartedActive`)
  — they are consumed as-is.

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
  rules, expand/collapse, scroll, overlays, Ctrl+C/D/Q handling).
- High-frequency WebSocket feed updates render without flicker
  (`incrementalRendering` on); terminal resize updates layout correctly (verify
  the resize bug, if present, is gone).
- All preserved domain behavior in §6 still works (manual checklist during
  review).

---

## 9. Suggested scouting targets (to speed up the scout phase)

- Read: every file in `packages/tui/src/` and `packages/tui/src/components/`.
- `node_modules/@earendil-works/pi-tui/dist/index.d.ts` — full API being replaced.
- `rg '@harms-haus/engin-tui' packages/cli/src` — public surface to preserve.
- `rg '@engin/shared' packages/tui/src` — shared deps the TUI relies on.
- `packages/shared/src` — `WorkflowProjection`,
  `isTerminalTaskStatus`, `pickMostRecentlyStartedActive`, `ClientStore`.
- `package.json`, `bunfig.toml`, `bun.lock` (root + `packages/tui`) — exact
  versions (Bun, React slot, Node engines).
- npm/GitHub for current versions + maintenance of: `ink`, `react`,
  `yoga-layout`, `ink-scroll-view`, `ink-testing-library`.
- Bun + Ink input issues (§5.3) — verify status against the project's Bun
  version.
