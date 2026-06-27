# Contributing & internals

How to build, test, lint, and navigate the engin codebase.

## Scripts

| Command                 | Description                                                            |
| ----------------------- | ---------------------------------------------------------------------- |
| `bun run build`         | Build the shared package (`tsc -b packages/shared`).                   |
| `bun test`              | Run all tests with `bun:test`.                                         |
| `bun run test:watch`    | Run tests in watch mode.                                               |
| `bun run test:coverage` | Run tests with coverage.                                               |
| `bun run typecheck`     | Type-check the workspace (`tsc -b packages/shared && tsc --noEmit`).   |
| `bun run lint`          | Run ESLint across the project.                                         |
| `bun run lint:fix`      | Auto-fix ESLint issues.                                                |
| `bun run format`        | Format all files with Prettier.                                        |
| `bun run format:check`  | Check formatting without writing.                                      |
| `bun run prepare`       | Install git hooks via `simple-git-hooks` (auto-runs on `bun install`). |
| `bun run setup`         | Build then run `engin init` to create config directories.              |

## Code quality

ESLint is configured via flat config in `eslint.config.js` using `typescript-eslint` with the
`recommended`, `strict`, and `stylistic` presets. Key configuration:

- **`@typescript-eslint/consistent-type-imports`** — enforces `import type` with separate
  import statements, aligning with `prettier-plugin-organize-imports`.
- **`@typescript-eslint/no-unused-vars`** — flags unused variables and parameters; `_`-prefixed
  names are ignored.
- **Bun globals** — `Bun` is registered as a readonly global.
- **`eslint-config-prettier`** — disables all ESLint rules that conflict with Prettier, applied
  last to ensure it takes effect.
- **`no-restricted-imports`** — enforces the package dependency rules: `shared` may not
  import Node builtins/Bun/React/pi; `tui` may not import `engine`; `web` may import only
  `shared`. See [Architecture → Dependency rules](concepts/architecture.md#dependency-rules).

Test files (`tests/**/*.ts`) relax `no-non-null-assertion`, `no-empty-function`, and
`no-explicit-any`.

## Formatting

Prettier is configured via `.prettierrc`:

| Setting      | Value                   |
| ------------ | ----------------------- |
| Print width  | 120                     |
| Quotes       | Single quotes           |
| Commas       | Trailing commas (`all`) |
| Arrow parens | Always (`(x) => x`)     |
| Indent       | 2 spaces                |
| Semicolons   | Always                  |
| End of line  | `lf`                    |

`prettier-plugin-organize-imports` runs as part of formatting and sorts/consolidates imports.

## Pre-commit hooks

`simple-git-hooks` and `lint-staged` are configured in `package.json` to run on `git commit`.
The pre-commit hook invokes `bunx lint-staged`, which applies targeted checks to staged files:

- **`.ts` files** — `eslint --fix` then `prettier --write`.
- **`.json` and `.md` files** — `prettier --write`.

Hooks install via `bun run prepare` (auto-run on `bun install`). Skip per-commit with
`git commit --no-verify`.

## CI/CD

A GitHub Actions workflow at `.github/workflows/ci.yml` runs on every push and pull request to
`main`. It runs the full quality pipeline in one job:

1. **Typecheck** (`bun run typecheck`)
2. **Lint** (`bun run lint`)
3. **Format check** (`bun run format:check`)
4. **Test** (`bun test`)

It uses `oven-sh/setup-bun@v2` with Bun dependency caching. All GitHub Actions are pinned to
specific commit SHAs (not tags) for supply-chain security.

Replicate CI locally:

```bash
bun run typecheck && bun run lint && bun run format:check && bun test
```

## TypeScript configuration

| Setting           | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| Target            | ES2024                                                       |
| Module            | ESNext (ESM, `.js` extensions in imports)                    |
| Strict mode       | enabled                                                      |
| Declaration files | emitted to `dist/`                                           |
| Path alias        | `@engin/shared`, `@engin/shared/*` → `./packages/shared/src` |

## Project structure

engin is a 5-package workspace rooted at `engin-workspace`. See
[Architecture](concepts/architecture.md#package-layout) for the full dependency rules.

```
engin/
├── packages/
│   ├── shared/         # PURE TS — types, protocol, evolve, EngineClient, ClientStore
│   ├── engine/         # THE SERVER + ALL EXECUTION (core/, pool/, tracking/, server/)
│   ├── tui/            # pi-tui CLIENT (WorkflowTUI, widgets, detach/kill prompt)
│   ├── cli/            # THE `engin` BINARY (@harms-haus/engin, published)
│   └── web/            # REACT CLIENT (zustand store, runs frame, components)
├── tests/              # Test files (cli/, core/, pool/, tracking/, server/, shared/, tui/, web/)
├── docs/               # This documentation library
├── scripts/            # Maintenance scripts (e.g. backfill-agents.ts)
├── package.json        # workspace root + shared scripts
├── tsconfig.json       # path aliases + project references
├── eslint.config.js    # import-boundary rules (no-restricted-imports)
├── bunfig.toml
└── bun.lock
```

## Test layout

Tests live in `tests/` and are organised by domain:

```
tests/
├── cli/         # parse-args, commands, sigint, session-selector, run/resume guards
├── core/        # agent-loop, agent-lifecycle, agent-plugin, agent-registry, config, phase-runner, phase-tasks, profile, structured-output, worktree-lifecycle, ...
├── pool/        # runner-pool, session, session-gate, runners/ (singleSession, linearRunner, reviewRunner, …), severity, validation, types
├── tracking/    # audit-log, event-store, evolve, task-status, workflow-status, workflow-serializer
├── server/      # daemon, run-manager, control-server, status-bridge, auth, bind-guard
├── shared/      # engine-client, client-store, protocol-types parity
├── tui/components/   # event-log, qr-overlay, dashboard, detach-kill-prompt, ...
├── web/         # store, hooks, components
├── scripts/     # backfill-agents
└── helpers/     # env-sandbox, make-profile, make-session, use-temp-dir, make-task
```

`bunfig.toml` configures `bun test` with `root = "."`. The web package has its own
`vitest` suite (`packages/web` → `npm run test`).

### Testing patterns

- **Helpers** in `tests/helpers/` (`make-profile`, `make-session`, `make-task`, `use-temp-dir`,
  `env-sandbox`) keep tests terse and deterministic.
- **Pure units** (`evolve`, `parseProfile`, `extractJsonFromText`) are tested in isolation.
- **`RunnerPool`** is tested with mock agent-plugin sessions to avoid real model calls; tests
  cover the drain-loop, `SessionGate` concurrency capping, runner resolution (`getRunnerForTask`
  - `beforeTask` hook), and the retry valve.
- **`runSession`** (the session primitive) is tested for idempotency (`.complete` sentinel +
  `result.json` checksum), watchdog timeout/escalation, and structured/text/filesystem output modes.
- **Composable runners** (`singleSession`, `linearRunner`, `reviewRunner`, `coalescingRunner`,
  `coordinatorRunner`) are tested in isolation against synthetic `RunnerContext` values.
- **Concurrency** tests (e.g. `session-gate`, `workflow-status-atomic-save`) cover the
  tricky timing/serialisation paths.

## Adding new profiles and workflows

Profiles and workflows are **user-authored** — they live in your config directories, not in
this repo. See [Authoring profiles](guides/profiles.md) and
[Building a new workflow](guides/building-workflows.md).

## Maintenance scripts

`scripts/backfill-agents.ts` reconstructs `spawnedAgents` in older `.engin-state.json` files
from their `audit/audit.jsonl` logs. Usage:

```bash
bun run scripts/backfill-agents.ts [--cwd <dir>] [--dry-run] [--force]
```

## Where to go next

- [Architecture](concepts/architecture.md) — the layer model and module responsibilities.
- [Building a new workflow](guides/building-workflows.md) — the main authoring guide.
