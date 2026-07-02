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

### Write-sandbox utilities

Source: `packages/engine/src/agents/pi-coding-agent/write-sandbox.ts`. General-purpose path-safety helpers that enforce write-sandbox boundaries, re-exported from the agents barrel so custom agent plugins and workflows can reuse them.

- `createWriteSandboxExtension({ allowedDirs, cwd }): ExtensionFactory` — build a pi `tool_call` extension that blocks `write`/`edit` calls resolving outside `allowedDirs`. Paths are canonicalized with `realpathSync` so symlink escapes are contained.
- `resolveToolPath(inputPath, cwd): string` — lexical resolution mirroring pi's write/edit tools (expand `~`, strip a leading `@`, resolve relatives against `cwd`).
- `canonicalizePath(p): string` — `realpathSync`-based canonicalization. When the leaf path does not yet exist (e.g. a new file being created), canonicalizes the existing parent directory and re-appends the basename so ancestor symlinks are resolved. Re-throws the original error if the parent is also missing or inaccessible (fail closed).
- `isPathWithin(target, dir): boolean` — true when `target` resolves inside `dir`.
- `resolveAllowedDirs(allowedDirs, cwd): string[]` — canonicalize each allowed dir against `cwd`.
- `findAllowedDir(target, resolvedAllowedDirs): string | null` — return the first allowed dir containing `target`, else `null`.

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

## Error classification

Source: `packages/engine/src/core/error-classifier.ts`. Classifies thrown errors and
assistant-message metadata into a structured `ErrorKind` + retryability verdict, so
callers can decide whether to retry, abort, or escalate. Classification precedence is
abort > empty > permanent > transient > unknown. Used by `runSession` to build the
`SessionError.classification` verdict (see [Session primitive](#session-primitive)).

### `classify(err: unknown, opts?: ClassifyOptions): Classification`

Classify `err`, optionally enriched with the last assistant message and attempt number.
Returns `{ kind, retryable, delayMs? }`: `kind` is one of `'transient'`, `'permanent'`,
`'abort'`, `'empty'`, or `'unknown'`; `retryable` is `true` for transient/empty verdicts;
`delayMs` is present only on transient verdicts (exponential backoff, jittered, capped).
See [Types reference → `ErrorKind`](types.md#errorkind),
[`Classification`](types.md#classification), and
[`ClassifyOptions`](types.md#classifyoptions).

### `ErrorKind`, `Classification`

`ErrorKind = 'transient' | 'permanent' | 'abort' | 'empty' | 'unknown'`;
`Classification = { kind: ErrorKind; retryable: boolean; delayMs?: number }`. See
[Types reference → Error classification types](types.md#error-classification-types).

### `extractLastAssistantMessage(session): LastAssistantMessage | undefined`

Given a session-like object with a `messages` array, walk backwards to the last message
with `role: 'assistant'` and return its `{ stopReason, errorMessage, content, usage }`.
Returns `undefined` when the session is missing, has no messages, or contains no assistant
message. Pass the result as `ClassifyOptions.lastAssistantMessage` to `classify`.

### `CONTEXT_OVERFLOW_FALLBACK_RE`

Secondary safety-net regex — `/context.*length|maximum.*context|context window|too many tokens/i` —
for context-overflow patterns not yet covered by pi-ai's `isContextOverflow`. Applied to
the assistant `errorMessage` during classification.

## Shared utilities

### `validateWorkflowName(name: string): void`

Throw on `/`, `\`, or `..` (path traversal prevention).

### `isEnoentError(err: unknown): boolean`

True when `err` is a non-null object with `code === 'ENOENT'`.

### `safeErrorMessage(err: unknown): string`

`err.message` for `Error` instances, otherwise `String(err)`.

### `forwardAgentStatus(onStatus?: StatusCallbacks): AgentStatusCallbacks | undefined`

Return an `AgentStatusCallbacks` that forwards the four agent-level callbacks (`onTurnStart`,
`onTurnEnd`, `onToolCallStart`, `onToolCallEnd`) to `onStatus`. Returns `undefined` when
`onStatus` is absent (the conventional no-op for harness options).

### `appendReviewFeedback(task, feedback): void`

Append a feedback string to `task.reviewFeedback`, initialising the array if absent.

### `DEFAULT_TOOLS: readonly string[]`

Frozen array: `['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']`.

### `redactSecrets(text: string): string`

Redact common API-key and secret patterns from `text`: `Bearer <token>`, `sk-ant-…`,
`sk-…`, and key-value assignments whose key suggests a secret (`api_key`, `api-key`,
`apikey`, `token`, `secret`, `password`, `authorization`). The key name is preserved while
the value is replaced with `[REDACTED]`. Returns the input unchanged when no pattern
matches. Source: `packages/engine/src/core/redact.ts`.

### `getLocalNetworkIP(): string | null`

Return the first non-loopback, non-docker, non-link-local IPv4 address found on the
system, or `null` when no suitable interface exists. Source:
`packages/engine/src/core/network.ts`.

### `relativizePathsIn(value: unknown, roots: string[]): unknown`

Recursively rewrite absolute paths that fall under any of `roots` to repo-relative tails
inside a structured `value` (strings, plain objects, arrays). Exact-root matches become
`.`; only the longest matching root applies per string leaf. Returns new containers (it
does not mutate the input) and is idempotent. Applied at task result-capture seams — see
[Worktrees reference → Task succeeds](worktrees.md#task-succeeds). Source:
`packages/engine/src/core/path-relativizer.ts`.

### `invokeRenderer(rendererRegistry, profileId, rawText, agentId, taskId, onAgentRender?): void`

Invoke the renderer registered for `profileId` against the agent's raw assistant text and,
when a non-empty rendering is produced, forward it to `onAgentRender`. If `rawText` holds a
parseable JSON document the parsed value is passed to the renderer; otherwise the raw text
is passed verbatim. No-ops (returns without firing) when there is no registry, no renderer
for `profileId`, `rawText` is empty, or the renderer returns an empty/falsy value.
`onAgentRender` is an [`AgentRenderHandler`](types.md#agentrenderhandler). Source:
`packages/engine/src/core/renderer-invocation.ts`.

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

### `runStepTask<T>(opts: RunStepTaskOptions): Promise<T>` 🗑️ Removed

**Removed in the session-first redesign.** Was used to run one agent as a one-step task.
Use [`runSession`](#runsession) for single-session tasks, or
[`SessionScheduler`](#sessionscheduler) with `singleSession` for tasks that participate in the
phase/task/session hierarchy.

## Session primitive

### `runSession(ctx: RunSessionContext): Promise<SessionResult>`

The single-session primitive. Runs one agent session with full lifecycle management:
idempotency check (`.complete` sentinel + `result.json`), agent session creation via the
plugin registry, prompt delivery (text / structured / filesystem output mode), response
parsing & atomic result persistence, activity-based watchdog timeout, and
`onSessionStart` / `onSessionComplete` lifecycle callbacks. Throws `SessionError`
(classified by the error classifier) on any failure.

`RunSessionContext` carries: `spec` (`SessionSpec`), `sessionBaseDir`, `cwd`, optional
`worktreeCwd`, `phaseId`, `agentId`, optional `taskId`, optional `apiKeys`, `onStatus`,
`activeSessions`, `profiles`, `signal`, `watchdogTimeoutMs`, and `watchdogMaxResumes`.

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

## Session scheduler

The concurrent task execution engine. The `SessionScheduler` drives a `TaskGraph`
through a `SessionGate` using a greedy tiered drain loop. It replaces the old
`RunnerPool` (and before it, `LanePool` + `Scheduler`). Key differences from
`RunnerPool`: runners are pure `SessionPlanRunner` async generators that never touch
the gate — the scheduler owns gate acquisition/release directly (acquire before
`execute()`, release on settle). There is no `maxTaskRetries`.

### `SessionScheduler`

Source: `packages/engine/src/pool/session-scheduler.ts`.

Constructor takes `SessionSchedulerOptions` (see [Types reference →
`SessionSchedulerOptions`](types.md#sessionscheduleroptions)). `run()` returns
`{ completedTasks: number; failedTasks: number }`.

The drain loop processes three tiers in priority order:

- **T1 (active):** continue specs in active tasks' held batches.
- **T2 (parked):** resume parked tasks whose pending specs now fit gate capacity.
- **T3 (ready):** initialize runner + first batch, start first specs — a ready task
  only becomes `'active'` when its first session actually acquires a slot (**lazy
  activation**).

A spec that cannot start parks the task (emits `task_parked`); already-started
siblings continue running. A parked task that resumes emits `task_unparked`.
Multiple near-simultaneous completions / `gate.onRelease` triggers coalesce into a
single drain pass via `queueMicrotask`. Status transitions are emitted exclusively
through `graph.onStatusTransition`; the scheduler owns event emission.

See [Types reference → `SessionPlanRunner`](types.md#sessionplanrunner) for the
runner contract, and [Types reference → `TaskGraphEntry`](types.md#taskgraphentry)
for the per-task scheduler state.

### `TaskGraph`

Source: `packages/engine/src/pool/task-graph.ts`.

A task dependency graph (DAG) with status tracking and blocking-pressure ranking.
Owns the task DAG (forward + reverse-dependency indices), per-task status transitions
(`blocked` / `ready` / `parked` / `active` / `complete` / `failed` / `cancelled`),
memoized transitive-dependent counts (reverse-topology DFS), Kahn's-algorithm cycle
detection at insert time, and missing-dependency deadlock detection.

Unlike `TaskTracker`, `TaskGraph` does **not** emit Node `EventEmitter` events.
Status transitions surface exclusively through the optional `onStatusTransition`
callback, which the scheduler sets.

Constructor: `new TaskGraph()`. Key methods:

| Method                         | Behaviour                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `addTask(task, runnerFactory)` | Insert a task. Assigns initial status (`'ready'` if all deps settled, `'blocked'` otherwise). Runs cycle detection and **throws** on a cycle. Reverse-dep index + transitive-dependents cache updated. |
| `addTasks(...tasks)`           | Batch insert. Each task may carry a `runnerFactory`; when omitted, a no-op factory is used. Cycle detection runs after each insertion.                                                                 |
| `getTask(id)`                  | Return the live `TaskGraphEntry`, or `undefined`.                                                                                                                                                      |
| `getAllTasks()`                | All entries in insertion order (live references).                                                                                                                                                      |
| `getReadyTasks()`              | Tasks with status `'ready'`, sorted DESC by `transitiveDependentCount` (blocking pressure). Equal-pressure ties keep insertion order (stable FIFO).                                                    |
| `getParkedTasks()`             | Tasks with status `'parked'`, sorted DESC by blocking pressure.                                                                                                                                        |
| `getActiveTasks()`             | Tasks with status `'active'`, in insertion order.                                                                                                                                                      |
| `setTaskStatus(id, status)`    | Transition a task's status (syncs `entry.status` + `entry.task.status`). Invokes `onStatusTransition` when the status actually changes.                                                                |
| `recalculateReady(depsHint?)`  | Promote blocked dependents whose deps are now all settled (`'blocked'` → `'ready'`). When `depsHint` is given, only dependents of that task are checked.                                               |
| `transitiveDependentCount(id)` | Count of tasks that transitively depend on `id` (backed by a memoized map invalidated on topology change). Used for blocking-pressure ranking.                                                         |
| `failDeadlockedTasks()`        | Mark blocked tasks whose dependency ids don't exist in the graph as `'failed'`. Idempotent.                                                                                                            |

### `SessionGate`

Source: `packages/engine/src/pool/session-gate.ts`.

Two-level (total + per-model) FIFO concurrency gate for LLM sessions. The
`SessionScheduler` acquires slots directly via `gate.acquire(profile)` and releases
them via `gate.release(profile)` after each session settles. `gate.canStart(profile)`
is a non-blocking capacity probe used by the drain loop to decide which specs can
start. `gate.onRelease` is wired by the scheduler to trigger a coalesced drain pass
when a slot frees up.

Constructor takes `SessionGateOptions` (`{ total, perModel }`) and an optional
`AbortSignal`. The per-model key is `${provider}:${model}` (or
`${provider}:${model}:${agent}` when an agent-specific cap exists).

### Session-plan helpers

#### `runScheduledSession(spec, ctx): Promise<SessionResult>`

Source: `packages/engine/src/pool/run-scheduled-session.ts`.

Thin wrapper around [`runSession`](#runsession) for the `SessionScheduler`. Constructs
a `RunSessionContext` from the `SessionPlanContext` + `SessionSpec` and delegates to
`runSession`. The scheduler has already acquired the gate slot before calling this — it
does **not** acquire or release any gate. Errors (including `SessionError`) propagate
unchanged to the caller (the scheduler).

#### `defaultExecute`

Source: `packages/engine/src/pool/runners/runner-utils.ts`.

Default `execute` implementation for `SessionPlanRunner`s. Delegates to
`runScheduledSession` with the given spec and context. Since the scheduler acquires
the gate slot before calling `execute()`, no gate interaction occurs here. All
single-session `SessionPlanRunner`s that need an execute primitive should reference
this instead of duplicating the method.

#### `delegateToChild(child, ctx)`

Source: `packages/engine/src/pool/runners/runner-utils.ts`.

Shared async-generator helper that fully delegates to a child `SessionPlanRunner`'s
`plan()`: re-yields every batch, threads results back via `childGen.next(results)`,
and returns the child's terminal value. A `try/finally` calls `childGen.return()` on
early termination (including a parent `.return()`), so the child's `finally` blocks
always run. Composite runners delegate via `yield* delegateToChild(child, ctx)` so that
`.return()` propagates from parent to child. _(Runner-internal utility — not exported
from the top-level engine barrel.)_

### Session watchdog

Source: `packages/engine/src/pool/session-watchdog.ts`.

Reusable activity-based idle watchdog extracted from the session primitive. Workflow code building custom session execution can reuse it to reproduce `runSession`'s freeze-detection semantics.

#### `createSessionWatchdog(timeoutMs, onTimeout?): SessionWatchdog`

Returns a handle with three methods. When `timeoutMs` is `undefined` the watchdog is disabled: `arm()` and `dispose()` are no-ops and `race()` returns its argument unchanged.

- `arm()` — clear any in-flight timer and arm a fresh idle window.
- `race<T>(work: Promise<T>): Promise<T>` — race `work` against the watchdog promise. A no-op `.catch` is pre-attached to `work` and the race result so a late abort-triggered rejection never surfaces as unhandled. Rejects with `WatchdogTimeoutError` when the timer wins.
- `dispose()` — clear the in-flight timer.

`onTimeout` is invoked (without `await`) when the timer fires — typically `() => session.abort().catch(() => {})`.

#### `WatchdogTimeoutError`

`Error` subclass thrown by `race()` when the idle window elapses. `name === 'WatchdogTimeoutError'`. The scheduler routes a thrown `WatchdogTimeoutError` from `runner.execute()` to `failTask`.

### Plan-generator timeout

Source: `packages/engine/src/pool/scheduler-timeout.ts`.

#### `withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T>`

Race a promise against a `setTimeout`. Rejects with `GeneratorTimeoutError` (mentioning `label`, defaulting to `'plan generator operation'`) when the timeout fires first. The timer is cleared via `.then()` when the promise settles first, and `.unref()`-ed so it cannot keep the process alive.

#### `GeneratorTimeoutError`

`Error` subclass with readonly `label: string` and `ms: number`. The scheduler swallows it in `nextNonEmptyBatch` / `cleanupGenerator` so a hung generator does not fail the task.

#### `GENERATOR_TIMEOUT_MS`

Constant `5_000` — the grace period the scheduler uses for `planGen.next()` / `planGen.return()`.

## Composable runners

All runners are factory functions returning a [`SessionPlanFactory`](types.md#sessionplanfactory)
(defined in `packages/engine/src/pool/runners/`). Each factory constructs a fresh
[`SessionPlanRunner`](types.md#sessionplanrunner) — a stateful object with a `plan(ctx)`
async generator (yielding batches of `SessionSpec[]`) and an `execute(ctx, spec)` method.
The scheduler owns the gate and calls `execute()` for each spec; runners never acquire or
release gate slots themselves. Child runners take `SessionPlanRunner[]` and composite
runners delegate via `yield* delegateToChild(child, ctx)`.

| Runner                       | Signature                                                                              | Behaviour                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `singleSession`              | `(spec: Omit<SessionSpec, 'id'> & { role, attempt? }) => SessionPlanFactory`           | Runs exactly one session via `defaultExecute` (gate-free). Session id: `${taskId}/${role}#${attempt}`. Yields one batch `[fullSpec]`.                                                                          |
| `linearRunner`               | `(children: SessionPlanRunner[]) => SessionPlanFactory`                                | Runs children in strict sequential order. Each child's `plan()` is fully consumed before advancing. Short-circuits if a child's `execute()` throws (scheduler marks the task failed).                          |
| `reviewRunner`               | `(executeSpec, reviewSpec, options?) => SessionPlanFactory`                            | Implements the execute→review loop: run execute, feed output into review prompt; on rejection, append feedback and re-run execute. Up to `maxRounds` (default 3).                                              |
| `councilRunner`              | `(workers: SessionSpec[], synthesizer: SessionSpec) => SessionPlanFactory`             | Runs worker sessions in parallel; feeds concatenated outputs into a synthesizer session. All workers failing → task fails.                                                                                     |
| `parallelRunner`             | `(children: SessionPlanRunner[]) => SessionPlanFactory`                                | Starts all children as concurrent batches (`Promise.allSettled` delegation). Returns the first failed child's outcome (by array index); siblings are not cancelled.                                            |
| `mapRunner`                  | `(options: MapRunnerOptions) => SessionPlanFactory`                                    | Fans out over a static `items` array, running one session per item with an optional concurrency cap. Session id: `${taskId}/map[${index}].${role}#${attempt}`.                                                 |
| `branchRunner`               | `(options: BranchRunnerOptions) => SessionPlanFactory`                                 | Evaluates branch conditions in order (sync or async); runs the first matching child SessionPlanRunner. Falls back to `default` or fails if no match.                                                           |
| `coordinatorRunner`          | `(coordinatorSpec: SessionSpec, opts: CoordinatorRunnerOptions) => SessionPlanFactory` | Runs a coordinator session (must fully resolve first), then delegates to `opts.childRunner(coordinatorResult)` to build + run children.                                                                        |
| `coalescingRunner`           | `(coordinatorSpec: SessionSpec, opts: CoalescingRunnerOptions) => SessionPlanFactory`  | Coordinator → children → coordinator loop. Each round the coordinator returns `{ done, children?, feedback? }`; `done: true` → completed. Loops to `maxRounds`.                                                |
| `retrospectiveCouncilRunner` | `(options: RetrospectiveCouncilRunnerOptions) => SessionPlanFactory`                   | Convener → (members → retrospective)\* loop. Members run in parallel each round; retrospective interprets results and decides to terminate or supply next members. Returns silently on `maxRounds` (no throw). |

### Removed runners

The following runners from the old step-execution path (the removed `LanePool` /
`Scheduler`) were **removed** in the session-first redesign. Use the composable
runners above with [`SessionScheduler`](#sessionscheduler).

| Runner              | Replacement                                       |
| ------------------- | ------------------------------------------------- |
| `linearStepsRunner` | Use `linearRunner` with `singleSession` children. |
| `reflectionRunner`  | Use `coalescingRunner` or `reviewRunner`.         |

## Tracking

See [Event store & status](event-store.md) for `EventStore`, `createStoreCallbacks`, `evolve`,
and the projection. See [Task pool & execution](task-pool.md) for `SessionScheduler` and `TaskTracker`.

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

Returns a `validateOutput` callback for the removed `runStepTask` / `runMultiStepTask`
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
