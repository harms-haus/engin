# workflow-harness

A script-based workflow engine for AI-driven development, built on top of [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

---

## 1. Overview

**workflow-harness** orchestrates multi-agent AI workflows for software development tasks. It uses `AgentSession` from `@earendil-works/pi-coding-agent` as its inference layer and provides a phase-based approach to breaking down, planning, implementing, and reviewing code changes.

Workflows and profiles are loaded dynamically from config directories — you create your own workflows and agent profiles and place them in `~/.config/workflow-harness/` (or `.workflow-harness/` for per-project config). Agent profiles are plain markdown files with YAML frontmatter, so you can customize agent behavior without touching code.

Key properties:

- **Dynamic workflow loading** — workflows are discovered from global and local config directories, loaded at runtime by name.
- **Layered config resolution** — profiles and workflows are resolved from `~/.config/workflow-harness/` (global) and `.workflow-harness/` (local), with local overriding global.
- **Agent profiles** are defined as markdown files with YAML frontmatter, making it easy to add or modify agents without touching code.
- **Structured output** is enforced via Zod schemas — every phase produces validated, typed data.
- **Task dependency tracking** uses a DAG with cycle detection, so tasks execute in topological order with configurable concurrency.
- **Full audit trail** — every agent start, end, decision, and error is logged to JSONL for post-hoc analysis.
- **Resumable** — workflow state is persisted to disk so interrupted runs can resume from the last completed phase.

---

## 2. Installation

### Prerequisites

- **Bun** >= 1.2.0 (used as both runtime and package manager)
- **API keys** for your configured provider(s); see [Configuration](#9-configuration) for details

### Install

```bash
git clone <repository-url> workflow-harness
cd workflow-harness
bun install
bun run build
```

### First-Time Setup

Create the config directory structure in your global config directory:

```bash
workflow-harness init
```

This creates the `profiles/` and `workflows/` subdirectories inside `~/.config/workflow-harness/` (or `$XDG_CONFIG_HOME/workflow-harness/`). Profiles and workflows are user-managed — place your own `.md` profile files in `profiles/` and `.js`/`.ts` workflow files in `workflows/`.

---

## 3. Quick Start

### CLI

```bash
# Create config directory structure (first time only)
workflow-harness init

# Add your profiles and workflows to ~/.config/workflow-harness/

# Run a workflow by name (assuming you've created a "develop" workflow)
workflow-harness develop "Add input validation to all public API endpoints"

# Run with options (same assumption)
workflow-harness develop "Fix the login bug" \
  --cwd ./my-project \
  --max-concurrent 5 \
  --verbose
```

### Programmatic

```typescript
import { createHarness, loadProfilesFromDirs, resolveProfilesDirs } from 'workflow-harness';

const profilesDirs = resolveProfilesDirs('/path/to/project');
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

The `workflow-harness` binary supports several commands:

```
workflow-harness <command> [options]
```

### Commands

| Command            | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `run` (default)    | Run a named workflow with a task prompt                          |
| `list`             | List available workflows and profiles                            |
| `init`             | Create config directory structure in the global config directory |
| `--help` / `-h`    | Show usage information                                           |
| `--version` / `-v` | Show version                                                     |

### `run`

```bash
workflow-harness <workflow-name> <task-prompt> [options]
```

The `run` command keyword is implicit — the first positional argument is the workflow name and the second is the task prompt.

```bash
workflow-harness develop "Refactor the auth module"
```

### `list`

```bash
workflow-harness list [--cwd <path>]
```

Lists all available workflows found in global and local config directories, along with any loadable profiles.

### `init`

```bash
workflow-harness init
```

Creates the `profiles/` and `workflows/` subdirectories inside the global config directory (`~/.config/workflow-harness/`). The command only ensures directories exist. Profiles and workflows are user-managed; see [Profiles](#6-profiles) and [Custom Workflows](#7-custom-workflows) for authoring guides.

### Flags

| Flag                       | Applies to     | Description                                                                                                                 |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--cwd <path>`             | `run`, `list`  | Project working directory (default: `process.cwd()`)                                                                        |
| `--work-dir <path>`        | `run`          | Directory for workflow state persistence. Default: `.workflow-harness/work/<workflow-name>` inside `cwd`                    |
| `--max-concurrent <n>`     | `run`          | Maximum parallel implementer agents (default: `3`). Must be a positive integer.                                             |
| `--verbose`                | `all commands` | Enable verbose output, including `.env` file loading information and agent-level output (turns, tool calls, token usage)    |
| `--api-key <provider=key>` | `run`          | Provider → API key override. Repeatable. **Warning:** values are visible in process listings; prefer environment variables. |

### Exit Codes

| Code | Meaning                         |
| ---- | ------------------------------- |
| `0`  | Workflow completed successfully |
| `1`  | Workflow failed with an error   |

### Example Output

Default (non-verbose) output shows workflow-level and task-level events:

```
[09:14:32] 🚀 Workflow started: "Add input validation to all public API endpoints" (resumed: false)
[09:14:32] 📦 Phase started: scouting (round 0)
[09:14:33] ⏳ Agent spawned: scout-coordinator (profile: scout)
[09:14:45] ✅ Agent complete: scout-coordinator
[09:14:46] ⏳ Agent spawned: scout-0 (profile: scout)
[09:15:02] ✅ Agent complete: scout-0
[09:15:02] ✅ Phase completed: scouting (30.1s)
[09:15:02] 📦 Phase started: scouting_review (round 0)
...
[09:22:18] 📋 Task started: task-1 - "Add input validation to user routes"
[09:22:35] ✅ Task complete: task-1
...
[09:31:44] 🎉 Workflow complete in 1032.4s (14 agents)
```

With `--verbose`, agent-level events are also shown:

```
[09:14:33] 🔄 Turn 1 started (agent: abc123)
[09:14:33] 🔧 Tool call: read (agent: abc123)
[09:14:34] ✅ Tool result: read (agent: abc123)
[09:14:35] 🔄 Turn 1 ended (agent: abc123, tokens: 1520 in / 340 out)
```

---

## 5. Configuration Directory Resolution

workflow-harness discovers profiles and workflows from two locations, with **local overriding global** on name conflicts.

### Directory Locations

| Scope      | Path                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| **Global** | `$XDG_CONFIG_HOME/workflow-harness/` — or `~/.config/workflow-harness/` when `XDG_CONFIG_HOME` is unset or empty |
| **Local**  | `{cwd}/.workflow-harness/` — where `cwd` is the project directory                                                |

### Directory Structure

```
.workflow-harness/           # Local (per-project)
├── profiles/                # Agent profile .md files
├── workflows/               # Workflow scripts (.js, .mjs, .cjs, .ts)
├── work/                    # Runtime state (auto-created)
│   └── develop/             # One subdirectory per workflow run
│       └── workflow-state.json
│       └── audit/audit.jsonl
└── .env                     # Project-level environment variables (git-ignored)

~/.config/workflow-harness/  # Global (user-wide)
├── profiles/
├── workflows/
└── .env                     # User-level environment variables
```

### Resolution Order

When loading profiles or workflows, the system searches both directories. On name conflict, the **local** entry wins:

```
resolveProfilesDirs(cwd) → [
  "{cwd}/.workflow-harness/profiles",   // local — higher priority
  "~/.config/workflow-harness/profiles" // global
]
```

The same pattern applies to workflows via `resolveWorkflowsDirs(cwd)`.

### Default Work Directory

When `--work-dir` is not specified, the CLI uses:

```
{cwd}/.workflow-harness/work/{workflowName}
```

---

## 6. Profiles

Agent profiles are markdown files with YAML frontmatter. The filename (without `.md`) becomes the profile's `id`.

### Where to Place Profiles

- **Global:** `~/.config/workflow-harness/profiles/*.md`
- **Local:** `{cwd}/.workflow-harness/profiles/*.md`

Local profiles override global profiles with the same ID.

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

- **Global:** `~/.config/workflow-harness/workflows/`
- **Local:** `{cwd}/.workflow-harness/workflows/`

Supported file extensions: `.js`, `.mjs`, `.cjs`, `.ts`.

The workflow name is the filename without its extension (e.g. `develop.js` → `develop`).

### Security

Workflow names cannot contain `/`, `\`, or `..` — this prevents path traversal attacks. The loader throws an error for invalid names.

### Example: Minimal Custom Workflow

```javascript
// ~/.config/workflow-harness/workflows/my-workflow.js
import { createHarness, loadProfilesFromDirs, resolveProfilesDirs, promptForStructured } from 'workflow-harness';
import { z } from 'zod';

export async function run(taskPrompt, options) {
  const { cwd, workDir, apiKeys, onStatus } = options;
  const profilesDirs = resolveProfilesDirs(cwd);
  const profiles = await loadProfilesFromDirs(profilesDirs);

  const profile = profiles.get('implementer');
  if (!profile) throw new Error('implementer profile not found');

  const { session, dispose } = await createHarness({ profile, cwd, apiKeys });
  try {
    await session.prompt(`Complete this task: ${taskPrompt}`);
    console.log('Done:', session.getLastAssistantText());
  } finally {
    dispose();
  }
}
```

### Example: Composing Phase Functions

You can import building blocks from `workflow-harness` to compose a custom workflow pipeline. The library provides `createHarness`, `parallelAgents`, `promptForStructured`, `WorkflowStatusTracker`, `TaskTracker`, and other utilities — see [Programmatic API](#8-programmatic-api) for the full list.

```typescript
// ~/.config/workflow-harness/workflows/develop.ts
import {
  createHarness,
  loadProfilesFromDirs,
  resolveProfilesDirs,
  promptForStructured,
  WorkflowStatusTracker,
  parallelAgents,
} from 'workflow-harness';
import { z } from 'zod';

export async function run(taskPrompt: string, options: WorkflowRunOptions) {
  const tracker = new WorkflowStatusTracker(options.workDir);
  const profilesDirs = resolveProfilesDirs(options.cwd);
  const profiles = await loadProfilesFromDirs(profilesDirs);

  // ... your custom orchestration logic using the library's building blocks
}
```

### TypeScript Workflows

`.ts` workflow files are natively supported by the Bun runtime — no additional loader or transpilation step is needed.

---

## 8. Programmatic API

All types and functions below are exported from the top-level `workflow-harness` entry point.

### Workflow Loading

#### `loadWorkflow(name, cwd): Promise<WorkflowModule>`

Dynamically load a workflow module by name. Searches local then global workflow directories. Supports `.js`, `.mjs`, `.cjs`, and `.ts` files. Results are cached by resolved file path.

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

Create a fully-wired `AgentSession` from an `AgentProfile`. All sessions are in-memory via `SessionManager.inMemory()`. Resolution steps: resolve model via `getModel()`, resolve API key and register with `AuthStorage.inMemory()`, build tool allowlist/denylist from profile, create `DefaultResourceLoader` with system prompt override, construct session via `createAgentSession()`, optionally subscribe to agent status events.

**`HarnessCreationOptions` fields:**

| Field            | Type                     | Description                           |
| ---------------- | ------------------------ | ------------------------------------- |
| `profile`        | `AgentProfile`           | The agent configuration               |
| `cwd`            | `string`                 | Working directory for file operations |
| `apiKeys?`       | `Record<string, string>` | Provider → API key overrides          |
| `onAgentStatus?` | `AgentStatusCallbacks`   | Callbacks for turn/tool events        |

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

Returns the global config directory path. Uses `$XDG_CONFIG_HOME/workflow-harness` if set and non-empty, otherwise `~/.config/workflow-harness`.

#### `getLocalConfigDir(cwd): string`

Returns `{cwd}/.workflow-harness`.

#### `resolveProfilesDirs(cwd): string[]`

Returns `[localProfilesDir, globalProfilesDir]` — local first for override priority.

#### `resolveWorkflowsDirs(cwd): string[]`

Returns `[localWorkflowsDir, globalWorkflowsDir]` — local first for override priority.

#### `getDefaultWorkDir(cwd, workflowName): string`

Returns `{cwd}/.workflow-harness/work/{workflowName}`.

#### `ensureDir(dirPath): Promise<void>`

Recursively creates a directory. Re-throws any errors.

#### `loadEnvFiles(cwd: string): LoadEnvResult`

Loads `.env` files from the global and local config directories, merges them (local overrides global), and sets keys into `process.env` only for variables not already defined. This is called automatically by the CLI before command dispatch, but can also be called programmatically.

- **Synchronous** — must complete before any command execution or env-dependent initialization.
- **Global path**: `~/.config/workflow-harness/.env` (or `$XDG_CONFIG_HOME/workflow-harness/.env`)
- **Local path**: `{cwd}/.workflow-harness/.env`
- **Precedence**: Existing `process.env` values are never overwritten.
- **Security**: A blocklist of dangerous runtime variables (`NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, etc.) is enforced — these are never loaded from `.env` files.

Returns a `LoadEnvResult` object:

| Field          | Type       | Description                                                                                                |
| -------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `loadedFiles`  | `string[]` | Paths of `.env` files that existed and were parsed                                                         |
| `skippedFiles` | `string[]` | Paths of `.env` files that did not exist                                                                   |
| `keysSet`      | `string[]` | Environment variable names actually written to `process.env` (excluding already-set keys and blocked vars) |

### Setup

#### `initDefaultConfig(): Promise<{ createdDirs: string[] }>`

Creates the `profiles/` and `workflows/` subdirectories inside the global config directory (`~/.config/workflow-harness/`). No files are installed — profiles and workflows are user-managed. Takes no arguments.

Returns `{ createdDirs: string[] }` where `createdDirs` is `['profiles', 'workflows']` — the names of the directories that were ensured to exist.

### Structured Output

#### `promptForStructured<T>(harness, prompt, schema, options?): Promise<T>`

Prompt a harness (any object satisfying `PromptableHarness`) and parse the response through a Zod schema. The harness's `getLastAssistantText()` is used to extract the response text. Retries up to `maxRetries` (default 3) with error feedback appended to the prompt.

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

Create sessions for every config in parallel via `createHarness`, then run prompts via `Promise.allSettled`. All sessions are disposed in a `finally` block. When `options.schema` is provided, each result is validated through `promptForStructured`; otherwise the raw `getLastAssistantText()` value is returned.

#### `sequentialAgents<T>(configs, promptFn, options?): Promise<T[]>`

Same as `parallelAgents` but runs prompts sequentially. All sessions are disposed in a `finally` block. Throws on the first failure.

### Session Management

#### `SessionHistory`

```typescript
class SessionHistory {
  constructor(session: SessionWithMessages);
  getMessageCount(): number;
  getStats(): SessionStats;
}
```

Wraps any object with a `messages` array (compatible with `AgentSession`). Methods are synchronous.

#### `createResumableSession(cwd?): { sessionManager, sessionId }`

Create a session manager backed by in-memory storage via `SessionManager.inMemory()`. Returns `{ sessionManager: SessionManager, sessionId: string }`. Always synchronous.

#### `resumeSession(source, target): Promise<void>`

Copy all message entries from a source session into a target session. Uses `appendMessage` when available, or pushes directly into the `messages` array.

### API Key Resolution

#### `resolveApiKey(provider, customKeys?): string | undefined`

Resolve from custom overrides (`customKeys[provider]`) or environment variables via `getEnvApiKey(provider)` from `@earendil-works/pi-ai`.

#### `resolveApiKeyOrThrow(provider, customKeys?): string`

Same as `resolveApiKey` but throws with a helpful error message including expected env var names.

### Re-exports from Dependencies

The following are re-exported from `@earendil-works/pi-coding-agent`:

- `AgentSession`, `SessionManager`, `DefaultResourceLoader`, `AuthStorage`

The following are re-exported from `@earendil-works/pi-ai` (not re-exported by pi-coding-agent):

- `Model` (type), `getModel`, `parseJsonWithRepair`

The following are re-exported from `@earendil-works/pi-agent-core` (not re-exported by pi-coding-agent):

- `ThinkingLevel` (type)

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
class TaskTracker {
  addTask(task: Omit<Task, 'status'> & { status?: TaskStatus }): void;
  getTask(id: string): Task | undefined;
  getAllTasks(): Task[];
  getReadyTasks(): Task[];
  claimTasks(count: number): Task[];
  startTask(id: string, agentId: string): void;
  submitForReview(id: string, result: unknown): void;
  completeTask(id: string): void;
  rejectTask(id: string, reason: string): void;
  areAllDone(): boolean;
  recalculateStatuses(): void;
  toJSON(): { tasks: Task[] };
  static fromJSON(data: { tasks: Task[] }): TaskTracker;
}
```

Manages a DAG of tasks with enforced state transitions and cycle detection. `addTask` performs temporary insertion to check for cycles, rolling back if one is detected.

**Task lifecycle:**

```
blocked → ready → claimed → implementing → reviewing → done
                                    ↑            ↓
                                    └── rejected ←┘ (returns to "ready")
```

> **Note:** `rejected` is not a `TaskStatus` value. It represents the transition from `reviewing` back to `ready` via `rejectTask()`. The task's status is set to `ready`, not `rejected`.

#### `PHASE_ORDER`

The standard phase execution order as a constant array of `WorkflowPhase` values:

```typescript
const PHASE_ORDER: WorkflowPhase[] = [
  'scouting',
  'scouting_review',
  'planning',
  'plan_review',
  'implementing',
  'final_review',
  'done',
];
```

Use this constant when iterating over phases in order. `WorkflowStatusTracker.advancePhase()` uses this internally to determine the next phase.

#### `WorkflowStatusTracker`

```typescript
class WorkflowStatusTracker {
  constructor(workDir: string);
  // Getters
  get taskPrompt(): string;
  get currentPhase(): WorkflowPhase;
  get completedPhases(): WorkflowPhase[];
  get scoutingReports(): unknown[];
  get plan(): unknown;
  get research(): string | undefined;
  get stats(): { totalTokens; totalCost; agentCount };
  get taskTracker(): TaskTracker;
  get auditLog(): AuditLog;
  // Mutators
  setTaskPrompt(prompt: string): void;
  advancePhase(): void;
  setPhase(phase: WorkflowPhase): void;
  setScoutingReports(reports: unknown[]): void;
  setPlan(plan: unknown): void;
  setResearch(research: string): void;
  addTokensToStats(tokens: { input: number; output: number }): void;
  incrementAgentCount(): void;
  // Persistence
  toJSON(): WorkflowState;
  save(): Promise<void>;
  static load(workDir: string): Promise<WorkflowStatusTracker>;
}
```

Top-level workflow state manager. Persists to `workflow-state.json` in the working directory.

---

## 9. Architecture

```
src/
├── index.ts                     # Public API re-exports
├── cli.ts                       # CLI entry point (run, list, init commands)
├── setup.ts                     # Config directory creation (init command)
├── core/
│   ├── types.ts                 # Shared type definitions and re-exports
│   ├── config.ts                # Config directory resolution (global/local/work dirs)
│   ├── profile.ts               # Markdown profile parser, loader, and multi-dir merge
│   ├── workflow-loader.ts       # Dynamic workflow module loading and listing
│   ├── harness-factory.ts       # AgentSession construction from profiles
│   ├── structured-output.ts     # JSON extraction, Zod-validated prompting
│   ├── session-history.ts       # Session statistics and resumption helpers
│   ├── agent-loop.ts            # Looping, parallel, and sequential agent patterns
│   └── auth.ts                  # API key resolution (env vars and overrides)
└── tracking/
    ├── audit-log.ts             # JSONL-based audit event log
    ├── task-status.ts           # Task DAG tracker with state transitions
    └── workflow-status.ts       # Full workflow phase state (persisted to JSON)
```

### Core Layer (`src/core/`)

| Module                 | Responsibility                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`             | Re-exports from `pi-coding-agent`, `pi-agent-core`, and `pi-ai`; defines `AgentProfile`, `Task`, `WorkflowState`, `AuditEvent`, `WorkflowModule`, `WorkflowRunOptions`, and related types      |
| `config.ts`            | Resolves global (`~/.config/workflow-harness/`) and local (`.workflow-harness/`) config directories; provides default work directory paths                                                     |
| `profile.ts`           | Parses markdown files with YAML frontmatter into `AgentProfile` objects; loads all profiles from a directory or merges from multiple directories                                               |
| `workflow-loader.ts`   | Dynamically loads workflow modules by name from config directories; supports `.js`, `.mjs`, `.cjs`, `.ts`; caches loaded modules                                                               |
| `harness-factory.ts`   | Creates a fully-wired `AgentSession` from a profile: model resolution, `AuthStorage`, tool filtering, `DefaultResourceLoader`, and `createAgentSession` from `@earendil-works/pi-coding-agent` |
| `structured-output.ts` | Extracts JSON from free-text model responses; prompts a session and validates output against a Zod schema with automatic retries                                                               |
| `session-history.ts`   | Tracks token usage and cost across a session; provides session resumption by copying message history                                                                                           |
| `agent-loop.ts`        | Higher-level patterns: `agentLoopUntil`, `parallelAgents`, `sequentialAgents`. Uses `AgentSession` and `dispose()` for cleanup                                                                 |
| `auth.ts`              | Resolves API keys from caller-supplied overrides or environment variables via `@earendil-works/pi-ai`                                                                                          |

### Tracking Layer (`src/tracking/`)

| Module               | Responsibility                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-log.ts`       | Appends `AuditEvent` records to a JSONL file; supports filtering by type or task ID; computes aggregate stats                                 |
| `task-status.ts`     | Manages a collection of `Task` objects with a DAG of dependencies; enforces state transitions; detects cycles                                 |
| `workflow-status.ts` | Top-level workflow state: current phase, completed phases, scouting reports, plan, stats, and task tracker; persists to `workflow-state.json` |

This package is a **pure library** — it provides building blocks (harness creation, profile loading, structured output, agent loop patterns, task tracking, audit logging) that user-managed workflow scripts compose into pipelines. It does not ship any built-in workflows or agent profiles.

---

## 10. Authoring Workflows

Workflows are user-managed scripts that use the library's building blocks to define multi-agent pipelines. A typical workflow:

1. Resolves profiles from config directories via `resolveProfilesDirs` and `loadProfilesFromDirs`.
2. Creates a `WorkflowStatusTracker` for phase and task state persistence.
3. Uses `createHarness` or `parallelAgents` to spawn agents with specific profiles.
4. Uses `promptForStructured` with Zod schemas to enforce structured output.
5. Tracks tasks via `TaskTracker` and logs events via `AuditLog`.

See [Custom Workflows](#7-custom-workflows) for examples and [Programmatic API](#8-programmatic-api) for the full set of available building blocks.

---

## 11. Types Reference

All types listed below are exported from the top-level `workflow-harness` entry point.

### Union Types

#### `ThinkingLevel`

```typescript
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
```

Re-exported from `@earendil-works/pi-agent-core`.

#### `WorkflowPhase`

```typescript
type WorkflowPhase =
  | 'scouting'
  | 'scouting_review'
  | 'planning'
  | 'plan_review'
  | 'implementing'
  | 'final_review'
  | 'done';
```

`advancePhase()` moves strictly forward; `setPhase()` can jump to any valid phase.

#### `TaskStatus`

```typescript
type TaskStatus = 'blocked' | 'ready' | 'claimed' | 'implementing' | 'reviewing' | 'done';
```

See [Task lifecycle](#tasktracker) for valid transitions.

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

| Field             | Type         | Description                                    |
| ----------------- | ------------ | ---------------------------------------------- |
| `id`              | `string`     | Unique task identifier                         |
| `title`           | `string`     | Short description                              |
| `prompt`          | `string`     | Detailed prompt for the implementing agent     |
| `profile`         | `string`     | Agent profile ID to use                        |
| `files`           | `string[]`   | Files this task is expected to modify          |
| `dependencies`    | `string[]`   | Task IDs that must complete before this task   |
| `status`          | `TaskStatus` | Current lifecycle state                        |
| `assignedAgent?`  | `string`     | ID of the agent currently working on this task |
| `result?`         | `unknown`    | Implementation result submitted for review     |
| `reviewFeedback?` | `string`     | Feedback from reviewer on rejection            |

---

### `AuditEvent`

A discriminated union logged by `AuditLog`. Each variant has an auto-generated `timestamp: string` field.

#### `agent_start`

| Field     | Type            | Description                      |
| --------- | --------------- | -------------------------------- |
| `type`    | `"agent_start"` | Discriminant                     |
| `agentId` | `string`        | Identifier of the agent          |
| `profile` | `AgentProfile`  | Profile used to create the agent |
| `taskId?` | `string`        | Associated task, if applicable   |

#### `agent_end`

| Field     | Type          | Description                                                |
| --------- | ------------- | ---------------------------------------------------------- |
| `type`    | `"agent_end"` | Discriminant                                               |
| `agentId` | `string`      | Identifier of the agent                                    |
| `result`  | `unknown`     | The agent's final result (may include `cost` and `tokens`) |
| `taskId?` | `string`      | Associated task, if applicable                             |

#### `decision`

| Field       | Type         | Description                                                 |
| ----------- | ------------ | ----------------------------------------------------------- |
| `type`      | `"decision"` | Discriminant                                                |
| `agentId`   | `string`     | Identifier of the deciding agent                            |
| `decision`  | `string`     | Short decision label (e.g. `"approved"`, `"plan_rejected"`) |
| `reasoning` | `string`     | Explanation for the decision                                |
| `taskId?`   | `string`     | Associated task, if applicable                              |

#### `structured_output`

| Field     | Type                  | Description                       |
| --------- | --------------------- | --------------------------------- |
| `type`    | `"structured_output"` | Discriminant                      |
| `agentId` | `string`              | Identifier of the producing agent |
| `output`  | `unknown`             | The validated structured output   |
| `taskId?` | `string`              | Associated task, if applicable    |

#### `error`

| Field     | Type      | Description                          |
| --------- | --------- | ------------------------------------ |
| `type`    | `"error"` | Discriminant                         |
| `agentId` | `string`  | Identifier of the agent that errored |
| `error`   | `string`  | Error description                    |
| `taskId?` | `string`  | Associated task, if applicable       |

---

### `WorkflowState`

Serialized form of `WorkflowStatusTracker`. Written to `workflow-state.json` on `save()`.

| Field             | Type                                                             | Description                                       |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| `taskPrompt`      | `string`                                                         | The original task prompt                          |
| `currentPhase`    | `WorkflowPhase`                                                  | Phase the workflow is currently in                |
| `completedPhases` | `WorkflowPhase[]`                                                | Phases that have finished                         |
| `tasks`           | `Task[]`                                                         | All tasks in the plan                             |
| `scoutingReports` | `unknown[]`                                                      | Collected scouting reports                        |
| `plan`            | `unknown`                                                        | The validated implementation plan                 |
| `research?`       | `string`                                                         | Synthesized research summary from scouting review |
| `stats`           | `{ totalTokens: number; totalCost: number; agentCount: number }` | Aggregate statistics                              |

---

### `WorkflowRunOptions`

Options passed to a workflow's `run()` function.

| Field                 | Type                     | Description                               |
| --------------------- | ------------------------ | ----------------------------------------- |
| `cwd`                 | `string`                 | Project directory to operate on           |
| `workDir`             | `string`                 | Directory for workflow state persistence  |
| `maxConcurrentTasks?` | `number`                 | Maximum parallel implementers (default 3) |
| `apiKeys?`            | `Record<string, string>` | Provider → API key overrides              |
| `onStatus?`           | `StatusCallbacks`        | Callbacks for workflow/agent events       |

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

| Field            | Type                     | Description                                    |
| ---------------- | ------------------------ | ---------------------------------------------- |
| `profile`        | `AgentProfile`           | The agent configuration to use                 |
| `cwd`            | `string`                 | Working directory for file operations          |
| `apiKeys?`       | `Record<string, string>` | Provider → API key overrides                   |
| `onAgentStatus?` | `AgentStatusCallbacks`   | Callbacks for turn-level and tool-level events |

Tool filtering is handled internally from the profile's `includeTools`/`excludeTools` fields. The default tool set is `read`, `bash`, `edit`, `write`.

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

### `SessionStats`

Token usage and cost aggregation returned by `SessionHistory.getStats()`.

| Field               | Type     | Description                                    |
| ------------------- | -------- | ---------------------------------------------- |
| `totalInputTokens`  | `number` | Sum of input tokens from assistant messages    |
| `totalOutputTokens` | `number` | Sum of output tokens from assistant messages   |
| `totalCost`         | `number` | Sum of costs from assistant messages           |
| `messageCount`      | `number` | Total number of message entries in the session |

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

| Method               | Parameter Shape                                                             | Fired when                             |
| -------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| `onWorkflowStart`    | `{ taskPrompt: string; resumed: boolean; workDir: string }`                 | The `run()` orchestrator starts        |
| `onPhaseStart`       | `{ phase: WorkflowPhase; round: number }`                                   | A phase begins execution               |
| `onPhaseComplete`    | `{ phase: WorkflowPhase; durationMs: number }`                              | A phase finishes                       |
| `onAgentSpawn`       | `{ agentId: string; profile: string; phase: string; taskId?: string }`      | An agent session is created            |
| `onAgentComplete`    | `{ agentId: string; profile: string; phase: string; taskId?: string }`      | An agent finishes its prompt           |
| `onTaskStart`        | `{ taskId: string; title: string; agentId: string }`                        | A task is claimed and dispatched       |
| `onTaskComplete`     | `{ taskId: string; title: string }`                                         | A task passes review                   |
| `onTaskRejected`     | `{ taskId: string; title: string; reason: string }`                         | A task fails review                    |
| `onDecision`         | `{ agentId: string; decision: string; reasoning: string; taskId?: string }` | A reviewer makes a decision            |
| `onError`            | `{ agentId: string; error: string; phase: string; taskId?: string }`        | An agent encounters an error           |
| `onWorkflowComplete` | `{ totalDurationMs: number; agentCount: number }`                           | The workflow finishes successfully     |
| `onWorkflowFailed`   | `{ error: Error; phase: string }`                                           | The workflow throws an unhandled error |

All methods are optional.

#### `AgentStatusCallbacks`

| Method            | Parameter Shape                                                                 | Fired when                |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------- |
| `onTurnStart`     | `{ agentId: string; turn: number }`                                             | An agent turn begins      |
| `onTurnEnd`       | `{ agentId: string; turn: number; tokens?: { input: number; output: number } }` | An agent turn completes   |
| `onToolCallStart` | `{ agentId: string; toolName: string; toolCallId: string }`                     | A tool execution starts   |
| `onToolCallEnd`   | `{ agentId: string; toolName: string; toolCallId: string; isError: boolean }`   | A tool execution finishes |

All methods are optional.

---

## 12. Configuration

### .env File Loading

workflow-harness automatically loads environment variables from `.env` files at startup, before any command executes. This is useful for storing API keys and other configuration needed by tools and providers.

**File locations (loaded in order):**

| Priority    | Path                              | Scope                                |
| ----------- | --------------------------------- | ------------------------------------ |
| 1 (lowest)  | `~/.config/workflow-harness/.env` | User-level, shared across projects   |
| 2 (highest) | `{cwd}/.workflow-harness/.env`    | Project-level, per-project overrides |

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
# workflow-harness .env file
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
MY_TOOL_API_KEY=abc123
```

**Verbose output:** When run with `--verbose`, loaded `.env` file paths are printed:

```
[12:34:56] 📄 Loaded .env: /home/user/.config/workflow-harness/.env
[12:34:56] 📄 Loaded .env: /path/to/project/.workflow-harness/.env
```

> **Note:** The `.workflow-harness/.env` file should be included in the project's `.gitignore`. Never commit `.env` files containing secrets to version control.

### Environment Variables

API keys are resolved in this order:

1. The `apiKeys` option passed to `createHarness` or `run`.
2. The `--api-key` CLI flag.
3. Provider-specific environment variables (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).

> **Warning:** API keys passed via `--api-key` are visible in process listings. Prefer environment variables or the `apiKeys` programmatic option.

### Resuming a Workflow

If `workflow-state.json` exists in `workDir`, the `run()` function loads it and resumes from the last saved phase.

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
| `bun run setup`        | Build then run `workflow-harness init` to create config directories   |

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
workflow-harness/
├── src/                # Source code
│   ├── core/           # Core layer (sessions, profiles, auth, config)
│   └── tracking/       # Tracking layer (audit, tasks, workflow state)
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
│   ├── auth.test.ts
│   ├── config.test.ts
│   ├── harness-factory.test.ts
│   ├── harness-factory.subscribe.test.ts
│   ├── profile.test.ts
│   ├── session-history.test.ts
│   ├── structured-output.test.ts
│   └── workflow-loader.test.ts
├── tracking/
│   ├── audit-log.test.ts
│   ├── task-status.test.ts
│   └── workflow-status.test.ts
├── cli.test.ts
└── setup.test.ts
```

### Adding New Profiles

1. Create a `.md` file in `~/.config/workflow-harness/profiles/` (e.g. `my-agent.md`).
2. Add YAML frontmatter with at least `provider` and `model`.
3. Write the system prompt in the body.
4. The profile is now available to workflows that load profiles from the config directories.

### Adding a New Workflow

1. Create a `.js`, `.mjs`, `.cjs`, or `.ts` file in `~/.config/workflow-harness/workflows/` or `.workflow-harness/workflows/`.
2. Export a `run(taskPrompt, options)` function.
3. Reference it by filename (without extension) on the CLI:

```bash
workflow-harness my-workflow "Do the thing"
```

### TypeScript Configuration

- **Target**: ES2024
- **Module**: ESNext (ESM with `.js` extensions in imports)
- **Strict mode**: enabled
- **Declaration files**: emitted to `dist/`
