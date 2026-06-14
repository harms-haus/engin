# Contributing & internals

How to build, test, lint, and navigate the engin codebase.

## Scripts

| Command                 | Description                                                            |
| ----------------------- | ---------------------------------------------------------------------- |
| `bun run build`         | Compile TypeScript to `dist/`.                                         |
| `bun test`              | Run all tests with `bun:test`.                                         |
| `bun run test:watch`    | Run tests in watch mode.                                               |
| `bun run test:coverage` | Run tests with coverage.                                               |
| `bun run typecheck`     | Type-check without emitting.                                           |
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

| Setting           | Value                                     |
| ----------------- | ----------------------------------------- |
| Target            | ES2024                                    |
| Module            | ESNext (ESM, `.js` extensions in imports) |
| Strict mode       | enabled                                   |
| Declaration files | emitted to `dist/`                        |
| Path alias        | `@engin/*` → `./src/*`                    |

## Project structure

```
engin/
├── src/                # Source code
│   ├── core/           # Core primitives (profiles, config, harness, runStepTask)
│   ├── cli/            # CLI command machinery
│   ├── pool/           # LanePool + step execution + retry
│   ├── tracking/       # Event store, reducer, task tracker, persistence
│   ├── tui/            # Terminal dashboard
│   └── web/            # Observer server + protocol
├── web/                # React web mirror frontend
├── tests/              # Test files mirroring src/ structure
├── docs/               # This documentation library
├── scripts/            # Maintenance scripts (e.g. backfill-agents.ts)
├── package.json
├── tsconfig.json
├── bunfig.toml
└── bun.lock
```

## Test layout

Tests are co-located in `tests/` and mirror `src/`:

```
tests/
├── core/        # agent-loop, config, harness-factory, phase-tasks, profile, structured-output, ...
├── pool/        # lane-pool, step-execution, prompt-builder, severity, validation, types
├── tracking/    # audit-log, event-store, evolve, task-status, workflow-status, workflow-serializer
├── tui/components/   # event-log, qr-overlay, dashboard, ...
├── scripts/     # backfill-agents
└── helpers/     # env-sandbox, make-profile, make-session, use-temp-dir, make-task
```

`bunfig.toml` configures `bun test` with `root = "."` and ignores `web/**`.

### Testing patterns

- **Helpers** in `tests/helpers/` (`make-profile`, `make-session`, `make-task`, `use-temp-dir`,
  `env-sandbox`) keep tests terse and deterministic.
- **Pure units** (`evolve`, `parseProfile`, `extractJsonFromText`) are tested in isolation.
- **`runStepTask` and `LanePool`** are tested with mock `PromptableHarness`-shaped sessions to
  avoid real model calls.
- **Concurrency** tests (e.g. `lane-pool-wait-pattern`, `workflow-status-atomic-save`) cover the
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
