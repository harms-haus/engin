# Configuration

engin discovers profiles and workflows from two locations, layers `.env` files, and resolves
API keys through a well-defined precedence chain. This document covers all of it.

## Config directory resolution

engin uses two config roots, with **local overriding global** on name conflicts.

| Scope      | Path                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------- |
| **Global** | `$XDG_CONFIG_HOME/engin/` — or `~/.config/engin/` when `XDG_CONFIG_HOME` is unset or empty. |
| **Local**  | `{cwd}/.engin/` — where `cwd` is the project directory.                                     |

### Directory structure

```
.engin/                          # Local (per-project)
├── workflows/                   # Workflow directories (each with main.ts)
│   └── apidoc/
│       ├── main.ts              # Workflow orchestrator
│       └── profiles/            # Agent profiles for this workflow
├── work/                        # Runtime state (auto-created)
│   └── 1718012345678-apidoc/    # One directory per run: {timestamp}-{workflow}
│       ├── .engin-state.json    # Persisted workflow state
│       ├── events.jsonl         # Append-only event log
│       ├── event-snapshot.json  # Optional projection snapshot
│       ├── audit/audit.jsonl    # Audit log
│       └── sessions/            # Persisted agent sessions
└── .env                         # Project-level env vars (git-ignored)

~/.config/engin/                 # Global (user-wide)
├── workflows/
│   └── apidoc/
│       ├── main.ts
│       └── profiles/
└── .env                         # User-level env vars
```

### Resolution order

For both profiles and workflows, the system searches both directories and **local wins** on a
name collision. The resolver functions return directories in override order (local first):

| Function                                 | Returns                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `resolveProfilesDirs(cwd, workflowName)` | `[localProfiles, globalProfiles]` — or `[]` when `workflowName` is omitted. |
| `resolveWorkflowsDirs(cwd)`              | `[localWorkflows, globalWorkflows]`.                                        |
| `getGlobalConfigDir()`                   | `$XDG_CONFIG_HOME/engin` or `~/.config/engin`.                              |
| `getLocalConfigDir(cwd)`                 | `{cwd}/.engin`.                                                             |

Workflow and profile names are validated against path traversal (`/`, `\`, `..` are rejected).

## Default work directory

When `--work-dir` is not specified, the CLI uses:

```
{cwd}/.engin/work/{Date.now()}-{workflowName}
```

Each run gets a unique directory with a millisecond timestamp prefix.

## Past runs

`scanPastRuns(cwd)` reads `{cwd}/.engin/work/` and returns entries matching
`/^(\d+)-(.+)$/`, sorted newest-first. Each entry reports:

| Field          | Description                                            |
| -------------- | ------------------------------------------------------ |
| `dirName`      | e.g. `"1718012345678-apidoc"`.                         |
| `fullPath`     | Absolute path.                                         |
| `workflowName` | Parsed workflow name (everything after the first `-`). |
| `timestamp`    | Parsed millisecond timestamp.                          |
| `hasStateFile` | Whether `.engin-state.json` exists.                    |

Returns `[]` if the directory does not exist.

## `.env` file loading

`loadEnvFiles(cwd)` runs **synchronously** before any command dispatch (except `help`/`version`).
It reads two files in order:

| Priority    | Path                            |
| ----------- | ------------------------------- |
| 1 (lowest)  | `~/.config/engin/.env` (global) |
| 2 (highest) | `{cwd}/.engin/.env` (local)     |

**Behaviour:**

- Local values override global values for the same key.
- Keys already set in `process.env` are **never overwritten** — `.env` files only fill gaps.
- Missing files are silently skipped.

It returns a `LoadEnvResult`:

| Field          | Description                                                                               |
| -------------- | ----------------------------------------------------------------------------------------- |
| `loadedFiles`  | `.env` files that existed and were parsed.                                                |
| `skippedFiles` | `.env` files that did not exist.                                                          |
| `keysSet`      | Variable names actually written to `process.env` (excludes already-set and blocked keys). |

### Blocked environment variables

The following names are **never** loaded from `.env` files, regardless of file contents:

```
NODE_OPTIONS
NODE_TLS_REJECT_UNAUTHORIZED
NODE_EXTRA_CA_CERTS
LD_PRELOAD
LD_LIBRARY_PATH
PATH
HOME
SHELL
```

### Verbose output

With `--verbose`, loaded paths are printed:

```
[12:34:56] 📄 Loaded .env: /home/user/.config/engin/.env
[12:34:56] 📄 Loaded .env: /path/to/project/.engin/.env
```

> Add `.engin/.env` to your project's `.gitignore`. Never commit `.env` files containing
> secrets.

## API key resolution

`createHarness` resolves credentials via `AuthStorage` in this priority order:

1. **Runtime overrides** — the `apiKeys` option passed to `createHarness` / a workflow's
   `run()`, or the `--api-key` CLI flag. Both call `setRuntimeApiKey` under the hood.
2. **Stored API keys** — explicit keys saved in `~/.pi/agent/auth.json`.
3. **OAuth tokens** — OAuth access tokens from `~/.pi/agent/auth.json` (auto-refreshed when
   expired).
4. **Environment variables** — provider-specific variables (e.g. `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`).
5. **Fallback resolver** — custom provider key resolvers defined in `models.json`.

> **Warning:** API keys passed via `--api-key` are visible in process listings. Prefer
> environment variables or the `apiKeys` programmatic option.

The standalone helpers `resolveApiKey(provider, customKeys?)` and
`resolveApiKeyOrThrow(provider, customKeys?)` resolve from custom overrides or env vars only.
They do **not** consult `auth.json` or OAuth — `createHarness` does.

## Resuming a workflow

If `.engin-state.json` exists in `workDir`, the workflow's `run()` can resume. The CLI's
`resume` command handles this end to end:

- It picks a run (interactive picker or by name/prefix).
- It throws if the run has no state file.
- It loads the task prompt and worktree info from the saved state.
- It constructs the `EventStore` via `EventStore.load(workDir)`, which replays the snapshot and
  `events.jsonl` to rebuild the projection before the workflow continues.

> **Clean break.** The event model and projection shape changed substantially in recent
> versions (new event types `phase_registered`, `task_registered`, `step_started`; new
> `PhaseEntity`/`StepEntity`/`TaskEntity` shapes). Old runs created with the previous event
> model will not resume correctly — `evolve()` cannot interpret legacy events against the new
> projection. Delete or archive old `work/` directories from prior versions.

## Where to go next

- [CLI reference](cli.md) — the `resume` command and flags.
- [Event store & status](event-store.md) — what gets persisted and how.
- [Building a new workflow](../guides/building-workflows.md) — author a workflow that resumes
  cleanly.
