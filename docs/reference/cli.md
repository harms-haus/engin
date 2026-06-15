# CLI reference

The `engin` binary supports a small set of commands. The first positional argument is usually
the workflow name; the second is the task prompt.

```
engin <command> [options]
```

## Commands

| Command                       | Description                                                           |
| ----------------------------- | --------------------------------------------------------------------- |
| `<workflow> <task>` (default) | Run a named workflow with a task prompt.                              |
| `init`                        | Create the config directory structure in the global config directory. |
| `resume [session]`            | Resume a past workflow run.                                           |
| (no arguments, in a TTY)      | Launch the interactive composer.                                      |
| `--help` / `-h`               | Show usage.                                                           |
| `--version` / `-v`            | Show version.                                                         |

The `run` keyword is implicit — `engin apidoc "Do the thing"` runs the `apidoc` workflow.

## `run`

```bash
engin <workflow-name> <task-prompt> [options]
```

Loads the workflow by name (local then global config), wires up status tracking, sets up the
TUI or verbose console output, and calls the workflow's `run(taskPrompt, options)`.

### Flags

| Flag                       | Default                              | Description                                                                      |
| -------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `--cwd <path>`             | `process.cwd()`                      | Project working directory.                                                       |
| `--work-dir <path>`        | `.engin/work/<timestamp>-<workflow>` | Directory for workflow state persistence.                                        |
| `--max-concurrent <n>`     | `5`                                  | Maximum parallel agents. Must be a positive integer.                             |
| `--verbose`                | off                                  | Verbose console output. Disables the TUI when stdout is a TTY.                   |
| `--worktree`               | off                                  | Run the workflow in a git worktree.                                              |
| `--api-key <provider=key>` | —                                    | Provider → API key override (repeatable). **Visible in process listings.**       |
| `--host <host>`            | `127.0.0.1`                          | Web server bind host.                                                            |
| `--lan`                    | off                                  | Bind on all interfaces (0.0.0.0) and auto-detect the LAN IP for QR code display. |
| `--port <port>`            | `3619`                               | Web server port (integer in 1–65535).                                            |

A value beginning with `--` (e.g. `--port --verbose`) is rejected as a missing value. Unknown
flags throw. `--help`/`-h` and `--version`/`-v` short-circuit before flag validation.

The first time `--api-key` is used, a single warning is emitted to stderr:

> Warning: API keys passed via --api-key are visible in process listings. Consider using
> environment variables instead.

### Exit codes

| Code | Meaning                          |
| ---- | -------------------------------- |
| `0`  | Workflow completed successfully. |
| `1`  | Workflow failed with an error.   |

## `init`

```bash
engin init
```

Creates `~/.config/engin/workflows/` (the `workflows` subdirectory inside the global config
directory). No files are installed — workflows are user-managed. Safe to run repeatedly.

## `resume`

```bash
engin resume                  # interactive picker
engin resume <session-name>   # resume a specific run by name (or unique prefix)
```

Lists past runs from `{cwd}/.engin/work/` (newest first, up to 20 shown) and lets you pick one.
A `💾` marker means the run has a resumable `.engin-state.json`. Runs are matched by exact
directory name, or by a unique prefix. An ambiguous prefix throws; no match throws with a hint
to run `engin resume` without arguments.

Resume reads the task prompt and optional worktree info from the saved state, then calls the
workflow's `run()` with the loaded `EventStore` so the dashboard replays prior events before
continuing.

## Interactive composer

Running `engin` with no arguments in a TTY opens an interactive editor. Type a slash command:

```
/apidoc Document the public API
```

Supported inline flags: `--verbose`, `--worktree`, `--max-concurrent <n>`. `Ctrl+Enter` inserts
a new line; `Enter` submits; `Ctrl+C` or `Escape` cancels.

## TUI vs console output

Output mode is decided by `shouldUseTui({ verbose, isTty: !!process.stdout.isTTY })` — the rule
is `!verbose && isTTY`. So:

- **TTY, not verbose** → the live dashboard (see [TUI reference](tui.md)).
- **TTY, verbose** → console output with turn/tool-call/token detail.
- **Non-TTY** (piped, CI) → console output at the non-verbose level.

In both console and TUI modes, events are recorded into the canonical `EventStore` so the web
mirror and resume both work.

### Console output (non-verbose)

```
[09:14:32] 🚀 Workflow started: "..." (resumed: false)
[09:14:32] 📝 Phase registered: Scouting
[09:14:32] 📦 Phase started: scouting (round 0)
[09:14:33] ⏳ Agent spawned: scout (profile: scout)
[09:14:45] ✅ Agent complete: scout
[09:14:46] ✅ Phase completed: scouting (13.1s)
...
[09:31:44] 🎉 Workflow complete in 1032.4s (14 agents)
```

### Console output (verbose)

Adds turn-level and tool-level lines:

```
[09:14:33] 🔄 Turn 1 started (agent: scout)
[09:14:33] 🔧 read({"path":"src/index.ts"}) (agent: scout)
[09:14:34] ✅ Tool result: read (agent: scout)
[09:14:35] 🧠 Let me analyse the file structure...
[09:14:35] 💬 I've found the relevant files.
[09:14:35] 📊 Tokens: 1520 in / 340 out
```

## SIGINT (Ctrl+C) behaviour

There are two Ctrl+C paths; exactly one is active depending on the output mode:

- **TUI mode** — the dashboard's raw-mode input listener handles Ctrl+C. The first press calls
  `abort()` on the run's `AbortController` (cooperative cancellation). The second press calls
  `process.exit(1)`.
- **Console mode** — a SIGINT handler does the same two-step dance, with log lines. After the
  first Ctrl+C a 5-second force-exit safety net starts; if graceful shutdown has not completed
  by then, the process exits with code 1. The second Ctrl+C exits immediately.

## Worktree runs

Pass `--worktree` to run inside a freshly created git worktree on a generated branch (sibling
of the repo root). After the workflow completes, engin prompts for a post-run action:

1. **Do nothing** — keep the worktree.
2. **Merge to main** — commit, merge into the detected main branch, resolve conflicts with an
   agent if any, then remove the worktree.
3. **Push and create PR** — commit, push, and run `gh pr create`.

The branch name is generated by an agent and sanitised to `[a-z0-9-]`. Files listed in a
`.worktreecopy` file at the repo root are copied into the worktree before the run (useful for
ignored config you still need).
