# @harms-haus/engin-tui

The terminal UI for **engin** workflow runs, built on [Ink](https://github.com/vadimdemedes/ink) (React 19 + Yoga) and layered over [`@harms-haus/ink-overlay`](https://github.com/harms-haus/ink-overlay) (overlay/input-capture) and [`ink-scroll-view`](https://github.com/sindresorhus/ink-scroll-view). It renders a `ClientStore` projection that is fed over a WebSocket by the shared `EngineClient`, not from an in-process store.

> This package was migrated from a retained-mode string-based TUI framework to Ink (React 19 + Yoga). For the full current architecture (widget tree, session-follow rules, input dispatch, disconnect semantics) see [`docs/reference/tui.md`](../../docs/reference/tui.md). This README covers the public contract and the non-obvious development setup only.

---

## Public surface

The **only stable, externally-facing contract** is the `WorkflowTUI` class and its `WorkflowTUIOptions`. Everything else in `src/` (components, hooks, `TuiStore`, `createWsBackedTui`) is internal.

```typescript
import { WorkflowTUI, type WorkflowTUIOptions } from '@harms-haus/engin-tui';
```

### `WorkflowTUI`

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

| Method                        | Description                                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                     | Build the Ink `App` tree, create a `TuiStore`, and enter the render loop. No-op if already running or no `clientStore` was supplied.                                                |
| `stop()`                      | Unmount the Ink tree, dispose the `TuiStore` (unsubscribe from `ClientStore`), and reset state. Safe to call repeatedly.                                                            |
| `prepareQrCode(url)`          | Pre-generate the QR overlay string (revealed on `Ctrl+Q`). Call before `start()` for a scrollback-safe first frame. No-op before `start()`.                                         |
| `showQrCode(url)`             | Prepare the QR and make it immediately visible.                                                                                                                                     |
| `pauseForInspection(signal?)` | Keep the TUI open and navigable after the run completes. Resolves only on `Ctrl+C` (via the Ink input handler) or `signal` aborting. Prints one hint line. `Ctrl+D` still detaches. |
| `getEventLog()`               | Returns the current event-log lines (a `string[]`).                                                                                                                                 |
| `getDashboard()`              | Returns the live `TuiStore` (or `null`).                                                                                                                                            |
| `setRunId(runId)`             | Update the run identifier (e.g. once `run_started` arrives) for display in the detach/kill prompt.                                                                                  |

### `WorkflowTUIOptions`

| Field            | Type                               | Default        | Description                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentLogLines?` | `number`                           | —              | Accepted for backward compatibility but **ignored** — never read. Agent-log row counts are governed by `layout-constants.ts` (`AGENT_LOG_COLLAPSED_LINES` / `AGENT_LOG_EXPANDED_LINES`).                                                              |
| `clientStore?`   | `ClientStore`                      | —              | The shared projection store the TUI syncs from. If omitted, `start()` is a no-op.                                                                                                                                                                     |
| `runId?`         | `string`                           | —              | Server run identifier, shown in the detach/kill prompt. Updateable later via `setRunId()`.                                                                                                                                                            |
| `onDetach?`      | `() => void`                       | —              | Invoked when the user chooses to detach (leave run on the server, exit the client).                                                                                                                                                                   |
| `onKill?`        | `() => void`                       | —              | Invoked when the user chooses to kill (cancel the run, then exit).                                                                                                                                                                                    |
| `renderFn?`      | `(node, options?) => Ink.Instance` | Ink's `render` | Custom render function; intended for tests that want to avoid spinning up a real terminal. `RenderFn` is **internal** (not re-exported from the package barrel); consumers writing tests can inline the signature `(node, options?) => Ink.Instance`. |

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

---

## Architecture overview

```
ClientStore (shared projection, fed by EngineClient over ws://)
  │  clientStore.subscribe(notify)
  ▼
TuiStore ── useSyncExternalStore bridge ──► Ink/React tree
  │  • drains workflowEventLog + runLog → eventLogLines (FIFO cap 10 000)
  │  • owns isLogExpanded-aware session-follow (overrides ClientStore's
  │    unconditional reconcileSelection)
  │  • holds UI-only state: expand/collapse, QR overlay, detach/kill prompt,
  │    inspecting flag
  ▼
App
  ├── EventLog                (scrollable workflow-level log)
  ├── separator
  ├── Dashboard
  │     ├── PhaseBar
  │     ├── TaskList
  │     └── AgentLog          (+ SessionTabBar, expands/collapses via Space)
  └── Overlays: DetachKillPrompt · QrOverlay
```

`App` mounts an internal `WorkflowInput` component (inside `OverlayHost`) that registers **two** `useInput` hooks:

1. **Always active** (`isActive: true`): `Ctrl+D` → `store.invokeDetach()`. Works even when an overlay captures input.
2. **Gated by `useInputCaptureState`** (`isActive: !isCaptured`): `Ctrl+C`, `Ctrl+Q`, arrow keys (phase/task nav), `Tab`/`Shift+Tab` (session cycle), `Space` (expand/collapse).

See [`docs/reference/tui.md`](../../docs/reference/tui.md) for the full keyboard map, widget internals, and disconnect/reconnect behaviour.

---

## Development setup — critical constraints

The TUI depends on three things that are **not** resolved through normal package.json wiring. Get them wrong and you'll see `'Invalid hook call'`, `'Cannot access Yoga before initialization'`, or empty test frames.

### 1. The `@harms-haus/ink-overlay` symlink

`packages/ink-overlay` is a **symlink** to `~/Documents/software/ink-overlay` — a separate git repo that is gitignored from engin. It is **not** a dependency in `package.json` (Bun's workspace resolver does not follow the symlink). Instead it is resolved via a TypeScript path alias declared in **both** `tsconfig.json` (root) and `packages/tui/tsconfig.json`:

```jsonc
// packages/tui/tsconfig.json
"paths": {
  "@engin/shared":       ["../shared/src/index"],
  "@engin/shared/*":     ["../shared/src/*"],
  "@harms-haus/ink-overlay": ["../ink-overlay/dist/index.js"]
}
```

To set up a fresh checkout:

```bash
# 1. clone the overlay repo next to engin
git clone <ink-overlay-url> ~/Documents/software/ink-overlay

# 2. symlink it into the workspace
ln -s ~/Documents/software/ink-overlay packages/ink-overlay

# 3. build dist/ so the path alias can resolve
( cd ~/Documents/software/ink-overlay && bun install && bun run build )
```

### 2. React singleton requirement

Ink-overlay's `node_modules` must resolve the **same** `react`, `react-reconciler`, `scheduler`, and `ink` instances as the engin root, or ink-overlay's hooks throw `Invalid hook call`. The engin workspace satisfies this by symlinking those packages from ink-overlay's `node_modules` back to engin's root:

```
~/Documents/software/ink-overlay/node_modules/react             -> engin/node_modules/react
~/Documents/software/ink-overlay/node_modules/react-reconciler  -> engin/node_modules/react-reconciler
~/Documents/software/ink-overlay/node_modules/scheduler         -> engin/node_modules/scheduler
~/Documents/software/ink-overlay/node_modules/ink               -> engin/node_modules/ink
```

**If you re-run `bun install` inside the ink-overlay repo, these symlinks are overwritten with real copies and must be re-established** (e.g. `rm -rf` the four directories and re-create the symlinks above).

### 3. Tests run serially

Ink's `render()` holds shared global state (Yoga). Under Bun's default `maxConcurrency` of 20 this produces `Cannot access 'Yoga before initialization` and empty `lastFrame()` output. The root `bunfig.toml` pins serial execution:

```toml
[test]
maxConcurrency = 1
pathIgnorePatterns = ["web/**", "packages/web/**", "packages/ink-overlay/**"]
```

`packages/ink-overlay` is excluded from `bun test` because it is a symlinked external repo with its **own** vitest runner (~380 timing-sensitive overlay/scene tests).

---

## Testing

- **Renderer**: [`ink-testing-library`](https://github.com/vadimdemedes/ink-testing-library) (works natively with Ink 7 / React 19). The shared harness in `src/test-harness.tsx` tries `ink-testing-library` first and falls back to a custom Ink `render()` + mock-stream harness if it returns empty/undefined frames (common for overlay-based components).
- **Runner**: `bun:test`.
- **Helpers**: `renderTest`, `renderWithHost` (wraps the tree in `<OverlayHost>`), `sendKey` (named keys like `'ctrlC'`, `'shiftTab'`, `'pgUp'` or raw escape sequences), and a re-exported `stripAnsi`.
- **Regression guard**: `src/bun-input-smoke.test.tsx` is a **permanent** regression test (not a temporary smoke test) that pipes every key escape sequence through Ink's stdin parser and asserts `useInput` fires with the correct `key` fields. It validates all 15 key categories under Bun.

---

## Scripts

This package has **no build step**. It exports raw `.tsx`/`.ts` from `src/` and relies on Bun's runtime JSX transform (`tsconfig.json` sets `"jsx": "react-jsx"`).

```bash
# Typecheck (no emit)
tsc --noEmit -p packages/tui/tsconfig.json

# Run tests (serial, from repo root)
bun test
```

---

## Exports

`src/index.ts` re-exports the public surface plus the component and theme modules for internal consumers:

```typescript
export * from './components/index.js'; // AgentLog, Dashboard, DetachKillPrompt, EventLog, PhaseBar, QrOverlay, TaskList, …
export * from './theme.js';
export { WorkflowTUI, type WorkflowTUIOptions } from './workflow-tui.js';
export { createWsBackedTui } from './ws-backed-tui.js';
export { TuiStore } from './tui-store.js';
```

Only `WorkflowTUI` and `WorkflowTUIOptions` are the stable consumer contract; the rest is internal and may change without notice.
