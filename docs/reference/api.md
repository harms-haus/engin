# Programmatic API

Everything below is exported from the top-level `@harms-haus/engin` entry point (`src/index.ts`).
Types are collected separately in [Types reference](types.md).

## Workflow loading

### `loadWorkflow(name, cwd): Promise<WorkflowModule>`

Dynamically load a workflow module by name. Validates the name against path traversal, searches
local then global workflow directories for `{name}/main.ts`, busts Bun's `require.cache` for
the file before loading, and wraps the result as `mod.default ?? mod`. Throws if the module
does not export a `run` function, or if the workflow is not found. Results are cached by
resolved file path (FIFO-bounded).

### `listWorkflows(cwd): Promise<WorkflowEntry[]>`

List all available workflows across local and global directories. Only directories containing
a `main.ts` file are included; hidden directories (starting with `.`) are skipped. Returns
`{ name, source: 'local' | 'global', path }`, sorted by name then by source (local first).

### `clearWorkflowCache(): void`

Clear the in-memory workflow module cache.

## Profile loading

### `loadProfiles(dirPath): Promise<Map<string, AgentProfile>>`

Load all `.md` files from a directory into a `Map` keyed by profile ID. Results are cached per
directory for the process lifetime (FIFO-bounded). Throws if the directory is missing or is not
a directory.

### `loadProfile(dirPath, profileId): Promise<AgentProfile>`

Load a single profile by ID from a directory. Uses the directory cache. Throws if not found.

### `loadProfileSingle(filePath): Promise<AgentProfile>`

Load a single profile directly from a `.md` file path. Bypasses the directory cache.

### `loadProfilesFromDirs(dirs): Promise<Map<string, AgentProfile>>`

Load and merge profiles from multiple directories. Directories are processed in **reverse**
order so that the **first** array entry (local) overrides later entries (global) on ID
collision. Missing or non-directory paths are silently skipped; malformed profiles re-throw.
The merged result is not cached.

### `parseProfile(content, filename): AgentProfile`

Parse a Markdown string with YAML frontmatter into an `AgentProfile`. Throws if `provider` or
`model` is missing, or if `thinkingLevel` is invalid.

### `clearProfileCache(): void`

Clear the in-memory profile cache.

## Harness creation

### `createHarness(options): Promise<{ session, sessionId, dispose }>`

Create a fully-wired `AgentSession` from an `AgentProfile`. Resolution steps:

1. Resolve the model via `getModel(profile.provider, profile.model)` (throws if unknown).
2. Load `AuthStorage` from `~/.pi/agent/auth.json`; apply caller-supplied `apiKeys` as runtime
   overrides.
3. Build the tool allowlist from the profile: `includeTools` (if non-empty) **intersects**
   `DEFAULT_TOOLS`; then `excludeTools` is subtracted. See
   [Authoring profiles → Tool filtering](../guides/profiles.md#tool-filtering--read-this-carefully).
4. Build a `DefaultResourceLoader` with `systemPromptOverride: () => profile.systemPrompt`.
5. Construct the session in one of three modes (checked in this order):
   - **Resumed** — `SessionManager.open(resumeSessionPath, …)` when `resumeSessionPath` is set.
   - **Persisted** — `SessionManager.create(cwd, sessionDir)` when `sessionDir` is set.
   - **In-memory** — `SessionManager.inMemory(cwd)` otherwise.
6. If `onAgentStatus` is provided with at least one handler, subscribe to agent events. The
   effective agent ID is `options.agentId ?? sessionId`.

`HarnessCreationOptions`:

| Field                | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| `profile`            | The agent configuration.                                     |
| `cwd`                | Working directory for file operations.                       |
| `apiKeys?`           | Provider → API key overrides.                                |
| `onAgentStatus?`     | Callbacks for turn-level and tool-level events.              |
| `sessionDir?`        | Directory for persisted session storage.                     |
| `resumeSessionPath?` | Path to an existing session for resumption.                  |
| `agentId?`           | Agent ID used in status callbacks (defaults to `sessionId`). |

Returns `{ session: AgentSession; sessionId: string; dispose: () => void }`. `dispose`
unsubscribes from agent events and disposes the session — always call it in a `finally`.

### `createHarnessFromProfile(dirPath, profileId, options): Promise<{ session, sessionId, dispose }>`

Convenience wrapper: loads a profile from disk, then delegates to `createHarness`.

## Config resolution

### `getGlobalConfigDir(): string`

`$XDG_CONFIG_HOME/engin` if set and non-empty, otherwise `~/.config/engin`.

### `getLocalConfigDir(cwd): string`

`{cwd}/.engin`.

### `resolveProfilesDirs(cwd, workflowName?): string[]`

Workflow-scoped profile directories, local first. Returns `[]` when `workflowName` is omitted.
Throws on path-traversal names.

### `resolveWorkflowsDirs(cwd): string[]`

`[localWorkflows, globalWorkflows]`, local first.

### `getDefaultWorkDir(cwd, workflowName): string`

`{cwd}/.engin/work/{Date.now()}-{workflowName}`. Unique per invocation.

### `scanPastRuns(cwd): Promise<PastRunEntry[]>`

Scan `{cwd}/.engin/work/` for past run directories. Returns entries sorted newest-first. See
[Configuration → Past runs](configuration.md#past-runs).

### `ensureDir(dirPath): Promise<void>`

Recursively create a directory. Re-throws errors.

### `loadEnvFiles(cwd): LoadEnvResult`

Synchronously load and merge `.env` files. See
[Configuration → `.env` file loading](configuration.md#env-file-loading).

## Shared utilities

### `validateWorkflowName(name: string): void`

Throw on `/`, `\`, or `..` (path traversal prevention).

### `isEnoentError(err: unknown): boolean`

True when `err` is a non-null object with `code === 'ENOENT'`.

### `safeErrorMessage(err: unknown): string`

`err.message` for `Error` instances, otherwise `String(err)`.

### `composeStatusCallbacks(callbacks: StatusCallbacks[]): StatusCallbacks`

Compose multiple `StatusCallbacks` into one. Empty input returns a no-op; a single input is
returned directly; otherwise each method fans out to every callback **in array order**, with
each call wrapped in try/catch (a failing callback is logged and does not stop the others).

### `forwardAgentStatus(onStatus?: StatusCallbacks): AgentStatusCallbacks | undefined`

Return an `AgentStatusCallbacks` that forwards the four agent-level callbacks (`onTurnStart`,
`onTurnEnd`, `onToolCallStart`, `onToolCallEnd`) to `onStatus`. Returns `undefined` when
`onStatus` is absent (the conventional no-op for harness options).

### `appendReviewFeedback(task, feedback): void`

Append a feedback string to `task.reviewFeedback`, initialising the array if absent.

### `DEFAULT_TOOLS: readonly string[]`

Frozen array: `['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']`.

## Setup

### `initDefaultConfig(): Promise<{ createdDirs: string[] }>`

Ensure `~/.config/engin/workflows/` exists. Returns `{ createdDirs: ['workflows'] }`.

## Structured output

### `promptForStructured<T>(harness, prompt, schema, options?): Promise<{ result: T; attempts: number }>`

Prompt a `PromptableHarness` and validate the response through a Zod schema. Appends a
schema description to the prompt; on failure, rebuilds the prompt with the latest error and
retries. `maxRetries` (default `3`) is the **total number of attempts**, not retries-on-top.
Returns `{ result, attempts }` with `attempts` 1-based. Throws after exhausting attempts.

> `options.retryPrompt` is declared on the type but is **not read** by the implementation.

### `extractJsonFromText(text): string | null`

Extract a JSON string from free-text output. Tries fenced ```json blocks first, then bracket
counting with string/escape awareness. Returns the first substring that parses as valid JSON,
or `null`.

### `schemaToString(schema): string`

Convert a Zod schema into a human-readable description (delegates to `describeSchema`).

### `describeSchema(def): string`

Convert a Zod `_def` into a human-readable description. Handles objects, primitives, arrays,
enums, optional/nullable/default, unions, effects, branded, records, tuples, maps, sets,
promises, lazy, intersections, dates, readonly, pipelines, and catch.

## Agent loop utilities

### `agentLoopUntil(session, promptFn, conditionFn, options?): Promise<{ lastText, attempts }>`

Repeatedly prompt a `PromptableHarness` until `conditionFn(lastText)` returns true or
`maxAttempts` (default `10`) is reached. `promptFn(attempt, lastText)` builds each prompt.
Returns `{ lastText, attempts }`. Throws if the condition is never met.

### `retryAgentUntil<T>(session, prompt, schema, options?): Promise<AgentLoopResult<T>>`

Convenience wrapper around `promptForStructured` returning an `AgentLoopResult` envelope.
`totalTokens` is always `{ input: 0, output: 0 }` (token tracking is not available via
`PromptableHarness`).

### `parallelAgents<T>(configs, promptFn, options?): Promise<PromiseSettledResult<T>[]>`

Create sessions **sequentially** (with rollback on failure), then run the prompts **in
parallel** via `Promise.allSettled`. All sessions are disposed in a `finally` block. When
`options.schema` is provided, each result is validated; otherwise `getLastAssistantText()` is
returned. Returns settled results — individual prompt failures do not throw.

### `sequentialAgents<T>(configs, promptFn, options?): Promise<T[]>`

Create sessions and run prompts **one at a time**, disposing each within its iteration. Throws
on the first failure. Returns `T[]`.

## API key resolution

### `resolveApiKey(provider, customKeys?): string | undefined`

Resolve from `customKeys[provider]` or env vars via `getEnvApiKey(provider)`. Does **not**
consult `auth.json` or OAuth — `createHarness` does.

### `resolveApiKeyOrThrow(provider, customKeys?): string`

Same as `resolveApiKey` but throws with a helpful error listing expected env var names.

## Single-agent task primitive

### `runStepTask<T>(opts: RunStepTaskOptions): Promise<T>`

Run one agent as a one-step task. See
[Building a new workflow → `runStepTask`](../guides/building-workflows.md#primitive-1--single-agent-tasks-with-runsteptask)
and [Types reference → `RunStepTaskOptions`](types.md#runsteptaskoptions) for the full
lifecycle and options.

## Tracking

See [Event store & status](event-store.md) for `EventStore`, `createStoreCallbacks`, `evolve`,
and the projection. See [Task pool & execution](task-pool.md) for `LanePool` and `TaskTracker`.

The persisted-workflow-state classes are also exported:

### `WorkflowStatusTracker`

Top-level persisted workflow state. Persists to `.engin-state.json`. Auto-persists on
`TaskSettled`, `TaskReady`, and `TaskClaimed` events from its `TaskTracker`. See source in
`src/tracking/workflow-status.ts` for the full getter/mutator surface.

### `AuditLog`

JSONL-backed audit log. `append`, `getEvents({ taskId?, type? })`, `getEventsByTask`,
`getStats`, `clear`. Results are cached in-memory (capped at 5000 events); the cache is
invalidated on each `append`.

## Re-exports from dependencies

From `@earendil-works/pi-coding-agent`: `AgentSession`, `SessionManager`,
`DefaultResourceLoader`, `AuthStorage`.

From `@earendil-works/pi-ai`: `getModel`, `parseJsonWithRepair`, and the `Model` type.

From `@earendil-works/pi-agent-core`: the `ThinkingLevel` type.

## TUI and web

The TUI (`WorkflowTUI`, widgets, theme helpers) and web (`ObserverServer`, `StatusBridge`,
protocol types) are also exported. See [TUI reference](tui.md) and [Web reference](web.md).
