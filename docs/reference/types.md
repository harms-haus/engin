# Types reference

All types below are exported from the `@harms-haus/engin-engine` entry point
(`packages/engine/src/index.ts`). The published CLI package (`@harms-haus/engin`) does not
re-export these types — depend on `@harms-haus/engin-engine` directly. Where a type is defined
in a specific source file, that is noted.

## Union types

### `ThinkingLevel`

```typescript
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
```

Re-exported from `@earendil-works/pi-agent-core`.

### `TaskStatus`

```typescript
type TaskStatus = 'ready' | 'blocked' | 'active' | 'complete' | 'failed' | 'cancelled' | 'parked';
```

Settled statuses (`complete`, `failed`, `cancelled`) are terminal on the executor side. The
`'parked'` status is transient — it marks a task whose current batch of sessions cannot start
due to gate-capacity saturation; the scheduler resumes it when a slot frees up. See
[Task pool & execution → Task lifecycle](task-pool.md#task-lifecycle).

### `EventType`

The event types recorded by `EventStore`:

```typescript
type EventType =
  | 'workflow_started'
  | 'phase_registered'
  | 'phase_started'
  | 'phase_completed'
  | 'session_started'
  | 'session_completed'
  | 'session_failed'
  | 'auto_retry_started'
  | 'auto_retry_completed'
  | 'task_registered'
  | 'task_started'
  | 'task_completed'
  | 'task_rejected'
  | 'task_parked'
  | 'task_unparked'
  | 'decision'
  | 'error'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'sidebar_updated'
  | 'turn_started'
  | 'turn_ended'
  | 'tool_call_started'
  | 'tool_call_ended'
  | 'log'
  | 'agent_rendered'
  | 'workflow_data_set';
```

See [Event store & status → The reducer](event-store.md#the-evolve-reducer).

## Error classification types

Source: `packages/engine/src/core/error-classifier.ts`. See
[API reference → Error classification](api.md#error-classification).

### `ErrorKind`

```typescript
type ErrorKind = 'transient' | 'permanent' | 'abort' | 'empty' | 'unknown';
```

The structured error category returned by `classify`. Classification precedence is
abort > empty > permanent > transient > unknown.

### `Classification`

```typescript
interface Classification {
  kind: ErrorKind;
  retryable: boolean;
  delayMs?: number;
}
```

The verdict returned by `classify`. `retryable` is `true` for transient/empty verdicts;
`delayMs` is present only on transient verdicts (exponential backoff, jittered, capped).

### `ClassifyOptions`

| Field                   | Type                                               | Description                                                                                                        |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `lastAssistantMessage?` | `{ stopReason?, errorMessage?, content?, usage? }` | The last assistant message (as returned by `extractLastAssistantMessage`), for empty/overflow/transient detection. |
| `contextWindow?`        | `number`                                           | Model context window, for silent context-overflow detection.                                                       |
| `attempt?`              | `number`                                           | 1-based attempt number, used to compute transient backoff delay (default `1`).                                     |

## Core types

### `AgentProfile`

Source: `packages/engine/src/core/types/profiles.ts`.

| Field           | Type            | Description                                               |
| --------------- | --------------- | --------------------------------------------------------- |
| `id`            | `string`        | Profile identifier — derived from filename without `.md`. |
| `name`          | `string`        | Human-readable display name.                              |
| `provider`      | `string`        | AI provider identifier.                                   |
| `model`         | `string`        | Model identifier within the provider.                     |
| `agent?`        | `string`        | Agent runtime plugin ID. Defaults to `'pi-coding-agent'`. |
| `thinkingLevel` | `ThinkingLevel` | Model thinking depth. Defaults to `'medium'`.             |
| `systemPrompt`  | `string`        | The full system prompt (Markdown body after frontmatter). |
| `excludeTools`  | `string[]`      | Tool names to remove from the default set.                |
| `includeTools`  | `string[]`      | If non-empty, intersected with the default set.           |

### `Task`

The executor-side (write-model) task. Source: `packages/engine/src/core/types/tasks.ts`.

| Field             | Type               | Description                                                                                    |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| `id`              | `string`           | Unique task identifier.                                                                        |
| `title`           | `string`           | Short description.                                                                             |
| `prompt`          | `string`           | Detailed prompt for the implementing agent.                                                    |
| `profile`         | `string`           | Agent profile ID to use.                                                                       |
| `files`           | `string[]`         | File paths pre-loaded into the prompt (relative to `cwd`; binary skipped; truncated at 10 KB). |
| `dependencies`    | `string[]`         | Task IDs that must complete before this task.                                                  |
| `status`          | `TaskStatus`       | Current lifecycle state.                                                                       |
| `phaseId`         | `string`           | **Required.** Phase the task belongs to.                                                       |
| `worktree`        | `'none' \| 'code'` | **Required.** Worktree mode: `'code'` creates a per-task git worktree; `'none'` runs in `cwd`. |
| `assignedAgent?`  | `string`           | ID of the agent currently working on this task.                                                |
| `result?`         | `unknown`          | Implementation result submitted for review.                                                    |
| `reviewFeedback?` | `string[]`         | Accumulated feedback from reviewer rejections.                                                 |

### `TaskEntity`

The read-model (projection) shape. Source: `packages/shared/src/types.ts`. Does **not** carry
executor-only fields. Has no `steps` or `activeStepIndex` — task-level progress is derived
from status, and per-session detail lives in `SessionEntity`.

| Field              | Type                                  | Description                                                                                                                                                                                                               |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | `string`                              | Unique task identifier.                                                                                                                                                                                                   |
| `title`            | `string`                              | Short description.                                                                                                                                                                                                        |
| `phaseId`          | `string`                              | **Required.** Phase the task belongs to.                                                                                                                                                                                  |
| `status`           | `TaskStatus`                          | Current lifecycle state.                                                                                                                                                                                                  |
| `dependencies`     | `string[]`                            | Task IDs that must complete before this task.                                                                                                                                                                             |
| `startedAt?`       | `number`                              | Epoch milliseconds when the task started.                                                                                                                                                                                 |
| `completedAt?`     | `string`                              | ISO timestamp when the task completed.                                                                                                                                                                                    |
| `elapsedMs?`       | `number`                              | Accumulated ACTIVE running time in epoch-ms, excluding intervals spent `parked` waiting for a gate slot. Folded projection-side from event timestamps (replay-deterministic). Frozen when the task is parked or terminal. |
| `activeStartedAt?` | `number`                              | Epoch-ms marking the start of the current active interval; cleared (folded into `elapsedMs`) on park or terminal transition. Present only while the task is `active`.                                                     |
| `parkedAt?`        | `number`                              | Epoch-ms when the task last transitioned into `parked`. Used by clients to render a parked duration.                                                                                                                      |
| `sessionPlan?`     | `{ role: string; profile: string }[]` | Ordered session plan declared when the task started (roles/profiles), so consumers can render all planned sessions + a `●N/M` progress counter. Absent for tasks that don't declare a plan.                               |

Active-time display rule: `active` → live tick `elapsedMs + (Date.now() - activeStartedAt)`; `ready`/`blocked` → blank; `parked`/terminal → frozen `elapsedMs`. The timer pauses while a task is parked, so `elapsedMs` reflects active work only.

### `SessionEntity`

Source: `packages/shared/src/event-types.ts` (canonical; re-exported by the engine). The
projection shape for a single agent session. Keyed by `sessionKey(agentId, taskId,
runnerRole, attempt)` in `WorkflowProjection.sessions`.

| Field            | Type                                                | Description                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uid`            | `string`                                            | Stable key. Format is `agentId::taskId::runnerRole::attempt` when associated with a task role/attempt, `agentId::taskId::runnerRole` or `agentId::taskId` when some components are absent, or just `agentId` for non-task agents (scouts/planners). |
| `agentId`        | `string`                                            | Agent identifier.                                                                                                                                                                                                                                   |
| `profile`        | `string`                                            | Profile ID used to create the session.                                                                                                                                                                                                              |
| `phaseId`        | `string`                                            | Phase the session belongs to.                                                                                                                                                                                                                       |
| `taskId?`        | `string`                                            | Associated task, if any.                                                                                                                                                                                                                            |
| `sessionId?`     | `string`                                            | Session identifier.                                                                                                                                                                                                                                 |
| `sessionPath?`   | `string`                                            | Session storage path.                                                                                                                                                                                                                               |
| `active`         | `boolean`                                           | Whether the session is currently running.                                                                                                                                                                                                           |
| `status?`        | `'pending' \| 'running' \| 'completed' \| 'failed'` | Session lifecycle status (alongside the legacy active boolean).                                                                                                                                                                                     |
| `log`            | `LogEntry[]`                                        | Session log entries (capped at 500).                                                                                                                                                                                                                |
| `toolCallCount`  | `number`                                            | Total tool calls made.                                                                                                                                                                                                                              |
| `inputTokens`    | `number`                                            | Accumulated input tokens.                                                                                                                                                                                                                           |
| `outputTokens`   | `number`                                            | Accumulated output tokens.                                                                                                                                                                                                                          |
| `contextWindow?` | `number`                                            | Resolved model context window (from pi-ai `Model.contextWindow`), surfaced on `session_started`. Optional; used by the TUI to show a cumulative-consumption multiple.                                                                               |
| `taskTitle`      | `string`                                            | Title of the associated task (empty if none).                                                                                                                                                                                                       |
| `startedAt?`     | `string`                                            | ISO timestamp stamped once at first spawn (from the session-start event's `metadata.timestamp`); preserved across re-spawns. Used to compute per-session active time.                                                                               |
| `completedAt?`   | `string`                                            | ISO timestamp when the session completed.                                                                                                                                                                                                           |
| `runnerRole`     | `string`                                            | Role label for the runner that spawned this session (e.g. `'executor'`, `'reviewer'`, `'worker'`). Defaults to `'executor'` when not provided.                                                                                                      |
| `attempt`        | `number`                                            | 1-based attempt/retry number. Defaults to `1` when not provided.                                                                                                                                                                                    |

### `PhaseEntity`

Source: `packages/shared/src/event-types.ts` (canonical; re-exported by the engine).

| Field     | Type       | Description                                       |
| --------- | ---------- | ------------------------------------------------- |
| `id`      | `string`   | Phase identifier.                                 |
| `label`   | `string`   | Human-readable label for display.                 |
| `icon`    | `string`   | Emoji or icon.                                    |
| `taskIds` | `string[]` | Ordered list of task IDs belonging to this phase. |

### `LogEntry`

Source: `packages/shared/src/event-types.ts` (canonical; re-exported by the engine).

| Field       | Type                                                                                                               | Description                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `id`        | `string`                                                                                                           | Stable entry identifier.      |
| `timestamp` | `string`                                                                                                           | ISO timestamp.                |
| `type`      | `'text' \| 'thinking' \| 'tool_call' \| 'tool_call_start' \| 'tool_call_end' \| 'error' \| 'decision' \| 'render'` | Entry discriminant.           |
| `content`   | `string`                                                                                                           | Entry text content.           |
| `metadata?` | `Record<string, unknown>`                                                                                          | Optional structured metadata. |

### `WorkflowProjection`

Source: `packages/shared/src/event-types.ts` (canonical; re-exported by the engine). The canonical read-model derived by `evolve()`.

```typescript
interface WorkflowProjection {
  seq: number;
  taskPrompt: string;
  phases: PhaseEntity[]; // ordered list, each with taskIds
  currentPhaseId: string;
  completedPhaseIds: string[];
  tasks: Record<string, TaskEntity>; // keyed by taskId
  sessions: Record<string, SessionEntity>; // keyed by sessionKey (agentId::taskId::runnerRole::attempt)
  sidebar: { title: string; indicator: string };
  status: 'running' | 'complete' | 'failed';
  error?: string;
  failedPhase?: string;
  stats: { totalTokens: number; sessionCount: number };
  /** Server-captured console output (capped at MAX_RUN_LOG entries). */
  runLog: LogEntry[];
  /** Arbitrary data attached via workflow_data_set events (shallow-merged). */
  workflowData?: Record<string, unknown>;
}
```

### `EventRecord`

Source: `packages/shared/src/event-types.ts` (canonical; re-exported by the engine).

```typescript
interface EventRecord {
  seq: number;
  type: EventType;
  data: Record<string, unknown>;
  metadata: {
    timestamp: string;
    agentId?: string;
    taskId?: string;
    phaseId?: string;
    runnerRole?: string;
    attempt?: number;
  };
}
```

### `WorkflowState`

Serialized form of `WorkflowStatusTracker`. Written to `.engin-state.json`.

| Field               | Type                                     | Description                                                  |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `taskPrompt`        | `string`                                 | The original task prompt.                                    |
| `currentPhaseId`    | `string`                                 | Phase the workflow is currently in.                          |
| `completedPhaseIds` | `string[]`                               | Phases that have finished.                                   |
| `tasks`             | `Task[]`                                 | All tasks in the plan.                                       |
| `workflowData`      | `Record<string, unknown>`                | Generic data bag for workflow-specific state.                |
| `stats`             | `{ totalTokens; totalCost; agentCount }` | Aggregate statistics.                                        |
| `spawnedAgents?`    | `PersistedAgentRecord[]`                 | Persisted records of spawned agents.                         |
| `worktree?`         | `WorktreeInfo`                           | Main worktree information (set when the run uses worktrees). |

## Workflow + harness option types

### `WorkflowRunOptions`

Options passed to a workflow's `run()`. Source: `packages/engine/src/core/types/workflow.ts`.

| Field                 | Type                     | Description                                                                                                                                                                                                   |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                 | `string`                 | Working directory. For git-repo runs this is the **main worktree path** (`{run-id}/worktree`), not the original cwd.                                                                                          |
| `workDir`             | `string`                 | Directory for workflow state persistence.                                                                                                                                                                     |
| `maxConcurrentTasks?` | `number`                 | Maximum parallel agents (default 5).                                                                                                                                                                          |
| `apiKeys?`            | `Record<string, string>` | Provider → API key overrides.                                                                                                                                                                                 |
| `onStatus?`           | `StatusCallbacks`        | Callbacks for workflow/agent/session events.                                                                                                                                                                  |
| `verbose?`            | `boolean`                | Verbose console output instead of TUI dashboard.                                                                                                                                                              |
| `signal?`             | `AbortSignal`            | Abort signal for cooperative cancellation.                                                                                                                                                                    |
| `eventStore?`         | `EventStore`             | Shared event store so workflows can read projection state for resume / workflowData.                                                                                                                          |
| `worktree?`           | `WorktreeInfo`           | Main worktree information (set alongside `worktreeManager` for git-repo runs).                                                                                                                                |
| `worktreeManager?`    | `WorktreeManager`        | Per-run worktree manager. Forward to `SessionScheduler` to enable per-task worktrees. Absent for the non-git fallback path.                                                                                   |
| `rendererRegistry?`   | `RendererRegistry`       | Registry of per-profile renderers that transform agent JSON output into human-readable markdown.                                                                                                              |
| `hookRegistry?`       | `HookRegistry`           | The engine-assembled hook registry (built by `composeHooks` from `WorkflowModule.hooks`). Forward to `SessionScheduler` / `PhaseRunner` to activate their hooks. Absent when the workflow exports no `hooks`. |
| `stepTimeoutMs?`      | `number`                 | Optional per-prompt timeout in milliseconds. Forwarded to the pool so each `session.prompt()` call is raced against a watchdog. Unset/0/NaN → no timeout.                                                     |

### `WorkflowModule`

Source: `packages/engine/src/core/types/workflow.ts`.

| Field                | Type                                                                 | Description                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`                | `(taskPrompt: string, options: WorkflowRunOptions) => Promise<void>` | The workflow entry point (**required**).                                                                                                                                            |
| `registerRenderers?` | `(registry: RendererRegistry) => void`                               | Optional hook for workflows to register output renderers for agent profiles. Called by the engine after module load.                                                                |
| `hooks?`             | `HookProvider`                                                       | Optional workflow-provided hooks. The engine composes these with the store callbacks via `composeHooks`; a single `WorkflowHooks` object or an array of them (registered in order). |
| `name?`              | `string`                                                             | Human-readable workflow name.                                                                                                                                                       |
| `description?`       | `string`                                                             | Workflow description.                                                                                                                                                               |

### `WorkflowEntry`

| Field    | Type                  | Description                     |
| -------- | --------------------- | ------------------------------- |
| `name`   | `string`              | Workflow name (directory name). |
| `source` | `'local' \| 'global'` | Which config root it came from. |
| `path`   | `string`              | Absolute path to `main.ts`.     |

### `HarnessCreationOptions`

| Field                | Type                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`            | `AgentProfile`           | The agent configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cwd`                | `string`                 | Working directory.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apiKeys?`           | `Record<string, string>` | Provider → API key overrides.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `onAgentStatus?`     | `AgentStatusCallbacks`   | Turn-level and tool-level callbacks.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sessionDir?`        | `string`                 | Directory for persisted session storage.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `resumeSessionPath?` | `string`                 | Path to an existing session for resumption.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `agentId?`           | `string`                 | Agent ID for status callbacks (defaults to `sessionId`).                                                                                                                                                                                                                                                                                                                                                                                                    |
| `allowedWriteDirs?`  | `string[]`               | Optional write-sandbox override: blocks `write`/`edit` outside these directories (resolved against `cwd`). When **omitted** on a non-read-only session, the engine applies a default sandbox confining writes to the session's own cwd (`worktreeCwd ?? cwd`) so a task cannot leak changes into the main working directory. Read-only sessions skip the sandbox entirely. Pass an explicit array to broaden writes (e.g. to a shared artifacts directory). |

### `WriteSandboxOptions`

Options for `createWriteSandboxExtension` (see [API reference → Write-sandbox utilities](api.md#write-sandbox-utilities)). Source: `packages/engine/src/agents/pi-coding-agent/write-sandbox.ts`.

| Field         | Type       | Description                                                   |
| ------------- | ---------- | ------------------------------------------------------------- |
| `allowedDirs` | `string[]` | Directories that `write`/`edit` calls may resolve into.       |
| `cwd`         | `string`   | Base directory relatives resolve against when canonicalizing. |

## Worktree types

Source: `packages/engine/src/core/types/workflow.ts` (`WorktreeInfo`),
`packages/engine/src/core/worktree-manager.ts` (`WorktreeManager`,
`WorktreeManagerOptions`, `TaskWorktreeInfo`),
`packages/engine/src/core/git.ts` (`WorktreeCopyEntry`).

See [Worktrees reference](worktrees.md) for the full system description.

### `WorktreeInfo`

Describes a git worktree used for isolated execution. Carried on
`WorkflowRunOptions.worktree`, `WorkflowState.worktree`, `RunHandle.worktree`,
and `RunSummary.worktree`.

| Field          | Type     | Description                                                                                      |
| -------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `worktreePath` | `string` | Absolute path to the worktree directory on disk.                                                 |
| `branchName`   | `string` | Name of the branch checked out in the worktree (`engin/{mainSlug}` for the main worktree).       |
| `originalCwd`  | `string` | The original working directory before switching to the worktree (where `.worktreecopy` is read). |

### `WorktreeManagerOptions`

Constructor options for `WorktreeManager`.

| Field              | Type                     | Description                                                                                                                                                                     |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoRoot`         | `string`                 | Absolute path to the real git repository root.                                                                                                                                  |
| `sourceCwd`        | `string`                 | Original cwd (where `.worktreecopy` lives).                                                                                                                                     |
| `workDir`          | `string`                 | Run dir (`.engin/work/{run-id}/`) — parent of the main + task worktrees.                                                                                                        |
| `mainBranch`       | `string`                 | The main-wt branch name (`engin/{mainSlug}`). Provided by the caller.                                                                                                           |
| `mainWorktreePath` | `string`                 | Absolute path to the main worktree (`{workDir}/worktree`).                                                                                                                      |
| `profilesDirs`     | `string[]`               | Profile directories for agent-based commit/conflict operations.                                                                                                                 |
| `apiKeys?`         | `Record<string, string>` | API keys for agent operations.                                                                                                                                                  |
| `hookRegistry?`    | `HookRegistry`           | Optional hook registry for worktree-lifecycle hooks (`populateWorktree`, `beforeTaskWorktreeCreate`, `onTaskMerge`, …). When absent, methods behave as today (backward compat). |

### `TaskWorktreeInfo`

Describes a single per-task worktree, tracked in `WorktreeManager.taskWorktrees`.

| Field    | Type                                   | Description                                              |
| -------- | -------------------------------------- | -------------------------------------------------------- |
| `path`   | `string`                               | Absolute path to the per-task worktree directory.        |
| `branch` | `string`                               | The per-task branch name (`engin/{mainSlug}--{taskId}`). |
| `status` | `'active'` \| `'merged'` \| `'culled'` | Lifecycle status of the task worktree.                   |

### `WorktreeManager`

Source: `packages/engine/src/core/worktree-manager.ts`.

The sole owner of main worktree creation and the central orchestrator for the
per-task worktree feature. Owns:

- The **main worktree** (the `engin/{mainSlug}` branch checked out at
  `{workDir}/worktree`, populated from `.worktreecopy`).
- The **per-task worktree lifecycle** (one worktree per concurrent task with `worktree === 'code'`, branched
  off the main-wt branch so each task inherits already-merged sibling work).
- **Merge serialization** — concurrent task merges are chained onto a single
  `mergeChain` promise so the squash-merges into the main-wt branch never
  interleave.
- The **final run-end merge** into real `main` (and its conflict resolution /
  abort UX).

No other code should call `createWorktree` for the main worktree — it must go
through `WorktreeManager.setupMainWorktree()`.

| Method                                              | Behaviour                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setupMainWorktree()`                               | Prune orphans; create the main worktree at `mainWorktreePath` on `mainBranch`; populate from `.worktreecopy`. The branch name is NOT generated here — the caller provides `mainBranch` (from `generateTitleAndBranch`).                                                             |
| `createTaskWorktree(taskId, taskPrompt?, task?)`    | Create a per-task worktree at `{workDir}/task-worktrees/{taskId}/` on `engin/{mainSlug}--{taskId}`, branched off the **main worktree**. Populate from `.worktreecopy`. Store the `taskPrompt`/`task` for later use by `mergeTaskBranch`. Returns the absolute worktree path.        |
| `mergeTaskBranch(taskId)`                           | Commit pending changes in the task worktree (outside the serialized section), then **serialized** squash-merge into the main-wt branch. On conflict, `resolveConflictsWithAgent` attempts resolution. On success, cull the task worktree. Returns `{ success, conflictsResolved }`. |
| `cullTaskWorktree(taskId)`                          | Force-remove the task worktree + force-delete its branch. Idempotent no-op for unknown/culled taskIds. Best-effort — errors are swallowed and logged. Used on success after a merge, and on failure before a retry.                                                                 |
| `prune()`                                           | `git worktree prune` to sweep orphaned worktree metadata from crashed runs.                                                                                                                                                                                                         |
| `finalMergeToMain()`                                | Squash-merge the main-wt branch into real `main` (used by the run-end final merge UX). On conflict, leaves the repo in the conflicted merge state for a follow-up `resolve`/`decline`. Returns `{ success, conflicts, conflictsResolved }`.                                         |
| `resolveFinalMergeConflicts(conflicts, taskPrompt)` | Resolve conflicts from a failed `finalMergeToMain` via the agent. On success, stage the resolved files and commit. Returns `true` when all conflicts were resolved.                                                                                                                 |
| `abortFinalMerge()`                                 | Abort an in-progress final merge on the repo root (`git merge --abort`).                                                                                                                                                                                                            |
| `cleanup()`                                         | Remove the main worktree + main-wt branch + sweep leftover task worktrees. **Only called after a successful final merge.** Best-effort; returns `{ cleanupError? }`.                                                                                                                |
| `getWorktreeInfo()`                                 | Returns a `WorktreeInfo` describing the MAIN worktree, for `RunHandle.worktree` and `RunSummary.worktree`.                                                                                                                                                                          |

### `WorktreeCopyEntry`

Source: `packages/engine/src/core/worktree-populate.ts`. One parsed entry from a `.worktreecopy`
file.

| Field     | Type                    | Description                                                                                    |
| --------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `pattern` | `string`                | The gitignore-like pattern (markers stripped).                                                 |
| `mode`    | `'copy'` \| `'symlink'` | `copy` (default) copies the matched path; `symlink` (the `@symlink` prefix) creates a symlink. |
| `negated` | `boolean`               | `true` when the line started with `!` (re-include a previously excluded path).                 |

## Pool & scheduling types

### `SessionSchedulerOptions`

Source: `packages/engine/src/pool/session-scheduler.ts`. Constructor options for
`SessionScheduler` — the concurrent task execution engine that drives a
`TaskGraph` through a `SessionGate`.

| Field               | Required          | Description                                                                                                                      |
| ------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `graph`             | **Yes**           | The task DAG (`TaskGraph`) with status tracking + blocking-pressure ranking.                                                     |
| `gate`              | **Yes**           | Two-level concurrency gate (`SessionGate`).                                                                                      |
| `profiles`          | **Yes**           | Resolved agent profiles keyed by profile id.                                                                                     |
| `sessionBaseDir`    | **Yes**           | Base directory for persisted session storage (`{base}/{sessionId}/`).                                                            |
| `cwd`               | **Yes**           | Working directory.                                                                                                               |
| `onStatus?`         | No                | Status callbacks.                                                                                                                |
| `hookRegistry?`     | No                | Hook registry (for `beforeTask` lifecycle hooks). Scoped-cloned at the start of `run()`.                                         |
| `rendererRegistry?` | No                | Registry of custom output renderers keyed by profile id.                                                                         |
| `auditLog?`         | No                | Audit log (for tracking session events).                                                                                         |
| `signal?`           | No                | Abort signal.                                                                                                                    |
| `stepTimeoutMs?`    | No                | Per-session execute timeout in milliseconds (default 300 000). Forwarded to sessions as `watchdogTimeoutMs`.                     |
| `phaseId`           | **Yes**           | The phase this scheduler serves.                                                                                                 |
| `apiKeys?`          | No                | Provider → API key overrides.                                                                                                    |
| `activeSessions`    | **Yes**           | Mutable set of active sessions (for cooperative abort).                                                                          |
| `worktreeManager?`  | `WorktreeManager` | Per-run worktree manager. When set, tasks with `worktree === 'code'` get their own worktree (merged on success, culled on fail). |

### `TaskGraphEntry`

Source: `packages/engine/src/pool/task-graph.ts`. A task plus its scheduler-managed
session-plan state. The `task` and `status` fields are owned by `TaskGraph`; the
runner / session-plan fields are mutated externally by the scheduler.

| Field               | Type                                             | Description                                                                |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `task`              | `Task`                                           | The underlying task definition.                                            |
| `runnerFactory`     | `() => SessionPlanRunner`                        | Constructs a fresh `SessionPlanRunner` when the task becomes active.       |
| `status`            | `TaskStatus`                                     | Current status (mirrors `task.status`; kept in sync by `TaskGraph`).       |
| `planGen?`          | `AsyncGenerator<SessionSpec[], SessionResult[]>` | Live async generator from `runner.plan(ctx)`, while the task is executing. |
| `heldBatch?`        | `SessionSpec[]`                                  | The currently-held batch of specs the scheduler is executing.              |
| `batchResults`      | `SessionResult[]`                                | Results collected for the held batch so far (in spec order).               |
| `completedSessions` | `number`                                         | Count of settled (completed or failed) `execute()` calls.                  |
| `totalSessions`     | `number`                                         | Total count of `SessionSpec`s yielded across all batches so far.           |

### `SessionGateOptions`

Source: `packages/engine/src/pool/session-gate.ts`.

| Field      | Type                     | Description                                                                        |
| ---------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `total`    | `number`                 | Hard cap on concurrent in-flight callbacks across ALL models.                      |
| `perModel` | `Record<string, number>` | Per-model caps keyed by `${provider}:${model}` or `${provider}:${model}:${agent}`. |

### `SessionSpec`

Source: `packages/engine/src/pool/session.ts`.

| Field         | Type         | Description                                                                                                                                                                                                                             |
| ------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `string`     | Unique session identifier (used for persistence path).                                                                                                                                                                                  |
| `profile`     | `string`     | Agent profile ID (resolved against `ctx.profiles`).                                                                                                                                                                                     |
| `prompt`      | `string`     | The prompt text sent to the agent.                                                                                                                                                                                                      |
| `schema?`     | `ZodType`    | Optional Zod schema for structured output mode.                                                                                                                                                                                         |
| `outputMode`  | `OutputMode` | `'text' \| 'structured' \| 'filesystem'` — how the response is interpreted.                                                                                                                                                             |
| `isReadOnly?` | `boolean`    | When true, write/edit tools are stripped.                                                                                                                                                                                               |
| `runnerRole`  | `string`     | Role label for the runner (e.g. `'executor'`, `'reviewer'`). Propagated to callbacks.                                                                                                                                                   |
| `attempt`     | `number`     | 1-based attempt number. Propagated to callbacks.                                                                                                                                                                                        |
| `resume?`     | `boolean`    | When true, resume an existing session at this id (continue its conversation) instead of creating a fresh one. Used by review loops so a rejected execute step is re-prompted in the same session. Bypasses the idempotency cache check. |

### `SessionResult`

Source: `packages/engine/src/pool/session.ts`.

```typescript
type SessionResult =
  | { mode: 'text'; text: string }
  | { mode: 'structured'; data: unknown }
  | { mode: 'filesystem'; files: string[] };
```

### `RunSessionContext`

Source: `packages/engine/src/pool/session.ts`.

| Field                 | Type                              | Description                                                                   |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `spec`                | `SessionSpec`                     | The session specification to execute.                                         |
| `sessionBaseDir`      | `string`                          | Base directory for persisted session storage.                                 |
| `cwd`                 | `string`                          | Working directory for agent operations.                                       |
| `worktreeCwd?`        | `string`                          | Per-task worktree path. When set, the agent runs inside the worktree.         |
| `phaseId`             | `string`                          | Phase identifier for callbacks.                                               |
| `agentId`             | `string`                          | Agent identifier for callbacks.                                               |
| `apiKeys?`            | `Record<string, string>`          | API key overrides.                                                            |
| `onStatus?`           | `StatusCallbacks`                 | Callbacks (`onSessionStart` / `onSessionComplete` + agent-status forwarding). |
| `activeSessions`      | `Set<{ abort(): Promise<void> }>` | Mutable set for cooperative abort.                                            |
| `profiles`            | `Map<string, AgentProfile>`       | Resolved profiles.                                                            |
| `signal?`             | `AbortSignal`                     | Cooperative cancellation.                                                     |
| `watchdogTimeoutMs?`  | `number`                          | Activity-based idle timeout.                                                  |
| `watchdogMaxResumes?` | `number`                          | Max internal retries on watchdog timeout before permanent error.              |

### `SessionPlanContext`

Source: `packages/engine/src/pool/runners/session-plan-types.ts`. Context passed to a
`SessionPlanRunner`'s `plan()` and `execute()` methods. Unlike the old runner contract,
this does **not** include a `gate`, a `runSession` function, or `maxTaskRetries` — the
scheduler owns the gate and invokes `execute()` for each spec.

| Field               | Type                              | Description                                                               |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `task`              | `Task`                            | The task being executed.                                                  |
| `profiles`          | `Map<string, AgentProfile>`       | Resolved agent profiles keyed by profile id.                              |
| `sessionBaseDir`    | `string`                          | Base directory for persisted session storage.                             |
| `cwd`               | `string`                          | Working directory for agent operations.                                   |
| `worktreeCwd?`      | `string`                          | Per-task worktree path. When set, agent sessions run inside the worktree. |
| `apiKeys?`          | `Record<string, string>`          | Provider → API key overrides.                                             |
| `activeSessions`    | `Set<{ abort(): Promise<void> }>` | Mutable set of active sessions (for cooperative abort).                   |
| `onStatus?`         | `StatusCallbacks`                 | Status callbacks (`onSessionStart` / `onSessionComplete` + agent-status). |
| `hookRegistry?`     | `HookRegistry`                    | Hook registry (for lifecycle hooks).                                      |
| `rendererRegistry?` | `RendererRegistry`                | Registry of custom output renderers.                                      |
| `auditLog?`         | `AuditLog`                        | Audit log (for tracking session events).                                  |
| `signal?`           | `AbortSignal`                     | Cooperative cancellation signal.                                          |
| `stepTimeoutMs?`    | `number`                          | Step timeout in milliseconds (passed through to session execution).       |
| `phaseId`           | `string`                          | Phase identifier (propagated to lifecycle callbacks).                     |
| `agentId`           | `string`                          | Agent identifier (propagated to lifecycle callbacks).                     |

### `SessionPlanRunner`

Source: `packages/engine/src/pool/runners/session-plan-types.ts`. The SessionPlan
runner contract — a stateful object that decouples _planning_ (what sessions to run)
from _scheduling_ (when to start them, subject to gate capacity). The scheduler owns
the `SessionGate`; the runner never acquires or releases gate slots itself.

```typescript
interface SessionPlanRunner {
  plan(ctx: SessionPlanContext): AsyncGenerator<SessionSpec[], SessionResult[] | undefined, SessionResult[]>;
  execute(ctx: SessionPlanContext, spec: SessionSpec): Promise<SessionResult>;
}
```

**`plan(ctx)`** — async generator yielding **batches** of `SessionSpec[]`. The scheduler
calls `gen.next()` to receive the first batch, starts as many sessions as gate capacity
allows, then calls `gen.next(results)` to advance **only once the entire batch has
settled**. The `results` argument is `SessionResult[]` — one per spec, in order. A
batch is **atomic**: the generator cannot advance until every spec settles. A spec that
cannot start parks the task (status `'parked'`); already-started siblings keep running.
The generator's `return` value may be a final `SessionResult[]` or `undefined`.

**`execute(ctx, spec)`** — runs one `SessionSpec` and returns its `SessionResult`. Must
**not** acquire the gate — the scheduler acquires the slot before calling `execute()`
and releases it after the returned promise settles.

### `SessionPlanFactory`

Source: `packages/engine/src/pool/runners/session-plan-types.ts`.

```typescript
type SessionPlanFactory = () => SessionPlanRunner;
```

Factory that constructs a fresh `SessionPlanRunner` instance. Runners are stateful
(they track plan progress across batches), so each task gets its own runner instance.
The scheduler constructs a runner lazily when a task becomes active.

### Session watchdog & generator-timeout types

Source: `packages/engine/src/pool/session-watchdog.ts` (`SessionWatchdog`, `WatchdogTimeoutError`)
and `packages/engine/src/pool/scheduler-timeout.ts` (`GeneratorTimeoutError`). All three are
re-exported from the entry point for workflow code building custom session primitives.

| Type                    | Description                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionWatchdog`       | Handle returned by `createSessionWatchdog` (`arm()`, `race<T>(work)`, `dispose()`) implementing activity-based idle detection.            |
| `WatchdogTimeoutError`  | `Error` subclass thrown by `SessionWatchdog.race()` when the idle window elapses; routed by the scheduler to `failTask`.                  |
| `GeneratorTimeoutError` | `Error` subclass (readonly `label`, `ms`) raised by `withTimeout`; swallowed by the scheduler so a hung generator does not fail the task. |

## Structured-output and loop option types

### `StructuredOutputOptions`

| Field          | Type     | Description                                   |
| -------------- | -------- | --------------------------------------------- |
| `maxRetries`   | `number` | Total number of attempts (default `3`).       |
| `retryPrompt?` | `string` | Declared but unused by `promptForStructured`. |

### `AgentLoopUntilOptions`

| Field          | Type     | Description                             |
| -------------- | -------- | --------------------------------------- |
| `maxAttempts?` | `number` | Maximum loop iterations (default `10`). |

### `MultiAgentOptions` (for `parallelAgents` / `sequentialAgents`)

| Field            | Type           | Description                                             |
| ---------------- | -------------- | ------------------------------------------------------- |
| `schema?`        | `ZodType<any>` | Zod schema for structured output validation.            |
| `maxRetries?`    | `number`       | Max attempts for structured output (default `3`).       |
| `agentIdPrefix?` | `string`       | Prefix for generated agent IDs (`parallelAgents` only). |

### `PromptableHarness`

```typescript
interface PromptableHarness {
  prompt: (text: string) => Promise<void>;
  getLastAssistantText: () => string | undefined;
}
```

### `AgentLoopResult<T>`

| Field         | Type                                | Description                                                |
| ------------- | ----------------------------------- | ---------------------------------------------------------- |
| `result`      | `T`                                 | The validated structured output.                           |
| `attempts`    | `number`                            | Configured max retry attempts (not the actual count used). |
| `totalTokens` | `{ input: number; output: number }` | Token usage (always zero from `retryAgentUntil`).          |

## Callback types

### `StatusCallbacks`

`StatusCallbacks = WorkflowStatusCallbacks & AgentStatusCallbacks`. All methods are optional.
Source: `packages/engine/src/core/types/callbacks.ts`.

#### `WorkflowStatusCallbacks`

| Method                 | Parameter shape                                                                                           | Fired when                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `onWorkflowStart`      | `{ taskPrompt, resumed, workDir }`                                                                        | The `run()` orchestrator starts.          |
| `onPhaseRegister`      | `{ id, label, icon }`                                                                                     | A phase is registered at startup.         |
| `onPhaseStart`         | `{ phase, round }`                                                                                        | A phase begins execution.                 |
| `onPhaseComplete`      | `{ phase, durationMs }`                                                                                   | A phase finishes.                         |
| `onSessionStart`       | `{ agentId, profile, phaseId, taskId?, sessionId?, sessionPath?, contextWindow?, runnerRole?, attempt? }` | A session is created (agent spawned).     |
| `onSessionComplete`    | `{ agentId, profile, phaseId, taskId?, sessionId?, runnerRole?, attempt? }`                               | A session finishes its prompt.            |
| `onTaskStart`          | `{ taskId, title, agentId, phaseId?, startedAt?, sessionPlan? }`                                          | A task is claimed and dispatched.         |
| `onTaskRegister`       | `{ taskId, phaseId, title, dependencies }`                                                                | A task is registered.                     |
| `onTaskComplete`       | `{ taskId, title }`                                                                                       | A task passes review.                     |
| `onTaskRejected`       | `{ taskId, title, reason }`                                                                               | A task fails review.                      |
| `onTaskParked`         | `{ taskId, title, agentId, phaseId? }`                                                                    | A task is parked (gate at capacity).      |
| `onTaskUnparked`       | `{ taskId, title, agentId, phaseId? }`                                                                    | A parked task resumes (slot freed).       |
| `onDecision`           | `{ agentId, decision, reasoning, taskId? }`                                                               | A reviewer makes a decision.              |
| `onAgentRender`        | `{ agentId, profile, taskId?, rendered }`                                                                 | A renderer produces markdown from output. |
| `onError`              | `{ agentId, error, phaseId, taskId? }`                                                                    | A session encounters an error.            |
| `onWorkflowComplete`   | `{ totalDurationMs, agentCount }`                                                                         | The workflow finishes successfully.       |
| `onWorkflowFailed`     | `{ error: Error, phaseId }`                                                                               | The workflow throws an unhandled error.   |
| `onWorkflowData`       | `{ data: Record<string, unknown> }`                                                                       | Arbitrary workflow data is attached.      |
| `onSidebarUpdate`      | `{ title?, indicator? }`                                                                                  | Sidebar UI metadata is updated.           |
| `onAutoRetryStart`     | `{ agentId, attempt, maxAttempts, delayMs, errorMessage? }`                                               | An auto-retry cycle begins.               |
| `onAutoRetryCompleted` | `{ agentId, success, attempt, finalError? }`                                                              | An auto-retry cycle ends.                 |

#### `AgentStatusCallbacks`

| Method                 | Parameter shape                                             | Fired when                  |
| ---------------------- | ----------------------------------------------------------- | --------------------------- |
| `onTurnStart`          | `{ agentId, turn }`                                         | An agent turn begins.       |
| `onTurnEnd`            | `{ agentId, turn, tokens?, contentBlocks? }`                | An agent turn completes.    |
| `onToolCallStart`      | `{ agentId, toolName, toolCallId, arguments }`              | A tool execution starts.    |
| `onToolCallEnd`        | `{ agentId, toolName, toolCallId, isError }`                | A tool execution finishes.  |
| `onAutoRetryStart`     | `{ agentId, attempt, maxAttempts, delayMs, errorMessage? }` | An auto-retry cycle begins. |
| `onAutoRetryCompleted` | `{ agentId, success, attempt, finalError? }`                | An auto-retry cycle ends.   |

### `TurnContentBlock`

A discriminated union representing the content of an assistant turn:

| Type       | Shape                                                                | Description                      |
| ---------- | -------------------------------------------------------------------- | -------------------------------- |
| `text`     | `{ type: 'text'; text: string }`                                     | Message text from the assistant. |
| `thinking` | `{ type: 'thinking'; thinking: string; redacted?: boolean }`         | Thinking/reasoning text.         |
| `toolCall` | `{ type: 'toolCall'; id, name, arguments: Record<string, unknown> }` | Tool call with parameters.       |

`contentBlocks` is only populated when the turn's message has `role: 'assistant'`.

### `AgentRenderHandler`

Source: `packages/engine/src/core/renderer-invocation.ts`. The callback shape passed to
[`invokeRenderer`](api.md#invokerenderer) for delivering a rendered agent output.

```typescript
type AgentRenderHandler = (info: { agentId: string; profile: string; taskId: string; rendered: string }) => void;
```

Mirrors the `onAgentRender` status-callback payload (`{ agentId, profile, taskId?, rendered }`),
with `taskId` required here because `invokeRenderer` always operates within a task context.

## Hook types

Source: **`packages/engine/src/hooks/types.ts`** (the canonical `WorkflowHooks` interface and
all hook argument/result types live here — **not** `core/types.ts`). The composition
implementation ships in `hooks/registry.ts` / `hooks/compose.ts`. See [Hooks](hooks.md) for the
full catalog, composition rules, default implementations, and wiring status. If a type here
ever disagrees with `types.ts`, the code wins.

### Mechanism types

| Type / field             | Shape                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CompositionRule`        | `'observe' \| 'pipeline' \| 'first-wins' \| 'all-run'` — how multiple subscribers to one hook name are combined.                                                                                                                                                               |
| `HookContext`            | `{ registry: HookRegistry; cwd: string; workDir: string; signal?: AbortSignal }`. Built by the engine (NOT the workflow) and passed to every hook invocation. `cwd` is the original repo cwd, not the per-task worktree path.                                                  |
| `ObserveHook<Args>`      | `(args, ctx) => void \| Promise<void>` — fire-and-forget fan-out (rule: `'observe'`).                                                                                                                                                                                          |
| `PipelineHook<V, Args>`  | `(value, args, ctx) => V \| Promise<V>` — ordered value transform (rule: `'pipeline'`).                                                                                                                                                                                        |
| `FirstWinsHook<R, Args>` | `(args, ctx) => R \| undefined \| Promise<R \| undefined>` — first non-`undefined` wins (rule: `'first-wins'`). Only `undefined` abstains (`false`/`0`/`''` are decisions).                                                                                                    |
| `AllRunHook<C, Args>`    | `(args, ctx) => C \| Promise<C>` — every subscriber contributes, folded by the hook's reducer (rule: `'all-run'`).                                                                                                                                                             |
| `HookRegistry`           | Interface: `register(hooks)`, `invokeObserve(name, args, ctx)`, `invokePipeline(name, initialValue, args, ctx)`, `invokeFirstWins(name, args, ctx)`, `invokeAllRun(name, args, ctx)`, `hasSubscribers(name)`, `clone()`. Each `invoke*` is generic over `keyof WorkflowHooks`. |
| `WorkflowHooks`          | The hook catalog interface — grown by declaration merging across `types.ts`. Each field is `SomeHook<Args> \| SomeHook<Args>[]`. See [Hooks §3](hooks.md#3-hook-catalog) for every field's signature, rule, and wiring status.                                                 |
| `HookProvider`           | `WorkflowHooks \| WorkflowHooks[]` — what `WorkflowModule.hooks` accepts (a single object or an array registered in order).                                                                                                                                                    |

### Per-hook argument / result types

These are the `Args`/`Result` shapes the hook functions receive/return, grouped by lifecycle
level (matching [Hooks §3](hooks.md#3-hook-catalog)). `Task` is defined in `core/types.ts`;
`StepDefinition` in `shared/src/types.ts`; `WorktreeInfo` in `core/types/workflow.ts`.

#### Session level

| Type                      | Fields                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `BeforeSessionPromptArgs` | `{ task: Task; step: StepDefinition; prompt: string; cwd: string; worktreeCwd?: string }` |
| `CollectContextArgs`      | `{ task: Task; step: StepDefinition; cwd: string; worktreeCwd?: string }`                 |
| `ContextBlock`            | `{ label: string; content: string }`                                                      |

#### Lane / failure isolation

| Type                | Fields                                                           |
| ------------------- | ---------------------------------------------------------------- |
| `OnLaneErrorArgs`   | `{ laneId: string; task: Task; error: string; phaseId: string }` |
| `ShouldIsolateArgs` | `{ task: Task; error: string; laneId: string }`                  |

#### Workflow level

| Type                     | Fields                                                                   |
| ------------------------ | ------------------------------------------------------------------------ |
| `OnWorkflowResumeArgs`   | `{ workDir: string; tracker: unknown }`                                  |
| `OnWorkflowAbortArgs`    | `{ reason: string; workDir: string }`                                    |
| `OnPersistArgs`          | `{ workDir: string }`                                                    |
| `OnRestoreArgs`          | `{ workDir: string }`                                                    |
| `BeforeRunMergeArgs`     | `{ worktree?: WorktreeInfo; repoRoot: string; mainBranch: string }`      |
| `RunMergeDecision`       | `{ proceed: boolean; strategy?: 'squash' \| 'merge' \| 'rebase' }`       |
| `OnRunMergeConflictArgs` | `{ conflicts: string[]; worktreePath: string; repoRoot: string }`        |
| `ConflictResolution`     | `{ strategy: 'agent' \| 'manual' \| 'abort'; resolvedFiles?: string[] }` |

#### Audit observe hooks

| Type                     | Fields                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `OnStructuredOutputArgs` | `{ agentId: string; output: unknown; taskId?: string; phaseId?: string; stepIndex?: number }` |
| `OnDecisionArgs`         | `{ agentId: string; decision: string; reasoning: string; taskId?: string; phaseId?: string }` |

#### Phase / task level

| Type                        | Fields                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BeforePhaseArgs`           | `{ phaseId: string; state: Record<string, unknown> }`                                                                                                            |
| `BeforePhaseResult`         | `{ skip?: boolean; statePatch?: Record<string, unknown> }`                                                                                                       |
| `AfterPhaseArgs`            | `{ phaseId: string; result: unknown; durationMs: number }`                                                                                                       |
| `BeforePhaseTransitionArgs` | `{ from: string; to: string; state: Record<string, unknown> }`                                                                                                   |
| `PhaseTransition`           | `{ type: 'advance' \| 'loop' \| 'jump'; target?: string }`                                                                                                       |
| `ShouldRetryPhaseArgs`      | `{ phaseId: string; result: unknown; round: number; state: Record<string, unknown> }`                                                                            |
| `OnPhaseSettledArgs`        | `{ phaseId: string; tasks: Task[]; state: Record<string, unknown> }`                                                                                             |
| `BeforeTaskArgs`            | `{ task: Task; steps: StepDefinition[] }`                                                                                                                        |
| `BeforeTaskResult`          | `{ skip?: boolean; runner?: SessionPlanRunner; steps?: StepDefinition[]; files?: string[]; reason?: string; sessionPlan?: { role: string; profile: string }[] }` |

#### Scheduler / execution level

| Type               | Fields                                                                               |
| ------------------ | ------------------------------------------------------------------------------------ |
| `WakeStrategyArgs` | `{ laneId: string; reason: 'task-ready' \| 'task-settled' \| 'timeout' \| 'abort' }` |
| `OnLaneIdleArgs`   | `{ laneId: string; consecutiveTimeouts: number }`                                    |

#### Worktree lifecycle

| Type                       | Fields                                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| `BeforeTaskWorktreeArgs`   | `{ task: Task; worktreeManager: unknown }`                                      |
| `BeforeTaskWorktreeResult` | `{ skip?: boolean; baseBranch?: string; extraFiles?: string[] }`                |
| `AfterTaskWorktreeArgs`    | `{ task: Task; worktreePath: string; branch: string }`                          |
| `PopulateWorktreeArgs`     | `{ worktreePath: string; sourceCwd: string; task?: Task }`                      |
| `OnTaskMergeArgs`          | `{ task: Task; worktreePath: string; branch: string }`                          |
| `TaskMergeDecision`        | `{ proceed: boolean; strategy?: 'squash' \| 'merge' }`                          |
| `OnMergeConflictArgs`      | `{ task: Task; conflicts: string[]; worktreePath: string; mainBranch: string }` |
| `OnCommitFailureArgs`      | `{ task: Task; errors: string[]; worktreePath: string }`                        |
| `CommitFailureResolution`  | `{ strategy: 'agent' \| 'skip' \| 'fail'; resolvedFiles?: string[] }`           |

## TUI option types

### `WorkflowTUIOptions`

Source: `packages/tui/src/workflow-tui.ts`. The TUI is a WebSocket client — it takes a
`ClientStore` (fed by the `EngineClient`), not an `EventStore`.

| Field            | Type          | Default | Description                                                                     |
| ---------------- | ------------- | ------- | ------------------------------------------------------------------------------- |
| `agentLogLines?` | `number`      | `20`    | Collapsed height of the agent detail log (expanded shows 40).                   |
| `clientStore?`   | `ClientStore` | —       | The shared projection store the widgets sync from (fed by the `EngineClient`).  |
| `runId?`         | `string`      | —       | Server run identifier, shown in the detach/kill prompt.                         |
| `onDetach?`      | `() => void`  | —       | Called when the user detaches (leaves the run on the server, exits the client). |
| `onKill?`        | `() => void`  | —       | Called when the user kills (sends `cancel_run`, then exits on terminal state).  |

### `DashboardSelection`

| Field               | Type             | Description                                    |
| ------------------- | ---------------- | ---------------------------------------------- |
| `selectedPhaseId`   | `string \| null` | The phase whose tasks are displayed.           |
| `selectedTaskId`    | `string \| null` | The task whose session log is shown.           |
| `selectedSessionId` | `string \| null` | The session tab highlighted.                   |
| `userPinnedPhase`   | `boolean`        | True when the user clicked a completed phase.  |
| `userPinnedSession` | `boolean`        | True when the user clicked a specific session. |

## Web protocol types

See [Web reference → Protocol](web.md#protocol). The full `ServerMessage` /
`ClientMessage` discriminated unions live in `packages/shared/src/protocol-types.ts`.

### `worktree_merge_result` (ServerMessage)

Broadcast by `RunManager.handleWorktreeAction` (via
`StatusBridge.broadcastWorktreeResult`) as the reply to a `worktree_action`
ClientMessage. See [Worktrees reference → Final merge UX](worktrees.md#final-merge-ux).

```typescript
interface WorktreeMergeResultMessage {
  type: 'worktree_merge_result';
  runId: string;
  outcome: 'clean' | 'conflicts' | 'resolved' | 'failed' | 'declined';
  cleanupError?: string; // best-effort cleanup failure message
  worktreePath?: string; // preserved worktree path (conflicts / failed / declined)
  branchName?: string; // preserved branch name (conflicts / failed / declined)
}
```

| Outcome     | When                                                                           | Cleanup? |
| ----------- | ------------------------------------------------------------------------------ | -------- |
| `clean`     | `merge` action succeeded with no conflicts.                                    | Yes      |
| `conflicts` | `merge` action produced conflicts; awaiting a follow-up `resolve` / `decline`. | No       |
| `resolved`  | `resolve` action succeeded (conflicts resolved by the agent).                  | Yes      |
| `failed`    | `merge` or `resolve` failed (non-conflict error, or resolver exhaustion).      | No       |
| `declined`  | `decline` action — the user chose to handle the merge manually.                | No       |
