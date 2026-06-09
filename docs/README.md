# workflow-harness

A script-based workflow engine for AI-driven development, built on top of [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core).

---

## 1. Overview

**workflow-harness** orchestrates multi-agent AI workflows for software development tasks. It uses `AgentHarness` from `@earendil-works/pi-agent-core` as its inference layer and provides a phase-based approach to breaking down, planning, implementing, and reviewing code changes.

### How it works

The engine follows a structured pipeline of phases, each with internal loops for iterative refinement:

| Phase | Purpose |
|---|---|
| **Scouting** | Agents investigate the codebase to understand relevant areas and gather context |
| **Scouting Review** | A reviewer synthesizes findings and decides whether enough information has been collected |
| **Planning** | A planner creates a task breakdown with dependencies (a DAG of implementable units) |
| **Plan Review** | A reviewer evaluates the plan for completeness and feasibility |
| **Implementation** | Implementer agents claim tasks from the DAG, write code, and submit for review |
| **Final Review** | A final reviewer checks the entire codebase for remaining issues; fixers address critical problems |

Key properties:

- **Agent profiles** are defined as markdown files with YAML frontmatter, making it easy to add or modify agents without touching code.
- **Structured output** is enforced via Zod schemas — every phase produces validated, typed data.
- **Task dependency tracking** uses a DAG with cycle detection, so tasks execute in topological order with configurable concurrency.
- **Full audit trail** — every agent start, end, decision, and error is logged to JSONL for post-hoc analysis.
- **Resumable** — workflow state is persisted to disk so interrupted runs can resume from the last completed phase.

---

## 2. Architecture

workflow-harness is organized into three layers:

```
src/
├── index.ts                     # Public API re-exports
├── profiles/                    # Agent profile definitions (.md files)
│   ├── scout.md
│   ├── scouting-reviewer.md
│   ├── planner.md
│   ├── plan-reviewer.md
│   ├── implementer.md
│   ├── implement-reviewer.md
│   ├── final-reviewer.md
│   └── fixer.md
├── core/
│   ├── types.ts                 # Shared type definitions and re-exports
│   ├── profile.ts               # Markdown profile parser and loader
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
└── workflows/
    └── develop.ts               # The development workflow: phases + orchestrator
```

### Core Layer (`src/core/`)

The foundational building blocks that every workflow composes:

| Module | Responsibility |
|---|---|
| `types.ts` | Re-exports types from `pi-agent-core` and `pi-ai`; defines `AgentProfile`, `Task`, `WorkflowState`, `AuditEvent`, and related types |
| `profile.ts` | Parses markdown files with YAML frontmatter into `AgentProfile` objects; loads all profiles from a directory |
| `harness-factory.ts` | Creates a fully-wired `AgentHarness` from a profile: execution environment, session, model, tools, and API key |
| `structured-output.ts` | Extracts JSON from free-text model responses; prompts a harness and validates output against a Zod schema with automatic retries |
| `session-history.ts` | Tracks token usage and cost across a session; provides session resumption by copying message history |
| `agent-loop.ts` | Higher-level patterns: `agentLoopUntil` (loop until condition), `parallelAgents` (concurrent harness execution), `sequentialAgents` (ordered execution) |
| `auth.ts` | Resolves API keys from caller-supplied overrides or environment variables, with helpful error messages |
| `tool-registry.ts` | Registers tools by name and resolves a filtered subset based on `includeTools`/`excludeTools` lists from profiles |

### Tracking Layer (`src/tracking/`)

Observability and state management:

| Module | Responsibility |
|---|---|
| `audit-log.ts` | Appends `AuditEvent` records to a JSONL file; supports filtering by type or task ID; computes aggregate stats |
| `task-status.ts` | Manages a collection of `Task` objects with a DAG of dependencies; enforces state transitions (`blocked` → `ready` → `claimed` → `implementing` → `reviewing` → `done`); detects cycles; supports JSON serialization and deserialization |
| `workflow-status.ts` | Top-level workflow state: current phase, completed phases, scouting reports, plan, stats, and task tracker; persists to `workflow-state.json` for resumption |

### Workflow Layer (`src/workflows/`)

Phase functions and an orchestrator:

| Module | Responsibility |
|---|---|
| `develop.ts` | Exports individual phase functions (`scoutingPhase`, `planningPhase`, `implementationPhase`, `finalReviewPhase`, etc.) and a top-level `run()` orchestrator that chains them with retry loops |

---

## 3. Getting Started

### Prerequisites

- **Node.js** >= 22.19.0
- **npm** (bundled with Node.js)
- **API keys** — at minimum `ANTHROPIC_API_KEY` for the default profiles (which use Claude models)

### Installation

```bash
git clone <repository-url> workflow-harness
cd workflow-harness
npm install
```

### Quick Start

```typescript
import { run } from "workflow-harness";

await run("Add input validation to all public API endpoints", {
  profilesDir: "./src/profiles",
  cwd: "/path/to/project",
  workDir: "/tmp/workflow-run-001",
  maxConcurrentTasks: 3,
});
```

This will:

1. Scout the project at `/path/to/project` to understand its structure.
2. Create an implementation plan broken into tasks.
3. Execute tasks in parallel (up to 3 concurrent implementers).
4. Review each task's output and fix critical issues.
5. Persist all state to `/tmp/workflow-run-001` for resumption.

---

## 4. Profile Authoring Guide

Agent profiles are markdown files with YAML frontmatter, stored in a directory (e.g. `src/profiles/`). The filename (without `.md`) becomes the profile's `id`.

### Format

```markdown
---
name: My Agent
provider: anthropic
model: claude-sonnet-4-20250514
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
| `model` | **Yes** | — | Model identifier within the provider (e.g. `claude-sonnet-4-20250514`) |
| `thinkingLevel` | No | `"medium"` | Model thinking depth. One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `excludeTools` | No | `[]` | Tool names to remove from the default set |
| `includeTools` | No | `[]` | If non-empty, only these tools are included |

### System Prompt Body

The markdown content after the frontmatter becomes the agent's system prompt. Use it to define the agent's role, output format, and behavioral constraints.

### Example: Read-Only Reviewer

```markdown
---
name: Code Reviewer
provider: anthropic
model: claude-sonnet-4-20250514
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

---

## 5. API Reference

### Core

#### `parseProfile(content: string, filename: string): AgentProfile`

Parse a markdown string with YAML frontmatter into an `AgentProfile`. Throws if `provider` or `model` is missing, or if `thinkingLevel` is invalid.

#### `loadProfiles(dirPath: string): Promise<Map<string, AgentProfile>>`

Load all `.md` files from a directory into a `Map` keyed by profile id. Throws if the directory does not exist.

> **Caching:** Results are cached in-memory for the lifetime of the process. Use `clearProfileCache()` to invalidate.

#### `loadProfile(dirPath: string, profileId: string): Promise<AgentProfile>`

Load a single profile by id. Uses the directory cache internally. Throws if not found.

> **Caching:** Delegates to `loadProfiles`, which caches results in-memory for the lifetime of the process. Use `clearProfileCache()` to invalidate.

#### `loadProfileSingle(filePath: string): Promise<AgentProfile>`

Load a single profile directly from a `.md` file path. Bypasses the directory cache — use when you know the exact file location. Throws if the file does not exist or is invalid.

#### `clearProfileCache(): void`

Clear the in-memory profile cache. Forces a fresh disk read on the next `loadProfiles()` call.

#### `createHarness(options: HarnessCreationOptions): Promise<{ harness: AgentHarness; sessionId: string }>`

Create a fully-wired `AgentHarness` from an `AgentProfile`. Steps: create execution environment, session (in-memory or JSONL-backed), resolve model, filter tools, resolve API key.

**`HarnessCreationOptions` fields:**
- `profile: AgentProfile` — the agent configuration
- `cwd: string` — working directory for file operations
- `sessionId?: string` — provide to use JSONL persistence; omit for in-memory
- `additionalTools?: AgentTool[]` — extra tools beyond the defaults
- `apiKeys?: Record<string, string>` — provider → API key overrides

#### `createHarnessFromProfile(dirPath, profileId, options): Promise<...>`

Convenience wrapper: loads a profile from disk, then delegates to `createHarness`.

#### `extractJsonFromText(text: string): string | null`

Extract a JSON string from free-text model output. Tries fenced code blocks first, then bracket counting.

#### `promptForStructured<T>(harness, prompt, schema, options?): Promise<T>`

Prompt a harness and parse the response through a Zod schema. Retries up to `maxRetries` (default 3) with error feedback appended to the prompt.

#### `SessionHistory`

```typescript
class SessionHistory {
  constructor(session: Session);
  getMessageCount(): Promise<number>;
  getStats(): Promise<SessionStats>;
}
```

Aggregates token usage and cost from assistant messages in a session.

#### `createResumableSession(cwd: string, sessionId?: string): Promise<{ session: Session; sessionId: string }>`

Create a resumable session backed by in-memory storage (no `sessionId`) or JSONL file storage (with `sessionId`). Returns both the `Session` instance and its resolved ID.

#### `resumeSession(source: Session, target: AgentHarness): Promise<void>`

Copy all message entries from a source session into a target harness for resumption.

#### `agentLoopUntil(harness, promptFn, conditionFn, options?): Promise<{ response, attempts }>`

Repeatedly prompt a harness until `conditionFn` returns `true` or `maxAttempts` (default 10) is reached.

#### `retryAgentUntil<T>(harness, prompt, schema, options?): Promise<AgentLoopResult<T>>`

Convenience wrapper around `promptForStructured` that returns an `AgentLoopResult` envelope. Token tracking is not available through this wrapper — `totalTokens` is set to zero.

#### `parallelAgents<T>(configs, promptFn, options?): Promise<PromiseSettledResult<T>[]>`

Create harnesses for every config in parallel, then run prompts via `Promise.allSettled`. Optionally validate through a Zod schema.

#### `sequentialAgents<T>(configs, promptFn, options?): Promise<T[]>`

Same as `parallelAgents` but runs prompts sequentially. Throws on the first failure.

#### `resolveApiKey(provider, customKeys?): string | undefined`

Resolve an API key from custom overrides or environment variables.

#### `resolveApiKeyOrThrow(provider, customKeys?): string`

Same as `resolveApiKey` but throws with a helpful error message including expected env var names.

#### `ToolRegistry`

```typescript
class ToolRegistry {
  register(entry: ToolRegistryEntry): void;
  get(name: string): AgentTool | undefined;
  getAll(): AgentTool[];
  resolveTools(includeTools: string[], excludeTools: string[]): AgentTool[];
}
```

Name-indexed tool collection with include/exclude filtering.

#### `getAssistantText(message: { content: Array<{ type: string; text?: string }> }): string`

Concatenate all text blocks from an assistant message's content array. Ignores non-text blocks (e.g. thinking, toolCall).

#### `schemaToString(schema: ZodType): string`

Convert a Zod schema into a human-readable description string. Falls back to `JSON.stringify` for unrecognized shapes. Useful for constructing retry prompts that include the expected schema.

#### `createDefaultToolRegistry(env: ExecutionEnv): ToolRegistry`

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

JSONL-backed audit log. Each event is a JSON line with an auto-generated ISO timestamp.

> **Caching:** Events are cached in-memory after first read. The cache is invalidated on each `append()`.

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
                                    └── rejected ←┘ (returns to "claimed")
```

> **Note:** `rejected` is not a `TaskStatus` value. It represents the transition from `reviewing` back to `claimed` via `rejectTask()`. The task's status is set to `claimed`, not `rejected`.

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
  get stats(): { totalTokens; totalCost; agentCount };
  get taskTracker(): TaskTracker;
  get auditLog(): AuditLog;
  // Mutators
  setTaskPrompt(prompt: string): void;
  advancePhase(): void;
  setPhase(phase: WorkflowPhase): void;
  setScoutingReports(reports: unknown[]): void;
  setPlan(plan: unknown): void;
  addTokensToStats(tokens: { input: number; output: number }): void;
  incrementAgentCount(): void;
  // Persistence
  toJSON(): WorkflowState;
  save(): Promise<void>;
  static load(workDir: string): Promise<WorkflowStatusTracker>;
}
```

Top-level workflow state manager. Persists to `workflow-state.json` in the working directory.

### Workflow

#### `run(taskPrompt: string, options: RunOptions): Promise<void>`

Execute the full development workflow. Resumes automatically if a `workflow-state.json` exists in `workDir`.

**`RunOptions` fields:**
- `profilesDir: string` — directory containing agent profile `.md` files
- `cwd: string` — project directory to operate on
- `workDir: string` — directory for workflow state persistence
- `maxConcurrentTasks?: number` — max parallel implementers (default 3)
- `apiKeys?: Record<string, string>` — provider → API key overrides

#### Phase Functions

Each phase is exported individually for custom orchestration:

| Function | Signature |
|---|---|
| `scoutingPhase` | `(tracker, profilesDir, taskPrompt, cwd, apiKeys?) → Promise<unknown[]>` |
| `scoutingReviewPhase` | `(tracker, profilesDir, reports, cwd, apiKeys?) → Promise<ScoutingReview>` |
| `planningPhase` | `(tracker, profilesDir, research, taskPrompt, cwd, apiKeys?) → Promise<Plan>` |
| `planReviewPhase` | `(tracker, profilesDir, plan, research, taskPrompt, cwd, apiKeys?) → Promise<PlanReview>` |
| `implementationPhase` | `(tracker, profilesDir, plan, cwd, maxConcurrentTasks?, apiKeys?) → Promise<void>` |
| `finalReviewPhase` | `(tracker, profilesDir, cwd, apiKeys?) → Promise<boolean>` |

---

## 6. Types Reference

All types listed below are exported from the top-level `workflow-harness` entry point.

### Union Types

#### `ThinkingLevel`

```typescript
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

Controls how much "thinking" the model does before responding. Defaults to `"medium"` in profiles. Re-exported from `@earendil-works/pi-agent-core`.

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

Phases execute in the order listed. `WorkflowStatusTracker.advancePhase()` moves strictly forward; `setPhase()` can jump to any valid phase.

#### `TaskStatus`

```typescript
type TaskStatus = "blocked" | "ready" | "claimed" | "implementing" | "reviewing" | "done";
```

See [Task lifecycle diagram](#tasktracker) for valid transitions.

---

### `AgentProfile`

Defines a single agent's configuration. Parsed from markdown files with YAML frontmatter.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Profile identifier — derived from filename without `.md` |
| `name` | `string` | Human-readable display name. Defaults to `id` |
| `provider` | `string` | AI provider identifier (e.g. `"anthropic"`, `"openai"`) |
| `model` | `string` | Model identifier within the provider |
| `thinkingLevel` | `ThinkingLevel` | Model thinking depth |
| `systemPrompt` | `string` | The full system prompt (markdown body after frontmatter) |
| `excludeTools` | `string[]` | Tool names to remove from the default set |
| `includeTools` | `string[]` | If non-empty, only these tools are included |

---

### `Task`

A single unit of work within a plan, tracked by `TaskTracker`.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique task identifier |
| `title` | `string` | Short description |
| `prompt` | `string` | Detailed prompt for the implementing agent |
| `profile` | `string` | Agent profile ID to use (e.g. `"implementer"`) |
| `files` | `string[]` | Files this task is expected to modify |
| `dependencies` | `string[]` | Task IDs that must complete before this task |
| `status` | `TaskStatus` | Current lifecycle state |
| `assignedAgent?` | `string` | ID of the agent currently working on this task |
| `result?` | `unknown` | Implementation result submitted for review |
| `reviewFeedback?` | `string` | Feedback from reviewer on rejection |

---

### `AuditEvent`

A discriminated union of event types logged by `AuditLog`. Each variant has a `timestamp: string` field added automatically on append.

#### `agent_start`

| Field | Type | Description |
|---|---|---|
| `type` | `"agent_start"` | Discriminant |
| `agentId` | `string` | Identifier of the agent |
| `profile` | `AgentProfile` | Profile used to create the agent |
| `taskId?` | `string` | Associated task, if applicable |
| `timestamp` | `string` | ISO 8601 timestamp (auto-generated) |

#### `agent_end`

| Field | Type | Description |
|---|---|---|
| `type` | `"agent_end"` | Discriminant |
| `agentId` | `string` | Identifier of the agent |
| `result` | `unknown` | The agent's final result (may include `cost` and `tokens`) |
| `taskId?` | `string` | Associated task, if applicable |
| `timestamp` | `string` | ISO 8601 timestamp (auto-generated) |

#### `decision`

| Field | Type | Description |
|---|---|---|
| `type` | `"decision"` | Discriminant |
| `agentId` | `string` | Identifier of the deciding agent |
| `decision` | `string` | Short decision label (e.g. `"approved"`, `"plan_rejected"`) |
| `reasoning` | `string` | Explanation for the decision |
| `taskId?` | `string` | Associated task, if applicable |
| `timestamp` | `string` | ISO 8601 timestamp (auto-generated) |

#### `structured_output`

| Field | Type | Description |
|---|---|---|
| `type` | `"structured_output"` | Discriminant |
| `agentId` | `string` | Identifier of the producing agent |
| `output` | `unknown` | The validated structured output |
| `taskId?` | `string` | Associated task, if applicable |
| `timestamp` | `string` | ISO 8601 timestamp (auto-generated) |

#### `error`

| Field | Type | Description |
|---|---|---|
| `type` | `"error"` | Discriminant |
| `agentId` | `string` | Identifier of the agent that errored |
| `error` | `string` | Error description |
| `taskId?` | `string` | Associated task, if applicable |
| `timestamp` | `string` | ISO 8601 timestamp (auto-generated) |

---

### `WorkflowState`

Serialized form of `WorkflowStatusTracker`. Written to `workflow-state.json` on `save()`.

| Field | Type | Description |
|---|---|---|
| `taskPrompt` | `string` | The original task prompt for the workflow |
| `currentPhase` | `WorkflowPhase` | Phase the workflow is currently in |
| `completedPhases` | `WorkflowPhase[]` | Phases that have finished |
| `tasks` | `Task[]` | All tasks in the plan |
| `scoutingReports` | `unknown[]` | Collected scouting reports |
| `plan` | `unknown` | The validated implementation plan |
| `stats` | `{ totalTokens: number; totalCost: number; agentCount: number }` | Aggregate statistics |

---

### `HarnessCreationOptions`

Options for `createHarness`.

| Field | Type | Description |
|---|---|---|
| `profile` | `AgentProfile` | The agent configuration to use |
| `cwd` | `string` | Working directory for file operations |
| `sessionId?` | `string` | Provide to use JSONL persistence; omit for in-memory |
| `additionalTools?` | `AgentTool[]` | Extra tools beyond the defaults |
| `apiKeys?` | `Record<string, string>` | Provider → API key overrides |

---

### `StructuredOutputOptions`

Options for `promptForStructured` and related structured output functions.

| Field | Type | Description |
|---|---|---|
| `maxRetries` | `number` | Maximum number of retry attempts |
| `retryPrompt?` | `string` | Custom prompt to use when retrying |

---

### `AgentLoopUntilOptions`

Options for `agentLoopUntil`.

| Field | Type | Description |
|---|---|---|
| `maxAttempts?` | `number` | Maximum loop iterations (default: 10) |

---

### `DevelopWorkflowOptions`

Options shared by the develop workflow phases.

| Field | Type | Description |
|---|---|---|
| `profilesDir` | `string` | Directory containing agent profile `.md` files |
| `cwd` | `string` | Project directory to operate on |
| `maxConcurrentTasks?` | `number` | Maximum parallel implementers (default 3) |
| `apiKeys?` | `Record<string, string>` | Provider → API key overrides |
| `workDir?` | `string` | Directory for workflow state persistence |

`RunOptions` extends this with `workDir: string` as required.

---

### `PromptableHarness`

A minimal interface for objects that can be prompted — used by `promptForStructured`, `retryAgentUntil`, and related functions.

| Field | Type | Description |
|---|---|---|
| `prompt` | `(text: string) => Promise<{ content: Array<{ type: string; text?: string; thinking?: string }> }>` | Send a prompt and receive a response with content blocks |

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
| `attempts` | `number` | Configured maximum retry attempts (default: 3). Note: This is the configured max, not the actual number of attempts used. |
| `totalTokens` | `{ input: number; output: number }` | Token usage (zero when using `retryAgentUntil`) |

---

## 7. Workflow Authoring Guide

### How the Develop Workflow Works

The `run()` orchestrator in `develop.ts` uses a **phase-dispatch loop** driven by an ordered `phaseOrder` array:

```
["scouting", "scouting_review", "planning", "plan_review", "implementing", "final_review", "done"]
```

Each phase has a handler function (`handlePhase`) that performs exactly one step. A handler may return the name of a phase to **jump to** (for retries), or return `void` to **advance linearly** to the next entry in the array. This design makes the control flow explicit and easy to extend — to add a new phase, insert it into the array and add a case to the handler.

The pipeline proceeds as follows:

1. **Scouting** — A `scout` agent identifies codebase areas to investigate. For each topic discovered, a parallel scout agent produces a report via `parallelAgents`. Reports are collected and stored in the tracker.

2. **Scouting Review** — The `scouting-reviewer` synthesizes all reports into a research summary and decides whether enough information has been gathered. If `ready` is `false` and fewer than 3 rounds have elapsed, the handler returns `"scouting"` to jump back and gather more data. After 3 rounds the workflow proceeds regardless.

3. **Planning** — The `planner` agent creates a `Plan` containing an array of `Task` objects, each with an `id`, `title`, `prompt`, `profile`, `files`, and `dependencies`. The plan forms a DAG.

4. **Plan Review** — The `plan-reviewer` evaluates the plan. If `ready` is `false` and fewer than 3 rounds have elapsed, the handler returns `"planning"` to jump back and regenerate the plan. After 3 rounds the workflow proceeds with the current plan.

5. **Implementation** — Tasks are loaded into the `TaskTracker`. The orchestrator claims up to `maxConcurrentTasks` at a time, dispatches them to implementer agents in parallel via `parallelAgents`, and then runs reviewer agents in parallel via `Promise.allSettled`. Approved tasks are completed; rejected tasks return to `"claimed"` state for re-implementation. If a review itself fails (e.g. an error in the reviewer agent), the failure is logged to the audit trail and the task is still completed to avoid blocking the pipeline.

6. **Final Review** — The `final-reviewer` examines the entire codebase. If critical issues are found, `fixer` agents resolve them in parallel via `parallelAgents`. This loop runs up to 3 rounds.

> **Parallel Execution** — Concurrency is used at multiple points:
> - During **scouting**, one scout agent is spawned per topic via `parallelAgents`.
> - During **implementation**, tasks are claimed in batches of `maxConcurrentTasks`. Each batch runs implementer agents in parallel via `parallelAgents`, and the resulting reviews also run in parallel via `Promise.allSettled`.
> - During **final review**, fixer agents for critical issues run in parallel via `parallelAgents`.
>
> The `parallelAgents` utility uses `Promise.allSettled` under the hood, so a single agent failure does not crash the batch — settled results (fulfilled or rejected) are processed individually after the batch completes.

### Creating a Custom Workflow

To build your own workflow:

1. **Define Zod schemas** for each phase's input/output.

2. **Write phase functions** that create a harness from a profile, prompt it with `promptForStructured`, and return validated data.

3. **Use the tracking layer** — create a `WorkflowStatusTracker` to persist state, a `TaskTracker` for task management, and an `AuditLog` for events.

4. **Write an orchestrator** that chains your phases, with retry loops where needed.

Example skeleton:

```typescript
import { z } from "zod";
import { createHarness, loadProfiles, promptForStructured } from "workflow-harness";
import { WorkflowStatusTracker } from "workflow-harness";

const MyOutputSchema = z.object({
  result: z.string(),
});

export async function myCustomPhase(
  tracker: WorkflowStatusTracker,
  profilesDir: string,
  cwd: string,
): Promise<void> {
  const profiles = await loadProfiles(profilesDir);
  const profile = profiles.get("my-agent");
  if (!profile) throw new Error("Profile 'my-agent' not found");

  const { harness } = await createHarness({ profile, cwd });
  tracker.incrementAgentCount();

  const output = await promptForStructured(
    harness,
    "Do something specific",
    MyOutputSchema,
  );

  await tracker.auditLog.append({
    type: "structured_output",
    agentId: "my-agent",
    output,
  });
}
```

### Structured Output Schemas

The `develop.ts` workflow exports these Zod schemas for reuse:

| Schema | Fields |
|---|---|
| `ScoutingTopicSchema` | `topics: Array<{ topic, rationale, files }>` |
| `ScoutingReviewSchema` | `ready: boolean`, `research: string`, `gaps: string[]` |
| `PlanSchema` | `tasks: Array<{ id, title, prompt, profile, files, dependencies }>`, `strategy: string` |
| `PlanReviewSchema` | `ready: boolean`, `feedback: string`, `suggestions: string[]` |
| `ReviewResultSchema` | `approved: boolean`, `feedback: string`, `issues: Array<{ file, description, severity }>` |
| `ScoutingTopics` | `topics: Array<{ topic, rationale, files }>` |
| `FinalReviewTopicsSchema` | `topics: Array<{ topic, files }>`, `overallAssessment: string`, `issues: Array<{ file, description, severity }>` |

### Task Dependency Tracking (DAG)

Tasks are managed by `TaskTracker`, which enforces a directed acyclic graph:

- **Adding a task**: `addTask()` validates that no cycle would be introduced. If all dependencies are `"done"`, the task starts as `"ready"`; otherwise `"blocked"`.
- **Claiming tasks**: `claimTasks(n)` returns up to `n` ready tasks and transitions them to `"claimed"`.
- **Completing a task**: `completeTask()` moves a reviewed task to `"done"` and recalculates all blocked tasks — any whose dependencies are now all done become `"ready"`.
- **Rejection**: `rejectTask()` moves a task back to `"claimed"` with feedback, allowing re-implementation.

The tracker is serializable via `toJSON()`/`fromJSON()` for persistence across workflow runs.

### Agent Loop Utility Examples

The `agent-loop.ts` module provides three composable patterns for orchestrating multiple agent interactions. Below are practical examples showing how to use each one in a custom workflow.

#### `agentLoopUntil` — iterate until a condition is met

Use this when an agent's output needs iterative refinement. The `promptFn` receives the current attempt number and the previous response, so you can feed context back in:

```typescript
import { createHarness, agentLoopUntil } from "workflow-harness";
import { loadProfile } from "workflow-harness";

// 1. Create a harness from a profile
const profile = await loadProfile("./src/profiles", "scout");
const { harness } = await createHarness({ profile, cwd: process.cwd() });

// 2. Loop until the response is substantive
const { response, attempts } = await agentLoopUntil(
  harness,
  (attempt, lastResponse) => {
    if (lastResponse) {
      return `The previous answer was incomplete. Please try again.\n\nPrevious: ${lastResponse.content}`;
    }
    return "Research the authentication module in detail. Describe every publicly exported function.";
  },
  (response) => response.content.length > 200, // accept when the answer is substantive
  { maxAttempts: 3 },
);

console.log(`Got a substantive response after ${attempts} attempt(s).`);
```

The harness's `prompt()` method is called repeatedly. If the condition is never met within `maxAttempts`, an error is thrown.

#### `parallelAgents` — run multiple agents concurrently

Use this when you have independent tasks that can run simultaneously. Each config becomes a separate harness; `promptFn` receives the created harness and its index:

```typescript
import { parallelAgents, loadProfile, createHarness } from "workflow-harness";
import { z } from "zod";

const ScoutingReportSchema = z.object({
  report: z.string(),
  filesExamined: z.array(z.string()),
});

const topics = [
  { topic: "Database layer", files: ["src/db/"] },
  { topic: "API routes", files: ["src/routes/"] },
  { topic: "Auth middleware", files: ["src/middleware/auth.ts"] },
];

// Each topic gets its own harness config
const configs = await Promise.all(
  topics.map(async () => {
    const profile = await loadProfile("./src/profiles", "scout");
    return { profile, cwd: process.cwd() };
  }),
);

// Run all scouts in parallel, validating output through the Zod schema
const results = await parallelAgents(
  configs,
  (harness, i) => {
    const t = topics[i];
    return `Investigate ${t.topic}. Key areas: ${t.files.join(", ")}. Provide a detailed report.`;
  },
  { schema: ScoutingReportSchema },
);

// results is PromiseSettledResult[] — handle fulfilled and rejected individually
for (const result of results) {
  if (result.status === "fulfilled") {
    console.log(result.value.report);
  } else {
    console.error("Scout failed:", result.reason);
  }
}
```

Because `parallelAgents` uses `Promise.allSettled`, one agent failure does not prevent the others from completing.

#### `sequentialAgents` — chain agents where each step depends on the previous

Use this when later prompts need to reference earlier results. Harnesses are created in parallel but prompts run one at a time, so you can build on prior output:

```typescript
import { sequentialAgents, loadProfile } from "workflow-harness";

const steps = [
  "Draft an outline of the module",
  "Write the public API types",
  "Implement the core logic",
  "Write unit tests",
];

const configs = await Promise.all(
  steps.map(async () => {
    const profile = await loadProfile("./src/profiles", "implementer");
    return { profile, cwd: process.cwd() };
  }),
);

// sequentialAgents throws on the first failure — all steps must succeed
const results = await sequentialAgents(
  configs,
  (harness, i) => {
    const prev = i > 0 ? `Previous work completed.\n` : "";
    return `${prev}Step ${i + 1}: ${steps[i]}`;
  },
);

console.log(`Completed ${results.length} steps.`);
```

Unlike `parallelAgents`, `sequentialAgents` returns a plain `T[]` and throws immediately if any step fails.

---

## 8. Configuration

### Environment Variables

| Variable | Provider | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `anthropic` | API key for Anthropic (Claude) models |
| `OPENAI_API_KEY` | `openai` | API key for OpenAI models |

API keys are resolved in this order:
1. The `apiKeys` option passed to `createHarness` or `run`.
2. Well-known environment variables via `getEnvApiKey()`.

### Profile Configuration

See [Section 4: Profile Authoring Guide](#4-profile-authoring-guide) for the full frontmatter schema.

The default profiles in `src/profiles/` are:

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

### Workflow Options

The `DevelopWorkflowOptions` / `RunOptions` interface:

```typescript
interface RunOptions {
  profilesDir: string;          // Directory with .md profile files
  cwd: string;                  // Project directory to work on
  workDir: string;              // Directory for workflow state persistence
  maxConcurrentTasks?: number;  // Max parallel implementers (default: 3)
  apiKeys?: Record<string, string>; // Provider → API key overrides
}
```

**Resuming a workflow**: If `workflow-state.json` exists in `workDir`, the `run()` function loads it and resumes from the last saved phase.

---

## 9. Development

### Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run all tests with Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check without emitting |

### Project Structure

```
workflow-harness/
├── src/                # Source code
│   ├── core/           # Core layer (harness, profiles, tools, auth)
│   ├── tracking/       # Tracking layer (audit, tasks, workflow state)
│   ├── workflows/      # Workflow layer (develop workflow)
│   └── profiles/       # Agent profile definitions
├── tests/              # Test files mirroring src/ structure
│   ├── core/
│   ├── tracking/
│   ├── workflows/
│   └── integration/
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
│   ├── placeholder.test.ts
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

1. Create a new `.md` file in `src/profiles/` (e.g. `my-agent.md`).
2. Add YAML frontmatter with at least `provider` and `model`.
3. Write the system prompt in the body.
4. Reference it by filename (without `.md`) in your workflow code:

```typescript
const profile = await loadProfile("./src/profiles", "my-agent");
const { harness } = await createHarness({ profile, cwd: process.cwd() });
```

### TypeScript Configuration

- **Target**: ES2024
- **Module**: ESNext (ESM with `.js` extensions in imports)
- **Strict mode**: enabled
- **Declaration files**: emitted to `dist/`
