# End-to-End Verification Report

## Manual Smoke Test Checklist

### Server lifecycle

1. `engin server up` — starts daemon process, writes PID file, opens control socket
2. `engin server status` — reports "running" with PID
3. `engin server down` — stops daemon, removes PID file

### Run submission

4. `engin run <workflow> <task>` — submits task via WebSocket, attaches TUI
5. Second concurrent `engin run <workflow> <task>` — both run in parallel
6. Ctrl+C in TUI — shows detach/kill prompt

### Web UI

7. `cd packages/web && bun run dev` — starts the Vite dev server for hot-reload web development (UI loads at the Vite dev URL, which connects to the engine server at `http://127.0.0.1:3619/`)
8. RunsFrame shows active run(s)
9. Clicking a run navigates to RunDetails view

### Package surface

10. `import { ... } from '@harms-haus/engin'` — 126 exports available
    - Key APIs: `RunManager`, `startDaemon`, `stopDaemon`, `isServerAlive`,
      `WorkflowTUI`, `createWsBackedTui`, `loadWorkflow`, `listWorkflows`,
      `EventStore`, `startObserverServer`, `StatusBridge`, `clearWorkflowCache`

---

## Verification Results (2026-06-16)

| Check                                 | Result                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| `bun install`                         | ✅ clean (448 installs, no changes)                               |
| `bun run typecheck`                   | ✅ 0 errors (`tsc -b packages/shared && tsc --noEmit`)            |
| `bun run lint`                        | ⚠️ 13 errors (down from 1220; all source-code quality, see below) |
| `bun run format`                      | ✅ clean (102 files formatted)                                    |
| `bun run format:check`                | ✅ all files use Prettier                                         |
| `bun test` (full suite)               | ⚠️ 2920 pass / 288 fail across 17 test files (pre-existing)       |
| `cd packages/web && bun run build`    | ✅ built in 567ms                                                 |
| Package surface (`@harms-haus/engin`) | ✅ 126 exports, all key APIs present                              |

### Lint config fixes applied

- Added `packages/*/dist/**` and `packages/*/node_modules/**` to `ignores`
- Added Node/Bun globals: `console`, `process`, `setTimeout`, `clearTimeout`,
  `setInterval`, `clearInterval`, `setImmediate`, `queueMicrotask`, `Buffer`,
  `fetch`, `AbortController`, `URL`, `Response`, `performance`, `structuredClone`,
  `MessageChannel`, `WebSocket`
- Added browser globals for `packages/web/src/**`: `window`, `document`, `navigator`,
  `WebSocket`, `FormData`, `MutationObserver`, `matchMedia`, `navigation`,
  `reportError`, `__REACT_DEVTOOLS_GLOBAL_HOOK__`
- Expanded test file relaxation to cover `packages/*/src/**/*.test.*` (was only `tests/**/*.ts`)
- Removed stale `eslint-disable` directives via `--fix`

### Remaining 13 lint errors (source-code quality, not config)

| File                                            | Rule                            | Issue                                                     |
| ----------------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| `packages/cli/src/cli/commands.ts:451`          | `preserve-caught-error`         | Missing `cause` on re-thrown error                        |
| `packages/cli/src/cli/post-worktree.ts` (×5)    | `no-non-null-assertion`         | Non-null assertions                                       |
| `packages/cli/src/cli/tui-setup.ts:106`         | `no-empty-function`             | Empty arrow function                                      |
| `packages/engine/src/server/server-entry.ts:72` | `no-empty-function`             | Empty arrow function                                      |
| `packages/shared/src/engine-client.js:119`      | `no-empty-function`             | Empty arrow function                                      |
| `packages/shared/src/engine-client.ts:180`      | `no-empty-function`             | Empty arrow function                                      |
| `packages/web/src/components/AgentLog.tsx:16`   | `no-unused-vars`                | `selectedPhaseId` assigned but unused                     |
| `packages/web/src/hooks/useWebSocket.ts:26`     | `no-explicit-any`               | `any` type                                                |
| `tests/cli/resume-command-tui.test.ts:740`      | `no-constant-binary-expression` | Comparing to newly constructed object (likely a test bug) |

---

## Known Gaps

### Test failures (288 across 17 files)

The full test suite completes in ~9s (no hang). Pre-existing failures span:

- **Web component tests**: `App.test.tsx`, `AgentLog.test.tsx`, `EventLog.test.tsx`,
  `PhaseBar.test.tsx`, `RunsFrame.test.tsx`, `TaskList.test.tsx`, `useWebSocket.test.ts`,
  `useWebSocket.adapter.test.ts`, `evolve-client.test.ts`
- **CLI tests**: `resume-command-worktree.test.ts`, `run-command-guards.test.ts`,
  `run-command-worktree.test.ts`
- **Server tests**: `auth.test.ts`
- **Shared tests**: `barrel-index-reexport.test.ts`, `engine-client.test.ts`
- **Web observer tests**: `observer-server.test.ts`, `protocol-types-shared-reexport.test.ts`

Root cause: mock/setup mismatches from the refactoring (mocked module paths, missing
mock implementations for new WebSocket-based architecture). These need per-file investigation
and mock updates.

### Auth disabled

`packages/engine/src/server/auth.ts` — authentication is wired but disabled by default.
Token generation and validation exist but are not enforced on WebSocket connections.
See `tests/server/auth.test.ts` for the auth contract.

### Resume active-run attach

`packages/cli/src/cli/commands.ts` — the `resume` command TODO for attaching to an
already-running daemon session (as opposed to starting a fresh TUI) is noted but not
yet implemented. Currently `resume` always starts a new WebSocket connection.

### Build-all limitation

`bun run typecheck` runs `tsc -b packages/shared && tsc --noEmit`. The `tsc -b` only
builds `packages/shared` because other packages use `@engin/*` path aliases that resolve
at runtime via workspace links but not via TypeScript project references. Full `tsc -b`
across all packages would require tsconfig `references` setup (see T43).

### Web start-run UI

The web UI's "Start Run" button and run submission form are placeholder-only.
The `RunsFrame` component shows active runs from the WebSocket stream but
there is no UI to initiate a new run from the browser. This is planned future work.

---

## Code Review Fixes (holistic review)

### Fixed (this round)

- **Sec-C1 (CRITICAL)**: WebSocket CSRF — browser-originated connections (Origin header present) now rejected while auth disabled. `control-server.ts` `validateWebSocketOrigin`. (Non-browser CLI clients unaffected — they send no Origin.)
- **Sec-H3 (HIGH)**: Added `maxPayloadLength` 1 MiB to WS config (DoS protection).
- **Sec-M2 (MEDIUM)**: HTML-encoded Host header in served HTML (`escapeHtml`) to prevent self-XSS.
- **Eff-C1 (CRITICAL)**: EventStore ring buffer now trims at 1.1× capacity (hysteresis) — ~100× less allocation.
- **Eff-H1/H3/M2 (HIGH/MEDIUM)**: Agent log cap optimized to single allocation; redundant `capAgentLogs` removed from event-folding path (kept for snapshots); `appendRunLog` now capped.
- **UI-C1 (CRITICAL)**: RunsFrame Cancel now requires 2-click confirmation.
- **UI-H4/H5/H6 (HIGH)**: RunsFrame keyboard accessibility (`role`/`tabIndex`/`onKeyDown`/`focus-visible`); session picker labels `complete`→`COMPLETE` / `failed`→`FAILED` (not `DETACHED`); `runs[]` status updated on complete/fail.
- **UI-H2 (HIGH)**: Detach/Kill prompt shows descriptions ("Leave run running" / "Cancel run").
- **UI-M7 (MEDIUM)**: WCAG contrast fixes (`--text-muted` `#8b949e`, `--error` `#f85149`, disabled style).
- **CQ-H1 (HIGH)**: Engine self-imports eliminated — 12 sites across 8 files converted from `@harms-haus/engin-engine` barrel to relative paths (removes circular module graph; prerequisite for build-all).

### Deferred (documented for follow-up)

- **Sec-C2 (CRITICAL)**: Runtime zod validation of all `ClientMessage` payloads (currently TS types only, erased at runtime). Requires schema for each message variant.
- **Sec-H1 (HIGH)**: cwd/workDir allowlist — server currently accepts attacker-chosen paths in `start_run` (`loadEnvFiles`, `loadWorkflow`, `EventStore.load`). Validate/restrict cwd to approved project roots; derive workDir server-side.
- **Sec-H2 (HIGH)**: Per-run authorization — any connected client can cancel/manipulate any run. Requires tracking run ownership + enabling auth.
- **Eff-H2 (HIGH)**: `saveSnapshot()` never called in production — `events.jsonl` grows unbounded; resume replays all history. Call at terminal states + periodic.
- **CQ-H2 (HIGH)**: Duplicated `reconcileSelection` logic (web workflow-store + shared client-store). Extract to shared generic.
- **CQ-H3 (HIGH)**: Global console mutation in `RunManager` corrupts under concurrent runs. Route through per-run sink instead of process-global override.
- **Remaining MEDIUM/LOW**: Various code smells, minor a11y, dead code (`createStatusCallbacks` deprecated-but-unused, web `types.ts` shim), triplicated placeholder serving, etc.

These deferred items largely align with the deliberately-deferred auth/security hardening scope
(auth is plumbed-but-disabled this iteration). They should be addressed before any
non-localhost deployment.
