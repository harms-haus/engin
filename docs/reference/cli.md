# CLI reference

The `engin` binary is the published entry point (`@harms-haus/engin`). It is a
**client** of the long-lived engine server daemon. Every run is submitted to the
server; the CLI attaches a view (TUI or stdout renderer) that consumes the run's
event stream over WebSocket, blocks until the run reaches a terminal state, then
exits — leaving the server running.

```
engin <command> [options]
```

## Commands

| Command                 | Description                                                                     |
| ----------------------- | ------------------------------------------------------------------------------- |
| `run <workflow> <task>` | Auto-start the server if down, submit the run, attach, block to terminal state. |
| `resume [session]`      | Resume/attach to a past or active workflow run.                                 |
| `init`                  | Create the config directory structure in the global config directory.           |
| `server up`             | Start the engine server daemon (idempotent).                                    |
| `server down`           | Stop the engine server daemon (warns about active runs unless `--force`).       |
| `server status`         | Report whether the server is running and on which port.                         |
| `--help` / `-h`         | Show usage.                                                                     |
| `--version` / `-v`      | Show version.                                                                   |

> The `run` keyword is implicit — `engin apidoc "Do the thing"` runs the `apidoc`
> workflow (there is no literal `run` token). Running `engin` with no positional
> arguments is treated as `run` with no workflow name, which errors with a usage
> message.

## `run`

```bash
engin <workflow-name> <task-prompt> [options]
```

### What it does

1. **Ensure server up.** Probe `GET /health` on the configured `--port` (default
   3619). If down, auto-start the daemon detached and wait for readiness (polling
   `/health` with a timeout). If it fails to come up, error clearly.
2. **Submit.** Connect an `EngineClient` over WebSocket to `ws://127.0.0.1:<port>/ws`
   and send `start_run { workflowName, taskPrompt, cwd, workDir?, maxConcurrent?,
apiKeys? }`. Receive `run_started { runId, summary }` (the client is
   auto-subscribed to the run). Note: `summary.worktree` is populated
   asynchronously by the run executor (after an LLM-generated branch slug +
   worktree setup), so it is NOT present on the initial `run_started` message;
   it appears on later `runs` list broadcasts once setup completes.
3. **Attach the view.**
   - **TTY** (and not `--verbose`): render the TUI dashboard (`WorkflowTUI`) driven
     by a `ClientStore` fed from the `EngineClient`. The QR overlay points at the
     server's web URL (`http://127.0.0.1:<port>/`).
   - **non-TTY** or `--verbose`: render formatted event lines to stdout from the WS
     event/`log` stream via the stdout renderer (a `ClientStore` subscriber).
4. **Block** until `run_complete` / `run_failed` for `runId`. Transient WS drops are
   handled by reconnect/backoff + `resync` + a "reconnecting…" banner (TUI). If the
   server is truly gone, the CLI errors out.
5. **Post-run.** On terminal state, when the run captured a worktree (every git-repo
   run does), run the interactive **two yes/No prompt** final merge client-side and
   send the chosen `worktree_action` (`merge` / `resolve` / `decline`) to the server.
   Non-git runs have no worktree and skip the prompt entirely.
6. **Exit.** The server keeps running. The client flushes nothing — durability is
   the server's job.

There is **exactly one execution path: the server**. Non-TTY `engin run` does not
fall back to in-process execution; it submits to the server and renders the
resulting stream to stdout.

> **Worktrees are automatic.** Every git-repo run uses worktrees by default — there
> is no `--worktree` flag. The server creates a main worktree on `engin/{mainSlug}`
> and a per-task worktree on `engin/{mainSlug}--{taskId}` for each task. Non-git
> runs warn and prompt to continue in-place. See
> [Worktrees reference](worktrees.md).

### Flags

| Flag                       | Default                              | Description                                                                                         |
| -------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `--cwd <path>`             | `process.cwd()`                      | Project working directory.                                                                          |
| `--work-dir <path>`        | `.engin/work/<timestamp>-<workflow>` | Directory for workflow state persistence (forwarded to the server).                                 |
| `--max-concurrent <n>`     | `5`                                  | Maximum parallel agents. Must be a positive integer.                                                |
| `--verbose`                | off                                  | Verbose stdout output (turn/tool detail). Disables the TUI when stdout is a TTY.                    |
| `--api-key <provider=key>` | —                                    | Provider → API key override (repeatable). Forwarded to the server. **Visible in process listings.** |
| `--port <port>`            | `3619`                               | Server port to connect to / auto-start. Integer in 1–65535.                                         |

> `--host` and `--lan` are **deprecated for `run`/`resume`** — server binding is
> `engin server up`'s concern. If passed to `run`/`resume`, a deprecation warning is
> emitted and they have no effect (the CLI always connects to `127.0.0.1`).

A value beginning with `--` (e.g. `--port --verbose`) is rejected as a missing
value. Unknown flags throw. `--help`/`-h` and `--version`/`-v` short-circuit before
flag validation.

The first time `--api-key` is used, a single warning is emitted to stderr:

> Warning: API keys passed via --api-key are visible in process listings. Consider
> using environment variables instead.

### Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| `0`  | Workflow completed successfully.                   |
| `1`  | Workflow failed, was killed, or an error occurred. |

### Disconnect semantics (TTY)

The attached TUI offers two ways to leave a run without stopping the server:

| Input                            | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+C`                         | Show the **detach/kill prompt** overlay (showing the `runId`). **Detach** (default) leaves the run running on the server and exits the client; **Kill** sends `cancel_run { runId }` and stays attached until terminal state is observed. Exception: after the run completes and `pauseForInspection()` is active (inspecting mode), Ctrl+C instead resolves the pause for a graceful exit — the detach/kill prompt is not shown. |
| `Ctrl+D`                         | **Detach immediately** (no prompt) — leave the run running, exit the client.                                                                                                                                                                                                                                                                                                                                                      |
| Esc / 2nd Ctrl+C (at the prompt) | Dismiss the prompt; the run is unaffected and the client stays attached.                                                                                                                                                                                                                                                                                                                                                          |

On detach, the client prints:

```
[hh:mm:ss] 🔌 Detached. Run <runId> is still active on the server. Re-attach with: engin resume <runId>
```

These inputs **never kill the server** and never affect other runs.

### SIGINT behaviour (non-TTY)

Non-TTY mode has no interactive prompt:

- **First Ctrl+C** — sends `cancel_run { runId }` and prints a message. The client
  stays alive until the terminal event arrives.
- **Second Ctrl+C** — force-quits the client immediately (exit code 1).

## `resume`

```bash
engin resume                  # interactive picker
engin resume <session-name>   # resume a specific run by name (or unique prefix)
```

Resume reads the task prompt and optional worktree info from the run's saved
`.engin-state.json`, then submits it to the server (which replays prior events
before continuing) and attaches the same view path as `run`.

### Interactive picker

With no `session-name`, the picker draws from **two sources, in this order**:

1. **Active / detached runs first** — runs currently in the server's active registry
   (queried via `list_runs`), shown with a 🟢 marker and a `RUNNING` / `COMPLETE` / `FAILED`
   label, above the historical list.
2. **Historical runs below** — runs found by the disk scan of `<cwd>/.engin/work/`
   that have a resumable `.engin-state.json` and are **not** active on the server.
   A `💾` marker means the run has a resumable state file.

A run that is both on disk and active appears **only** in the top (active) section,
never duplicated. Runs are matched by exact directory name, or by a unique prefix;
an ambiguous prefix throws, and no match throws with a hint to run `engin resume`
without arguments.

> **Known limitation.** Selecting an **active** run currently errors out — the code
> constructs a synthetic `PastRunEntry` with `hasStateFile: false`, which throws
> "does not have a resumable state file". The TODO to wire subscribe-only attach
> (so selecting an active run attaches to the live run instead of erroring) is not
> yet implemented (`packages/cli/src/cli/commands.ts`). Selecting a historical run
> resumes it as expected.

If the server is down, the picker shows only the historical (disk) list.

## `init`

```bash
engin init
```

Creates `~/.config/engin/workflows/` (the `workflows` subdirectory inside the global
config directory). No files are installed — workflows are user-managed. Safe to run
repeatedly. Unchanged from the single-process era (client-side config setup).

## `server`

### `engin server up`

```bash
engin server up [--port <port>] [--host <host>] [--lan]
```

Starts the engine server daemon. **Idempotent** — probes `/health` first and is a
no-op if the server is already up on the port. Prints the server URL and pid on
success.

| Flag     | Default     | Description                                                                |
| -------- | ----------- | -------------------------------------------------------------------------- |
| `--port` | `3619`      | Port to bind.                                                              |
| `--host` | `127.0.0.1` | Bind host.                                                                 |
| `--lan`  | off         | Bind on all interfaces. **Refused** until auth is implemented (see below). |

**`--lan` / wildcard host guard.** `--lan` (or `--host 0.0.0.0`, `::`, `*`) binds to
all network interfaces, which requires authentication that is not yet implemented.
The command refuses with a non-zero exit and a clear message:

> LAN binding (0.0.0.0 / --lan) requires authentication, which is not yet supported.
> The server is limited to localhost (127.0.0.1) bindings until auth is available.

This guard lives in the engine (`packages/engine/src/server/bind-guard.ts`) so it
covers every caller: `server up`, and the auto-start paths in `run`/`resume`.

### `engin server down`

```bash
engin server down [--force | -y]
```

Stops the daemon. If the server is alive with active runs and `--force` is not set,
prints the active-run count and prompts **y/N** for confirmation. On approval (or
with `--force`), it sends `SIGTERM` via the pidfile, waits up to 10 s, escalates to
`SIGKILL` if needed, and clears the pidfile. The daemon's shutdown hook cancels all
active runs and flushes their stores before the socket closes.

### `engin server status`

```bash
engin server status
```

Probes `/health` and prints whether the server is running and on which port.

## Worktrees (automatic for git repos)

There is no `--worktree` flag — worktrees are the default execution model for git
repositories. The server creates a main worktree on `engin/{mainSlug}` and a
per-task worktree on `engin/{mainSlug}--{taskId}` for each task, isolating
concurrent tasks. Full details — the layout, the branch-naming scheme, the
`.worktreecopy` spec, the merge/cull model, and the final-merge UX — live in the
[Worktrees reference](worktrees.md).

### Non-git fallback

When `--cwd` is not inside a git repository, `run` warns and prompts before
submitting:

```
Warning: '/path/to/cwd' is not a git repository. Continue without git and worktrees? [y/N]
```

- **Yes** → the run is submitted. The server detects non-git and runs in-place
  (no worktrees, no branches, no final merge prompt).
- **No** → the CLI aborts with a pointer to `git init`.

engin never auto-runs `git init`.

### Final merge UX (git-repo runs)

When a run reaches a terminal state and the client captured a worktree (every
git-repo run does), the CLI runs the two yes/No prompt final merge client-side.
Every action is sent to the server as a `worktree_action` (`merge` / `resolve` /
`decline`); the server performs the git operations and replies with a
`worktree_merge_result`.

1. **Prompt 1 — "Merge into main? yes/No"**
   - **yes** → squash-merge the main-wt branch into real `main`. Clean merge →
     cleanup (remove worktrees + branches). Conflicts → **Prompt 2**.
   - **No** → preserve everything for manual merge (paths surfaced).
2. **Prompt 2 — "Conflicts exist on the merge. Should engin handle it? yes/No"**
   - **yes** → the hardened conflict resolver runs (tool-using agent + self-verify).
     Resolved → cleanup. Failed → preserve everything.
   - **No** → `git merge --abort` and preserve everything.

Cleanup runs **only** after a successful merge. A "No" at either prompt means
"the user will handle it manually," **not** "discard the changes" — worktrees and
branches are preserved.

If the client detaches mid-run, the worktree is **left in place** for a later
client to act on.

## Where to go next

- [Server reference](server.md) — the daemon, `RunManager`, the multi-run protocol.
- [Worktrees reference](worktrees.md) — the per-task worktree system, `.worktreecopy`,
  and the final merge UX.
- [TUI reference](tui.md) — the terminal view and the detach/kill prompt.
- [Web reference](web.md) — the React client and runs frame.
