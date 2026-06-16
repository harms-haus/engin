# Types reference

All types below are exported from the top-level `@harms-haus/engin` entry point. Where a type
is defined in a specific source file, that is noted.

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

| Field           | Type         | Description                                        |
| --------------- | ------------ | -------------------------------------------------- |
| `uid`           | `string`     | Stable key (`agentId::taskId`, or just `agentId`). |
| `agentId`       | `string`     | Agent identifier.                                  |
| `profile`       | `string`     | Profile ID used to create the agent.               |
| `phaseId`       | `string`     | Phase the agent belongs to.                        |
| `stepIndex?`    | `number`     | Step index within the task, when associated.       |
| `taskId?`       | `string`     | Associated task, if any.                           |
| `sessionId?`    | `string`     | Session identifier.                                |
| `sessionPath?`  | `string`     | Session storage path.                              |
| `active`        | `boolean`    | Whether the agent is currently running.            |
| `log`           | `LogEntry[]` | Agent log entries (capped at 500).                 |
| `toolCallCount` | `number`     | Total tool calls made.                             |
| `inputTokens`   | `number`     | Accumulated input tokens.                          |
| `outputTokens`  | `number`     | Accumulated output tokens.                         |
| `taskTitle`     | `string`     | Title of the associated task (empty if none).      |
| `completedAt?`  | `string`     | ISO timestamp when the agent completed.            |

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
  agents: Record<string, AgentEntity>; // keyed by agentKey (agentId::taskId)
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

| Field               | Type                                     | Description                                   |
| ------------------- | ---------------------------------------- | --------------------------------------------- |
| `taskPrompt`        | `string`                                 | The original task prompt.                     |
| `currentPhaseId`    | `string`                                 | Phase the workflow is currently in.           |
| `completedPhaseIds` | `string[]`                               | Phases that have finished.                    |
| `tasks`             | `Task[]`                                 | All tasks in the plan.                        |
| `workflowData`      | `Record<string, unknown>`                | Generic data bag for workflow-specific state. |
| `stats`             | `{ totalTokens; totalCost; agentCount }` | Aggregate statistics.                         |
| `spawnedAgents?`    | `PersistedAgentRecord[]`                 | Persisted records of spawned agents.          |
| `worktree?`         | `WorktreeInfo`                           | Git worktree information.                     |

## Workflow + harness option types

### `WorkflowRunOptions`

Options passed to a workflow's `run()`.

| Field                 | Type                     | Description                                      |
| --------------------- | ------------------------ | ------------------------------------------------ |
| `cwd`                 | `string`                 | Project directory to operate on.                 |
| `workDir`             | `string`                 | Directory for workflow state persistence.        |
| `maxConcurrentTasks?` | `number`                 | Maximum parallel agents (default 5).             |
| `apiKeys?`            | `Record<string, string>` | Provider → API key overrides.                    |
| `onStatus?`           | `StatusCallbacks`        | Callbacks for workflow/agent events.             |
| `verbose?`            | `boolean`                | Verbose console output instead of TUI dashboard. |
| `signal?`             | `AbortSignal`            | Abort signal for cooperative cancellation.       |
| `tracker?`            | `unknown`                | Pre-created `WorkflowStatusTracker`, if any.     |
| `worktree?`           | `WorktreeInfo`           | Git worktree information.                        |

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

## Pool types

### `RunStepTaskOptions`

| Field          | Required           | Description                            |
| -------------- | ------------------ | -------------------------------------- |
| `profilesDirs` | **Yes**            | Directories containing `.md` profiles. |
| `phaseId`      | **Yes**            | Phase identifier for status callbacks. |
| `taskId`       | **Yes**            | Unique task identifier.                |
| `title`        | **Yes**            | Human-readable task title.             |
| `stepName`     | **Yes**            | Step name (displayed in the UI).       |
| `profileId`    | **Yes**            | Profile ID to load.                    |
| `cwd`          | **Yes**            | Working directory for the agent.       |
| `prompt`       | **Yes**            | Prompt to send.                        |
| `apiKeys?`     | No                 | Provider → API key overrides.          |
| `onStatus?`    | No                 | Status callbacks.                      |
| `isReadOnly?`  | No                 | Strip write/edit (default `false`).    |
| `schema?`      | `ZodType<unknown>` | Zod schema for structured output.      |
| `signal?`      | No                 | Abort signal (checked once at start).  |

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

| Field                | Required | Description                                                                                    |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `maxConcurrentLanes` | **Yes**  | Maximum concurrent lanes (workers).                                                            |
| `profilesDirs`       | **Yes**  | Directories containing `.md` profiles.                                                         |
| `sessionBaseDir`     | **Yes**  | Base directory for persisted sessions (`{base}/{taskId}/{execCount}-{stepIndex}-{stepName}/`). |
| `cwd`                | **Yes**  | Working directory.                                                                             |
| `taskTracker`        | **Yes**  | Shared `TaskTracker` lanes claim from.                                                         |
| `getStepsForTask`    | No       | `(task) => StepDefinition[]`.                                                                  |
| `getRunnerForTask`   | No       | `(task) => TaskRunner`. Takes precedence over `getStepsForTask`.                               |
| `phaseId`            | **Yes**  | The phase this pool serves.                                                                    |
| `apiKeys?`           | No       | Provider → API key overrides.                                                                  |
| `onStatus?`          | No       | Status callbacks.                                                                              |
| `auditLog?`          | No       | Audit log.                                                                                     |
| `maxStepRetries?`    | No       | Max retries per step on rejection (default `5`).                                               |
| `laneWaitTimeoutMs?` | No       | Lane idle poll interval (default `60000`).                                                     |
| `signal?`            | No       | Abort signal.                                                                                  |

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
| `onAgentComplete`    | `{ agentId, profile, phaseId, taskId?, sessionId? }`                                 | An agent finishes its prompt.              |
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

See [Web reference → Protocol](web.md#protocol).
