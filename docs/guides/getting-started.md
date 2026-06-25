# Getting started

This guide takes you from a fresh checkout to running your first workflow.

## Prerequisites

- **Bun** `>= 1.2.0` — used as both the runtime and the package manager. Install it from
  <https://bun.sh>.
- **API keys** for the provider(s) your profiles use. See
  [Configuration → API key resolution](../reference/configuration.md#api-key-resolution) for
  how engin finds them.

## Install

```bash
git clone <repository-url> engin
cd engin
bun install
bun run build
```

To make the `engin` command available globally, use the included helper script:

```bash
./install-global.sh          # install from this repo
./install-global.sh --force  # force reinstall
```

The script builds the package, installs it into Bun's global `node_modules`, links the
`engin` binary into `~/.bun/bin/`, and verifies that workflow scripts can import
`@harms-haus/engin`. Ensure `~/.bun/bin` is on your `PATH`.

## First-time setup

Create the config directory structure in your global config directory:

```bash
engin init
```

This creates `~/.config/engin/workflows/` (or `$XDG_CONFIG_HOME/engin/workflows/`). engin
ships no workflows — you author your own under this directory. See
[Building a new workflow](building-workflows.md).

## Run a workflow

Once you have authored a workflow (say, `apidoc`), run it by name with a task prompt:

```bash
engin apidoc "Generate API reference docs for the public exports of src/"
```

Useful flags:

```bash
engin apidoc "Generate API docs" \
  --cwd ./my-project \
  --max-concurrent 5 \
  --verbose
```

| Flag                       | Meaning                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `--cwd <path>`             | Project working directory (default: current directory).                      |
| `--work-dir <path>`        | Directory for workflow state. Default: `.engin/work/<timestamp>-<workflow>`. |
| `--max-concurrent <n>`     | Maximum parallel agents (default: `5`). Must be a positive integer.          |
| `--verbose`                | Verbose console output. Disables the TUI dashboard when stdout is a TTY.     |
| `--api-key <provider=key>` | Provider → API key override (repeatable). Visible in process listings.       |
| `--host <host>`            | _Deprecated for `run`._ Bind host — use `engin server up --host` instead.    |
| `--lan`                    | _Deprecated for `run`._ Bind all interfaces — use `engin server up --lan`.   |
| `--port <port>`            | Web server port (default: `3619`).                                           |

> **Worktrees are automatic.** Every git-repo run uses git worktrees by default — there is
> no `--worktree` flag. Each task gets its own worktree on `engin/{mainSlug}--{taskId}` so
> concurrent tasks are isolated. At the end of the run you are asked whether to squash-merge
> the run's branch back into `main`. Non-git runs warn and prompt to continue in-place.
> Put a `.worktreecopy` file at the repo root to tell engin which `.gitignore`d files
> (`.env`, `node_modules`, …) each worktree needs. See
> [Worktrees reference](../reference/worktrees.md).

### Starting runs

The only way to start a run is explicitly: `engin run <workflow-name> <task prompt>`.
See the [CLI reference](../reference/cli.md) for the full command list (including
`engin server up/down/status`) and exit codes.

## Programmatic quick start

You can also drive engin from TypeScript without the CLI:

```typescript
import {
  loadProfilesFromDirs,
  promptForStructured,
  requireAgentPlugin,
  resolveProfilesDirs,
} from '@harms-haus/engin-engine';
import { z } from 'zod';

const cwd = '/path/to/project';
const profilesDirs = resolveProfilesDirs(cwd, 'apidoc');

const profiles = await loadProfilesFromDirs(profilesDirs);
const profile = profiles.get('scout');
if (!profile) throw new Error('scout profile not found');

const session = await requireAgentPlugin(profile.agent).createSession({ profile, cwd });
try {
  const Files = z.object({ files: z.array(z.string()) });
  const { result } = await promptForStructured(session, 'List the public entry points.', Files);
  console.log('Files:', result.files);
} finally {
  session.dispose();
}
```

See the [programmatic API reference](../reference/api.md) for every available function.

## Where to go next

- [Building a new workflow](building-workflows.md) — author your first end-to-end workflow.
- [Authoring profiles](profiles.md) — the Markdown format for agent profiles.
- [Worktrees reference](../reference/worktrees.md) — the per-task worktree system and `.worktreecopy`.
- [Configuration](../reference/configuration.md) — config directories, `.env`, and API keys.
