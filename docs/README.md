# workflow-harness

A script-based workflow engine for AI-driven development, built on top of [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core).

---

## 1. Overview

**workflow-harness** orchestrates multi-agent AI workflows for software development tasks. It uses `AgentHarness` from `@earendil-works/pi-agent-core` as its inference layer and provides a phase-based approach to breaking down, planning, implementing, and reviewing code changes.

Workflows are loaded dynamically from config directories — you can use the built-in `develop` workflow or drop in your own. Agent profiles are plain markdown files with YAML frontmatter, so you can customize agent behavior without touching code.

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

- **Node.js** >= 22.19.0
- **npm** (bundled with Node.js)
- **API keys** for your configured provider(s); see [Configuration](#9-configuration) for details

### Install

```bash
git clone <repository-url> workflow-harness
cd workflow-harness
npm install
npm run build
```

### First-Time Setup

Install default profiles and the `develop` workflow into your global config directory:

```bash
workflow-harness init
```

This copies built-in profiles and workflows to `~/.config/workflow-harness/` (or `$XDG_CONFIG_HOME/workflow-harness/`). Files that already exist are skipped unless you pass `--force`.

---

## 3. Quick Start

### CLI

```bash
# Initialize default config (first time only)
workflow-harness init

# Run the develop workflow
workflow-harness develop "Add input validation to all public API endpoints"

# Run with options
workflow-harness develop "Fix the login bug" \
  --cwd ./my-project \
  --max-concurrent 5 \
  --verbose
```

### Programmatic

```typescript
import { run } from "workflow-harness";

await run("Add input validation to all public API endpoints", {
  cwd: "/path/to/project",
  workDir: "/tmp/workflow-run-001",
  maxConcurrentTasks: 3,
});
```

With status callbacks to monitor progress:

```typescript
await run("Add input validation to all public API endpoints", {
  cwd: "/path/to/project",
  workDir: "/tmp/workflow-run-001",
  maxConcurrentTasks: 3,
  onStatus: {
    onPhaseStart: ({ phase }) => console.log(`Starting: ${phase}`),
    onPhaseComplete: ({ phase, durationMs }) => console.log(`Done: ${phase} (${durationMs}ms)`),
    onWorkflowComplete: ({ totalDurationMs }) => console.log(`Finished in ${totalDurationMs}ms`),
  },
});
```

---

## 4. CLI Reference

The `workflow-harness` binary supports several commands:

```
workflow-harness <command> [options]
```

### Commands

| Command | Description |
|---|---|
| `run` (default) | Run a named workflow with a task prompt |
| `list` | List available workflows and profiles |
| `init` | Install default profiles and workflows to the global config directory |
| `--help` / `-h` | Show usage information |
| `--version` / `-v` | Show version |

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
workflow-harness init [--force]
```

Copies built-in profiles from `defaults/profiles/` and the default `develop` workflow from `defaults/workflows/` into the global config directory. Skips files that already exist unless `--force` is passed.

### Flags

| Flag | Applies to | Description |
|---|---|---|
| `--cwd <path>` | All commands | Project working directory (default: `process.cwd()`) |
| `--work-dir <path>` | `run` | Directory for workflow state persistence. Default: `.workflow-harness/work/<workflow-name>` inside `cwd` |
| `--max-concurrent <n>` | `run` | Maximum parallel implementer agents (default: `3`). Must be a positive integer. |
| `--verbose` | `run` | Enable agent-level output (turns, tool calls, token usage) |
| `--api-key <provider=key>` | `run` | Provider → API key override. Repeatable. **Warning:** values are visible in process listings; prefer environment variables. |
| `--force` | `init` | Overwrite existing files |

### Exit Codes

| Code | Meaning |
|---|---|
| `0` | Workflow completed successfully |
| `1` | Workflow failed with an error |

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

| Scope | Path |
|---|---|
| **Global** | `$XDG_CONFIG_HOME/workflow-harness/` — or `~/.config/workflow-harness/` when `XDG_CONFIG_HOME` is unset or empty |
| **Local** | `{cwd}/.workflow-harness/` — where `cwd` is the project directory |

### Directory Structure

```
.workflow-harness/           # Local (per-project)
├── profiles/                # Agent profile .md files
├── workflows/               # Workflow scripts (.js, .mjs, .cjs, .ts)
└── work/                    # Runtime state (auto-created)
    └── develop/             # One subdirectory per workflow run
            └── workflow-state.json
            └── audit/audit.jsonl

~/.config/workflow-harness/  # Global (user-wide)
├── profiles/
└── workflows/
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

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | No | Filename without `.md` | Human-readable display name |
| `provider` | **Yes** | — | AI provider identifier (e.g. `anthropic`, `openai`) |
| `model` | **Yes** | — | Model identifier within the provider |
| `thinkingLevel` | No | `"medium"` | Model thinking depth. One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `excludeTools` | No | `[]` | Tool names to remove from the default set |
| `includeTools` | No | `[]` | If non-empty, only these tools are included |

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

### Default Profiles

The built-in profiles in `defaults/profiles/` are installed by `workflow-harness init`:

| Profile ID | Role | Tools |
|---|---|---|
| `scout` | Investigates codebase areas | Excludes `write`, `edit` |
| `scouting-reviewer` | Synthesizes scouting reports | Excludes `write`, `edit` |
| `planner` | Creates implementation plans | Excludes `write`, `edit` |
| `plan-reviewer` | Reviews plans for feasibility | Excludes `write`, `edit` |
| `implementer` | Writes code to implement tasks | All tools available |
| `implement-reviewer` | Reviews implementations | Excludes `write`, `edit` |
| `final-reviewer` | Final quality review | Excludes `write`, `edit` |
| `fixer` | Fixes issues found in review | All tools available |

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
import { createHarness, loadProfilesFromDirs, resolveProfilesDirs, promptForStructured } from "workflow-harness";
import { z } from "zod";

export async function run(taskPrompt, options) {
  const { cwd, workDir, apiKeys, onStatus } = options;
  const profilesDirs = resolveProfilesDirs(cwd);
  const profiles = await loadProfilesFromDirs(profilesDirs);

  const profile = profiles.get("implementer");
  if (!profile) throw new Error("implementer profile not found");

  const { harness } = await createHarness({ profile, cwd, apiKeys });
  const result = await harness.prompt(`Complete this task: ${taskPrompt}`);
  console.log("Done:", result);
}
```

### Example: Composing Phase Functions

The default `develop` workflow is just a re-export:

```javascript
// defaults/workflows/develop.js
export { run } from "workflow-harness";
```

You can import individual phase functions from `workflow-harness` to compose a custom pipeline:

```typescript
import {
  scoutingPhase,
  planningPhase,
  implementationPhase,
  finalReviewPhase,
  WorkflowStatusTracker,
} from "workflow-harness";

export async function run(taskPrompt: string, options: WorkflowRunOptions) {
  const tracker = new WorkflowStatusTracker(options.workDir);
  const profilesDirs = resolveProfilesDirs(options.cwd);

  const reports = await scoutingPhase(tracker, profilesDirs, taskPrompt, options.cwd, options.apiKeys, options.onStatus);
  // ... custom orchestration logic
}
```

### TypeScript Workflows

`.ts` workflow files are supported at runtime via the `tsx` ESM loader, which is automatically registered the first time a `.ts` workflow is loaded.

---

## 8. Programmatic API

All types and functions below are exported from the top-level `workflow-harness` entry point.

### Workflow Execution

#### `run(taskPrompt, options): Promise<void>`

Execute the full development workflow. Resumes automatically if a `workflow-state.json` exists in `workDir`.

```typescript
import { run } from "workflow-harness";

await run("Add error handling to the API layer", {
  cwd: "/path/to/project",
  workDir: "/tmp/workflow-run-001",
  maxConcurrentTasks: 3,
});
```

If `profilesDir` is omitted, profiles are auto-resolved from the local and global config directories via `resolveProfilesDirs(cwd)`.

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

#### `createHarness(options): Promise<{ harness, sessionId, unsubscribe? }>`

Create a fully-wired `AgentHarness` from an `AgentProfile`. Resolution steps: create `NodeExecutionEnv`, create session (in-memory or JSONL-backed), resolve model, filter tools, resolve API key, subscribe to agent status events.

**`HarnessCreationOptions` fields:**

| Field | Type | Description |
|---|---|---|
| `profile` | `AgentProfile` | The agent configuration |
| `cwd` | `string` | Working directory for file operations |
| `sessionId?` | `string` | Provide for JSONL persistence; omit for in-memory |
| `additionalTools?` | `AgentTool[]` | Extra tools beyond the defaults |
| `apiKeys?` | `Record<string, string>` | Provider → API key overrides |
| `onAgentStatus?` | `AgentStatusCallbacks` | Callbacks for turn/tool events |

**Return fields:**

| Field | Type | Description |
|---|---|---|
| `harness` | `AgentHarness` | The fully-wired agent harness |
| `sessionId` | `string` | Resolved session identifier |
| `unsubscribe?` | `() => void` | Teardown for agent status subscription. Only present when `onAgentStatus` is provided AND at least one agent-level callback is defined. |

#### `createHarnessFromProfile(dirPath, profileId, options): Promise<{ harness, sessionId, unsubscribe? }>`

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

### Setup

#### `initDefaultConfig(options?): Promise<{ installed, skipped }>`

Installs default profiles and workflows from `defaults/` into the global config directory. Skips existing files unless `force: true` is passed. Skips symlinks with a warning.

### Structured Output

#### `promptForStructured<T>(harness, prompt, schema, options?): Promise<T>`

Prompt a harness and parse the response through a Zod schema. Retries up to `maxRetries` (default 3) with error feedback appended to the prompt.

#### `extractJsonFromText(text): string | null`

Extract a JSON string from free-text model output. Tries fenced code blocks first, then bracket counting.

#### `getAssistantText(message): string`

Concatenate all text blocks from an assistant message's content array.

#### `schemaToString(schema): string`

Convert a Zod schema into a human-readable description string.

### Agent Loop Utilities

#### `agentLoopUntil(harness, promptFn, conditionFn, options?): Promise<{ response, attempts }>`

Repeatedly prompt a harness until `conditionFn` returns `true` or `maxAttempts` (default 10) is reached.

#### `retryAgentUntil<T>(harness, prompt, schema, options?): Promise<AgentLoopResult<T>>`

Convenience wrapper around `promptForStructured` that returns an `AgentLoopResult` envelope. Token tracking is not available — `totalTokens` is set to zero.

#### `parallelAgents<T>(configs, promptFn, options?): Promise<PromiseSettledResult<T>[]>`

Create harnesses for every config in parallel, then run prompts via `Promise.allSettled`. Optionally validate through a Zod schema.

#### `sequentialAgents<T>(configs, promptFn, options?): Promise<T[]>`

Same as `parallelAgents` but runs prompts sequentially. Throws on the first failure.

### Session Management

#### `SessionHistory`

```typescript
class SessionHistory {
  constructor(session: Session);
  getMessageCount(): Promise<number>;
  getStats(): Promise<SessionStats>;
}
```

#### `createResumableSession(cwd, sessionId?): Promise<{ session, sessionId }>`

Create a session backed by in-memory or JSONL storage.

#### `resumeSession(source, target): Promise<void>`

Copy all message entries from a source session into a target harness.

### API Key Resolution

#### `resolveApiKey(provider, customKeys?): string | undefined`

Resolve from custom overrides or environment variables.

#### `resolveApiKeyOrThrow(provider, customKeys?): string`

Same as `resolveApiKey` but throws with a helpful error message including expected env var names.

### Tool Registry

#### `ToolRegistry`

```typescript
class ToolRegistry {
  register(entry: ToolRegistryEntry): void;
  get(name: string): AgentTool | undefined;
  getAll(): AgentTool[];
  resolveTools(includeTools: string[], excludeTools: string[]): AgentTool[];
}
```

#### `createDefaultToolRegistry(env): ToolRegistry`

Creates a registry with seven built-in tools: `read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`.

### Tracking

#### `AuditLog`

```typescript
class AuditLog {
  constructor(logDir: string);
  append(event: Omit<AuditEvent, "timestamp">): Promise<void>;
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
  addTask(task: Omit<Task, "status"> & { status?: TaskStatus }): void;
  getTask(id: string): Task | undefined;
  getAllTasks(): Task[];
  getReadyTasks(): Task[];
  claimTasks(count: number): Task[];
  startTask(id: string, agentId: string): void;
  submitForReview(id: string, result: unknown): void;
  completeTask(id: string): void;
  rejectTask(id: string, reason: string): void;
  areAllDone(): boolean;
  toJSON(): { tasks: Task[] };
  static fromJSON(data: { tasks: Task[] }): TaskTracker;
}
```

Manages a DAG of tasks with enforced state transitions and cycle detection.

**Task lifecycle:**

```
blocked → ready → claimed → implementing → reviewing → done
                                    ↑            ↓
                                    └── rejected ←┘ (returns to "ready")
```

> **Note:** `rejected` is not a `TaskStatus` value. It represents the transition from `reviewing` back to `ready` via `rejectTask()`. The task's status is set to `ready`, not `rejected`.

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

### Phase Functions (Develop Workflow)

Each phase of the develop workflow is exported individually for custom orchestration:

| Function | Signature |
|---|---|
| `scoutingPhase` | `(tracker, profilesDirs, taskPrompt, cwd, apiKeys?, onStatus?) → Promise<unknown[]>` |
| `scoutingReviewPhase` | `(tracker, profilesDirs, reports, cwd, apiKeys?, onStatus?) → Promise<ScoutingReview>` |
| `planningPhase` | `(tracker, profilesDirs, research, taskPrompt, cwd, apiKeys?, onStatus?) → Promise<Plan>` |
| `planReviewPhase` | `(tracker, profilesDirs, plan, research, taskPrompt, cwd, apiKeys?, onStatus?) → Promise<PlanReview>` |
| `implementationPhase` | `(tracker, profilesDirs, plan, cwd, maxConcurrentTasks?, apiKeys?, onStatus?) → Promise<void>` |
| `finalReviewPhase` | `(tracker, profilesDirs, cwd, apiKeys?, onStatus?) → Promise<boolean>` |

Note the `profilesDirs` parameter is a `string[]` (an array of directories), not a single directory path.

---

## 9. Architecture

```
src/
├── index.ts                     # Public API re-exports
├── cli.ts                       # CLI entry point (run, list, init commands)
├── setup.ts                     # Default config installation (initDefaultConfig)
├── core/
│   ├── types.ts                 # Shared type definitions and re-exports
│   ├── config.ts                # Config directory resolution (global/local/work dirs)
│   ├── profile.ts               # Markdown profile parser, loader, and multi-dir merge
│   ├── workflow-loader.ts       # Dynamic workflow module loading and listing
│   ├── harness-factory.ts       # AgentHarness construction from profiles
│   ├── structured-output.ts     # JSON extraction, Zod-validated prompting
│   ├── session-history.ts       # Session statistics and resumption helpers
│   ├── agent-loop.ts            # Looping, parallel, and sequential agent patterns
│   ├── auth.ts                  # API key resolution (env vars and overrides)
│   └── tool-registry.ts         # Tool registration and filtered resolution
├── tracking/
│   ├── audit-log.ts             # JSONL-based audit event log
│   ├── task-status.ts           # Task DAG tracker with state transitions
│   └── workflow-status.ts       # Full workflow phase state (persisted to JSON)
├── workflows/
│   └── develop.ts               # The development workflow: phases + orchestrator
└── profiles/                    # Built-in agent profile definitions
    ├── scout.md
    ├── scouting-reviewer.md
    ├── planner.md
    ├── plan-reviewer.md
    ├── implementer.md
    ├── implement-reviewer.md
    ├── final-reviewer.md
    └── fixer.md

defaults/                        # Files installed by `workflow-harness init`
├── profiles/                    # Same as src/profiles/
└── workflows/
    └── develop.js               # Re-exports run from workflow-harness
```

### Core Layer (`src/core/`)

| Module | Responsibility |
|---|---|
| `types.ts` | Re-exports from `pi-agent-core` and `pi-ai`; defines `AgentProfile`, `Task`, `WorkflowState`, `AuditEvent`, `WorkflowModule`, `WorkflowRunOptions`, and related types |
| `config.ts` | Resolves global (`~/.config/workflow-harness/`) and local (`.workflow-harness/`) config directories; provides default work directory paths |
| `profile.ts` | Parses markdown files with YAML frontmatter into `AgentProfile` objects; loads all profiles from a directory or merges from multiple directories |
| `workflow-loader.ts` | Dynamically loads workflow modules by name from config directories; supports `.js`, `.mjs`, `.cjs`, `.ts`; caches loaded modules |
| `harness-factory.ts` | Creates a fully-wired `AgentHarness` from a profile: execution environment, session, model, tools, and API key |
| `structured-output.ts` | Extracts JSON from free-text model responses; prompts a harness and validates output against a Zod schema with automatic retries |
| `session-history.ts` | Tracks token usage and cost across a session; provides session resumption by copying message history |
| `agent-loop.ts` | Higher-level patterns: `agentLoopUntil`, `parallelAgents`, `sequentialAgents` |
| `auth.ts` | Resolves API keys from caller-supplied overrides or environment variables |
| `tool-registry.ts` | Registers tools by name and resolves a filtered subset based on `includeTools`/`excludeTools` |

### Tracking Layer (`src/tracking/`)

| Module | Responsibility |
|---|---|
| `audit-log.ts` | Appends `AuditEvent` records to a JSONL file; supports filtering by type or task ID; computes aggregate stats |
| `task-status.ts` | Manages a collection of `Task` objects with a DAG of dependencies; enforces state transitions; detects cycles |
| `workflow-status.ts` | Top-level workflow state: current phase, completed phases, scouting reports, plan, stats, and task tracker; persists to `workflow-state.json` |

### Workflow Layer (`src/workflows/`)

| Module | Responsibility |
|---|---|
| `develop.ts` | Exports individual phase functions and a top-level `run()` orchestrator that chains them with retry loops |

---

## 10. How the Develop Workflow Works

The `run()` orchestrator in `develop.ts` uses a **phase-dispatch loop** driven by an ordered `phaseOrder` array:

```
["scouting", "scouting_review", "planning", "plan_review", "implementing", "final_review", "done"]
```

Each phase has a handler that performs exactly one step. A handler may return the name of a phase to **jump to** (for retries), or return `void` to **advance linearly** to the next entry. This makes the control flow explicit and easy to extend — to add a new phase, insert it into the array and add a case to the handler.

The pipeline proceeds as follows:

1. **Scouting** — A `scout` agent identifies codebase areas to investigate. For each topic discovered, a parallel scout agent produces a report via `parallelAgents`.

2. **Scouting Review** — The `scouting-reviewer` synthesizes all reports into a research summary and decides whether enough information has been gathered. If `ready` is `false` and fewer than 3 rounds have elapsed, the handler returns `"scouting"` to jump back. After 3 rounds the workflow proceeds regardless.

3. **Planning** — The `planner` agent creates a `Plan` containing an array of `Task` objects, each with `id`, `title`, `prompt`, `profile`, `files`, and `dependencies`. The plan forms a DAG.

4. **Plan Review** — The `plan-reviewer` evaluates the plan. If `ready` is `false` and fewer than 3 rounds have elapsed, the handler returns `"planning"` to jump back. After 3 rounds the workflow proceeds with the current plan.

5. **Implementation** — Tasks are loaded into the `TaskTracker`. The orchestrator claims up to `maxConcurrentTasks` at a time, dispatches them to implementer agents in parallel via `parallelAgents`, and then runs reviewer agents in parallel via `Promise.allSettled`. Approved tasks are completed; rejected tasks return to `"ready"` for re-implementation. If a review itself fails, the failure is logged and the task is still completed to avoid blocking the pipeline.

6. **Final Review** — The `final-reviewer` examines the entire codebase. If critical issues are found, `fixer` agents resolve them in parallel. This loop runs up to 3 rounds.

### Parallel Execution

Concurrency is used at multiple points:

- During **scouting**, one scout agent is spawned per topic via `parallelAgents`.
- During **implementation**, tasks are claimed in batches of `maxConcurrentTasks`. Each batch runs implementer agents in parallel, and reviews also run in parallel.
- During **final review**, fixer agents for critical issues run in parallel.

`parallelAgents` uses `Promise.allSettled` under the hood, so a single agent failure does not crash the batch.

### Structured Output Schemas

The develop workflow exports these Zod schemas for reuse:

| Schema | Fields |
|---|---|
| `ScoutingTopicSchema` | `topics: Array<{ topic, rationale, files }>` |
| `ScoutingReviewSchema` | `ready: boolean`, `research: string`, `gaps: string[]` |
| `PlanSchema` | `tasks: Array<{ id, title, prompt, profile, files, dependencies }>`, `strategy: string` |
| `PlanReviewSchema` | `ready: boolean`, `feedback: string`, `suggestions: string[]` |
| `ReviewResultSchema` | `approved: boolean`, `feedback: string`, `issues: Array<{ file, description, severity }>` |
| `FinalReviewTopicsSchema` | `topics: Array<{ topic, files }>`, `overallAssessment: string`, `issues: Array<{ file, description, severity }>` |

---

## 11. Types Reference

All types listed below are exported from the top-level `workflow-harness` entry point.

### Union Types

#### `ThinkingLevel`

```typescript
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

Re-exported from `@earendil-works/pi-agent-core`.

#### `WorkflowPhase`

```typescript
type WorkflowPhase =
    | "scouting"
    | "scouting_review"
    | "planning"
    | "plan_review"
    | "implementing"
    | "final_review"
    | "done";
```

`advancePhase()` moves strictly forward; `setPhase()` can jump to any valid phase.

#### `TaskStatus`

```typescript
type TaskStatus = "blocked" | "ready" | "claimed" | "implementing" | "reviewing" | "done";
```

See [Task lifecycle](#tasktracker) for valid transitions.

---

### `AgentProfile`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Profile identifier — derived from filename without `.md` |
| `name` | `string` | Human-readable display name. Defaults to `id` |
| `provider` | `string` | AI provider identifier |
| `model` | `string` | Model identifier within the provider |
| `thinkingLevel` | `ThinkingLevel` | Model thinking depth |
| `systemPrompt` | `string` | The full system prompt (markdown body after frontmatter) |
| `excludeTools` | `string[]` | Tool names to remove from the default set |
| `includeTools` | `string[]` | If non-empty, only these tools are included |

---

### `Task`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique task identifier |
| `title` | `string` | Short description |
| `prompt` | `string` | Detailed prompt for the implementing agent |
| `profile` | `string` | Agent profile ID to use |
| `files` | `string[]` | Files this task is expected to modify |
| `dependencies` | `string[]` | Task IDs that must complete before this task |
| `status` | `TaskStatus` | Current lifecycle state |
| `assignedAgent?` | `string` | ID of the agent currently working on this task |
| `result?` | `unknown` | Implementation result submitted for review |
| `reviewFeedback?` | `string` | Feedback from reviewer on rejection |

---

### `AuditEvent`

A discriminated union logged by `AuditLog`. Each variant has an auto-generated `timestamp: string` field.

#### `agent_start`

| Field | Type | Description |
|---|---|---|
| `type` | `"agent_start"` | Discriminant |
| `agentId` | `string` | Identifier of the agent |
| `profile` | `AgentProfile` | Profile used to create the agent |
| `taskId?` | `string` | Associated task, if applicable |

#### `agent_end`

| Field | Type | Description |
|---|---|---|
| `type` | `"agent_end"` | Discriminant |
| `agentId` | `string` | Identifier of the agent |
| `result` | `unknown` | The agent's final result (may include `cost` and `tokens`) |
| `taskId?` | `string` | Associated task, if applicable |

#### `decision`

| Field | Type | Description |
|---|---|---|
| `type` | `"decision"` | Discriminant |
| `agentId` | `string` | Identifier of the deciding agent |
| `decision` | `string` | Short decision label (e.g. `"approved"`, `"plan_rejected"`) |
| `reasoning` | `string` | Explanation for the decision |
| `taskId?` | `string` | Associated task, if applicable |

#### `structured_output`

| Field | Type | Description |
|---|---|---|
| `type` | `"structured_output"` | Discriminant |
| `agentId` | `string` | Identifier of the producing agent |
| `output` | `unknown` | The validated structured output |
| `taskId?` | `string` | Associated task, if applicable |

#### `error`

| Field | Type | Description |
|---|---|---|
| `type` | `"error"` | Discriminant |
| `agentId` | `string` | Identifier of the agent that errored |
| `error` | `string` | Error description |
| `taskId?` | `string` | Associated task, if applicable |

---

### `WorkflowState`

Serialized form of `WorkflowStatusTracker`. Written to `workflow-state.json` on `save()`.

| Field | Type | Description |
|---|---|---|
| `taskPrompt` | `string` | The original task prompt |
| `currentPhase` | `WorkflowPhase` | Phase the workflow is currently in |
| `completedPhases` | `WorkflowPhase[]` | Phases that have finished |
| `tasks` | `Task[]` | All tasks in the plan |
| `scoutingReports` | `unknown[]` | Collected scouting reports |
| `plan` | `unknown` | The validated implementation plan |
| `research?` | `string` | Synthesized research summary from scouting review |
| `stats` | `{ totalTokens: number; totalCost: number; agentCount: number }` | Aggregate statistics |

---

### `WorkflowRunOptions`

Options passed to a workflow's `run()` function.

| Field | Type | Description |
|---|---|---|
| `cwd` | `string` | Project directory to operate on |
| `workDir` | `string` | Directory for workflow state persistence |
| `maxConcurrentTasks?` | `number` | Maximum parallel implementers (default 3) |
| `apiKeys?` | `Record<string, string>` | Provider → API key overrides |
| `onStatus?` | `StatusCallbacks` | Callbacks for workflow/agent events |

---

### `WorkflowModule`

Interface for workflow modules loaded by `loadWorkflow`.

| Field | Type | Description |
|---|---|---|
| `run` | `(taskPrompt: string, options: WorkflowRunOptions) => Promise<void>` | The workflow entry point (**required**) |
| `name?` | `string` | Human-readable workflow name |
| `description?` | `string` | Workflow description |

---

### `DevelopWorkflowOptions`

Options shared by the develop workflow phases.

| Field | Type | Description |
|---|---|---|
| `profilesDir?` | `string` | Explicit profiles directory. If omitted, auto-resolved via `resolveProfilesDirs(cwd)` |
| `cwd` | `string` | Project directory to operate on |
| `maxConcurrentTasks?` | `number` | Maximum parallel implementers (default 3) |
| `apiKeys?` | `Record<string, string>` | Provider → API key overrides |
| `onStatus?` | `StatusCallbacks` | Callbacks for workflow and agent events |
| `workDir?` | `string` | Directory for workflow state persistence |

`RunOptions` extends this with `workDir: string` as required.

---

### `HarnessCreationOptions`

Options for `createHarness`.

| Field | Type | Description |
|---|---|---|
| `profile` | `AgentProfile` | The agent configuration to use |
| `cwd` | `string` | Working directory for file operations |
| `sessionId?` | `string` | Provide for JSONL persistence; omit for in-memory |
| `additionalTools?` | `AgentTool[]` | Extra tools beyond the defaults |
| `apiKeys?` | `Record<string, string>` | Provider → API key overrides |
| `onAgentStatus?` | `AgentStatusCallbacks` | Callbacks for turn-level and tool-level events |

---

### `StructuredOutputOptions`

Options for `promptForStructured`.

| Field | Type | Description |
|---|---|---|
| `maxRetries` | `number` | Maximum number of retry attempts |

---

### `AgentLoopUntilOptions`

Options for `agentLoopUntil`.

| Field | Type | Description |
|---|---|---|
| `maxAttempts?` | `number` | Maximum loop iterations (default: 10) |

### `ParallelAgentOptions`

Options for `parallelAgents`.

| Field | Type | Description |
|---|---|---|
| `schema?` | `ZodType<any>` | Zod schema for structured output validation |
| `maxRetries?` | `number` | Max retries for structured output (default: 3) |

### `SequentialAgentOptions`

Options for `sequentialAgents`.

| Field | Type | Description |
|---|---|---|
| `schema?` | `ZodType<any>` | Zod schema for structured output validation |
| `maxRetries?` | `number` | Max retries for structured output (default: 3) |

---

### `ToolRegistryEntry`

Used by `ToolRegistry.register(entry)`.

```typescript
interface ToolRegistryEntry {
    name: string;
    tool: AgentTool;
}
```

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Tool name used for lookup and filtering |
| `tool` | `AgentTool` | The tool implementation |

### `PromptableHarness`

A minimal interface for objects that can be prompted.

```typescript
interface PromptableHarness {
  prompt: (text: string) => Promise<{
    content: Array<{ type: string; text?: string; thinking?: string }>;
  }>;
}
```

Both `AgentHarness` instances and mock objects satisfy this interface.

---

### `SessionStats`

Token usage and cost aggregation returned by `SessionHistory.getStats()`.

| Field | Type | Description |
|---|---|---|
| `totalInputTokens` | `number` | Sum of input tokens from assistant messages |
| `totalOutputTokens` | `number` | Sum of output tokens from assistant messages |
| `totalCost` | `number` | Sum of costs from assistant messages |
| `messageCount` | `number` | Total number of message entries in the session |

---

### `AgentLoopResult<T>`

Envelope returned by `retryAgentUntil`.

| Field | Type | Description |
|---|---|---|
| `result` | `T` | The validated structured output |
| `attempts` | `number` | Configured maximum retry attempts (default: 3). This is the configured max, not the actual number of attempts used. |
| `totalTokens` | `{ input: number; output: number }` | Token usage (zero when using `retryAgentUntil`) |

---

### `StatusCallbacks`

```typescript
type StatusCallbacks = WorkflowStatusCallbacks & AgentStatusCallbacks;
```

#### `WorkflowStatusCallbacks`

| Method | Parameter Shape | Fired when |
|---|---|---|
| `onWorkflowStart` | `{ taskPrompt: string; resumed: boolean; workDir: string }` | The `run()` orchestrator starts |
| `onPhaseStart` | `{ phase: WorkflowPhase; round: number }` | A phase begins execution |
| `onPhaseComplete` | `{ phase: WorkflowPhase; durationMs: number }` | A phase finishes |
| `onAgentSpawn` | `{ agentId: string; profile: string; phase: string; taskId?: string }` | An agent harness is created |
| `onAgentComplete` | `{ agentId: string; profile: string; phase: string; taskId?: string }` | An agent finishes its prompt |
| `onTaskStart` | `{ taskId: string; title: string; agentId: string }` | A task is claimed and dispatched |
| `onTaskComplete` | `{ taskId: string; title: string }` | A task passes review |
| `onTaskRejected` | `{ taskId: string; title: string; reason: string }` | A task fails review |
| `onDecision` | `{ agentId: string; decision: string; reasoning: string; taskId?: string }` | A reviewer makes a decision |
| `onError` | `{ agentId: string; error: string; phase: string; taskId?: string }` | An agent encounters an error |
| `onWorkflowComplete` | `{ totalDurationMs: number; agentCount: number }` | The workflow finishes successfully |
| `onWorkflowFailed` | `{ error: Error; phase: string }` | The workflow throws an unhandled error |

All methods are optional.

#### `AgentStatusCallbacks`

| Method | Parameter Shape | Fired when |
|---|---|---|
| `onTurnStart` | `{ agentId: string; turn: number }` | An agent turn begins |
| `onTurnEnd` | `{ agentId: string; turn: number; tokens?: { input: number; output: number } }` | An agent turn completes |
| `onToolCallStart` | `{ agentId: string; toolName: string; toolCallId: string }` | A tool execution starts |
| `onToolCallEnd` | `{ agentId: string; toolName: string; toolCallId: string; isError: boolean }` | A tool execution finishes |

All methods are optional.

---

## 12. Configuration

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

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` and copy defaults |
| `npm test` | Run all tests with Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check without emitting |
| `npm run setup` | Build then run `workflow-harness init` |

### Project Structure

```
workflow-harness/
├── src/                # Source code
│   ├── core/           # Core layer (harness, profiles, tools, auth, config)
│   ├── tracking/       # Tracking layer (audit, tasks, workflow state)
│   ├── workflows/      # Workflow layer (develop workflow)
│   └── profiles/       # Built-in agent profile definitions
├── defaults/           # Files installed by workflow-harness init
│   ├── profiles/       # Copies of built-in profiles
│   └── workflows/      # Default workflow stubs
├── tests/              # Test files mirroring src/ structure
├── docs/               # Documentation
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Test Layout

Tests are co-located in `tests/` and mirror the `src/` structure:

```
tests/
├── core/
│   ├── agent-loop.test.ts
│   ├── auth.test.ts
│   ├── harness-factory.test.ts
│   ├── profile.test.ts
│   ├── session-history.test.ts
│   ├── structured-output.test.ts
│   └── tool-registry.test.ts
├── tracking/
│   ├── audit-log.test.ts
│   ├── task-status.test.ts
│   └── workflow-status.test.ts
├── workflows/
│   └── develop.test.ts
└── integration/
    └── workflow-smoke.test.ts
```

### Adding New Profiles

1. Create a `.md` file in `defaults/profiles/` (e.g. `my-agent.md`).
2. Add YAML frontmatter with at least `provider` and `model`.
3. Write the system prompt in the body.
4. Run `workflow-harness init --force` to install, or place it directly in `~/.config/workflow-harness/profiles/` or `.workflow-harness/profiles/`.

### Adding a New Workflow

1. Create a `.js`, `.mjs`, `.cjs`, or `.ts` file in `defaults/workflows/` or directly in a config workflows directory.
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
