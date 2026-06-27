# Programmatic API

Everything below is exported from the `@harms-haus/engin-engine` entry point
(`packages/engine/src/index.ts`). The published CLI package (`@harms-haus/engin`,
`packages/cli/src/index.ts`) exports only its own command surface — `initCommand`,
`runCommand`, `resumeCommand`, `serverUpCommand`/`serverDownCommand`/`serverStatusCommand`,
`parseArgs`, `main`, `USAGE`, `VERSION`, and the `CliOptions` type — and deliberately does
**not** re-export the engine or TUI packages. Consumers that need the programmatic workflow
API should depend on `@harms-haus/engin-engine` directly (see the import paths used in
[Building a new workflow](../guides/building-workflows.md)).
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

## Agent plugin system

The engine uses a provider-neutral plugin registry to create agent sessions. Built-in
adapters (`pi-coding-agent`, `codex`, `cursor`) self-register on import. Workflows resolve a
plugin by id (or the default) and call `createSession` to obtain an `AgentRuntime`.

### `requireAgentPlugin(pluginId?: string): AgentPlugin`

Return the registered agent plugin with the given id, defaulting to
`DEFAULT_AGENT_PLUGIN_ID` (`'pi-coding-agent'`) when `pluginId` is omitted. Throws a
descriptive error — listing all currently registered ids — if no plugin is registered for
the resolved id.

### `getAgentPlugin(pluginId: string): AgentPlugin | undefined`

Return the plugin registered under `pluginId`, or `undefined` when none is registered.

### `hasAgentPlugin(pluginId: string): boolean`

Return `true` when a plugin is registered under `pluginId`, otherwise `false`.

### `registerAgentPlugin(plugin: AgentPlugin): void`

Register a custom agent plugin. If a plugin with the same `id` is already registered it is
overwritten. Call this once during initialisation to make a provider available to workflows.

### `DEFAULT_AGENT_PLUGIN_ID: string`

The well-known default plugin id: the constant string `'pi-coding-agent'`. Used by
`requireAgentPlugin` when no explicit id is supplied.

### `AgentPlugin` interface

The adapter contract each backend implements:

- `readonly id: string` — unique plugin identifier.
- `createSession(options: AgentSessionOptions): Promise<AgentRuntime>` — create and return
  a new session. The implementation resolves the model via
  `getModel(profile.provider, profile.model)`, loads credentials via `AuthStorage` (from
  `~/.pi/agent/auth.json`, with caller-supplied `apiKeys` applied as runtime overrides),
  builds the tool allowlist from the profile (`includeTools` intersects `DEFAULT_TOOLS`, then
  `excludeTools` is subtracted), and constructs the session in resumed / persisted /
  in-memory mode based on the options. See
  [Authoring profiles → Tool filtering](../guides/profiles.md#tool-filtering--read-this-carefully).

The returned `AgentRuntime` exposes:

- `prompt(text, opts?): Promise<void>` — send a prompt; resolves when the turn completes.
- `getLastAssistantText(): string | undefined` — plain-text of the last assistant response.
- `subscribe(cb: (e: AgentRuntimeEvent) => void): () => void` — subscribe to runtime events
  (`turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`, `auto_retry_start`,
  `auto_retry_end`); returns an unsubscribe function.
- `dispose(): void` — release all session resources. Always call in a `finally`.

### `AgentSessionOptions`

Options passed to `AgentPlugin.createSession`:

| Field                | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| `profile`            | The agent configuration (`AgentProfile`).                    |
| `cwd`                | Working directory for file operations.                       |
| `apiKeys?`           | Provider → API key overrides.                                |
| `onAgentStatus?`     | Callbacks for turn-level and tool-level events.              |
| `sessionDir?`        | Directory for persisted session storage.                     |
| `resumeSessionPath?` | Path to an existing session for resumption.                  |
| `agentId?`           | Agent ID used in status callbacks (defaults to `sessionId`). |

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
consult `auth.json` or OAuth — agent plugin session creation does.

### `resolveApiKeyOrThrow(provider, customKeys?): string`

Same as `resolveApiKey` but throws with a helpful error listing expected env var names.

## Single-agent task primitive

### `runStepTask<T>(opts: RunStepTaskOptions): Promise<T>` ⚠️ Deprecated

Run one agent as a one-step task. See
[Building a new workflow → `runStepTask`](../guides/building-workflows.md#primitive-1--single-agent-tasks-with-runsteptask)
and [Types reference → `RunStepTaskOptions`](types.md#runsteptaskoptions) for the full
lifecycle and options.

> **Deprecated.** `runStepTask` remains exported but uses the old step-execution path
> (`spawnAgent` / `buildPrompt`) that predates the session-first engine. New workflows
> should prefer [`runSession`](#runsession) for single-session tasks, or
> [`RunnerPool`](#runnerpool) with `singleSession` for tasks that participate in the
> phase/task/session hierarchy.

## Session primitive

### `runSession(ctx: RunSessionContext): Promise<SessionResult>`

The single-session primitive. Runs one agent session with full lifecycle management:
idempotency check (`.complete` sentinel + `result.json`), agent session creation via the
plugin registry, prompt delivery (text / structured / filesystem output mode), response
parsing & atomic result persistence, activity-based watchdog timeout, and
`onSessionStart` / `onSessionComplete` lifecycle callbacks. Throws `SessionError`
(classified by the error classifier) on any failure.

`RunSessionContext` carries: `spec` (`SessionSpec`), `sessionBaseDir`, `cwd`, optional
`worktreeCwd`, `phaseId`, `agentId`, optional `apiKeys`, `onStatus`, `activeSessions`,
`profiles`, `signal`, `watchdogTimeoutMs`, and `watchdogMaxResumes`.

`SessionSpec` fields: `id` (deterministic session identifier), `profile` (profile id),
`prompt`, optional `schema` (Zod), `outputMode` (`'text'` | `'structured'` | `'filesystem'`),
optional `isReadOnly`, `runnerRole` (e.g. `'executor'`, `'reviewer'`), and `attempt`
(1-based).

`SessionResult` is a discriminated union: `{ mode: 'text'; text }`,
`{ mode: 'structured'; data }`, or `{ mode: 'filesystem'; files }`.

### `SessionError`

Error class thrown by `runSession`. Carries a `classification: Classification` (from the
error classifier) and a `transient: boolean` shortcut (`classification.retryable`).

### `clearTaskSessions(sessionBaseDir, taskId): void`

Recursively delete every persisted session for a task. No-op when the directory does not
exist.

## Runner pool

### `RunnerPool`

The concurrent task execution pool for the session-first engine. Replaces `LanePool` +
`Scheduler`. Key differences: no `getStepsForTask` (only `getRunnerForTask`), no
`maxConcurrentLanes` / `laneWaitTimeoutMs` (replaced by `maxConcurrentSessions` +
`modelConcurrency` via `SessionGate`), and runners return `TaskOutcome` directly (no
`completeTask`/`failTask` callbacks on the context).

Constructor takes `RunnerPoolOptions`; `run()` returns
`{ completedTasks: number; failedTasks: number }`. Uses a drain-loop model: all ready
tasks are claimed and their runner coroutines started immediately; the `SessionGate` is
the sole concurrency cap — runners gate themselves via `ctx.gate.run()` so at most
`maxConcurrentSessions` sessions execute simultaneously.

See [Types reference](types.md) for `RunnerPoolOptions` and [Building a new workflow →
RunnerPool](../guides/building-workflows.md#primitive-2--concurrent-tasks-with-runnerpool)
for the full lifecycle and authoring patterns.

### `SessionGate`

Two-level (total + per-model) FIFO concurrency gate for LLM sessions. Callers acquire via
`gate.run(profile, fn)` — the gate holds the slot for the duration of `fn`, then releases
automatically (RAII). There is no manual acquire/release API.

Constructor takes `SessionGateOptions` (`{ total, perModel }`) and an optional `AbortSignal`.
`gate.run(profile, fn)` resolves with `fn`'s result; the per-model key is
`${provider}:${model}` (or `${provider}:${model}:${agent}` when an agent-specific cap
exists).

## Composable runners

All runners are factory functions returning a `Runner` (defined in
`packages/engine/src/pool/runners/`). Each runner receives a `RunnerContext` and returns
a `Promise<TaskOutcome>` where `TaskOutcome = { status: 'completed' } | { status: 'failed';
error?: string }`.

| Runner              | Signature                                                                  | Behaviour                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `singleSession`     | `(spec: Omit<SessionSpec, 'id'> & { role: string }) => Runner`             | Runs exactly one session via the session primitive. Session id: `${taskId}/${role}#${attempt}`. Returns `{ status: 'completed' }` on success; rethrows `SessionError`. |
| `linearRunner`      | `(children: Runner[]) => Runner`                                           | Runs children in strict sequential order. Short-circuits on the first `{ status: 'failed' }` child.                                                                    |
| `reviewRunner`      | `(executeSpec, reviewSpec, options?) => Runner`                            | Implements the execute→review loop: run execute, feed output into review prompt; on rejection, append feedback and re-run execute. Up to `maxRounds` (default 3).      |
| `councilRunner`     | `(workers: SessionSpec[], synthesizer: SessionSpec) => Runner`             | Runs worker sessions in parallel via `Promise.allSettled`; feeds concatenated outputs into a synthesizer session. All workers failing → `{ status: 'failed' }`.        |
| `parallelRunner`    | `(children: Runner[]) => Runner`                                           | Starts all children as concurrent coroutines (`Promise.allSettled`). Returns the first failed child's outcome (by array index); siblings are not cancelled.            |
| `mapRunner`         | `(options: MapRunnerOptions) => Runner`                                    | Fans out over a static `items` array, running one session per item with an optional concurrency cap. Session id: `${taskId}/map[${index}].${role}#${attempt}`.         |
| `branchRunner`      | `(options: BranchRunnerOptions) => Runner`                                 | Evaluates branch conditions in order (sync or async); runs the first matching child Runner. Falls back to `default` or fails if no match.                              |
| `coordinatorRunner` | `(coordinatorSpec: SessionSpec, opts: CoordinatorRunnerOptions) => Runner` | Runs a coordinator session (must fully resolve first), then delegates to `opts.childRunner(coordinatorResult)` to build + run children.                                |
| `coalescingRunner`  | `(coordinatorSpec: SessionSpec, opts: CoalescingRunnerOptions) => Runner`  | Coordinator → children → coordinator loop. Each round the coordinator returns `{ done, children?, feedback? }`; `done: true` → completed. Loops to `maxRounds`.        |

### Deprecated runners

The following runners from the old step-execution path (the removed `LanePool` /
`Scheduler`) remain exported but are **deprecated** — new code should use the composable
runners above with [`RunnerPool`](#runnerpool).

| Runner              | Notes                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `linearStepsRunner` | Wraps a `StepDefinition[]` into a `TaskRunner` with reviewer back-up retry. Used by the removed `LanePool`. Deprecated — use `linearRunner`. |
| `reflectionRunner`  | Two-step draft→critic loop with session resume. Deprecated — prefer `reviewRunner`.                                                          |

## Tracking

See [Event store & status](event-store.md) for `EventStore`, `createStoreCallbacks`, `evolve`,
and the projection. See [Task pool & execution](task-pool.md) for `RunnerPool` and `TaskTracker`.

The persisted-workflow-state classes are also exported:

### `WorkflowStatusTracker`

Top-level persisted workflow state. Persists to `.engin-state.json`. Auto-persists on
`TaskSettled`, `TaskReady`, and `TaskClaimed` events from its `TaskTracker`. See source in
`packages/engine/src/tracking/workflow-status.ts` for the full getter/mutator surface.

### `AuditLog`

JSONL-backed audit log. `append`, `getEvents({ taskId?, type? })`, `getEventsByTask`,
`getStats`, `clear`. Results are cached in-memory (capped at 5000 events); the cache is
invalidated on each `append`.

## Worktree utilities

### `WorktreeManager`

The sole owner of main-worktree creation and the per-task worktree lifecycle.
Constructor takes `WorktreeManagerOptions`; key methods: `setupMainWorktree()`,
`createTaskWorktree(taskId, taskPrompt?)`, `mergeTaskBranch(taskId)`,
`cullTaskWorktree(taskId)`, `finalMergeToMain()`,
`resolveFinalMergeConflicts(conflicts, taskPrompt)`, `abortFinalMerge()`, `cleanup()`,
`getWorktreeInfo()`. See [Types reference → Worktree types](types.md#worktree-types)
and [Worktrees reference](worktrees.md) for the full method table and semantics.

### `createLintValidationGate(worktreePath): () => Promise<{ error?: string } | undefined>`

Returns a `validateOutput` callback for the deprecated `runStepTask` / `runMultiStepTask`
primitives (the session-first engine validates output via runner specs instead). Runs
`eslint --fix` + `prettier --write` (fire-and-forget), then a final `eslint` check;
returns `{ error }` when lint errors remain, else `undefined`. The argument is the
directory to lint — bind it to the directory the agent actually writes to (see the
caveat in [Building a new workflow](../guides/building-workflows.md#createLlintvalidationgate--the-primary-lint-defence)).

### `runTooledFixup(opts: FixupOptions): Promise<FixupResult>`

Shared, self-verifying, tooled fix-up agent (write/edit/bash enabled, sandboxed to
the worktree). Drives free-form `session.prompt()`, self-verifies with `tsc --noEmit`

- `eslint` after each turn, retries up to `maxAttempts` (default 3). Used by both
  the hardened conflict resolver and the commit-failure safety net.

### `generateTitleAndBranch(options): Promise<{ title, branchName }>`

LLM-generates a workflow title and a kebab-case branch slug from the task prompt
(schema: `TitleAndBranchSchema`); falls back deterministically on failure. Used by
the run executor to derive the `engin/{mainSlug}` branch.

## Re-exports from dependencies

From `@earendil-works/pi-coding-agent`: `AgentSession`, `SessionManager`,
`DefaultResourceLoader`, `AuthStorage`.

From `@earendil-works/pi-ai`: `getModel`, `parseJsonWithRepair`, and the `Model` type.

From `@earendil-works/pi-agent-core`: the `ThinkingLevel` type.

## TUI and web

The server components (`ControlServer`, `StatusBridge`, `RunManager`, protocol types) are
also exported from `@harms-haus/engin-engine`. The TUI (`WorkflowTUI`, widgets, theme
helpers) is exported from the separate `@harms-haus/engin-tui` package. See
[TUI reference](tui.md) and [Web reference](web.md).
