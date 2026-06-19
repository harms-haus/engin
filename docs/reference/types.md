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
type TaskStatus = 'ready' | 'blocked' | 'active' | 'complete' | 'failed' | 'cancelled';
```

Settled statuses (`complete`, `failed`, `cancelled`) are terminal on the executor side. See
[Task pool & execution → Task lifecycle](task-pool.md#task-lifecycle).

### `EventType`

The 21 event types recorded by `EventStore`:

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
  | 'tool_call_ended'
  | 'log';
```

See [Event store & status → The reducer](event-store.md#the-evolve-reducer).

## Core types

### `AgentProfile`

| Field           | Type            | Description                                               |
| --------------- | --------------- | --------------------------------------------------------- |
| `id`            | `string`        | Profile identifier — derived from filename without `.md`. |
| `name`          | `string`        | Human-readable display name. Defaults to `id`.            |
| `provider`      | `string`        | AI provider identifier.                                   |
| `model`         | `string`        | Model identifier within the provider.                     |
| `thinkingLevel` | `ThinkingLevel` | Model thinking depth. Defaults to `'medium'`.             |
| `systemPrompt`  | `string`        | The full system prompt (Markdown body after frontmatter). |
| `excludeTools`  | `string[]`      | Tool names to remove from the default set.                |
| `includeTools`  | `string[]`      | If non-empty, intersected with the default set.           |

### `Task`

The executor-side (write-model) task. Source: `packages/engine/src/core/types.ts`.

| Field             | Type         | Description                                                                                    |
| ----------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `id`              | `string`     | Unique task identifier.                                                                        |
| `title`           | `string`     | Short description.                                                                             |
| `prompt`          | `string`     | Detailed prompt for the implementing agent.                                                    |
| `profile`         | `string`     | Agent profile ID to use.                                                                       |
| `files`           | `string[]`   | File paths pre-loaded into the prompt (relative to `cwd`; binary skipped; truncated at 10 KB). |
| `dependencies`    | `string[]`   | Task IDs that must complete before this task.                                                  |
| `status`          | `TaskStatus` | Current lifecycle state.                                                                       |
| `phaseId`         | `string`     | **Required.** Phase the task belongs to.                                                       |
| `assignedAgent?`  | `string`     | ID of the agent currently working on this task.                                                |
| `result?`         | `unknown`    | Implementation result submitted for review.                                                    |
| `reviewFeedback?` | `string[]`   | Accumulated feedback from reviewer rejections.                                                 |
| `isCode?`         | `boolean`    | Whether this task writes/modifies code (vs. docs/config).                                      |

### `TaskEntity`

The read-model (projection) shape. Source: `packages/engine/src/core/types.ts`. Does **not** carry
executor-only fields. Steps have no `status`; their rendered state is derived from `index` vs
the task's `activeStepIndex`.

| Field              | Type           | Description                                    |
| ------------------ | -------------- | ---------------------------------------------- |
| `id`               | `string`       | Unique task identifier.                        |
| `title`            | `string`       | Short description.                             |
| `phaseId`          | `string`       | **Required.** Phase the task belongs to.       |
| `status`           | `TaskStatus`   | Current lifecycle state.                       |
| `steps`            | `StepEntity[]` | Ordered list of steps.                         |
| `activeStepIndex?` | `number`       | The single active step; `undefined` when none. |
| `dependencies`     | `string[]`     | Task IDs that must complete before this task.  |
| `startedAt?`       | `number`       | Epoch milliseconds when the task started.      |
| `completedAt?`     | `string`       | ISO timestamp when the task completed.         |

### `StepEntity`

Source: `packages/engine/src/core/types.ts`. Steps have **no status** — state is derived:

- `index < activeStepIndex` → done
- `index === activeStepIndex` → active
- `index > activeStepIndex` → pending

| Field         | Type      | Description                                            |
| ------------- | --------- | ------------------------------------------------------ |
| `name`        | `string`  | Human-readable step name.                              |
| `index`       | `number`  | 0-based position within the task.                      |
| `profile?`    | `string`  | Profile ID this step runs as.                          |
| `agentKey?`   | `string`  | Key into `projection.agents` once an agent is spawned. |
| `isReadOnly?` | `boolean` | When true, write/edit tools are stripped.              |

### `PhaseEntity`

Source: `packages/shared/src/event-types.ts` (canonical; re-exported by the engine).

| Field     | Type       | Description                                       |
| --------- | ---------- | ------------------------------------------------- |
| `id`      | `string`   | Phase identifier.                                 |
| `label`   | `string`   | Human-readable label for display.                 |
| `icon`    | `string`   | Emoji or icon.                                    |
| `taskIds` | `string[]` | Ordered list of task IDs belonging to this phase. |

### `AgentEntity`

Source: `packages/shared/src/event-types.ts` (canonical; re-exported by the engine).

| Field            | Type         | Description                                                                                                                                                                                                               |
| ---------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uid`            | `string`     | Stable key. Format is `agentId::taskId::stepIndex` when the agent is associated with a task step, `agentId::taskId` for legacy task agents without a step index, or just `agentId` for non-task agents (scouts/planners). |
| `agentId`        | `string`     | Agent identifier.                                                                                                                                                                                                         |
| `profile`        | `string`     | Profile ID used to create the agent.                                                                                                                                                                                      |
| `phaseId`        | `string`     | Phase the agent belongs to.                                                                                                                                                                                               |
| `stepIndex?`     | `number`     | Step index within the task, when associated.                                                                                                                                                                              |
| `taskId?`        | `string`     | Associated task, if any.                                                                                                                                                                                                  |
| `sessionId?`     | `string`     | Session identifier.                                                                                                                                                                                                       |
| `sessionPath?`   | `string`     | Session storage path.                                                                                                                                                                                                     |
| `active`         | `boolean`    | Whether the agent is currently running.                                                                                                                                                                                   |
| `log`            | `LogEntry[]` | Agent log entries (capped at 500).                                                                                                                                                                                        |
| `toolCallCount`  | `number`     | Total tool calls made.                                                                                                                                                                                                    |
| `inputTokens`    | `number`     | Accumulated input tokens.                                                                                                                                                                                                 |
| `outputTokens`   | `number`     | Accumulated output tokens.                                                                                                                                                                                                |
| `contextWindow?` | `number`     | Resolved model context window (from pi-ai `Model.contextWindow`), surfaced on `agent_spawned`. Optional; used by the TUI to show a cumulative-consumption multiple.                                                       |
| `taskTitle`      | `string`     | Title of the associated task (empty if none).                                                                                                                                                                             |
| `startedAt?`     | `string`     | ISO timestamp stamped once at first spawn (from the spawn event's `metadata.timestamp`); preserved across re-spawns. Used to compute per-agent active time in the workflow-completion summary.                            |
| `completedAt?`   | `string`     | ISO timestamp when the agent completed.                                                                                                                                                                                   |

### `LogEntry`

Source: `packages/shared/src/event-types.ts` (canonical; re-exported by the engine). Re-exported by the TUI as `AgentLogEntry`.

| Field       | Type                                                                                                   | Description                   |
| ----------- | ------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `id`        | `string`                                                                                               | Stable entry identifier.      |
| `timestamp` | `string`                                                                                               | ISO timestamp.                |
| `type`      | `'text' \| 'thinking' \| 'tool_call' \| 'tool_call_start' \| 'tool_call_end' \| 'error' \| 'decision'` | Entry discriminant.           |
| `content`   | `string`                                                                                               | Entry text content.           |
| `metadata?` | `Record<string, unknown>`                                                                              | Optional structured metadata. |

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
  agents: Record<string, AgentEntity>; // keyed by agentKey (agentId::taskId::stepIndex when step-scoped; see AgentEntity.uid)
  sidebar: { title: string; indicator: string };
  status: 'running' | 'complete' | 'failed';
  error?: string;
  failedPhase?: string;
  stats: { totalTokens: number; agentCount: number };
  /** Server-captured console output (capped at MAX_RUN_LOG entries). */
  runLog: LogEntry[];
}
```

### `EventRecord`

Source: `packages/shared/src/event-types.ts` (canonical; re-exported by the engine).

```typescript
interface EventRecord {
  seq: number;
  type: EventType;
  data: Record<string, unknown>;
  metadata: { timestamp: string; agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number };
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

Options passed to a workflow's `run()`.

| Field                 | Type                     | Description                                                                                                                                              |
| --------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                 | `string`                 | Working directory. For git-repo runs this is the **main worktree path** (`{run-id}/worktree`), not the original cwd.                                     |
| `workDir`             | `string`                 | Directory for workflow state persistence.                                                                                                                |
| `maxConcurrentTasks?` | `number`                 | Maximum parallel agents (default 5).                                                                                                                     |
| `apiKeys?`            | `Record<string, string>` | Provider → API key overrides.                                                                                                                            |
| `onStatus?`           | `StatusCallbacks`        | Callbacks for workflow/agent events.                                                                                                                     |
| `verbose?`            | `boolean`                | Verbose console output instead of TUI dashboard.                                                                                                         |
| `signal?`             | `AbortSignal`            | Abort signal for cooperative cancellation.                                                                                                               |
| `tracker?`            | `unknown`                | Pre-created `WorkflowStatusTracker`, if any.                                                                                                             |
| `worktree?`           | `WorktreeInfo`           | Main worktree information (set alongside `worktreeManager` for git-repo runs).                                                                           |
| `worktreeManager?`    | `WorktreeManager`        | Per-run worktree manager. Forward to `runStepTask` / `runMultiStepTask` / `LanePool` to enable per-task worktrees. Absent for the non-git fallback path. |
| `rendererRegistry?`   | `RendererRegistry`       | Registry of per-profile renderers that transform agent JSON output into human-readable markdown.                                                         |

### `WorkflowModule`

| Field          | Type                                                                 | Description                              |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| `run`          | `(taskPrompt: string, options: WorkflowRunOptions) => Promise<void>` | The workflow entry point (**required**). |
| `name?`        | `string`                                                             | Human-readable workflow name.            |
| `description?` | `string`                                                             | Workflow description.                    |

### `WorkflowEntry`

| Field    | Type                  | Description                     |
| -------- | --------------------- | ------------------------------- |
| `name`   | `string`              | Workflow name (directory name). |
| `source` | `'local' \| 'global'` | Which config root it came from. |
| `path`   | `string`              | Absolute path to `main.ts`.     |

### `HarnessCreationOptions`

| Field                | Type                     | Description                                              |
| -------------------- | ------------------------ | -------------------------------------------------------- |
| `profile`            | `AgentProfile`           | The agent configuration.                                 |
| `cwd`                | `string`                 | Working directory.                                       |
| `apiKeys?`           | `Record<string, string>` | Provider → API key overrides.                            |
| `onAgentStatus?`     | `AgentStatusCallbacks`   | Turn-level and tool-level callbacks.                     |
| `sessionDir?`        | `string`                 | Directory for persisted session storage.                 |
| `resumeSessionPath?` | `string`                 | Path to an existing session for resumption.              |
| `agentId?`           | `string`                 | Agent ID for status callbacks (defaults to `sessionId`). |

## Worktree types

Source: `packages/engine/src/core/types.ts` (`WorktreeInfo`),
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

| Field              | Type                     | Description                                                              |
| ------------------ | ------------------------ | ------------------------------------------------------------------------ |
| `repoRoot`         | `string`                 | Absolute path to the real git repository root.                           |
| `sourceCwd`        | `string`                 | Original cwd (where `.worktreecopy` lives).                              |
| `workDir`          | `string`                 | Run dir (`.engin/work/{run-id}/`) — parent of the main + task worktrees. |
| `mainBranch`       | `string`                 | The main-wt branch name (`engin/{mainSlug}`). Provided by the caller.    |
| `mainWorktreePath` | `string`                 | Absolute path to the main worktree (`{workDir}/worktree`).               |
| `profilesDirs`     | `string[]`               | Profile directories for agent-based commit/conflict operations.          |
| `apiKeys?`         | `Record<string, string>` | API keys for agent operations.                                           |

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
- The **per-task worktree lifecycle** (one worktree per concurrent task, branched
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
| `createTaskWorktree(taskId, taskPrompt?)`           | Create a per-task worktree at `{workDir}/task-worktrees/{taskId}/` on `engin/{mainSlug}--{taskId}`, branched off the **main worktree**. Populate from `.worktreecopy`. Store the `taskPrompt` for later use by `mergeTaskBranch`. Returns the absolute worktree path.               |
| `mergeTaskBranch(taskId)`                           | Commit pending changes in the task worktree (outside the serialized section), then **serialized** squash-merge into the main-wt branch. On conflict, `resolveConflictsWithAgent` attempts resolution. On success, cull the task worktree. Returns `{ success, conflictsResolved }`. |
| `cullTaskWorktree(taskId)`                          | Force-remove the task worktree + force-delete its branch. Idempotent no-op for unknown/culled taskIds. Best-effort — errors are swallowed and logged. Used on success after a merge, and on failure before a retry.                                                                 |
| `prune()`                                           | `git worktree prune` to sweep orphaned worktree metadata from crashed runs.                                                                                                                                                                                                         |
| `finalMergeToMain()`                                | Squash-merge the main-wt branch into real `main` (used by the run-end final merge UX). On conflict, leaves the repo in the conflicted merge state for a follow-up `resolve`/`decline`. Returns `{ success, conflicts, conflictsResolved }`.                                         |
| `resolveFinalMergeConflicts(conflicts, taskPrompt)` | Resolve conflicts from a failed `finalMergeToMain` via the agent. On success, stage the resolved files and commit. Returns `true` when all conflicts were resolved.                                                                                                                 |
| `abortFinalMerge()`                                 | Abort an in-progress final merge on the repo root (`git merge --abort`).                                                                                                                                                                                                            |
| `cleanup()`                                         | Remove the main worktree + main-wt branch + sweep leftover task worktrees. **Only called after a successful final merge.** Best-effort; returns `{ cleanupError? }`.                                                                                                                |
| `getWorktreeInfo()`                                 | Returns a `WorktreeInfo` describing the MAIN worktree, for `RunHandle.worktree` and `RunSummary.worktree`.                                                                                                                                                                          |

### `WorktreeCopyEntry`

Source: `packages/engine/src/core/git.ts`. One parsed entry from a `.worktreecopy`
file.

| Field     | Type                    | Description                                                                                    |
| --------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `pattern` | `string`                | The gitignore-like pattern (markers stripped).                                                 |
| `mode`    | `'copy'` \| `'symlink'` | `copy` (default) copies the matched path; `symlink` (the `@symlink` prefix) creates a symlink. |
| `negated` | `boolean`               | `true` when the line started with `!` (re-include a previously excluded path).                 |

## Pool types

### `RunStepTaskOptions`

| Field              | Required           | Description                                                                                                                                                                                                                                 |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profilesDirs`     | **Yes**            | Directories containing `.md` profiles.                                                                                                                                                                                                      |
| `phaseId`          | **Yes**            | Phase identifier for status callbacks.                                                                                                                                                                                                      |
| `taskId`           | **Yes**            | Unique task identifier.                                                                                                                                                                                                                     |
| `title`            | **Yes**            | Human-readable task title.                                                                                                                                                                                                                  |
| `stepName`         | **Yes**            | Step name (displayed in the UI).                                                                                                                                                                                                            |
| `profileId`        | **Yes**            | Profile ID to load.                                                                                                                                                                                                                         |
| `cwd`              | **Yes**            | Working directory for the agent.                                                                                                                                                                                                            |
| `prompt`           | **Yes**            | Prompt to send.                                                                                                                                                                                                                             |
| `apiKeys?`         | No                 | Provider → API key overrides.                                                                                                                                                                                                               |
| `onStatus?`        | No                 | Status callbacks.                                                                                                                                                                                                                           |
| `isReadOnly?`      | No                 | Strip write/edit (default `false`).                                                                                                                                                                                                         |
| `schema?`          | `ZodType<unknown>` | Zod schema for structured output.                                                                                                                                                                                                           |
| `signal?`          | No                 | Abort signal (checked once at start).                                                                                                                                                                                                       |
| `worktreeManager?` | `WorktreeManager`  | Per-run worktree manager. When set, `runStepTask` creates a per-task worktree, runs the agent inside it, squash-merges the task branch on success, and culls it on failure. Forward `options.worktreeManager` to enable per-task isolation. |

### `StepDefinition<T = unknown>`

| Field          | Required                 | Description                                                               |
| -------------- | ------------------------ | ------------------------------------------------------------------------- |
| `name`         | **Yes**                  | Human-readable step name.                                                 |
| `profileId`    | **Yes**                  | Profile ID to load.                                                       |
| `isReadOnly`   | **Yes**                  | When true, write/edit are stripped.                                       |
| `schema?`      | `ZodType<T>`             | Zod schema for structured-output steps.                                   |
| `isApproved?`  | `(result: T) => boolean` | Approval check. Default: `result.approved === true`.                      |
| `getFeedback?` | `(result: T) => string`  | Rejection feedback. Default: `result.feedback ?? 'No feedback provided'`. |

### `StepResult`

```typescript
type StepResult = { type: 'approved'; output: unknown } | { type: 'rejected'; feedback: string; output?: unknown };
```

### `LanePoolOptions`

| Field                | Required          | Description                                                                                                                                                                |
| -------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrentLanes` | **Yes**           | Maximum concurrent lanes (workers).                                                                                                                                        |
| `profilesDirs`       | **Yes**           | Directories containing `.md` profiles.                                                                                                                                     |
| `sessionBaseDir`     | **Yes**           | Base directory for persisted sessions (`{base}/{taskId}/{execCount}-{stepIndex}-{stepName}/`).                                                                             |
| `cwd`                | **Yes**           | Working directory.                                                                                                                                                         |
| `taskTracker`        | **Yes**           | Shared `TaskTracker` lanes claim from.                                                                                                                                     |
| `getStepsForTask`    | No                | `(task) => StepDefinition[]`.                                                                                                                                              |
| `getRunnerForTask`   | No                | `(task) => TaskRunner`. Takes precedence over `getStepsForTask`.                                                                                                           |
| `phaseId`            | **Yes**           | The phase this pool serves.                                                                                                                                                |
| `apiKeys?`           | No                | Provider → API key overrides.                                                                                                                                              |
| `onStatus?`          | No                | Status callbacks.                                                                                                                                                          |
| `auditLog?`          | No                | Audit log.                                                                                                                                                                 |
| `maxStepRetries?`    | No                | Max retries per step on rejection (default `5`).                                                                                                                           |
| `maxTaskRetries?`    | No                | Max times a failed task is reset and re-run from step 1 within one pool run (default `0`). Total attempts = `1 + maxTaskRetries`. Persisted sessions are cleared on retry. |
| `rendererRegistry?`  | No                | Optional registry of custom output renderers keyed by profile name.                                                                                                        |
| `laneWaitTimeoutMs?` | No                | Lane idle poll interval (default `60000`).                                                                                                                                 |
| `signal?`            | No                | Abort signal.                                                                                                                                                              |
| `worktreeManager?`   | `WorktreeManager` | Per-run worktree manager. When set, each claimed task gets its own worktree (branched off the main worktree) that is squash-merged on success and culled on failure/retry. |

### `LanePoolResult`

| Field            | Type     | Description                               |
| ---------------- | -------- | ----------------------------------------- |
| `completedTasks` | `number` | Tasks that passed all steps successfully. |
| `failedTasks`    | `number` | Tasks that exhausted retries or errored.  |

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

#### `WorkflowStatusCallbacks`

| Method               | Parameter shape                                                                      | Fired when                                 |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| `onWorkflowStart`    | `{ taskPrompt, resumed, workDir }`                                                   | The `run()` orchestrator starts.           |
| `onPhaseRegister`    | `{ id, label, icon }`                                                                | A phase is registered at startup.          |
| `onPhaseStart`       | `{ phase, round }`                                                                   | A phase begins execution.                  |
| `onPhaseComplete`    | `{ phase, durationMs }`                                                              | A phase finishes.                          |
| `onAgentSpawn`       | `{ agentId, profile, phaseId, taskId?, stepIndex?, sessionId?, sessionPath? }`       | An agent session is created.               |
| `onAgentComplete`    | `{ agentId, profile, phaseId, taskId?, stepIndex?, sessionId? }`                     | An agent finishes its prompt.              |
| `onTaskStart`        | `{ taskId, title, agentId, phaseId?, startedAt? }`                                   | A task is claimed and dispatched.          |
| `onTaskRegister`     | `{ taskId, phaseId, title, dependencies, steps: { name, profileId, isReadOnly }[] }` | A task is registered with its step layout. |
| `onStepStart`        | `{ taskId, stepIndex, stepName, agentId }`                                           | A step begins execution.                   |
| `onTaskComplete`     | `{ taskId, title }`                                                                  | A task passes review.                      |
| `onTaskRejected`     | `{ taskId, title, reason }`                                                          | A task fails review.                       |
| `onDecision`         | `{ agentId, decision, reasoning, taskId? }`                                          | A reviewer makes a decision.               |
| `onError`            | `{ agentId, error, phaseId, taskId? }`                                               | An agent encounters an error.              |
| `onWorkflowComplete` | `{ totalDurationMs, agentCount }`                                                    | The workflow finishes successfully.        |
| `onWorkflowFailed`   | `{ error: Error, phaseId }`                                                          | The workflow throws an unhandled error.    |
| `onSidebarUpdate`    | `{ title?, indicator? }`                                                             | Sidebar UI metadata is updated.            |

#### `AgentStatusCallbacks`

| Method            | Parameter shape                                | Fired when                 |
| ----------------- | ---------------------------------------------- | -------------------------- |
| `onTurnStart`     | `{ agentId, turn }`                            | An agent turn begins.      |
| `onTurnEnd`       | `{ agentId, turn, tokens?, contentBlocks? }`   | An agent turn completes.   |
| `onToolCallStart` | `{ agentId, toolName, toolCallId, arguments }` | A tool execution starts.   |
| `onToolCallEnd`   | `{ agentId, toolName, toolCallId, isError }`   | A tool execution finishes. |

### `TurnContentBlock`

A discriminated union representing the content of an assistant turn:

| Type       | Shape                                                                | Description                      |
| ---------- | -------------------------------------------------------------------- | -------------------------------- |
| `text`     | `{ type: 'text'; text: string }`                                     | Message text from the assistant. |
| `thinking` | `{ type: 'thinking'; thinking: string; redacted?: boolean }`         | Thinking/reasoning text.         |
| `toolCall` | `{ type: 'toolCall'; id, name, arguments: Record<string, unknown> }` | Tool call with parameters.       |

`contentBlocks` is only populated when the turn's message has `role: 'assistant'`.

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

| Field               | Type             | Description                                   |
| ------------------- | ---------------- | --------------------------------------------- |
| `selectedPhaseId`   | `string \| null` | The phase whose tasks are displayed.          |
| `selectedTaskId`    | `string \| null` | The task whose agent log is shown.            |
| `selectedStepIndex` | `number \| null` | The step tab highlighted.                     |
| `userPinnedPhase`   | `boolean`        | True when the user clicked a completed phase. |
| `userPinnedStep`    | `boolean`        | True when the user clicked a specific step.   |

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
