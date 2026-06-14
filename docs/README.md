# @harms-haus/engin

A script-based workflow engine for AI-driven development, built on top of [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

---

## 1. Overview

**engin** orchestrates multi-agent AI workflows for software development tasks. It uses `AgentSession` from `@earendil-works/pi-coding-agent` as its inference layer and provides a phase-based approach to breaking down, planning, implementing, and reviewing code changes.

Workflows and profiles are loaded dynamically from config directories — you create your own workflows and agent profiles and place them in `~/.config/engin/` (or `.engin/` for per-project config). Agent profiles are plain markdown files with YAML frontmatter, so you can customize agent behavior without touching code.

### Rigid Hierarchy: Workflow → Phases → Tasks → Steps

engin models execution as a **rigid four-level hierarchy**:

- A **Workflow** owns an ordered list of **Phases**. Phases execute one at a time; each phase must complete before the next begins.
- A **Phase** owns an ordered list of **Tasks** (its `taskIds`). Within a phase, tasks may run concurrently (via a `LanePool`) or one at a time (via `runStepTask`).
- A **Task** owns a linear sequence of **Steps** (its `steps`). Steps execute in order within a single task.
- A **Step** is fulfilled by exactly one **Agent** — every agent in the system is a step-of-a-task. There are no free-floating agents.

This structure is reflected everywhere: the event stream, the workflow projection, the TUI dashboard, and the web mirror all navigate the same hierarchy. A `PhaseEntity` lists its `taskIds`; a `TaskEntity` lists its `steps`; each `StepEntity` links to the `AgentEntity` that fulfils it via `agentKey`.

Key properties:

- **Rigid workflow → phases → tasks → steps hierarchy** — phases own ordered task lists; tasks own linear steps; every agent is a step-of-a-task. The hierarchy is enforced by the event model and the projection.
- **Dynamic workflow loading** — workflows are discovered from global and local config directories, loaded at runtime by name.
- **Layered config resolution** — profiles and workflows are resolved from `~/.config/engin/` (global) and `.engin/` (local), with local overriding global.
- **Agent profiles** are defined as markdown files with YAML frontmatter, making it easy to add or modify agents without touching code.
- **Structured output** is enforced via Zod schemas — every phase produces validated, typed data.
- **Task dependency tracking** uses a DAG with cycle detection, so tasks execute in topological order with configurable concurrency.
- **Full audit trail** — every agent start, end, decision, and error is logged to JSONL for post-hoc analysis.
- **Event-sourced status** — every status change is an append-only `EventRecord`; the in-memory `WorkflowProjection` is derived by a pure reducer. Both the TUI and web mirror subscribe to the same store.

---

## 2. Installation

### Prerequisites

- **Bun** >= 1.2.0 (used as both runtime and package manager)
- **API keys** for your configured provider(s); see [Configuration](#12-configuration) for details

### Install

```bash
git clone <repository-url> engin
cd engin
bun install
bun run build
```

### First-Time Setup

Create the config directory structure in your global config directory:

```bash
engin init
```

This creates the `workflows/` subdirectory inside `~/.config/engin/` (or `$XDG_CONFIG_HOME/engin/`). Workflows are user-managed — place your own workflow directories (each containing a `main.ts` entry point and an optional `profiles/` subdirectory for agent profiles) in `workflows/`.

---

## 3. Quick Start

### CLI

```bash
# Create config directory structure (first time only)
engin init

# Add your profiles and workflows to ~/.config/engin/

# Run a workflow by name (assuming you've created a "develop" workflow)
engin develop "Add input validation to all public API endpoints"

# Run with options (same assumption)
engin develop "Fix the login bug" \
  --cwd ./my-project \
  --max-concurrent 5 \
  --verbose
```

### Programmatic

```typescript
import { createHarness, loadProfilesFromDirs, resolveProfilesDirs } from '@harms-haus/engin';

const profilesDirs = resolveProfilesDirs('/path/to/project', 'my-workflow');
const profiles = await loadProfilesFromDirs(profilesDirs);

const profile = profiles.get('implementer');
if (!profile) throw new Error('implementer profile not found');

const { session, dispose } = await createHarness({ profile, cwd: '/path/to/project' });
try {
  await session.prompt('Add input validation to all public API endpoints');
  console.log('Done:', session.getLastAssistantText());
} finally {
  dispose();
}
```

---

## 4. CLI Reference

The `engin` binary supports several commands:

```
engin <command> [options]
```

### Commands

| Command            | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `run` (default)    | Run a named workflow with a task prompt                          |
| `init`             | Create config directory structure in the global config directory |
| `resume`           | Resume a past workflow run                                       |
| `--help` / `-h`    | Show usage information                                           |
| `--version` / `-v` | Show version                                                     |

### `run`

```bash
engin <workflow-name> <task-prompt> [options]
```

The `run` command keyword is implicit — the first positional argument is the workflow name and the second is the task prompt.

```bash
engin develop "Refactor the auth module"
```

### `init`

```bash
engin init
```

Creates the `workflows/` subdirectory inside the global config directory (`~/.config/engin/`). The command only ensures directories exist. Workflows are user-managed; see [Custom Workflows](#7-custom-workflows) for authoring guides.

### Flags

| Flag                       | Applies to     | Description                                                                                                                                                                                                   |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--cwd <path>`             | `run`          | Project working directory (default: `process.cwd()`)                                                                                                                                                          |
| `--work-dir <path>`        | `run`          | Directory for workflow state persistence. Default: `.engin/work/<timestamp>-<workflow-name>` inside `cwd`                                                                                                     |
| `--max-concurrent <n>`     | `run`          | Maximum parallel implementer agents (default: `5`). Must be a positive integer.                                                                                                                               |
| `--verbose`                | `all commands` | Enable verbose console output. When running in a TTY, this disables the TUI dashboard and uses console output instead. Shows `.env` file loading info and agent-level output (turns, tool calls, token usage) |
| `--worktree`               | `run`          | Run the workflow in a git worktree                                                                                                                                                                            |
| `--api-key <provider=key>` | `run`          | Provider → API key override. Repeatable. **Warning:** values are visible in process listings; prefer environment variables.                                                                                   |
| `--host <host>`            | `run`          | Web server bind host (default: auto-detect LAN IP)                                                                                                                                                            |
| `--port <port>`            | `run`          | Web server port (default: `3619`)                                                                                                                                                                             |

### Exit Codes

| Code | Meaning                         |
| ---- | ------------------------------- |
| `0`  | Workflow completed successfully |
| `1`  | Workflow failed with an error   |

### Example Output

Default (non-verbose) output shows workflow-level, phase-level, and task-level events:

```
[09:14:32] 🚀 Workflow started: "Add input validation to all public API endpoints" (resumed: false)
[09:14:32] 📝 Phase registered: Scouting
[09:14:32] 📦 Phase: scouting (round 0)
[09:14:33] ⏳ Agent scout-coordinator spawned (profile: scout)
[09:14:45] ✅ Agent scout-coordinator complete
[09:14:46] ⏳ Agent scout-0 spawned (profile: scout)
[09:15:02] ✅ Agent scout-0 complete
[09:15:02] ✅ Phase scouting done (30.1s)
[09:15:02] 📦 Phase: scouting_review (round 0)
...
[09:22:18] 📋 Task registered: "Add input validation to user routes" (phase: implementing, 2 steps)
[09:22:18] 📋 Task task-1: "Add input validation to user routes"
[09:22:35] Step 0 started: implement (task: task-1, agent: task-1)
[09:22:35] ✅ Task task-1 complete
...
[09:31:44] 🎉 Complete in 1032.4s (14 agents)
```

With `--verbose`, agent-level events are also shown:

```
[09:14:33] 🔄 Turn 1 started (agent: abc123)
[09:14:33] 🔧 Tool call: read (agent: abc123)
[09:14:34] ✅ Tool result: read (agent: abc123)
[09:14:35] 🧠 Let me analyze the file structure...
[09:14:35] 💬 I've found the relevant files. Let me read them.
[09:14:35] 🔧 read({"path":"src/index.ts"})
[09:14:35] 📊 Tokens: 1520 in / 340 out
```

---

## 5. Configuration Directory Resolution

engin discovers profiles and workflows from two locations, with **local overriding global** on name conflicts.

### Directory Locations

| Scope      | Path                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| **Global** | `$XDG_CONFIG_HOME/engin/` — or `~/.config/engin/` when `XDG_CONFIG_HOME` is unset or empty |
| **Local**  | `{cwd}/.engin/` — where `cwd` is the project directory                                     |

### Directory Structure

```
.engin/           # Local (per-project)
├── workflows/               # Workflow directories (each containing main.ts)
│   └── develop/             # One subdirectory per workflow
│       ├── main.ts          # Workflow orchestrator
│       ├── profiles/        # Agent profiles
│       ├── package.json
│       └── bunfig.toml
├── work/                    # Runtime state (auto-created)
│   └── 1718012345678-develop/  # One subdirectory per run: {timestamp}-{workflow-name}
│       └── .engin-state.json
│       └── audit/audit.jsonl
└── .env                     # Project-level environment variables (git-ignored)

~/.config/engin/  # Global (user-wide)
├── workflows/
│   └── develop/
│       ├── main.ts          # Workflow orchestrator
│       ├── profiles/        # Agent profiles
│       ├── package.json
│       └── bunfig.toml
└── .env                     # User-level environment variables
```

### Resolution Order

When loading profiles or workflows, the system searches both directories. On name conflict, the **local** entry wins:

```
resolveProfilesDirs(cwd, 'develop') → [
  "{cwd}/.engin/workflows/develop/profiles",   // local — higher priority
  "~/.config/engin/workflows/develop/profiles" // global
]
```

Profiles are scoped per-workflow. The `resolveProfilesDirs` function takes a `workflowName` argument and returns profile directories nested inside the corresponding workflow directory. The same pattern applies to workflows via `resolveWorkflowsDirs(cwd)`.

### Default Work Directory

When `--work-dir` is not specified, the CLI uses:

```
{cwd}/.engin/work/{Date.now()}-{workflowName}
```

Each run gets a unique directory with a millisecond timestamp prefix, allowing the UI to discover and display past runs.

---

## 6. Profiles

Agent profiles are markdown files with YAML frontmatter. The filename (without `.md`) becomes the profile's `id`.

### Where to Place Profiles

- **Global:** `~/.config/engin/workflows/{name}/profiles/*.md`
- **Local:** `{cwd}/.engin/workflows/{name}/profiles/*.md`

Profiles are scoped per-workflow. Local profiles override global profiles with the same ID within the same workflow.

### Format

```markdown
---
name: My Agent
provider: your-provider
model: your-model
thinkingLevel: medium
excludeTools:
  - write
  - edit
includeTools: []
---

You are a specialized agent. Your instructions go here.
This body text becomes the system prompt.
```

### Frontmatter Fields

| Field           | Required | Default                | Description                                                                      |
| --------------- | -------- | ---------------------- | -------------------------------------------------------------------------------- |
| `name`          | No       | Filename without `.md` | Human-readable display name                                                      |
| `provider`      | **Yes**  | —                      | AI provider identifier (e.g. `anthropic`, `openai`)                              |
| `model`         | **Yes**  | —                      | Model identifier within the provider                                             |
| `thinkingLevel` | No       | `"medium"`             | Model thinking depth. One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `excludeTools`  | No       | `[]`                   | Tool names to remove from the default set                                        |
| `includeTools`  | No       | `[]`                   | If non-empty, only these tools are included                                      |

### System Prompt Body

The markdown content after the frontmatter becomes the agent's system prompt. Use it to define the agent's role, output format, and behavioral constraints.

### Example: Read-Only Reviewer

```markdown
---
name: Code Reviewer
provider: your-provider
model: your-model
thinkingLevel: medium
excludeTools:
  - write
  - edit
---

You are a Code Reviewer agent. Evaluate code for correctness,
quality, and adherence to project conventions.

Output your review as structured JSON with fields:

- issues: array of { file, description, severity }
- quality_score: number 1-10
- approved: boolean
```

### User-Created Profiles

Profiles are user-created `.md` files placed in the config directories. There are no built-in profiles — you define the agents your workflow needs. See the [Frontmatter Fields](#frontmatter-fields) table and examples above for how to author them.

---

## 7. Custom Workflows

Workflows are JavaScript or TypeScript modules that export a `run` function. They are discovered by name from the config directories.

A workflow orchestrates the **workflow → phases → tasks → steps** hierarchy using three core primitives:

1. **Phase registration** — call `onStatus.onPhaseRegister({ id, label, icon })` at startup so the TUI and web mirror know which phases exist and in what order.
2. **Single-agent tasks** — call `runStepTask(opts)` to run one agent as a one-step task. It fires the full lifecycle (`onTaskRegister` → `onTaskStart` → `onAgentSpawn` → `onStepStart` → run → `onAgentComplete` → `onTaskComplete`).
3. **Concurrent multi-step tasks** — use a `LanePool` with a required `phaseId` and a `getStepsForTask` callback. Each claimed task runs its ordered steps; every step is one agent.

Every agent in the system is a **step-of-a-task**. There are no free-floating agents.

### The `WorkflowModule` Interface

```typescript
interface WorkflowModule {
  run(taskPrompt: string, options: WorkflowRunOptions): Promise<void>;
  name?: string;
  description?: string;
}
```

The default export (or the module itself) must have a `run` function. Optional `name` and `description` fields are for documentation.

### Where to Place Workflows

- **Global:** `~/.config/engin/workflows/`
- **Local:** `{cwd}/.engin/workflows/`

Workflows are directories containing a `main.ts` entry point. The workflow name is the directory name (e.g. `develop/main.ts` → `develop`). Hidden directories (starting with `.`) are skipped during discovery.

### Security

Workflow names cannot contain `/`, `\`, or `..` — this prevents path traversal attacks. The loader throws an error for invalid names.

### Registering Phases

At the top of your `run()` function, register every phase so the UI can render the phase bar before work begins. Pass `options.onStatus` (already wired by the engine to the [`EventStore`](#eventstore--event-sourced-status)):

```typescript
export async function run(taskPrompt: string, options: WorkflowRunOptions) {
  const { onStatus } = options;

  // Register phases in execution order
  onStatus?.onPhaseRegister?.({ id: 'scouting', label: 'Scouting', icon: '🔍' });
  onStatus?.onPhaseRegister?.({ id: 'planning', label: 'Planning', icon: '📋' });
  onStatus?.onPhaseRegister?.({ id: 'implementing', label: 'Implementing', icon: '🔨' });
  onStatus?.onPhaseRegister?.({ id: 'review', label: 'Review', icon: '✅' });

  // ... proceed to run each phase ...
}
```

Each `onPhaseRegister` call appends a `phase_registered` event, which adds a `PhaseEntity` to the projection. The TUI `PhaseBar` and web `PhaseBar` render these as clickable tabs.

### Single-Agent Tasks: `runStepTask`

`runStepTask` runs **one agent as a one-step task**. It is the simplest way to execute an agent that participates in the hierarchy — it fires `onTaskRegister` (with a single-step definition), `onTaskStart`, `onAgentSpawn`, `onStepStart`, runs the prompt, then `onAgentComplete` and `onTaskComplete`.

```typescript
import { runStepTask, resolveProfilesDirs } from '@harms-haus/engin';
import { z } from 'zod';

export async function run(taskPrompt: string, options: WorkflowRunOptions) {
  const { cwd, workDir, onStatus } = options;
  const profilesDirs = resolveProfilesDirs(cwd, 'my-workflow');

  onStatus?.onPhaseRegister?.({ id: 'scouting', label: 'Scouting', icon: '🔍' });
  onStatus?.onPhaseStart?.({ phase: 'scouting', round: 0 });

  const ScoutSchema = z.object({
    summary: z.string(),
    relevantFiles: z.array(z.string()),
  });

  const result = await runStepTask({
    profilesDirs,
    phaseId: 'scouting',
    taskId: 'scout-coordinator',
    title: 'Scout the codebase',
    stepName: 'scout',
    profileId: 'scout',
    cwd,
    onStatus,
    prompt: `Analyse the codebase for this task: ${taskPrompt}`,
    schema: ScoutSchema,
  });

  onStatus?.onPhaseComplete?.({ phase: 'scouting', durationMs: 0 });
  console.log('Scout result:', result);
}
```

`runStepTask` returns the validated structured output (when `schema` is provided) or the raw assistant text. On error it fires `onTaskRejected` before re-throwing. See [`RunStepTaskOptions`](#runsteptaskoptions) for all fields.

### Concurrent Multi-Step Tasks: `LanePool`

For phases that process multiple tasks in parallel, use a `LanePool`. The pool requires a `phaseId` (the phase whose tasks it processes) and a `getStepsForTask` callback that returns the ordered steps for each claimed task. **Every step is one agent.**

```typescript
import { LanePool, TaskTracker, resolveProfilesDirs } from '@harms-haus/engin';
import { z } from 'zod';

export async function run(taskPrompt: string, options: WorkflowRunOptions) {
  const { cwd, workDir, onStatus, maxConcurrentTasks } = options;
  const profilesDirs = resolveProfilesDirs(cwd, 'my-workflow');

  // ... planning phase produces a list of tasks ...

  onStatus?.onPhaseStart?.({ phase: 'implementing', round: 0 });

  const taskTracker = new TaskTracker();
  taskTracker.addTask({
    id: 'task-1',
    phaseId: 'implementing',
    title: 'Add input validation to user routes',
    prompt: '...',
    profile: 'implementer',
    files: ['src/routes/user.ts'],
    dependencies: [],
  });
  // ... add more tasks ...

  const ReviewSchema = z.object({
    approved: z.boolean(),
    feedback: z.string().optional(),
  });

  const pool = new LanePool({
    maxConcurrentLanes: maxConcurrentTasks ?? 5,
    profilesDirs,
    sessionBaseDir: `${workDir}/sessions`,
    cwd,
    phaseId: 'implementing', // REQUIRED — the phase this pool serves
    taskTracker,
    getStepsForTask: (task) => [
      { name: 'implement', profileId: 'implementer', isReadOnly: false },
      {
        name: 'review',
        profileId: 'reviewer',
        isReadOnly: true,
        schema: ReviewSchema,
      },
    ],
    onStatus,
    maxStepRetries: 5,
  });

  const result = await pool.run();
  onStatus?.onPhaseComplete?.({ phase: 'implementing', durationMs: 0 });
  console.log(`Completed: ${result.completedTasks}, Failed: ${result.failedTasks}`);
}
```

The `LanePool` fires `onTaskRegister` once per task (with the step definitions and `phaseId`) before spawning any agents, so the TUI and web mirror can render the full task layout immediately. Each step then fires `onStepStart` as it begins. On step rejection, the lane backs up to the previous step and retries (up to `maxStepRetries`); the review feedback is written to the task's `reviewFeedback` field and included in the next step's prompt.

See [`LanePoolOptions`](#lanepooloptions) for all fields.

### TypeScript Workflows

Each workflow is a directory with a `main.ts` entry point, loaded natively by the Bun runtime — no additional loader or transpilation step is needed.

---

## 8. Programmatic API

All types and functions below are exported from the top-level `@harms-haus/engin` entry point.

### Workflow Loading

#### `loadWorkflow(name, cwd): Promise<WorkflowModule>`

Dynamically load a workflow module by name. Searches local then global workflow directories, looking for `{name}/main.ts` inside each. Results are cached by resolved file path.

#### `listWorkflows(cwd): Promise<Array<{ name, source, path }>>`

List all available workflows across local and global directories. Returns entries sorted by name, then by source (local first).

#### `clearWorkflowCache(): void`

Clear the in-memory workflow module cache.

### Profile Loading

#### `loadProfiles(dirPath): Promise<Map<string, AgentProfile>>`

Load all `.md` files from a directory into a `Map` keyed by profile ID. Results are cached in-memory for the process lifetime. Throws if the directory does not exist.

#### `loadProfile(dirPath, profileId): Promise<AgentProfile>`

Load a single profile by ID from a directory. Uses the directory cache internally.

#### `loadProfileSingle(filePath): Promise<AgentProfile>`

Load a single profile directly from a `.md` file path. Bypasses the directory cache.

#### `loadProfilesFromDirs(dirs): Promise<Map<string, AgentProfile>>`

Load and merge profiles from multiple directories. Directories are processed in reverse order so that earlier entries (local) override later entries (global) on ID collision. Missing or non-directory paths are silently skipped.

#### `parseProfile(content, filename): AgentProfile`

Parse a markdown string with YAML frontmatter into an `AgentProfile`. Throws if `provider` or `model` is missing, or if `thinkingLevel` is invalid.

#### `clearProfileCache(): void`

Clear the in-memory profile cache.

### Harness Creation

#### `createHarness(options): Promise<{ session, sessionId, dispose }>`

Create a fully-wired `AgentSession` from an `AgentProfile`. Supports three session modes:

- **In-memory** (default) — `SessionManager.inMemory(cwd)`. Used when neither `sessionDir` nor `resumeSessionPath` is provided.
- **Persisted** — `SessionManager.create(cwd, sessionDir)`. Used when `sessionDir` is provided; session data is written to disk.
- **Resumed** — `SessionManager.open(resumeSessionPath, ...)`. Used when `resumeSessionPath` is provided; loads an existing session from disk.

Resolution steps: resolve model via `getModel()`, create `AuthStorage` via `AuthStorage.create()` (loads `~/.pi/agent/auth.json`) and apply caller-supplied `apiKeys` as runtime overrides via `setRuntimeApiKey`, build tool allowlist/denylist from profile, create `DefaultResourceLoader` with system prompt override, construct session via `createAgentSession()`, optionally subscribe to agent status events.

**`HarnessCreationOptions` fields:**

| Field                | Type                     | Description                                                                        |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `profile`            | `AgentProfile`           | The agent configuration                                                            |
| `cwd`                | `string`                 | Working directory for file operations                                              |
| `apiKeys?`           | `Record<string, string>` | Provider → API key overrides                                                       |
| `onAgentStatus?`     | `AgentStatusCallbacks`   | Callbacks for turn-level and tool-level events                                     |
| `sessionDir?`        | `string`                 | Directory for persisted session storage. Creates via `SessionManager.create()`     |
| `resumeSessionPath?` | `string`                 | Path to an existing session file for resumption via `SessionManager.open()`        |
| `agentId?`           | `string`                 | Override agent ID used in status callbacks. Defaults to sessionId if not provided. |

**Return fields:**

| Field       | Type           | Description                                                                        |
| ----------- | -------------- | ---------------------------------------------------------------------------------- |
| `session`   | `AgentSession` | The fully-wired agent session                                                      |
| `sessionId` | `string`       | Resolved session identifier                                                        |
| `dispose`   | `() => void`   | Teardown: unsubscribes from agent events and disposes the session. Always present. |

#### `createHarnessFromProfile(dirPath, profileId, options): Promise<{ session, sessionId, dispose }>`

Convenience wrapper: loads a profile from disk, then delegates to `createHarness`.

### Config Resolution

#### `getGlobalConfigDir(): string`

Returns the global config directory path. Uses `$XDG_CONFIG_HOME/engin` if set and non-empty, otherwise `~/.config/engin`.

#### `getLocalConfigDir(cwd): string`

Returns `{cwd}/.engin`.

#### `resolveProfilesDirs(cwd, workflowName?): string[]`

When `workflowName` is provided, returns `[localWorkflowProfilesDir, globalWorkflowProfilesDir]` — local first for override priority. Profiles are scoped per-workflow, nested inside `workflows/{workflowName}/profiles/` within each config directory. When `workflowName` is omitted, returns `[]`. Throws an `Error` if `workflowName` contains `/`, `\`, or `..` (path traversal prevention).

#### `resolveWorkflowsDirs(cwd): string[]`

Returns `[localWorkflowsDir, globalWorkflowsDir]` — local first for override priority.

#### `getDefaultWorkDir(cwd, workflowName): string`

Returns `{cwd}/.engin/work/{Date.now()}-{workflowName}`. Each invocation produces a unique path with a millisecond timestamp prefix.

#### `scanPastRuns(cwd): Promise<PastRunEntry[]>`

Scans `{cwd}/.engin/work/` for past run directories matching the pattern `{timestamp}-{workflowName}`. Returns entries sorted newest-first. Returns an empty array if the directory does not exist.

**`PastRunEntry` fields:**

| Field          | Type      | Description                                         |
| -------------- | --------- | --------------------------------------------------- |
| `dirName`      | `string`  | Directory name (e.g. `"1718012345678-develop"`)     |
| `fullPath`     | `string`  | Absolute path to the run directory                  |
| `workflowName` | `string`  | Parsed workflow name (e.g. `"develop"`)             |
| `timestamp`    | `number`  | Parsed millisecond timestamp                        |
| `hasStateFile` | `boolean` | Whether `.engin-state.json` exists in the directory |

#### `ensureDir(dirPath): Promise<void>`

Recursively creates a directory. Re-throws any errors.

#### `loadEnvFiles(cwd: string): LoadEnvResult`

Loads `.env` files from the global and local config directories, merges them (local overrides global), and sets keys into `process.env` only for variables not already defined. This is called automatically by the CLI before command dispatch, but can also be called programmatically.

- **Synchronous** — must complete before any command execution or env-dependent initialization.
- **Global path**: `~/.config/engin/.env` (or `$XDG_CONFIG_HOME/engin/.env`)
- **Local path**: `{cwd}/.engin/.env`
- **Precedence**: Existing `process.env` values are never overwritten.
- **Security**: A blocklist of dangerous runtime variables (`NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, etc.) is enforced — these are never loaded from `.env` files.

Returns a `LoadEnvResult` object:

| Field          | Type       | Description                                                                                                |
| -------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `loadedFiles`  | `string[]` | Paths of `.env` files that existed and were parsed                                                         |
| `skippedFiles` | `string[]` | Paths of `.env` files that did not exist                                                                   |
| `keysSet`      | `string[]` | Environment variable names actually written to `process.env` (excluding already-set keys and blocked vars) |

### Shared Utilities

#### `validateWorkflowName(name: string): void`

Throws an `Error` if the workflow name contains `/`, `\`, or `..` (path traversal prevention). Called internally by `loadWorkflow`, `resolveProfilesDirs`, and the CLI. Can be used by custom workflow loaders for consistent validation.

#### `isEnoentError(err: unknown): boolean`

Returns `true` when `err` is a non-null object with a `code` property equal to `'ENOENT'`. Used internally for graceful handling of missing files and directories.

#### `safeErrorMessage(err: unknown): string`

Returns `err.message` for `Error` instances, otherwise `String(err)`. Provides a safe way to extract a human-readable error message from `unknown` caught values.

#### `DEFAULT_TOOLS: readonly string[]`

Frozen array of the default tool names: `['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']`. Used by `createHarness` when the profile doesn't specify `includeTools`.

### Setup

#### `initDefaultConfig(): Promise<{ createdDirs: string[] }>`

Creates the `workflows/` subdirectory inside the global config directory (`~/.config/engin/`). No files are installed — workflows are user-managed. Takes no arguments.

Returns `{ createdDirs: string[] }` where `createdDirs` is `['workflows']` — the names of the directories that were ensured to exist.

### Structured Output

#### `promptForStructured<T>(harness, prompt, schema, options?): Promise<{ result: T; attempts: number }>`

Prompt a harness (any object satisfying `PromptableHarness`) and parse the response through a Zod schema. The harness's `getLastAssistantText()` is used to extract the response text. Retries up to `maxRetries` (default 3) with error feedback appended to the prompt. Returns `{ result: T; attempts: number }` — the Zod-validated data and the number of attempts made (1-based).

#### `extractJsonFromText(text): string | null`

Extract a JSON string from free-text model output. Tries fenced code blocks first, then bracket counting.

#### `schemaToString(schema): string`

Convert a Zod schema into a human-readable description string.

### Agent Loop Utilities

#### `agentLoopUntil(session, promptFn, conditionFn, options?): Promise<{ lastText, attempts }>`

Repeatedly prompt a session until `conditionFn` returns `true` or `maxAttempts` (default 10) is reached. The session must satisfy `{ prompt(text): Promise<void>, getLastAssistantText(): string | undefined }`. Returns `{ lastText: string | undefined, attempts: number }`.

#### `retryAgentUntil<T>(session, prompt, schema, options?): Promise<AgentLoopResult<T>>`

Convenience wrapper around `promptForStructured` that returns an `AgentLoopResult` envelope. Token tracking is not available — `totalTokens` is set to zero. The session must satisfy `PromptableHarness`.

#### `parallelAgents<T>(configs, promptFn, options?): Promise<PromiseSettledResult<T>[]>`

Sessions are created sequentially (with rollback on failure via `createSessionsWithCleanup`), then prompts run in parallel via `Promise.allSettled`. All sessions are disposed in a `finally` block. When `options.schema` is provided, each result is validated through `promptForStructured`; otherwise the raw `getLastAssistantText()` value is returned.

#### `sequentialAgents<T>(configs, promptFn, options?): Promise<T[]>`

Creates sessions and runs prompts sequentially, one at a time. Each session is created, used, and disposed immediately within the same loop iteration. Throws on the first failure.

### API Key Resolution

#### `resolveApiKey(provider, customKeys?): string | undefined`

Resolve from custom overrides (`customKeys[provider]`) or environment variables via `getEnvApiKey(provider)` from `@earendil-works/pi-ai`.

> **Note:** These are standalone utilities for lightweight key resolution without creating an `AuthStorage` instance. They **do not** check `~/.pi/agent/auth.json` or handle OAuth tokens. For full credential resolution, `createHarness` delegates to `AuthStorage.create()` instead (see [Environment Variables](#environment-variables)).

#### `resolveApiKeyOrThrow(provider, customKeys?): string`

Same as `resolveApiKey` but throws with a helpful error message including expected env var names.

### Re-exports from Dependencies

The following are re-exported from `@earendil-works/pi-coding-agent`:

- `AgentSession`, `SessionManager`, `DefaultResourceLoader`, `AuthStorage`

The following are re-exported from `@earendil-works/pi-ai` (not re-exported by pi-coding-agent):

- `Model` (type), `getModel`, `parseJsonWithRepair`

The following are re-exported from `@earendil-works/pi-agent-core` (not re-exported by pi-coding-agent):

- `ThinkingLevel` (type)

### Single-Agent Task Primitive

#### `runStepTask<T>(opts: RunStepTaskOptions): Promise<T>`

Run one agent as a one-step task. Implements the full task lifecycle:

1. Check abort signal (throws without callbacks if aborted).
2. Fire `onTaskRegister` with the single-step definition (name, profileId, isReadOnly).
3. Fire `onTaskStart`.
4. Load and adjust profile (strip `write`/`edit` if `isReadOnly`).
5. Create harness via `createHarness`.
6. Fire `onAgentSpawn` (with `phaseId`, `taskId`, `stepIndex: 0`).
7. Fire `onStepStart` (with `stepIndex: 0`).
8. Run the prompt (structured via Zod, or free-form).
9. In `finally`: fire `onAgentComplete`, dispose harness.
10. On error: fire `onTaskRejected` before re-throwing.
11. On success: fire `onTaskComplete` and return the result.

When `schema` is provided, returns the validated structured output cast to `T`. Otherwise returns `getLastAssistantText()` cast to `T`.

### Tracking

#### `AuditLog`

```typescript
class AuditLog {
  constructor(logDir: string);
  append(event: Omit<AuditEvent, 'timestamp'>): Promise<void>;
  getEvents(filter?: { taskId?: string; type?: string }): Promise<AuditEvent[]>;
  getEventsByTask(taskId: string): Promise<AuditEvent[]>;
  getStats(): Promise<{ totalEvents: number; totalCost: number; totalTokens: number }>;
  clear(): Promise<void>;
}
```

JSONL-backed audit log. Events are cached in-memory after first read; the cache is invalidated on each `append()`.

#### `TaskTracker`

```typescript
class TaskTracker extends EventEmitter {
  static readonly Events: { TaskReady: 'taskReady'; TaskSettled: 'taskSettled' };
  addTask(task: Omit<Task, 'status'> & { status?: TaskStatus }): void;
  getTask(id: string): Task | undefined;
  getAllTasks(): Task[];
  getReadyTasks(): Task[];
  claimTasks(count: number, agentId: string): Task[]; // ready → active
  completeTask(id: string): void; // active → complete
  failTask(id: string, result?: unknown): void; // active → failed
  rejectTask(id: string, reason: string): void; // active (stays), appends feedback
  cancelTask(id: string): void; // any non-settled → cancelled
  resetFailedTasks(): void; // failed → ready
  resetStuckTasks(): void; // active → ready
  resetForRetry(): void; // reset failed + stuck
  isPoolDone(): boolean;
  validateAllDependencies(): void;
  getTasksByPhase(phaseId: string): Task[];
  getPhases(): string[];
  recalculateStatuses(hintTaskId?: string): void;
  toJSON(): { tasks: Task[] };
  static fromJSON(data: { tasks: Task[] }, options?: { preserveState?: boolean }): TaskTracker;
}
```

Manages a DAG of tasks with enforced state transitions and cycle detection. `addTask` performs temporary insertion to check for cycles, rolling back if one is detected. Tasks require a `phaseId`.

**Task lifecycle (executor-side `Task.status`):**

```
blocked → ready → active → complete
                    │
                    ├─→ failed
                    └─→ (rejectTask: stays active, appends feedback, retries)
```

Any non-settled task can be cancelled (`→ cancelled`). Settled = `complete | failed | cancelled`.

> **Note:** `rejectTask` keeps the task `active` on the executor side (the lane already owns it and will retry). In the read-model projection, a `task_rejected` event maps to `failed`. These are two different views of the same lifecycle.

#### `WorkflowStatusTracker`

```typescript
class WorkflowStatusTracker {
  constructor(workDir: string, signal?: AbortSignal);
  // Getters
  get taskPrompt(): string;
  get currentPhaseId(): string;
  get completedPhaseIds(): string[];
  get phases(): { id: string; label: string; icon: string }[];
  get workflowData(): Record<string, unknown>;
  get stats(): { totalTokens; totalCost; agentCount };
  get taskTracker(): TaskTracker;
  get auditLog(): AuditLog;
  get spawnedAgents(): PersistedAgentRecord[];
  get worktree(): WorktreeInfo | undefined;
  // Mutators
  setTaskPrompt(prompt: string): void;
  setPhase(phaseId: string): void;           // push current → completed, set new current
  setCurrentPhase(phaseId: string): void;    // set current without completing previous
  registerPhase(info: { id; label; icon }): void;
  registerTask(info: { taskId; phaseId; title; dependencies }): void;
  setWorkflowData(updates: Record<string, unknown>): void;
  addTokensToStats(tokens: { input; output }): void;
  incrementAgentCount(): void;
  setWorktree(info: WorktreeInfo): void;
  recordAgentSpawn(...): void;
  recordAgentComplete(agentId: string): void;
  // Persistence
  toJSON(): WorkflowState;
  save(): Promise<void>;
  dispose(): void;
  static load(workDir: string): Promise<WorkflowStatusTracker>;
}
```

Top-level workflow state manager. Persists to `.engin-state.json` in the working directory. Auto-persists on task settled/ready events. Stores workflow-specific data (scouting reports, plan, research, etc.) in the generic `workflowData` bag.

### Task Pool

#### `LanePool`

```typescript
class LanePool {
  constructor(options: LanePoolOptions);
  run(): Promise<LanePoolResult>;
}
```

Concurrent task processing pool where N independent "lanes" (workers) claim tasks from a shared [`TaskTracker`](#tasktracker) and process them through configurable sequential steps. Every step is fulfilled by one agent — there are no free-floating agents.

**How it works:**

1. Fire `onTaskRegister` once per task (with `phaseId` and step definitions) so the UI gets the full task layout before any agents spawn.
2. Profiles are loaded once via [`loadProfilesFromDirs`](#loadprofilesdirsdirs) before spawning any lanes.
3. `maxConcurrentLanes` workers are spawned in parallel via `Promise.allSettled` (lane failures are isolated and don't crash sibling lanes).
4. Each lane runs a loop that claims a ready task from the shared [`TaskTracker`](#tasktracker) and processes it through the steps returned by `getStepsForTask`.
5. On step rejection, the lane backs up to the previous step and retries (up to `maxStepRetries`). The review feedback is written to the task's `reviewFeedback` field and included in the next step's prompt.
6. On agent crash (unhandled error), the lane fires `onError`, marks the task as failed, and moves on.
7. When no tasks are available but not all are done, lanes back off with exponential delay (50ms initial, capped at 2000ms).
8. All sessions are disposed in a `finally` block after each step completes.

Each step gets its own persisted session at `{sessionBaseDir}/{taskId}/{attempt}-{stepIndex}-{stepName}/`. Read-only steps automatically strip `write` and `edit` from the agent's toolset.

See [Concurrent Multi-Step Tasks: `LanePool`](#concurrent-multi-step-tasks-lanepool) for a usage example.

### TUI Dashboard

The TUI module provides a terminal user interface for workflow monitoring. When the CLI detects an interactive terminal (TTY) without `--verbose`, it uses `WorkflowTUI` to render a live dashboard instead of plain console output.

#### `WorkflowTUI`

```typescript
class WorkflowTUI {
  constructor(options?: WorkflowTUIOptions);
  start(): void;
  stop(): void;
  getEventLog(): EventLog;
  getDashboard(): Dashboard;
  prepareQrCode(url: string): Promise<void>;
  showQrCode(url: string): Promise<void>;
  pauseForInspection(signal?: AbortSignal): Promise<void>;
}
```

Top-level TUI lifecycle manager. Constructs the terminal, widget tree, and subscribes to an [`EventStore`](#eventstore--event-sourced-status) internally. The TUI does **not** expose `StatusCallbacks` — instead, the engine wires `createStoreCallbacks(store)` into the workflow's `onStatus`, and the TUI receives projection updates via store subscription.

**`start()`** — Initialises a `ProcessTerminal`, builds the widget tree (EventLog → separator → Dashboard), sets up input handling, overrides `console.warn`/`error` to route through the event log (`console.log` passes through unchanged), and starts rendering. No-op if already running.

**`stop()`** — Restores original `console` methods, unsubscribes from input, and stops the TUI. Safe to call multiple times.

**`prepareQrCode(url)`** — Pre-generates the QR overlay for the given observer URL. Call before `start()` so the overlay is ready instantly when toggled.

**`showQrCode(url)`** — Generates (if needed) and displays the QR code overlay for the given observer URL.

**`pauseForInspection(signal?)`** — Keeps the TUI alive after the workflow completes, allowing the user to inspect the final state. Resolves when `signal` fires or Ctrl+C/Escape is pressed.

**Keyboard shortcuts:**

| Key             | Action                                                           |
| --------------- | ---------------------------------------------------------------- |
| `Ctrl+C`        | First press: calls `abort()`; second: `process.exit`             |
| `←` / `→`       | Select phase (cycle through registered phases)                   |
| `↑` / `↓`       | Select task (when collapsed) or scroll agent log (when expanded) |
| `Tab` / `⇧Tab`  | Cycle steps/agents within the selected task (forward/backward)   |
| `Space`         | Expand/collapse the agent log widget                             |
| `⇧↑` / `⇧↓`     | Scroll agent log by 10 lines (expanded only)                     |
| `PgUp` / `PgDn` | Scroll event log up / down                                       |
| `Home` / `End`  | Jump to top / bottom of event log (resume auto-scroll)           |

Input is dispatched centrally by `WorkflowTUI`: Left/Right route to the `Dashboard` → `PhaseBar`; Up/Down route to the `Dashboard` (which delegates to `TaskListWidget` when collapsed or `AgentLogWidget` when expanded); Tab/Shift+Tab route to the `Dashboard` → `AgentLogWidget`; Space toggles `AgentLogWidget` expand; Shift+Up/Down route to the `AgentLogWidget` when expanded; PgUp/PgDn/Home/End route to the `EventLog`.

#### `WorkflowTUIOptions`

| Field            | Type         | Default | Description                                                                                                                                                                           |
| ---------------- | ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentLogLines?` | `number`     | `20`    | Collapsed height of the agent detail log (expanded shows 40 lines)                                                                                                                    |
| `abort?`         | `() => void` | —       | Callback invoked on first Ctrl+C; use to cancel the workflow run                                                                                                                      |
| `store?`         | `EventStore` | —       | The canonical [`EventStore`](#eventstore--event-sourced-status). When provided, the TUI subscribes to it and syncs widgets from the live [`WorkflowProjection`](#workflowprojection). |

#### `createStoreBackedTui(deps): { dispose: () => void }`

Factory that subscribes the TUI widgets to an [`EventStore`](#eventstore--event-sourced-status). It does **not** implement `StatusCallbacks` — instead, it subscribes to the store's projection via `store.subscribe()` and syncs all dashboard widgets from the projection.

On each store notification it:

1. Reads new events via `store.getEventsSince(lastSeq)` and writes human-readable lines into the `EventLog` (workflow/phase/agent/task lifecycle and error events), formatted by `formatWorkflowEventLine`.
2. Calls `dashboard.syncFromProjection(projection)` to push the current [`WorkflowProjection`](#workflowprojection) into the `PhaseBar`, `TaskListWidget`, and `AgentLogWidget`.
3. Calls `requestRender()` to trigger a TUI repaint.

Any events that were already in the store before subscription (e.g. from a resumed run's replay) are processed immediately on construction.

**`deps` parameter:**

| Field           | Type         | Description                                                      |
| --------------- | ------------ | ---------------------------------------------------------------- |
| `store`         | `EventStore` | The store to subscribe to                                        |
| `eventLog`      | `EventLog`   | The event log widget to write event-derived lines into           |
| `dashboard`     | `Dashboard`  | The dashboard whose child widgets are synced from the projection |
| `requestRender` | `() => void` | Trigger a TUI re-render after mutations                          |

Returns `{ dispose: () => void }` — call to unsubscribe from the store.

#### Widget Components

All widgets implement the `Component` interface from `@earendil-works/pi-tui` (`render(width): string[]`, `invalidate(): void`, `handleInput(data): void`).

##### `EventLog`

Scrollable log of timestamped event lines. Auto-scrolls to the bottom; supports PgUp/PgDn/Home/End navigation.

| Method         | Signature              | Description                                                                                  |
| -------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| `addLine`      | `(text: string): void` | Append a line. Oldest lines are pruned beyond `maxBufferLines` (5000).                       |
| `setMaxLines`  | `(n: number): void`    | Set the number of visible lines. Called by `WorkflowTUI.start()` to fit the terminal height. |
| `handleInput`  | `(data): void`         | Processes PgUp, PgDn, Home, End keys for scrolling.                                          |
| `totalLines`   | `number` (getter)      | Total lines in the buffer.                                                                   |
| `isScrolledUp` | `boolean` (getter)     | Whether the view is scrolled above the bottom.                                               |

When scrolled up, the first visible line is replaced with a dim indicator: `↑ N more lines above (PgUp/PgDn)`.

##### `PhaseBar`

Single-line phase progress indicator.

| Method                 | Signature                       | Description                                                                 |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `setPhases`            | `(phases: PhaseEntity[]): void` | Set the ordered list of phase entities.                                     |
| `setCurrentPhaseId`    | `(id: string): void`            | Highlight the given phase as current (cyan `●`). Clears the selected phase. |
| `setSelectedPhase`     | `(id: string): void`            | Underline the given phase (overlays the current highlight).                 |
| `setCompletedPhaseIds` | `(ids: string[]): void`         | Mark phases as completed (green `✓`).                                       |
| `setIndicator`         | `(icon: string): void`          | Prepend an icon (e.g. workflow emoji) before the phase segments.            |
| `handleInput`          | `(data): void`                  | Processes ←/→ arrow keys for phase selection.                               |

When no phases are set, renders just the indicator and/or current phase ID. Phase segments are joined with `│` separators.

##### `TaskListWidget`

Grid of tasks in the current phase, one row per task. Tasks are sorted by status priority (active first, then `ready`, `blocked`, and finally `complete`/`failed`/`cancelled`).

| Method                | Signature                     | Description                                                                             |
| --------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `updateTasks`         | `(tasks: TaskEntity[]): void` | Replace the full task list. Clears selection if the selected task is no longer present. |
| `setSelectedTaskId`   | `(id: string \| null): void`  | Highlight a task by ID (bold). No-op if the ID doesn't exist.                           |
| `getSelectedTaskId`   | `(): string \| null`          | Task ID of the selected task.                                                           |
| `getSelectedTask`     | `(): TaskEntity \| undefined` | The selected task from the sorted list.                                                 |
| `getVisibleTaskCount` | `(): number`                  | Number of tasks (determines rendered row count).                                        |
| `handleInput`         | `(data): void`                | Processes ↑/↓ arrow keys for task selection.                                            |

Active tasks with a known `activeStepIndex` show a step annotation (e.g. `step 1/2: implement`). Elapsed time is shown for active/settled tasks that have a `startedAt`.

##### `AgentLogWidget`

Detail view showing the log entries for the agent fulfilling the selected step of the selected task. The widget renders a step **tab bar** at the bottom — each tab is a step, marked as done (`✓`), active (`▶`), or pending (`○`), and clickable/cyclable via Tab/Shift+Tab. Steps without an agent yet are dimmed.

| Method                 | Signature                       | Description                                                                |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `setAgents`            | `(agents: AgentEntity[]): void` | Replace the full agent list (filtered to the selected task during render). |
| `setSteps`             | `(steps: StepEntity[]): void`   | Set the ordered steps for the selected task.                               |
| `setActiveStepIndex`   | `(index: number): void`         | Set which step is currently active (drives tab markers).                   |
| `setSelectedStepIndex` | `(index: number): void`         | Select a step by index (updates the displayed agent + pins).               |
| `setSelectedAgentUid`  | `(uid: string \| null): void`   | Select a step by its agent's uid.                                          |
| `toggleExpand`         | `(): void`                      | Toggle between collapsed and expanded modes.                               |
| `isExpanded`           | `(): boolean`                   | Whether the widget is expanded.                                            |
| `getExpandedLineCount` | `(): number`                    | Rendered line count (collapsed: `agentLogLines`; expanded: 40).            |
| `getSelectedAgentUid`  | `(): string \| null`            | uid of the agent for the selected step.                                    |
| `handleInput`          | `(data): void`                  | Tab/Shift+Tab cycle steps; ↑/↓ and ⇧↑/⇧↓ scroll when expanded.             |
| `invalidate`           | `(): void`                      | Mark the cached render as stale.                                           |

Each log entry is rendered with a type-specific icon and colour:

| Type              | Icon | Colour |
| ----------------- | ---- | ------ |
| `text`            | 💬   | none   |
| `thinking`        | 🧠   | dim    |
| `tool_call_start` | 🔧   | cyan   |
| `tool_call_end`   | ✅   | green  |
| `error`           | ⚠️   | red    |
| `decision`        | 🤝   | none   |

##### `Dashboard`

Composite widget containing `PhaseBar`, `TaskListWidget`, and `AgentLogWidget`. Owns the **centralized selection model** — `selectedPhaseId`, `selectedTaskId`, `selectedStepIndex`, plus `userPinnedPhase` and `userPinnedStep` flags that govern the follow rules.

| Method               | Signature                                | Description                                                                                               |
| -------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `phaseBar`           | (getter)                                 | The `PhaseBar` sub-widget.                                                                                |
| `taskList`           | (getter)                                 | The `TaskListWidget` sub-widget.                                                                          |
| `agentLog`           | (getter)                                 | The `AgentLogWidget` sub-widget.                                                                          |
| `getSelection`       | `(): DashboardSelection`                 | Returns the current selection state (`selectedPhaseId`, `selectedTaskId`, `selectedStepIndex`, pins).     |
| `forceReselect`      | `(): void`                               | Reset task/step selection so the next sync picks fresh defaults. Phase selection is preserved.            |
| `syncFromProjection` | `(projection: WorkflowProjection): void` | Push projection state into all child widgets and run the follow rules. Called on each store notification. |
| `getComputedHeight`  | `(): number`                             | Total rendered height: phase bar (1) + visible tasks + expanded agent log lines + 4 border lines.         |
| `handleInput`        | `(data): void`                           | Routes ←/→ to PhaseBar, ↑/↓ to TaskList (collapsed) or AgentLog (expanded), Tab/⇧Tab to AgentLog.         |

Renders sub-widgets top-to-bottom: phase bar, then task rows, then agent log, all inside a box-drawing border.

**Follow rules** (implemented in `syncFromProjection`):

- **Phase follow** — if the selected phase is not completed and differs from `currentPhaseId`, advance to `currentPhaseId`. If the selected phase is completed, leave it (reviewing history).
- **Task follow** — if the selected task is null or no longer in the selected phase's tasks, auto-select the first `active` task (or the first task).
- **Step follow** — if not user-pinned, sync `selectedStepIndex` to the task's `activeStepIndex`.

#### Theme Functions

Exported from `src/tui/theme.ts`. ANSI escape-sequence helpers for terminal styling.

**Foreground colours:**

| Function    | Description              |
| ----------- | ------------------------ |
| `cyan`      | Cyan foreground          |
| `dim`       | Dimmed (low intensity)   |
| `bold`      | Bold (high intensity)    |
| `underline` | Underline                |
| `green`     | Green foreground         |
| `red`       | Red foreground           |
| `yellow`    | Yellow foreground        |
| `blue`      | Blue foreground          |
| `magenta`   | Magenta foreground       |
| `darkRed`   | 256-color foreground 131 |

All foreground functions have the signature `(str: string) => string` — they wrap the input in ANSI codes and reset.

**Background colours:**

| Function      | Description              |
| ------------- | ------------------------ |
| `bgDark`      | 256-color background 236 |
| `bgStatusBar` | 256-color background 237 |

**Status helpers:**

| Function      | Signature                               | Description                                          |
| ------------- | --------------------------------------- | ---------------------------------------------------- |
| `statusColor` | `(status: TaskStatus) => (s) => string` | Returns the colour function for a task status.       |
| `statusIcon`  | `(status: TaskStatus) => string`        | Returns the single-character icon for a task status. |

**Status → colour/icon mapping:**

| Status      | Colour  | Icon |
| ----------- | ------- | ---- |
| `active`    | yellow  | ▶    |
| `complete`  | green   | ✓    |
| `failed`    | red     | ✗    |
| `cancelled` | dim     | ⊘    |
| `ready`     | cyan    | ○    |
| `blocked`   | darkRed | ·    |

**Other helpers:**

| Function        | Signature                                   | Description                                    |
| --------------- | ------------------------------------------- | ---------------------------------------------- |
| `borderLine`    | `(left, fill, right, innerWidth) => string` | Build a horizontal box-drawing line.           |
| `stripAnsi`     | `(str: string) => string`                   | Strip all ANSI escape sequences.               |
| `formatElapsed` | `(ms: number) => string`                    | Format milliseconds as a short elapsed string. |

#### Type Exports

##### `PhaseEntity`

Defined in `src/tracking/event-types.ts`.

| Field     | Type       | Description                                      |
| --------- | ---------- | ------------------------------------------------ |
| `id`      | `string`   | Phase identifier (e.g. `"scouting"`)             |
| `label`   | `string`   | Human-readable label for display                 |
| `icon`    | `string`   | Emoji or icon for the phase                      |
| `taskIds` | `string[]` | Ordered list of task IDs belonging to this phase |

##### `TaskLane`

> **Note:** The TUI no longer exposes a `TaskLane` type. Task display now uses [`TaskEntity`](#taskentity) directly. If you see references to `TaskLane` in older code, it has been superseded by `TaskEntity`.

##### `AgentLogEntry`

Re-exported from `src/tracking/event-types.ts` as an alias of `LogEntry`.

| Field       | Type                                                                                                   | Description                  |
| ----------- | ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `id`        | `string`                                                                                               | Stable entry identifier      |
| `timestamp` | `string`                                                                                               | ISO timestamp                |
| `type`      | `'text' \| 'thinking' \| 'tool_call' \| 'tool_call_start' \| 'tool_call_end' \| 'error' \| 'decision'` | Entry discriminant           |
| `content`   | `string`                                                                                               | Entry text content           |
| `metadata?` | `Record<string, unknown>`                                                                              | Optional structured metadata |

See [EventStore / Event-Sourced Status](#eventstore--event-sourced-status) for the canonical `LogEntry` type.

---

## 9. Architecture

```
src/
├── index.ts                     # Public API re-exports
├── cli.ts                       # CLI entry point (run, resume, init commands)
├── core/
│   ├── types.ts                 # Shared type definitions and re-exports
│   ├── config.ts                # Config directory resolution (global/local/work dirs)
│   ├── profile.ts               # Markdown profile parser, loader, and multi-dir merge
│   ├── workflow-loader.ts       # Dynamic workflow module loading and listing
│   ├── harness-factory.ts       # AgentSession construction from profiles
│   ├── phase-tasks.ts           # runStepTask — single-agent one-step task primitive
│   ├── structured-output.ts     # JSON extraction, Zod-validated prompting
│   ├── agent-loop.ts            # Looping, parallel, and sequential agent patterns
│   ├── schema-describe.ts       # Zod schema → human-readable description
│   ├── title-generator.ts       # Task title generation
│   ├── git.ts                   # Git utilities (worktree support)
│   ├── network.ts               # LAN IP auto-detection
│   ├── worktree-lifecycle.ts    # Worktree creation/branch/merge lifecycle
│   ├── setup.ts                 # initDefaultConfig — first-time directory setup
│   └── utils.ts                 # Shared utilities (validateWorkflowName, isEnoentError, safeErrorMessage, composeStatusCallbacks, forwardAgentStatus, DEFAULT_TOOLS)
├── cli/
│   ├── commands.ts              # runCommand / resumeCommand / initCommand orchestration
│   ├── parse-args.ts            # CLI argument parsing
│   ├── tui-setup.ts             # Shared TUI + observer server setup (setupTuiAndObserver)
│   ├── console-status.ts        # Console StatusCallbacks factory + TUI detection
│   ├── session-selector.ts      # Interactive run selection for resume
│   ├── post-worktree.ts         # Post-worktree action prompter
│   ├── sigint.ts                # SIGINT handler for cooperative cancellation
│   └── slash-command-parser.ts  # Slash-command argument parsing
├── pool/
│   ├── index.ts                 # Pool module re-exports
│   ├── types.ts                 # StepDefinition, LanePoolOptions, LanePoolResult, StepResult, TrackedSession types
│   ├── lane-pool.ts             # Concurrent task processing pool (LanePool class) — the executor
│   ├── prompt-builder.ts        # Builds prompt text with pre-loaded file contents
│   ├── severity.ts              # Severity helpers
│   ├── step-execution.ts        # Executes individual steps (profile load, session, approval)
│   ├── task-processor.ts        # Runs a task's steps with retry, fires onStepStart
│   └── validation.ts            # Task/dependency validation
├── tracking/
│   ├── audit-log.ts             # JSONL-based audit event log (legacy AuditLog)
│   ├── event-store.ts           # Event-sourced status store (EventStore class)
│   ├── event-types.ts           # EventType, EventRecord, WorkflowProjection, AgentEntity, TaskEntity, PhaseEntity, StepEntity, LogEntry
│   ├── evolve.ts                # Pure projection reducer (evolve function)
│   ├── store-callbacks.ts       # createStoreCallbacks: StatusCallbacks → EventStore.append
│   ├── task-status.ts           # Task DAG tracker with state transitions
│   ├── workflow-serializer.ts   # Atomic JSON save/load with legacy migration
│   └── workflow-status.ts       # Full workflow phase state (persisted to JSON)
├── tui/
│   ├── index.ts                 # TUI module re-exports
│   ├── composer.ts              # Composes the dashboard layout
│   ├── format-tool-call.ts      # Formats tool-call args for display
│   ├── format-workflow-event.ts # Maps EventRecord → human-readable event-log line
│   ├── workflow-tui.ts          # TUI lifecycle manager (WorkflowTUI class)
│   ├── status-callbacks.ts      # createStoreBackedTui: subscribes TUI widgets to EventStore
│   ├── theme.ts                 # ANSI styling helpers and status mappings
│   └── components/
│       ├── index.ts             # Component re-exports
│       ├── event-log.ts         # Scrollable event log widget
│       ├── phase-bar.ts         # Phase progress indicator widget
│       ├── task-list-widget.ts  # Task grid widget (replaces former lane-pool-widget)
│       ├── agent-log-widget.ts  # Agent detail log widget with step tab bar
│       ├── dashboard.ts         # Composite dashboard container with selection model
│       └── qr-overlay.ts        # QR code overlay for mobile observer URL
└── web/
    ├── observer-server.ts       # Bun HTTP + WebSocket server (static files + /ws)
    ├── protocol-types.ts        # ServerMessage / ClientMessage protocol types
    └── status-bridge.ts         # StatusBridge: store → WebSocket broadcast (snapshot/delta)
```

### Core Layer (`src/core/`)

| Module                 | Responsibility                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `types.ts`             | Re-exports from `pi-coding-agent`, `pi-agent-core`, and `pi-ai`; defines `AgentProfile`, `Task`, `TaskEntity`, `StepEntity`, `TaskStatus`, `WorkflowState`, `AuditEvent`, `StatusCallbacks`, `WorkflowModule`, `WorkflowRunOptions`, and related types |
| `config.ts`            | Resolves global (`~/.config/engin/`) and local (`.engin/`) config directories; provides default work directory paths                                                                                                                                   |
| `profile.ts`           | Parses markdown files with YAML frontmatter into `AgentProfile` objects; loads all profiles from a directory or merges from multiple directories                                                                                                       |
| `workflow-loader.ts`   | Dynamically loads workflow modules by name from config directories; discovers `main.ts` inside workflow subdirectories; caches loaded modules                                                                                                          |
| `harness-factory.ts`   | Creates a fully-wired `AgentSession` from a profile: model resolution, `AuthStorage`, tool filtering, `DefaultResourceLoader`, and `createAgentSession` from `@earendil-works/pi-coding-agent`                                                         |
| `phase-tasks.ts`       | `runStepTask` — runs one agent as a one-step task with the full lifecycle (`onTaskRegister` → `onTaskStart` → `onAgentSpawn` → `onStepStart` → run → `onAgentComplete` → `onTaskComplete`)                                                             |
| `structured-output.ts` | Extracts JSON from free-text model responses; prompts a session and validates output against a Zod schema with automatic retries                                                                                                                       |
| `agent-loop.ts`        | Higher-level patterns: `agentLoopUntil`, `parallelAgents`, `sequentialAgents`. Uses `AgentSession` and `dispose()` for cleanup                                                                                                                         |
| `utils.ts`             | Shared utilities: `validateWorkflowName`, `isEnoentError`, `safeErrorMessage`, `composeStatusCallbacks`, `forwardAgentStatus`, `DEFAULT_TOOLS`                                                                                                         |

### Pool Layer (`src/pool/`)

| Module              | Responsibility                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`          | Defines `StepDefinition`, `StepResult`, `LanePoolOptions` (with required `phaseId`), `LanePoolResult`, `RunStepTaskOptions`, and `TrackedSession` types                                             |
| `lane-pool.ts`      | Concurrent task processing pool (`LanePool` class); N lanes claim tasks from a shared `TaskTracker` and execute configurable sequential steps. Fires `onTaskRegister` once per task before spawning |
| `prompt-builder.ts` | Builds the prompt text for each step, including pre-loading file contents from `task.files` as fenced code blocks with syntax highlighting                                                          |
| `step-execution.ts` | Executes individual steps by loading the profile, creating a harness session, sending the prompt, and determining approval/rejection                                                                |
| `task-processor.ts` | Runs a task's ordered steps with retry; fires `onStepStart` before each step and `onAgentSpawn`/`onAgentComplete` around each agent                                                                 |

### Tracking Layer (`src/tracking/`)

| Module                   | Responsibility                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-log.ts`           | Appends `AuditEvent` records to a JSONL file; supports filtering by type or task ID; computes aggregate stats                                                                                                       |
| `event-store.ts`         | Event-sourced status store — the single source of truth. Durable `events.jsonl` + in-memory `WorkflowProjection` evolved via `evolve()`. See [EventStore / Event-Sourced Status](#eventstore--event-sourced-status) |
| `event-types.ts`         | Defines `EventType`, `EventRecord`, `WorkflowProjection`, `PhaseEntity`, `AgentEntity`, `TaskEntity`, `StepEntity`, `LogEntry`, and `createInitialProjection()`                                                     |
| `evolve.ts`              | Pure, immutable reducer: `evolve(state, event) → WorkflowProjection`. Handles all 20 event types                                                                                                                    |
| `store-callbacks.ts`     | `createStoreCallbacks(store)` — a `StatusCallbacks` implementation that fans every callback into `store.append()`                                                                                                   |
| `task-status.ts`         | Manages a collection of `Task` objects with a DAG of dependencies; enforces state transitions (`ready`/`blocked`/`active`/`complete`/`failed`/`cancelled`); detects cycles                                          |
| `workflow-status.ts`     | Top-level workflow state: current phase, completed phases, workflow data bag, stats, and task tracker; persists to `.engin-state.json`                                                                              |
| `workflow-serializer.ts` | Atomic save (temp file + rename) and load with legacy field migration                                                                                                                                               |

### CLI Layer (`src/cli/`)

| Module                    | Responsibility                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.ts`             | `runCommand`, `resumeCommand`, `initCommand` orchestration; TUI vs. console detection; `composeStatusCallbacks([storeCallbacks, consoleCallbacks])` wiring |
| `parse-args.ts`           | CLI argument parsing (`--cwd`, `--work-dir`, `--max-concurrent`, `--verbose`, `--api-key`, etc.)                                                           |
| `tui-setup.ts`            | `setupTuiAndObserver()` — shared setup of `EventStore`, `StatusBridge`, `ObserverServer`, and `WorkflowTUI` (with QR code)                                 |
| `console-status.ts`       | `createStatusCallbacks(verbose)` console output factory; `shouldUseTui()` detection helper                                                                 |
| `session-selector.ts`     | Interactive run selection for `resume` (scans past run directories)                                                                                        |
| `post-worktree.ts`        | Post-worktree action prompter (merge, push, etc.)                                                                                                          |
| `sigint.ts`               | SIGINT handler for cooperative cancellation via `AbortController`                                                                                          |
| `slash-command-parser.ts` | Slash-command argument parsing                                                                                                                             |

### Web Layer (`src/web/`)

| Module               | Responsibility                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observer-server.ts` | `startObserverServer()` — Bun HTTP + WebSocket server. Serves static files from `web/dist` (SPA fallback), handles `/ws` upgrade with Origin validation. WebSocket messages: `terminate_server`, `resync`. See [WebSocket Protocol](#websocket-protocol-snapshotdelta) |
| `protocol-types.ts`  | `ServerMessage` and `ClientMessage` union types; re-exports state types from `tracking/event-types.ts`                                                                                                                                                                 |
| `status-bridge.ts`   | `StatusBridge` — thin view over `EventStore` that broadcasts snapshot/delta `ServerMessage`s. Coalesces events per microtask tick; sends terminal lifecycle signals immediately                                                                                        |

### TUI Layer (`src/tui/`)

| Module                           | Responsibility                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow-tui.ts`                | Top-level TUI lifecycle: creates terminal, builds widget tree, subscribes to `EventStore`, overrides console, handles keyboard input (Ctrl+C, arrows, Tab, Space) |
| `status-callbacks.ts`            | `createStoreBackedTui(deps)` — subscribes TUI widgets to an `EventStore` and syncs from projection                                                                |
| `format-workflow-event.ts`       | Maps an `EventRecord` to a human-readable emoji line for the event-log widget; returns `null` for silent event types                                              |
| `theme.ts`                       | ANSI colour/style helpers (`cyan`, `dim`, `bold`, etc.), status-to-colour/icon mappings, `borderLine`, and `stripAnsi` sanitisation                               |
| `components/event-log.ts`        | Scrollable event log widget with PgUp/PgDn/Home/End navigation and auto-scroll                                                                                    |
| `components/phase-bar.ts`        | Single-line phase progress bar with completed/current/selected/pending states                                                                                     |
| `components/task-list-widget.ts` | Task grid with focus tracking (↑/↓), sorted by status priority (replaces former `lane-pool-widget.ts`)                                                            |
| `components/agent-log-widget.ts` | Agent detail log with step tab bar, expand/collapse, and scroll                                                                                                   |
| `components/dashboard.ts`        | Composite container: PhaseBar + TaskListWidget + AgentLogWidget with centralized selection model and `syncFromProjection()`                                       |
| `components/qr-overlay.ts`       | QR code overlay rendering the mobile observer URL                                                                                                                 |

> **Note:** `src/pool/lane-pool.ts` (the `LanePool` executor) is unrelated to the former `src/tui/components/lane-pool-widget.ts`. The executor stays; the TUI widget has been renamed to `task-list-widget.ts` to reflect that it now renders `TaskEntity` rows rather than lane concepts.

This package is a **pure library** — it provides building blocks (harness creation, profile loading, structured output, agent loop patterns, `runStepTask`, task tracking, event-sourced status, audit logging, a TUI dashboard, and a WebSocket observer server) that user-managed workflow scripts compose into pipelines. It does not ship any built-in workflows or agent profiles.

### EventStore / Event-Sourced Status

The `EventStore` class (`src/tracking/event-store.ts`) is the single source of truth for workflow status. Instead of mutating a state object directly, every status change is recorded as an append-only `EventRecord` in `events.jsonl`, and an in-memory `WorkflowProjection` is derived by replaying events through the pure `evolve()` reducer.

> **⚠️ Clean break from old runs:** The event model and projection shape were substantially reworked (new event types `phase_registered`, `task_registered`, `step_started`; removed `task_step_started`, `tasks_added`; new `PhaseEntity`/`StepEntity`/`TaskEntity` shapes; `TaskStatus` changed). **Old runs created with the previous event model will NOT resume correctly** — the `evolve()` reducer cannot interpret legacy events against the new projection shape. Delete or archive old `work/` directories from prior versions.

#### `EventStore`

```typescript
class EventStore {
  constructor(workDir: string, opts?: { maxRingBuffer?: number });
  append(
    type: EventType,
    data: Record<string, unknown>,
    metadata?: { agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number },
  ): EventRecord;
  getProjection(): WorkflowProjection;
  getSnapshot(): { state: WorkflowProjection; seq: number };
  getEventsSince(seq: number): EventRecord[];
  subscribe(cb: (projection: WorkflowProjection) => void): () => void;
  flush(): Promise<void>;
  saveSnapshot(): Promise<void>;
  static load(workDir: string, opts?: { maxRingBuffer?: number }): Promise<EventStore>;
}
```

**`append(type, data, metadata?)`** — Assigns the next monotonic `seq`, pushes the record into a bounded ring buffer (default 1000 entries), evolves the projection, enqueues a coalesced disk write, and notifies all subscribers synchronously. Returns the created `EventRecord`.

**Write coalescing** — Records appended within the same microtask tick are accumulated in `pendingRecords` and flushed to disk in a single `appendFile` call by `drainPending()`. This avoids one fs syscall per event while preserving seq ordering and line-delimited JSON.

**`flush(): Promise<void>`** — If a microtask drain is pending, drains it synchronously, then awaits the write queue. Guarantees durability even when called immediately after `append()`.

**`getEventsSince(seq)`** — Returns all records with `seq > arg` from the ring buffer. Uses binary search (the buffer is a contiguous, seq-ordered slice) instead of a linear filter. If `seq` is older than the buffer's oldest record, returns everything available.

**`subscribe(cb)`** — Registers a projection-change listener. Returns an unsubscribe function. Subscriber errors are caught and do not crash the store.

**`saveSnapshot()`** — Atomically writes `{ state, seq, timestamp }` to `event-snapshot.json` (via temp file + rename).

**`EventStore.load(workDir)`** — Factory for resume: loads a snapshot (if present), then replays `events.jsonl` records with `seq > snapshotSeq` through `evolve()`. Falls back to a pristine in-memory projection when neither file exists.

#### `createStoreCallbacks(store): StatusCallbacks`

A `StatusCallbacks` implementation that fans every callback into `store.append()` with the appropriate `EventType` and argument mapping. This is what the CLI passes to a workflow's `onStatus`. The mapping is 1:1 — each callback method maps to exactly one event type:

| Callback             | EventType            |
| -------------------- | -------------------- |
| `onWorkflowStart`    | `workflow_started`   |
| `onPhaseRegister`    | `phase_registered`   |
| `onPhaseStart`       | `phase_started`      |
| `onPhaseComplete`    | `phase_completed`    |
| `onAgentSpawn`       | `agent_spawned`      |
| `onAgentComplete`    | `agent_completed`    |
| `onTaskRegister`     | `task_registered`    |
| `onTaskStart`        | `task_started`       |
| `onStepStart`        | `step_started`       |
| `onTaskComplete`     | `task_completed`     |
| `onTaskRejected`     | `task_rejected`      |
| `onDecision`         | `decision`           |
| `onError`            | `error`              |
| `onWorkflowComplete` | `workflow_completed` |
| `onWorkflowFailed`   | `workflow_failed`    |
| `onSidebarUpdate`    | `sidebar_updated`    |
| `onTurnStart`        | `turn_started`       |
| `onTurnEnd`          | `turn_ended`         |
| `onToolCallStart`    | `tool_call_started`  |
| `onToolCallEnd`      | `tool_call_ended`    |

#### `evolve(state, event): WorkflowProjection`

Pure, immutable reducer (`src/tracking/evolve.ts`). Returns a **new** projection reflecting the given event. Handles all 20 event types:

- **Workflow lifecycle** — `workflow_started`, `workflow_completed`, `workflow_failed`
- **Phase lifecycle** — `phase_registered` (upsert into `phases` array), `phase_started` (sets `currentPhaseId`), `phase_completed` (appends to `completedPhaseIds`)
- **Agent lifecycle** — `agent_spawned` (upsert + `agentCount` increment on first spawn; links agent to task step via `stepIndex`), `agent_completed` (sets `active: false`)
- **Task lifecycle** — `task_registered` (creates `TaskEntity` with `steps`; appends `taskId` to owning `PhaseEntity.taskIds`), `task_started` (→ `active`), `step_started` (sets `activeStepIndex`; links agent), `task_completed` (→ `complete`), `task_rejected` (→ `failed`)
- **Agent log / decisions / errors** — `decision`, `error`, `turn_ended` (text + thinking blocks appended to agent log; token accumulation)
- **Tool call lifecycle** — `tool_call_started` (increments `toolCallCount`), `tool_call_ended`
- **Sidebar** — `sidebar_updated` (title, indicator only — phases are registered via `phase_registered`)
- **No-ops** — `turn_started` (seq bump only)

Agent logs are capped at 500 entries (oldest dropped). Agent entities are keyed by `agentId::taskId` (or just `agentId` when no task is associated), with fuzzy resolution when only `agentId` is available.

#### `WorkflowProjection`

The canonical read-model shape derived by `evolve()`:

```typescript
interface WorkflowProjection {
  seq: number;
  taskPrompt: string;
  phases: PhaseEntity[]; // ordered list, each with taskIds
  currentPhaseId: string;
  completedPhaseIds: string[];
  tasks: Record<string, TaskEntity>; // keyed by taskId
  agents: Record<string, AgentEntity>; // keyed by agentKey (agentId::taskId)
  sidebar: { title: string; indicator: string };
  status: 'running' | 'complete' | 'failed';
  error?: string;
  failedPhase?: string;
  stats: { totalTokens: number; agentCount: number };
}
```

### WebSocket Protocol (Snapshot/Delta)

The `ObserverServer` (`src/web/observer-server.ts`) is a Bun HTTP + WebSocket server that serves the static web frontend and broadcasts workflow status to connected clients (including mobile devices via a QR-coded URL).

#### Message Types

**Server → Client** (`ServerMessage`, defined in `src/web/protocol-types.ts`):

| Type                | Shape                                | Description                                                      |
| ------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `snapshot`          | `{ seq, state: WorkflowProjection }` | Full projection — sent on connect or full resync                 |
| `events`            | `{ seq, events: EventRecord[] }`     | Batch of raw event records since the client's last seq           |
| `workflow_complete` | `{}`                                 | Terminal lifecycle signal — broadcast immediately, not coalesced |
| `workflow_failed`   | `{ error: string, phase: string }`   | Terminal lifecycle signal — broadcast immediately, not coalesced |

**Client → Server** (`ClientMessage`):

| Type               | Shape                  | Description                                            |
| ------------------ | ---------------------- | ------------------------------------------------------ |
| `terminate_server` | `{}`                   | Request workflow cancellation (triggers `onTerminate`) |
| `resync`           | `{ lastSeq?: number }` | Request catch-up after reconnect                       |

#### `StatusBridge`

Thin view over the `EventStore` that broadcasts `ServerMessage`s whenever the store changes:

- **Late-joining clients** receive a full `{ type: 'snapshot' }` via `getSnapshot()`.
- **Between snapshots**, changes are coalesced into a single `{ type: 'events' }` message per microtask tick, forwarding raw `EventRecord`s. The client replays them through its own `evolveClient()`.
- **Terminal transitions** (→ complete / → failed) are broadcast **immediately** via dedicated messages so clients can surface a status banner without waiting for the batch flush. The coalesced events batch also carries the terminal records (idempotent).
- **Resync** — `handleResync(lastSeq)` attempts event catch-up if the ring buffer is contiguous (`events[0].seq === lastSeq + 1`); otherwise falls back to a full snapshot.

#### `ObserverServer`

The server binds to `0.0.0.0` by default and auto-detects the LAN IP for display (overridable via the `host` option). WebSocket upgrades on `/ws` are validated against the `Origin` header (non-browser clients without an Origin header bypass the check; localhost connections are always allowed). Static files are served from `web/dist` with SPA fallback to `index.html`; a `{{WS_ENDPOINT}}` placeholder in `index.html` is replaced with the appropriate `ws://` or `wss://` URL at serve time.

---

## 10. Web Mirror

The web frontend (`web/`) is a React + Zustand single-page application that mirrors the TUI dashboard in a browser. It connects to the `ObserverServer` via WebSocket and maintains its own copy of the `WorkflowProjection` by replaying events through `evolveClient()` — the same pure reducer logic as the server-side `evolve()`.

### Components

#### `PhaseBar`

Renders the registered phases as a horizontal row of **clickable tabs**. Each tab shows the phase `icon` and `label`, styled by state:

- **Completed** — green checkmark styling
- **Current** — highlighted as the active phase
- **Selected** — underlined/highlighted (overlays current)

Clicking a tab calls `selectPhase(id)`. Selecting a completed phase pins the view to it (reviewing history); selecting a non-completed phase is subject to the follow rule (auto-advances when it becomes non-current).

#### `TaskList`

Renders the tasks belonging to the **selected phase**, filtered by `task.phaseId === selectedPhaseId`. Tasks are sorted by status priority (`active` → `ready` → `blocked` → settled). Each task row shows its title and (when active) a step annotation like `step 1/2: implement`. The left border is coloured by status.

Clicking a task calls `selectTask(id)`, which drives the `AgentLog` below. If the selected phase has no tasks, an empty-state message is shown.

#### `AgentLog`

Renders the log entries for the agent fulfilling the **selected step** of the selected task. At the bottom is a **step tab bar** — one button per step in the task, marked as done (`✓`), active (`▶`), or pending (`○`). Steps without an agent are dimmed and disabled. Clicking an enabled step tab calls `selectStep(index)`, which pins the view to that step (until the follow rules re-select).

The header shows the agent's profile, tool-call count, and input/output token totals. A terminate-workflow button (with confirmation) is shown while the workflow is running.

### Centralized Selection Model

Both the TUI and the web mirror use a **centralized selection model** with the same five pieces of state:

| State               | TUI (`Dashboard`)  | Web (`workflow-store`) | Description                              |
| ------------------- | ------------------ | ---------------------- | ---------------------------------------- |
| `selectedPhaseId`   | `_selection` field | store field            | The phase whose tasks are displayed      |
| `selectedTaskId`    | `_selection` field | store field            | The task whose agent log is shown        |
| `selectedStepIndex` | `_selection` field | store field            | The step tab highlighted in AgentLog     |
| `userPinnedPhase`   | `_selection` field | store field            | True when user clicked a completed phase |
| `userPinnedStep`    | `_selection` field | store field            | True when user clicked a specific step   |

**Follow rules** (run after every projection update):

- **Phase follow** — if `selectedPhaseId` is set, not completed, and differs from `currentPhaseId`, advance to `currentPhaseId` and clear the pin.
- **Task follow** — if `selectedTaskId` is null or no longer in the selected phase's tasks, auto-select the first `active` task (or the first task). Reset step selection.
- **Step follow** — if `userPinnedStep` is false, sync `selectedStepIndex` to the task's `activeStepIndex`.

These rules keep the UI focused on live activity while allowing the user to pin to a specific phase/step for inspection.

### Web Architecture

| File                              | Responsibility                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `web/src/App.tsx`                 | Top-level layout: connection status banner, EventLog, PhaseBar, TaskList, AgentLog   |
| `web/src/components/PhaseBar.tsx` | Clickable phase tabs; calls `selectPhase`                                            |
| `web/src/components/TaskList.tsx` | Phase-filtered, click-to-select task list                                            |
| `web/src/components/AgentLog.tsx` | Agent detail log with step tab bar and terminate button                              |
| `web/src/components/EventLog.tsx` | Scrollable workflow-level event log (from `formatWorkflowEventLine`)                 |
| `web/src/store/workflow-store.ts` | Zustand store: holds the projection + selection state; implements follow rules       |
| `web/src/store/evolve-client.ts`  | Client-side pure reducer (mirrors server `evolve`)                                   |
| `web/src/hooks/useWebSocket.ts`   | WebSocket connection lifecycle: snapshot/events/terminal handling, resync, terminate |
| `web/src/protocol-types.ts`       | Re-exports protocol + state types from `src/web/protocol-types.ts`                   |

---

## 11. Types Reference

All types listed below are exported from the top-level `@harms-haus/engin` entry point.

### Union Types

#### `ThinkingLevel`

```typescript
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
```

Re-exported from `@earendil-works/pi-agent-core`.

#### `TaskStatus`

```typescript
type TaskStatus = 'ready' | 'blocked' | 'active' | 'complete' | 'failed' | 'cancelled';
```

See [TaskTracker](#tasktracker) for valid transitions. Settled statuses (`complete`, `failed`, `cancelled`) are terminal on the executor side.

#### `EventType`

The full union of event types recorded by `EventStore`:

```typescript
type EventType =
  | 'workflow_started'
  | 'phase_registered'
  | 'phase_started'
  | 'phase_completed'
  | 'agent_spawned'
  | 'agent_completed'
  | 'task_registered'
  | 'task_started'
  | 'step_started'
  | 'task_completed'
  | 'task_rejected'
  | 'decision'
  | 'error'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'sidebar_updated'
  | 'turn_started'
  | 'turn_ended'
  | 'tool_call_started'
  | 'tool_call_ended';
```

---

### `AgentProfile`

| Field           | Type            | Description                                              |
| --------------- | --------------- | -------------------------------------------------------- |
| `id`            | `string`        | Profile identifier — derived from filename without `.md` |
| `name`          | `string`        | Human-readable display name. Defaults to `id`            |
| `provider`      | `string`        | AI provider identifier                                   |
| `model`         | `string`        | Model identifier within the provider                     |
| `thinkingLevel` | `ThinkingLevel` | Model thinking depth                                     |
| `systemPrompt`  | `string`        | The full system prompt (markdown body after frontmatter) |
| `excludeTools`  | `string[]`      | Tool names to remove from the default set                |
| `includeTools`  | `string[]`      | If non-empty, only these tools are included              |

---

### `Task`

The executor-side (write-model) task. Carries `phaseId` and executor-only fields.

| Field             | Type         | Description                                                                                                                                                                                      |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`              | `string`     | Unique task identifier                                                                                                                                                                           |
| `title`           | `string`     | Short description                                                                                                                                                                                |
| `prompt`          | `string`     | Detailed prompt for the implementing agent                                                                                                                                                       |
| `profile`         | `string`     | Agent profile ID to use                                                                                                                                                                          |
| `files`           | `string[]`   | File paths whose contents are pre-loaded and injected as code blocks before the task prompt. Paths are resolved relative to `cwd`. Binary files are skipped. Large files are truncated at 10 KB. |
| `dependencies`    | `string[]`   | Task IDs that must complete before this task                                                                                                                                                     |
| `status`          | `TaskStatus` | Current lifecycle state                                                                                                                                                                          |
| `phaseId`         | `string`     | **Required.** Phase identifier the task belongs to                                                                                                                                               |
| `assignedAgent?`  | `string`     | ID of the agent currently working on this task                                                                                                                                                   |
| `result?`         | `unknown`    | Implementation result submitted for review                                                                                                                                                       |
| `reviewFeedback?` | `string[]`   | Accumulated feedback entries from reviewer rejections                                                                                                                                            |
| `isCode?`         | `boolean`    | Whether this task involves writing/modifying code (vs. docs/config). Optional.                                                                                                                   |

---

### `TaskEntity`

The read-model (projection) shape for a task. Does **not** carry executor-only fields (`prompt`, `files`, `result`, `reviewFeedback`, `isCode`, `assignedAgent`, `profile`). Steps have no `status` field — their rendered state is **derived** from their index vs the task's `activeStepIndex`.

| Field              | Type           | Description                                                 |
| ------------------ | -------------- | ----------------------------------------------------------- |
| `id`               | `string`       | Unique task identifier                                      |
| `title`            | `string`       | Short description                                           |
| `phaseId`          | `string`       | **Required.** Phase identifier the task belongs to          |
| `status`           | `TaskStatus`   | Current lifecycle state                                     |
| `steps`            | `StepEntity[]` | Ordered list of steps; state derived from `activeStepIndex` |
| `activeStepIndex?` | `number`       | The single active step; `undefined` when none               |
| `dependencies`     | `string[]`     | Task IDs that must complete before this task                |
| `startedAt?`       | `number`       | Epoch milliseconds when the task was started                |
| `completedAt?`     | `string`       | ISO timestamp when the task completed                       |

---

### `StepEntity`

Projection shape for a step within a task. Steps have **no status** — their rendered state (done / active / pending) is derived from their `index` vs the owning task's `activeStepIndex`:

- `index < activeStepIndex` → done
- `index === activeStepIndex` → active
- `index > activeStepIndex` → pending

| Field         | Type      | Description                                                                       |
| ------------- | --------- | --------------------------------------------------------------------------------- |
| `name`        | `string`  | Human-readable step name (e.g. `"implement"`, `"review"`)                         |
| `index`       | `number`  | 0-based position within the task                                                  |
| `profile?`    | `string`  | Profile ID this step runs as                                                      |
| `agentKey?`   | `string`  | Key into `projection.agents` once an agent is spawned (`undefined` until spawned) |
| `isReadOnly?` | `boolean` | When true, write/edit tools are stripped                                          |

---

### `PhaseEntity`

| Field     | Type       | Description                                      |
| --------- | ---------- | ------------------------------------------------ |
| `id`      | `string`   | Phase identifier (e.g. `"scouting"`)             |
| `label`   | `string`   | Human-readable label for display                 |
| `icon`    | `string`   | Emoji or icon for the phase                      |
| `taskIds` | `string[]` | Ordered list of task IDs belonging to this phase |

---

### `AgentEntity`

| Field           | Type         | Description                                                   |
| --------------- | ------------ | ------------------------------------------------------------- |
| `uid`           | `string`     | Stable key (`agentId::taskId`, or just `agentId`)             |
| `agentId`       | `string`     | Identifier of the agent                                       |
| `profile`       | `string`     | Profile ID used to create the agent                           |
| `phaseId`       | `string`     | Phase the agent belongs to                                    |
| `stepIndex?`    | `number`     | Step index within the task (when associated with a task step) |
| `taskId?`       | `string`     | Associated task, if applicable                                |
| `sessionId?`    | `string`     | Session identifier                                            |
| `sessionPath?`  | `string`     | Session storage path                                          |
| `active`        | `boolean`    | Whether the agent is currently running                        |
| `log`           | `LogEntry[]` | Agent log entries (capped at 500)                             |
| `toolCallCount` | `number`     | Total tool calls made                                         |
| `inputTokens`   | `number`     | Accumulated input tokens                                      |
| `outputTokens`  | `number`     | Accumulated output tokens                                     |
| `taskTitle`     | `string`     | Title of the associated task (empty if none)                  |
| `completedAt?`  | `string`     | ISO timestamp when the agent completed                        |

---

### `WorkflowState`

Serialized form of `WorkflowStatusTracker`. Written to `.engin-state.json` on `save()`.

| Field               | Type                                                             | Description                                                                                             |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `taskPrompt`        | `string`                                                         | The original task prompt                                                                                |
| `currentPhaseId`    | `string`                                                         | Phase the workflow is currently in                                                                      |
| `completedPhaseIds` | `string[]`                                                       | Phases that have finished                                                                               |
| `tasks`             | `Task[]`                                                         | All tasks in the plan                                                                                   |
| `workflowData`      | `Record<string, unknown>`                                        | Generic data bag — consumers store workflow-specific state (e.g. scouting reports, plan, research) here |
| `stats`             | `{ totalTokens: number; totalCost: number; agentCount: number }` | Aggregate statistics                                                                                    |
| `spawnedAgents?`    | `PersistedAgentRecord[]`                                         | Persisted records of spawned agents                                                                     |
| `worktree?`         | `WorktreeInfo`                                                   | Git worktree information for isolated execution                                                         |

> **Note:** The old `sidebar`, `scoutingReports`, `plan`, `research`, `planReviewFeedback`, and `planReviewSuggestions` top-level fields have been folded into `workflowData`. The serializer migrates legacy state files automatically on load.

---

### `WorkflowRunOptions`

Options passed to a workflow's `run()` function.

| Field                 | Type                     | Description                                                                               |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `cwd`                 | `string`                 | Project directory to operate on                                                           |
| `workDir`             | `string`                 | Directory for workflow state persistence                                                  |
| `maxConcurrentTasks?` | `number`                 | Maximum parallel implementers (default 5)                                                 |
| `apiKeys?`            | `Record<string, string>` | Provider → API key overrides                                                              |
| `onStatus?`           | `StatusCallbacks`        | Callbacks for workflow/agent events                                                       |
| `verbose?`            | `boolean`                | When true, use verbose console output instead of TUI dashboard                            |
| `signal?`             | `AbortSignal`            | Abort signal for cooperative cancellation                                                 |
| `tracker?`            | `unknown`                | Pre-created `WorkflowStatusTracker`; workflows should reuse instead of creating their own |
| `worktree?`           | `WorktreeInfo`           | Git worktree information for isolated execution                                           |

---

### `WorkflowModule`

Interface for workflow modules loaded by `loadWorkflow`.

| Field          | Type                                                                 | Description                             |
| -------------- | -------------------------------------------------------------------- | --------------------------------------- |
| `run`          | `(taskPrompt: string, options: WorkflowRunOptions) => Promise<void>` | The workflow entry point (**required**) |
| `name?`        | `string`                                                             | Human-readable workflow name            |
| `description?` | `string`                                                             | Workflow description                    |

---

### `HarnessCreationOptions`

Options for `createHarness`.

| Field                | Type                     | Description                                                                        |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `profile`            | `AgentProfile`           | The agent configuration to use                                                     |
| `cwd`                | `string`                 | Working directory for file operations                                              |
| `apiKeys?`           | `Record<string, string>` | Provider → API key overrides                                                       |
| `onAgentStatus?`     | `AgentStatusCallbacks`   | Callbacks for turn-level and tool-level events                                     |
| `sessionDir?`        | `string`                 | Directory for persisted session storage. Creates via `SessionManager.create()`     |
| `resumeSessionPath?` | `string`                 | Path to an existing session file for resumption via `SessionManager.open()`        |
| `agentId?`           | `string`                 | Override agent ID used in status callbacks. Defaults to sessionId if not provided. |

Tool filtering is handled internally from the profile's `includeTools`/`excludeTools` fields. The default tool set is `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

---

### `StructuredOutputOptions`

Options for `promptForStructured`.

| Field          | Type     | Description                                                                                                             |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `maxRetries`   | `number` | Maximum number of retry attempts                                                                                        |
| `retryPrompt?` | `string` | Custom retry prompt appended on failure (unused by built-in `promptForStructured` but available for external consumers) |

---

### `AgentLoopUntilOptions`

Options for `agentLoopUntil`.

| Field          | Type     | Description                           |
| -------------- | -------- | ------------------------------------- |
| `maxAttempts?` | `number` | Maximum loop iterations (default: 10) |

### `ParallelAgentOptions`

Options for `parallelAgents`.

| Field         | Type           | Description                                    |
| ------------- | -------------- | ---------------------------------------------- |
| `schema?`     | `ZodType<any>` | Zod schema for structured output validation    |
| `maxRetries?` | `number`       | Max retries for structured output (default: 3) |

### `SequentialAgentOptions`

Options for `sequentialAgents`.

| Field         | Type           | Description                                    |
| ------------- | -------------- | ---------------------------------------------- |
| `schema?`     | `ZodType<any>` | Zod schema for structured output validation    |
| `maxRetries?` | `number`       | Max retries for structured output (default: 3) |

---

### `RunStepTaskOptions`

Options for `runStepTask`. Runs one agent as a one-step task.

| Field          | Type                     | Required | Description                                                                                  |
| -------------- | ------------------------ | -------- | -------------------------------------------------------------------------------------------- |
| `profilesDirs` | `string[]`               | **Yes**  | Directories containing `.md` agent profile files                                             |
| `phaseId`      | `string`                 | **Yes**  | Phase identifier for status callbacks                                                        |
| `taskId`       | `string`                 | **Yes**  | Unique task identifier                                                                       |
| `title`        | `string`                 | **Yes**  | Human-readable task title                                                                    |
| `stepName`     | `string`                 | **Yes**  | Name of the step (displayed in status callbacks)                                             |
| `profileId`    | `string`                 | **Yes**  | Profile ID to load                                                                           |
| `cwd`          | `string`                 | **Yes**  | Working directory for the agent                                                              |
| `prompt`       | `string`                 | **Yes**  | Prompt to send to the agent                                                                  |
| `apiKeys?`     | `Record<string, string>` | No       | Optional API key overrides by provider                                                       |
| `onStatus?`    | `StatusCallbacks`        | No       | Status callback handlers                                                                     |
| `isReadOnly?`  | `boolean`                | No       | When true, `write` and `edit` tools are stripped from the agent's toolset (default: `false`) |
| `schema?`      | `ZodType<unknown>`       | No       | Zod schema for structured output. When absent, raw assistant text is returned                |
| `signal?`      | `AbortSignal`            | No       | Abort signal for cooperative cancellation                                                    |

---

### `StepDefinition<T>`

A single step in the task processing pipeline. Each step maps to an agent profile.

| Field          | Type                     | Required | Description                                                                                                 |
| -------------- | ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `name`         | `string`                 | **Yes**  | Human-readable step name (e.g. `"write-tests"`, `"execute"`, `"review"`)                                    |
| `profileId`    | `string`                 | **Yes**  | Profile ID to load from the profiles directories                                                            |
| `isReadOnly`   | `boolean`                | **Yes**  | When `true`, `write` and `edit` tools are stripped from the agent's toolset                                 |
| `schema?`      | `ZodType<T>`             | No       | Zod schema for structured output steps (reviews). When absent, raw assistant text is used                   |
| `isApproved?`  | `(result: T) => boolean` | No       | Determines approval from structured output. Defaults to checking `result.approved === true`                 |
| `getFeedback?` | `(result: T) => string`  | No       | Extracts rejection feedback from structured output. Defaults to `result.feedback ?? 'No feedback provided'` |

---

### `StepResult`

Discriminated union returned by each step execution.

```typescript
type StepResult = { type: 'approved'; output: unknown } | { type: 'rejected'; feedback: string; output?: unknown };
```

---

### `LanePoolOptions`

Configuration for creating a `LanePool`.

| Field                | Type                               | Required | Description                                                                                                                           |
| -------------------- | ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrentLanes` | `number`                           | **Yes**  | Maximum number of concurrent lanes (workers)                                                                                          |
| `profilesDirs`       | `string[]`                         | **Yes**  | Directories containing `.md` agent profile files. Searched in order, local overrides global                                           |
| `sessionBaseDir`     | `string`                           | **Yes**  | Base directory for persisted session storage. Sessions stored at `{base}/{taskId}/{attempt}-{stepIndex}-{stepName}/`                  |
| `cwd`                | `string`                           | **Yes**  | Working directory for agent operations                                                                                                |
| `taskTracker`        | `TaskTracker`                      | **Yes**  | Shared task tracker — lanes claim tasks from here                                                                                     |
| `getStepsForTask`    | `(task: Task) => StepDefinition[]` | **Yes**  | Given a task, return the ordered list of steps to execute                                                                             |
| `phaseId`            | `string`                           | **Yes**  | Phase identifier — the phase this pool serves. Propagated to all agent spawn/complete callbacks, task registration, and error reports |
| `apiKeys?`           | `Record<string, string>`           | No       | Optional API key overrides by provider                                                                                                |
| `onStatus?`          | `StatusCallbacks`                  | No       | Status callback handlers                                                                                                              |
| `auditLog?`          | `AuditLog`                         | No       | Audit log for recording events                                                                                                        |
| `maxStepRetries?`    | `number`                           | No       | Maximum retries per step on rejection (default: `5`)                                                                                  |
| `laneWaitTimeoutMs?` | `number`                           | No       | Maximum time (ms) a lane waits for new work before polling again (default: `60000`)                                                   |
| `signal?`            | `AbortSignal`                      | No       | Abort signal for cooperative cancellation                                                                                             |

---

### `LanePoolResult`

Aggregate result from running the pool.

| Field            | Type     | Description                                        |
| ---------------- | -------- | -------------------------------------------------- |
| `completedTasks` | `number` | Tasks that passed all steps successfully           |
| `failedTasks`    | `number` | Tasks that exhausted retries or encountered errors |

---

### `PromptableHarness`

A minimal interface for objects that can be prompted and return text.

```typescript
interface PromptableHarness {
  prompt: (text: string) => Promise<void>;
  getLastAssistantText: () => string | undefined;
}
```

Both `AgentSession` instances and mock objects satisfy this interface. The `prompt` method sends a message to the session; `getLastAssistantText` retrieves the last assistant response as plain text.

---

### `AgentLoopResult<T>`

Envelope returned by `retryAgentUntil`.

| Field         | Type                                | Description                                                                                                         |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `result`      | `T`                                 | The validated structured output                                                                                     |
| `attempts`    | `number`                            | Configured maximum retry attempts (default: 3). This is the configured max, not the actual number of attempts used. |
| `totalTokens` | `{ input: number; output: number }` | Token usage (zero when using `retryAgentUntil`)                                                                     |

---

### `StatusCallbacks`

```typescript
type StatusCallbacks = WorkflowStatusCallbacks & AgentStatusCallbacks;
```

#### `WorkflowStatusCallbacks`

| Method               | Parameter Shape                                                                                                                                 | Fired when                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `onWorkflowStart`    | `{ taskPrompt: string; resumed: boolean; workDir: string }`                                                                                     | The `run()` orchestrator starts           |
| `onPhaseRegister`    | `{ id: string; label: string; icon: string }`                                                                                                   | A phase is registered at startup          |
| `onPhaseStart`       | `{ phase: string; round: number }`                                                                                                              | A phase begins execution                  |
| `onPhaseComplete`    | `{ phase: string; durationMs: number }`                                                                                                         | A phase finishes                          |
| `onAgentSpawn`       | `{ agentId: string; profile: string; phaseId: string; taskId?: string; stepIndex?: number; sessionId?: string; sessionPath?: string }`          | An agent session is created               |
| `onAgentComplete`    | `{ agentId: string; profile: string; phaseId: string; taskId?: string; sessionId?: string }`                                                    | An agent finishes its prompt              |
| `onTaskStart`        | `{ taskId: string; title: string; agentId: string; phaseId?: string; startedAt?: number }`                                                      | A task is claimed and dispatched          |
| `onTaskRegister`     | `{ taskId: string; phaseId: string; title: string; dependencies: string[]; steps: { name: string; profileId: string; isReadOnly: boolean }[] }` | A task is registered with its step layout |
| `onStepStart`        | `{ taskId: string; stepIndex: number; stepName: string; agentId: string }`                                                                      | A step begins execution                   |
| `onTaskComplete`     | `{ taskId: string; title: string }`                                                                                                             | A task passes review                      |
| `onTaskRejected`     | `{ taskId: string; title: string; reason: string }`                                                                                             | A task fails review                       |
| `onDecision`         | `{ agentId: string; decision: string; reasoning: string; taskId?: string }`                                                                     | A reviewer makes a decision               |
| `onError`            | `{ agentId: string; error: string; phaseId: string; taskId?: string }`                                                                          | An agent encounters an error              |
| `onWorkflowComplete` | `{ totalDurationMs: number; agentCount: number }`                                                                                               | The workflow finishes successfully        |
| `onWorkflowFailed`   | `{ error: Error; phaseId: string }`                                                                                                             | The workflow throws an unhandled error    |
| `onSidebarUpdate`    | `{ title?: string; indicator?: string }`                                                                                                        | Sidebar UI metadata is updated            |

All methods are optional. Phases are registered via `onPhaseRegister`; tasks are registered via `onTaskRegister`; steps begin via `onStepStart`.

#### `AgentStatusCallbacks`

| Method            | Parameter Shape                                                                                                     | Fired when                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `onTurnStart`     | `{ agentId: string; turn: number }`                                                                                 | An agent turn begins      |
| `onTurnEnd`       | `{ agentId: string; turn: number; tokens?: { input: number; output: number }; contentBlocks?: TurnContentBlock[] }` | An agent turn completes   |
| `onToolCallStart` | `{ agentId: string; toolName: string; toolCallId: string; arguments: Record<string, unknown> }`                     | A tool execution starts   |
| `onToolCallEnd`   | `{ agentId: string; toolName: string; toolCallId: string; isError: boolean }`                                       | A tool execution finishes |

All methods are optional.

##### `TurnContentBlock`

A discriminated union representing the content of an assistant's turn:

| Type       | Shape                                                                                | Description                     |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| `text`     | `{ type: 'text'; text: string }`                                                     | Message text from the assistant |
| `thinking` | `{ type: 'thinking'; thinking: string; redacted?: boolean }`                         | Thinking/reasoning text         |
| `toolCall` | `{ type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }` | Tool call with parameters       |

`contentBlocks` is only populated when the turn's message has `role: 'assistant'`. For non-assistant messages, it is `undefined`.

---

## 12. Configuration

### .env File Loading

engin automatically loads environment variables from `.env` files at startup, before any command executes. This is useful for storing API keys and other configuration needed by tools and providers.

**File locations (loaded in order):**

| Priority    | Path                   | Scope                                |
| ----------- | ---------------------- | ------------------------------------ |
| 1 (lowest)  | `~/.config/engin/.env` | User-level, shared across projects   |
| 2 (highest) | `{cwd}/.engin/.env`    | Project-level, per-project overrides |

**Behavior:**

- Local values override global values for the same key.
- Environment variables already set in the shell (`process.env`) always take precedence — `.env` files never overwrite existing values.
- Files that don't exist are silently skipped.
- Loading is skipped for `help` and `version` commands.

**Security:**

The following environment variable names are **blocked** and will never be loaded from `.env` files:

- `NODE_OPTIONS`
- `NODE_TLS_REJECT_UNAUTHORIZED`
- `NODE_EXTRA_CA_CERTS`
- `LD_PRELOAD`
- `LD_LIBRARY_PATH`
- `PATH`
- `HOME`
- `SHELL`

**Example `.env` file:**

```env
# engin .env file
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
MY_TOOL_API_KEY=abc123
```

**Verbose output:** When run with `--verbose`, loaded `.env` file paths are printed:

```
[12:34:56] 📄 Loaded .env: /home/user/.config/engin/.env
[12:34:56] 📄 Loaded .env: /path/to/project/.engin/.env
```

> **Note:** The `.engin/.env` file should be included in the project's `.gitignore`. Never commit `.env` files containing secrets to version control.

### Environment Variables

API keys are resolved by `AuthStorage.getApiKey()` in this priority order:

1. **Runtime overrides** — the `apiKeys` option passed to `createHarness` / `run`, or the `--api-key` CLI flag (both call `setRuntimeApiKey` under the hood).
2. **Stored API keys** — explicit keys saved in `~/.pi/agent/auth.json`.
3. **OAuth tokens** — OAuth access tokens from `~/.pi/agent/auth.json` (auto-refreshed when expired).
4. **Environment variables** — provider-specific env vars (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
5. **Fallback resolver** — custom provider key resolvers defined in `models.json`.

> **Warning:** API keys passed via `--api-key` are visible in process listings. Prefer environment variables or the `apiKeys` programmatic option.

### Resuming a Workflow

If `.engin-state.json` exists in `workDir`, the `run()` function loads it and resumes from the last saved phase.

> **⚠️ Clean break:** The event model and `WorkflowProjection` shape were substantially reworked in this version. **Old runs created with the previous event model will NOT resume correctly** — the `evolve()` reducer cannot interpret legacy events (`task_step_started`, `tasks_added`) against the new projection shape (`TaskEntity` with `steps`, `PhaseEntity` with `taskIds`, etc.). Delete or archive old `work/` directories from prior versions before running new workflows.

---

## 13. Development

### Scripts

| Command                | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `bun run build`        | Compile TypeScript to `dist/`                                         |
| `bun test`             | Run all tests with `bun:test`                                         |
| `bun run test:watch`   | Run tests in watch mode                                               |
| `bun run typecheck`    | Type-check without emitting                                           |
| `bun run lint`         | Run ESLint across the project                                         |
| `bun run lint:fix`     | Auto-fix ESLint issues                                                |
| `bun run format`       | Format all files with Prettier                                        |
| `bun run format:check` | Check formatting without writing                                      |
| `bun run prepare`      | Install git hooks via `simple-git-hooks` (auto-runs on `bun install`) |
| `bun run setup`        | Build then run `engin init` to create config directories              |

### Code Quality

ESLint is configured via flat config in `eslint.config.js` using `typescript-eslint` with the `recommended`, `strict`, and `stylistic` config presets. Key configuration details:

- **`@typescript-eslint/consistent-type-imports`** — enforces `import type` with separate import statements, aligning with `prettier-plugin-organize-imports`.
- **`@typescript-eslint/no-unused-vars`** — flags unused variables and parameters, with `_`-prefixed names ignored.
- **Bun globals** — `Bun` is registered as a readonly global so Bun-specific APIs are recognized.
- **`eslint-config-prettier`** — disables all ESLint rules that conflict with Prettier, applied last to ensure it takes effect.

Run `bun run lint` to check for issues, or `bun run lint:fix` to auto-fix what can be fixed automatically. Some strict rule violations (e.g. `no-explicit-any` in edge cases) may exist and are acceptable.

### Formatting

Prettier is configured via `.prettierrc` with the following settings:

| Setting      | Value                   |
| ------------ | ----------------------- |
| Print width  | 120                     |
| Quotes       | Single quotes           |
| Commas       | Trailing commas (`all`) |
| Arrow parens | Always (`(x) => x`)     |
| Indent       | 2 spaces                |
| Semicolons   | Always                  |
| End of line  | `lf`                    |

`prettier-plugin-organize-imports` runs as part of formatting and automatically sorts and consolidates imports. Run `bun run format` to format all files, or `bun run format:check` to verify formatting without writing changes.

### Pre-commit Hooks

`simple-git-hooks` and `lint-staged` are configured in `package.json` to run automatically on `git commit`. The pre-commit hook invokes `bunx lint-staged`, which applies targeted checks to staged files only:

- **`.ts` files** — `eslint --fix` then `prettier --write`
- **`.json` and `.md` files** — `prettier --write`

Hooks are installed by `bun run prepare` (which runs automatically on `bun install`). Skip hooks on a per-commit basis with `git commit --no-verify`.

### CI/CD

A GitHub Actions workflow at `.github/workflows/ci.yml` runs on every push and pull request to `main`. It uses a single job that executes the full quality pipeline:

1. **Typecheck** (`bun run typecheck`)
2. **Lint** (`bun run lint`)
3. **Format check** (`bun run format:check`)
4. **Test** (`bun test`)

The workflow uses `oven-sh/setup-bun@v2` with Bun dependency caching for faster runs. All GitHub Actions are pinned to specific commit SHAs rather than tags for supply-chain security.

To replicate the full CI pipeline locally:

```bash
bun run typecheck && bun run lint && bun run format:check && bun test
```

### Project Structure

```
engin/
├── src/                # Source code
│   ├── core/           # Core layer (sessions, profiles, auth, config, runStepTask)
│   ├── pool/           # Pool layer (concurrent task processing — LanePool executor)
│   ├── tracking/       # Tracking layer (audit, tasks, workflow state, event store)
│   ├── tui/            # TUI layer (terminal dashboard widgets)
│   └── web/            # Web layer (observer server + protocol)
├── web/                # React web mirror frontend
├── tests/              # Test files mirroring src/ structure
├── docs/               # Documentation
├── package.json
├── tsconfig.json
├── bunfig.toml
└── bun.lock
```

### Test Layout

Tests are co-located in `tests/` and mirror the `src/` structure:

```
tests/
├── core/
│   ├── agent-loop.test.ts
│   ├── config.test.ts
│   ├── harness-factory.test.ts
│   ├── phase-tasks.test.ts
│   ├── profile.test.ts
│   ├── structured-output.test.ts
│   └── workflow-loader.test.ts
├── pool/
│   ├── lane-pool.test.ts
│   └── types.test.ts
├── tracking/
│   ├── audit-log.test.ts
│   ├── event-store.test.ts
│   ├── evolve.test.ts
│   ├── task-status.test.ts
│   └── workflow-status.test.ts
├── tui/
│   └── components/
│       ├── task-list-widget.test.ts
│       └── dashboard.test.ts
└── ...
```

### Adding New Profiles

1. Create a `.md` file in `~/.config/engin/workflows/{your-workflow}/profiles/` (e.g. `my-agent.md`).
2. Add YAML frontmatter with at least `provider` and `model`.
3. Write the system prompt in the body.
4. The profile is now available to workflows that load profiles from the config directories.

### Adding a New Workflow

1. Create a directory in `~/.config/engin/workflows/` or `.engin/workflows/` (e.g. `my-workflow/`).
2. Add a `main.ts` file inside that directory exporting a `run(taskPrompt, options)` function.
3. Register your phases via `options.onStatus.onPhaseRegister(...)`.
4. Use `runStepTask` for single-agent tasks or `LanePool` (with `phaseId`) for concurrent multi-step tasks.
5. Reference it by directory name on the CLI:

```bash
engin my-workflow "Do the thing"
```

### TypeScript Configuration

- **Target**: ES2024
- **Module**: ESNext (ESM with `.js` extensions in imports)
- **Strict mode**: enabled
- **Declaration files**: emitted to `dist/`
