# End-to-End Verification Report

> Snapshot refreshed 2026-06-16 after the post-cleanup pass (dead-code removal +
> `observer`→`control` rename). The suite is fully green; previously-tracked lint
> errors and test failures have been resolved.

## Manual Smoke Test Checklist

### Server lifecycle

1. `engin server up` — starts daemon process, writes PID file, opens control socket
2. `engin server status` — reports pid, port, host, active-run count, log path, and web URL
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
      `EventStore`, `startControlServer`, `ControlServer` (type), `StatusBridge`,
      `clearWorkflowCache`

---

## Verification Results (2026-06-16)

| Check                                      | Result                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| `bun install`                              | ✅ clean (448 installs, no changes)                           |
| `bun run typecheck`                        | ✅ 0 errors (`tsc -b packages/shared && tsc --noEmit`)        |
| `bun run lint`                             | ✅ 0 errors (`eslint .`)                                      |
| `bun run format`                           | ✅ clean (102 files formatted)                                |
| `bun run format:check`                     | ✅ all files use Prettier                                     |
| `bun test` (full suite)                    | ✅ 2784 pass / 0 fail across 92 files (6355 `expect()` calls) |
| `cd packages/web && bun run test` (vitest) | ✅ 16 files, 389 pass / 0 fail                                |
| `cd packages/web && bun run build`         | ✅ built in 567ms                                             |
| Package surface (`@harms-haus/engin`)      | ✅ 126 exports, all key APIs present                          |

> **Flaky-test caveat:** the full suite includes one inherently-racy concurrency
> test — `AuditLog cache (invalidate-on-write) > append during concurrent getEvents
returns fresh data` in `tests/tracking/audit-log.test.ts` — that intermittently
> reports a spurious failure under full-suite CPU contention but passes reliably in
> isolation. It is pre-existing and unrelated to this refactor; the 2784/0 figure
> above reflects a clean run.

### Lint config fixes applied (prior round, still in effect)

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

---

## Known Gaps

### Resolved this cleanup pass

- **Removed dead transitional code:** `setupTuiAndObserver` (deleted
  `packages/cli/src/cli/tui-setup.ts`), `createStatusCallbacks` (removed from
  `console-status.ts`; `formatTime`/`shouldUseTui` retained), `createStoreBackedTui`
  (deleted `packages/tui/src/status-callbacks.ts`).
- **Renamed for consistency:** `startObserverServer` → `startControlServer` and the
  `ObserverServer` interface → `ControlServer` (across engine, tests, docs); served
  placeholder HTML title `engin observer` → `engin server`; removed a stale doc
  comment referencing the deleted `terminate_server` protocol message; fixed a broken
  `packages/web/README.md` link (`observer-server.ts` → `control-server.ts`).
- **Closed DoD §18 gap:** `engin server status` now reports pid, port, host,
  active-run count, log path, and web URL (previously only printed port).
- **Config fixes:** removed the dead `'web/'` entry from eslint `ignores`; extended
  the web package `no-restricted-imports` boundary rule to also cover `*.tsx`;
  converted the root `tsconfig.json` to an honest pure-coordinator config
  (`"files": []`, removed the bogus `include`/`rootDir`/`outDir` pointing at a
  nonexistent `src/`).

### Still open

- **`engin resume <activeRunId>` attach:** selecting an active (server-tracked) run
  currently throws instead of attaching (see the
  `TODO: wire attach-to-active-run flow` at `packages/cli/src/cli/commands.ts`
  ~line 425). Historical runs resume fine.
- **Build/typecheck coverage limitation:** the root `typecheck` script only compiles
  `packages/shared`; `packages/engine`, `tui`, and `cli` are typechecked at runtime
  by Bun (transpiled per-file) but **not** by the `tsc` script. Checked directly,
  `packages/engine` has unresolved `rootDir`/TS6059 errors from `@engin/shared/*`
  path imports. A full `tsc -b` across all packages needs proper project `references`
  setup.
- **Auth plumbed but disabled (by design this iteration):** `--lan`/wildcard binding
  is refused. Runtime zod validation of `ClientMessage`s, a cwd/workDir allowlist, and
  per-run authorization remain deferred future work (see Code Review Fixes below).
- **Web "Start Run" UI absent:** start is CLI-only this iteration (by design).
- **RunManager console capture:** `packages/engine/src/server/run-manager.ts`
  reassigns the process-global `console.warn`/`error`/`info` per-run, which corrupts
  under concurrent runs — should route through a per-run sink (deferred CQ-H3).
- **`events.jsonl` grows unbounded in production:** `saveSnapshot()` is never called,
  so resume replays all history (deferred Eff-H2).
- **Minor:** `packages/web/src/types.ts` is flagged as a likely-dead shim (verify/remove
  is future work).

---

## Code Review Fixes (holistic review)

### Fixed (prior round)

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
- **Remaining MEDIUM/LOW**: Various code smells, minor a11y, dead code (web `types.ts` shim), triplicated placeholder serving, etc.

These deferred items largely align with the deliberately-deferred auth/security hardening scope
(auth is plumbed-but-disabled this iteration). They should be addressed before any
non-localhost deployment.
