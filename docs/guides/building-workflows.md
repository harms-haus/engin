# Building a new workflow

This is the primary authoring guide. By the end you will have built a complete, runnable
workflow that uses every core primitive: phase registration, single-agent sessions, a concurrent
multi-session task pool, structured output, and reviewer feedback loops.

The worked example is a brand-new workflow called **`apidoc`** that generates API reference
documentation for a codebase. It is invented for this guide — there is no preexisting workflow
by that name, and nothing here depends on any other workflow.

---

## 1. What a workflow actually is

A workflow is a TypeScript module that exports a `run` function:

```typescript
interface WorkflowModule {
  run(taskPrompt: string, options: WorkflowRunOptions): Promise<void>;
  name?: string;
  description?: string;
}
```

The default export (or the module itself) must have a `run` function. The optional `name` and
`description` fields are documentation only.

`WorkflowRunOptions` is what the engine passes in:

| Field                 | Type                     | Meaning                                                                                                                                                |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cwd`                 | `string`                 | Working directory. For git-repo runs this is the **main worktree path**, not the original cwd.                                                         |
| `workDir`             | `string`                 | Directory for workflow state persistence.                                                                                                              |
| `maxConcurrentTasks?` | `number`                 | Max concurrent tasks (default `5`).                                                                                                                    |
| `apiKeys?`            | `Record<string, string>` | Provider → API key overrides.                                                                                                                          |
| `onStatus?`           | `StatusCallbacks`        | The engine's wired-up status callbacks. **Use this.**                                                                                                  |
| `verbose?`            | `boolean`                | True when running with verbose console output.                                                                                                         |
| `signal?`             | `AbortSignal`            | Cooperative cancellation signal.                                                                                                                       |
| `eventStore?`         | `EventStore`             | Shared event store so workflows can read projection state for resume / `workflowData`.                                                                 |
| `worktree?`           | `WorktreeInfo`           | Main worktree info (git-repo runs only).                                                                                                               |
| `worktreeManager?`    | `WorktreeManager`        | Per-run worktree manager. Forward to `runSession` / `SessionScheduler` for per-task worktrees.                                                         |
| `rendererRegistry?`   | `RendererRegistry`       | Optional registry of per-profile output renderers.                                                                                                     |
| `hookRegistry?`       | `HookRegistry`           | The engine-assembled hook registry. Forward to `SessionScheduler` / `runSession` to activate scheduler/session hooks (see [§11](#11-authoring-hooks)). |

That's the whole contract. Everything else — phases, tasks, steps, agents — is your workflow's
internal structure, communicated to the engine purely through `options.onStatus`.

---

## 2. The mental model: phases → tasks → sessions

engin enforces a rigid hierarchy (see [Overview → The rigid hierarchy](../concepts/overview.md)):

- A **workflow** owns ordered **phases**. Phases run one at a time; each must finish before the
  next starts.
- A **phase** owns **tasks**. Within a phase, tasks can run one at a time or concurrently.
- A **task** is fulfilled by a **runner** — a composable function that orchestrates one or
  more agent **sessions**.
- A **session** is one agent prompt turn. Every session has a deterministic id, a profile, a
  runner role (e.g. `execute`, `review`), and an attempt number.

You orchestrate this hierarchy with two primitives:

1. **`runSession`** — runs one agent session as a single-task.
   Best for phases that need a single agent (a scout, a planner, a summariser).
2. **`SessionScheduler`** — drives a `TaskGraph` of many tasks concurrently through a `SessionGate`, each through its own runner tree built from composable runners (`singleSession`, `reviewRunner`, `linearRunner`, etc.). Best for phases that fan out across independent units of work.

Both fire the full lifecycle (`onTaskRegister` → `onTaskStart` → `onSessionStart` → run →
`onSessionComplete` → `onTaskComplete`) for you. You never emit those events manually.

---

## 3. Where the workflow lives

A workflow is a directory containing a `main.ts` entry point, discovered by name from the
config directories:

- **Global:** `~/.config/engin/workflows/<name>/main.ts`
- **Local:** `{cwd}/.engin/workflows/<name>/main.ts`

The directory name is the workflow name. Local overrides global on a name collision. Hidden
directories (starting with `.`) are skipped during discovery.

```
~/.config/engin/workflows/apidoc/
├── main.ts          ← required entry point
├── profiles/        ← agent profiles for this workflow
│   ├── scout.md
│   ├── outliner.md
│   ├── writer.md
│   └── reviewer.md
├── package.json     ← optional
└── bunfig.toml      ← optional
```

Each workflow directory is loaded natively by the Bun runtime — no extra loader or transpile
step. Your `main.ts` imports the engine primitives from `@harms-haus/engin-engine` and from
`zod`:

```typescript
import type { WorkflowModule, WorkflowRunOptions } from '@harms-haus/engin-engine';
```

### Name validation

Workflow names cannot contain `/`, `\`, or `..`. The loader (`validateWorkflowName`) throws
on anything else, which prevents path-traversal attacks. The same rule applies to task IDs and
step names used in file paths — keep them to `[A-Za-z0-9_-]`.

---

## 4. The `onStatus` callback

The engine wires `options.onStatus` to the canonical event store for you. It is a
`StatusCallbacks` object — a bag of optional methods. The two you will call most often while
authoring are the phase lifecycle hooks:

| Method            | Parameter shape         | When to call                                            |
| ----------------- | ----------------------- | ------------------------------------------------------- |
| `onPhaseRegister` | `{ id, label, icon }`   | Once per phase, at startup, **before** any work begins. |
| `onPhaseStart`    | `{ phase, round }`      | When a phase begins executing.                          |
| `onPhaseComplete` | `{ phase, durationMs }` | When a phase finishes.                                  |

Registering phases up front lets the TUI and web client render the full phase bar before any
agent has run. The other callbacks (`onTaskRegister`, `onTaskStart`, `onAgentSpawn`,
`onStepStart`, `onAgentComplete`, `onTaskComplete`, `onTaskRejected`, …) are fired for you by
`runSession` and the `SessionScheduler`. You generally do not call them directly.

> Always guard with `?.`: `options.onStatus?.onPhaseRegister?.(...)`. The field is optional and
> individual methods are optional.

For the complete callback surface, see
[Types reference → `StatusCallbacks`](../reference/types.md#statuscallbacks).

---

## 5. Primitive 1 — single-session tasks with `runSession`

`runSession(ctx: RunSessionContext)` is the single-step session primitive. It runs one agent
session, handles idempotency caching, prompt delivery, response parsing and persistence, and
fires `onSessionStart` / `onSessionComplete` lifecycle callbacks.

It accepts a **session spec** (`SessionSpec`) that defines the agent profile, prompt, output
mode, and optional Zod schema for structured output. The return value is a `SessionResult`
discriminated union:

| Mode (`outputMode`) | Result shape                    | When to use                                 |
| ------------------- | ------------------------------- | ------------------------------------------- |
| `'structured'`      | `{ mode: 'structured', data }`  | Schema-validated JSON from the agent.       |
| `'text'`            | `{ mode: 'text', text }`        | Free-form assistant text (no schema).       |
| `'filesystem'`      | `{ mode: 'filesystem', files }` | Agent writes files to disk during the turn. |

Here is a complete, runnable workflow that scouts a codebase and prints the result:

```typescript
// ~/.config/engin/workflows/apidoc/main.ts
import {
  loadProfilesFromDirs,
  resolveProfilesDirs,
  runSession,
  type SessionSpec,
  type WorkflowModule,
  type WorkflowRunOptions,
} from '@harms-haus/engin-engine';
import { z } from 'zod';

const ScoutSchema = z.object({
  summary: z.string().describe('A one-paragraph summary of the codebase'),
  files: z.array(z.string()).describe('Public entry-point files worth documenting'),
});

export async function run(taskPrompt: string, options: WorkflowRunOptions) {
  const { cwd, workDir, onStatus } = options;
  const profilesDirs = resolveProfilesDirs(cwd, 'apidoc');

  onStatus?.onPhaseRegister?.({ id: 'scouting', label: 'Scouting', icon: '🔍' });
  onStatus?.onPhaseStart?.({ phase: 'scouting', round: 0 });

  // 1. Load profiles from disk.
  const profiles = await loadProfilesFromDirs(profilesDirs);

  // 2. Build the session spec.
  const spec: SessionSpec = {
    id: 'scout',
    profile: 'scout',
    prompt: `${taskPrompt}\n\nIdentify the public entry points worth documenting.`,
    schema: ScoutSchema,
    outputMode: 'structured',
    isReadOnly: true,
    runnerRole: 'scout',
    attempt: 1,
  };

  // 3. Call the session primitive.
  const result = await runSession({
    spec,
    sessionBaseDir: `${workDir}/sessions`,
    cwd,
    profiles,
    phaseId: 'scouting',
    agentId: 'scout',
    taskId: 'scout',
    onStatus,
    activeSessions: new Set(),
  });

  onStatus?.onPhaseComplete?.({ phase: 'scouting', durationMs: 0 });

  if (result.mode === 'structured') {
    const data = result.data as z.infer<typeof ScoutSchema>;
    console.log('Scout summary:', data.summary);
    console.log('Files:', data.files);
  }
}

const module: WorkflowModule = { run, name: 'apidoc', description: 'Generate API docs' };
export default module;
```

### `RunSessionContext` reference

| Field                 | Required | Description                                                                                                                                                                                     |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec`                | **Yes**  | The `SessionSpec` describing the session to run (`id`, `profile`, `prompt`, `schema?`, `outputMode`, `isReadOnly?`, `runnerRole`, `attempt`). See below.                                        |
| `sessionBaseDir`      | **Yes**  | Base directory for persisted session state (`{sessionBaseDir}/{spec.id}/`).                                                                                                                     |
| `cwd`                 | **Yes**  | Working directory for agent operations.                                                                                                                                                         |
| `profiles`            | **Yes**  | Resolved agent profiles keyed by profile id (`Map<string, AgentProfile>`). Load with `loadProfilesFromDirs(dirs)`.                                                                              |
| `phaseId`             | **Yes**  | Phase identifier propagated to lifecycle callbacks.                                                                                                                                             |
| `agentId`             | **Yes**  | Agent identifier propagated to lifecycle callbacks.                                                                                                                                             |
| `activeSessions`      | **Yes**  | Mutable `Set<{ abort(): Promise<void> }>` of in-flight sessions for cooperative abort.                                                                                                          |
| `worktreeCwd?`        | No       | Per-task worktree path. When set, `cwd` falls back to this. `undefined` when no worktree is in use.                                                                                             |
| `taskId?`             | No       | Owning task id propagated to callbacks. Optional because some meta-sessions are genuinely task-less.                                                                                            |
| `apiKeys?`            | No       | Provider → API key overrides.                                                                                                                                                                   |
| `onStatus?`           | No       | Status callbacks (`onSessionStart` / `onSessionComplete` / agent-status forwarding).                                                                                                            |
| `signal?`             | No       | Abort signal. Checked once at the start.                                                                                                                                                        |
| `watchdogTimeoutMs?`  | No       | Activity-based idle timer (ms). When positive, the session is aborted if no activity events are received within this window.                                                                    |
| `watchdogMaxResumes?` | No       | Max watchdog-triggered resumes before error becomes permanent. When set alongside `watchdogTimeoutMs`, `runSession` internally retries up to this many times before throwing a permanent error. |

### `SessionSpec` fields

The `spec` field of `RunSessionContext` is a `SessionSpec`:

| Field         | Required | Description                                                                                                                              |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | **Yes**  | Unique session identifier (also used as the task id for session persistence). Validated against path traversal.                          |
| `profile`     | **Yes**  | Agent profile id (resolved against `profiles` map).                                                                                      |
| `prompt`      | **Yes**  | The prompt text sent to the agent.                                                                                                       |
| `outputMode`  | **Yes**  | `'text'` \| `'structured'` \| `'filesystem'`. Determines how the response is interpreted.                                                |
| `runnerRole`  | **Yes**  | Role label (e.g. `'executor'`, `'reviewer'`). Propagated to lifecycle callbacks.                                                         |
| `attempt`     | **Yes**  | 1-based attempt number (for multi-retry workflows).                                                                                      |
| `schema?`     | No       | Zod schema for structured output. Required when `outputMode === 'structured'`.                                                           |
| `isReadOnly?` | No       | When true, `write`/`edit` are stripped from the agent's toolset (default `false`).                                                       |
| `resume?`     | No       | When true, resume an existing session (continue conversation with `prompt`) instead of creating a fresh one. Bypasses idempotency cache. |

Lifecycle: abort check → idempotency cache read → `onSessionStart` → prompt execution (text / structured / filesystem) → result persistence → `onSessionComplete`.

> **Important.** Unlike the legacy step runner, `runSession` fires **only** `onSessionStart`
> and `onSessionComplete` — not `onTaskRegister`, `onTaskStart`, or `onAgentSpawn`. Those
> events are the responsibility of the higher-level `SessionScheduler` or runner that wraps
> the session primitive. For most workflows, consider using the `SessionScheduler` with a
> `singleSession` runner factory (see [§6](#6-primitive-2--concurrent-tasks-with-sessionscheduler))
> which fires the full task lifecycle for you.

> **Abort semantics.** `runSession` checks `signal.aborted` exactly once, before any callbacks
> fire. It does not register an abort listener or forward the signal downstream. Use it for
> "should we even start?" checks; for mid-run cancellation rely on the surrounding
> `SessionScheduler`/CLI flow.

---

## 6. Primitive 2 — concurrent tasks with `SessionScheduler`

A `SessionScheduler` drives a `TaskGraph` (a task DAG with status tracking and
dependency-pressure ranking) through a `SessionGate` (two-level: total + per-model caps)
using a greedy, tiered drain loop. Each task is fulfilled by a **runner** — an async
generator (`SessionPlanRunner`) that yields batches of `SessionSpec`s. This is what you
reach for when a phase fans out across many independent units of work.

Each task carries a `phaseId` and a list of `dependencies` (other task IDs that must
complete first). The graph performs Kahn's-algorithm cycle detection at `addTask` time
and serves ready tasks sorted **descending by blocking pressure** (transitive dependent
count). Unlike a coroutine-per-task pool, the scheduler **owns the gate directly**: it
acquires a slot before executing a session and releases it on settle. Runners are pure
generators that never touch the gate.

Three steps are the workflow's responsibility (the scheduler does not do them for you):

1. Build the `TaskGraph`, adding each task with its `SessionPlanFactory`.
2. Load profiles and construct the `SessionGate`.
3. Construct and run the `SessionScheduler`.

### Composable runners

Runners are built by composing factory functions from
`@harms-haus/engin-engine`. Each returns a `SessionPlanFactory` (a
`() => SessionPlanRunner`) that the scheduler invokes once, lazily, when the task
becomes active:

| Runner                       | Purpose                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `singleSession`              | Run exactly one session. The basic building block.                       |
| `linearRunner`               | Run children sequentially; short-circuit on first failure.               |
| `reviewRunner`               | Execute→review loop with approve/reject feedback (up to N rounds).       |
| `councilRunner`              | Run workers in parallel, then synthesise their outputs.                  |
| `parallelRunner`             | Run arbitrary child runners in parallel.                                 |
| `mapRunner`                  | Fan out over a collection, one session per item.                         |
| `branchRunner`               | Select one child runner based on task conditions.                        |
| `coordinatorRunner`          | Run a coordinator session, then delegate to children via a factory.      |
| `coalescingRunner`           | Coordinator → children → coordinator loop (dynamic rounds).              |
| `retrospectiveCouncilRunner` | Convener → parallel members → retrospective loop (iterative fix rounds). |

> **`linearRunner` / `parallelRunner` take runner instances, not factories.** They expect
> `SessionPlanRunner[]`, so you invoke the factory inline: `singleSession(spec)()`,
> `reviewRunner(a, b)()`. This mirrors the bundled `spir` implementation (see Runner trees
> below).

A **session spec** (`SessionSpec`) defines one session: `profile`, `prompt`, optional
`schema` (Zod), `outputMode` (`'text'` | `'structured'` | `'filesystem'`), `isReadOnly`,
`runnerRole`, and `attempt`. The session `id` is assigned deterministically at run time
from the task id and role (e.g. `${taskId}/execute`).

Here is the shape you will use for the `apidoc` writing phase:

```typescript
import {
  SessionScheduler,
  SessionGate,
  TaskGraph,
  loadProfilesFromDirs,
  reviewRunner,
  type SessionPlanFactory,
  type SessionSpec,
  type Task,
} from '@harms-haus/engin-engine';
import { z } from 'zod';

const ReviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});

// A SessionRoleSpec is a SessionSpec minus the deterministic id/attempt/runnerRole,
// plus a `role` label that drives session-id derivation.
type SessionRoleSpec = Omit<SessionSpec, 'id' | 'attempt' | 'runnerRole'> & { role: string };

// ...inside run(), for the 'writing' phase:
onStatus?.onPhaseStart?.({ phase: 'writing', round: 0 });

// 1. Build the task graph — each task carries its own runner factory.
const graph = new TaskGraph();
const reviewSpec: SessionRoleSpec = {
  role: 'review',
  profile: 'reviewer',
  prompt: 'Review the drafted documentation page for accuracy and clarity.',
  schema: ReviewSchema,
  outputMode: 'structured',
  isReadOnly: true,
};

for (const page of outline.pages) {
  const writeSpec: SessionRoleSpec = {
    role: 'draft',
    profile: 'writer',
    prompt: page.prompt,
    outputMode: 'filesystem',
    isReadOnly: false,
  };
  // The factory is stored on the graph entry; the scheduler constructs a
  // fresh SessionPlanRunner from it when the task becomes active.
  const runnerFactory: SessionPlanFactory = reviewRunner(writeSpec, reviewSpec, {
    maxRounds: 5,
  });
  graph.addTask(
    {
      id: page.id,
      title: page.title,
      profile: 'writer',
      files: [page.sourceFile],
      dependencies: [],
      prompt: page.prompt,
      phaseId: 'writing',
      status: 'ready',
    },
    runnerFactory,
  );
}

// 2. Load profiles and construct the gate.
const profiles = await loadProfilesFromDirs(profilesDirs);
const gate = new SessionGate({
  total: options.maxConcurrentTasks ?? 5,
  perModel: {},
});
const activeSessions = new Set<{ abort(): Promise<void> }>();

// 3. Construct and run the scheduler.
const scheduler = new SessionScheduler({
  graph,
  gate,
  profiles,
  sessionBaseDir: `${options.workDir}/sessions`,
  cwd: options.cwd,
  phaseId: 'writing',
  onStatus: options.onStatus,
  hookRegistry: options.hookRegistry,
  activeSessions,
  ...(options.worktreeManager !== undefined ? { worktreeManager: options.worktreeManager } : {}),
});

const result = await scheduler.run();
onStatus?.onPhaseComplete?.({ phase: 'writing', durationMs: 0 });
console.log(`Drafted ${result.completedTasks} pages; ${result.failedTasks} failed.`);
```

### Runner trees

Runners compose into trees. A task's factory is typically built from multiple composable
factories chained together. For example, the bundled `spir` implementation phase builds
this tree for code tasks:

```typescript
import { linearRunner, reviewRunner, singleSession } from '@harms-haus/engin-engine';

// Code task: write tests first, then run implement→review loop.
// linearRunner takes SessionPlanRunner[], so the factories are invoked inline.
const runnerFactory = linearRunner([
  singleSession(writeTestsSpec)(), // write tests
  reviewRunner(implSpec, reviewSpec)(), // implement → review loop
]);
```

For non-code tasks, the test-writer step is omitted:

```typescript
const runnerFactory = reviewRunner(implSpec, reviewSpec);
```

Each task's factory is passed to `graph.addTask(task, runnerFactory)`. You can also use the
`beforeTask` hook to provide a runner dynamically at claim time (see
[§11](#11-authoring-hooks)).

### How `SessionScheduler` processes a task

The scheduler runs a greedy, tiered drain loop:

- **T1 (active affinity)** — continue specs in an active task's held batch.
- **T2 (parked)** — resume parked tasks whose pending specs now fit gate capacity.
- **T3 (ready)** — initialize the runner + first batch, then start the first spec.

For each task that transitions to active, the scheduler:

1. Fires `onTaskStart` (via the graph's `onStatusTransition` callback).
2. Resolves the runner factory from the graph entry (or via the `beforeTask` hook if it
   returns `{ runner }`).
3. Calls `runner.plan(ctx)` to obtain the async generator, then `gen.next()` for the first
   batch of `SessionSpec`s.
4. For each spec in the batch, acquires a gate slot (`gate.acquire`), then calls
   `runner.execute(ctx, spec)` to run the agent. Specs that can't acquire a slot **park**
   the task (status `'parked'`); already-started siblings keep running.
5. Once the entire batch settles, feeds `SessionResult[]` back via `gen.next(results)` to
   advance the generator and receive the next batch.
6. Optionally creates a per-task worktree (when `worktreeManager` is forwarded and the task's
   `worktree` field is set) — squash-merged into the main worktree branch on success.
7. On terminal status (`complete` / `failed` / `cancelled`): fires the corresponding
   `onTaskComplete` / `onTaskRejected` event.

> **SessionGate.** The scheduler acquires/releases slots via `gate.acquire(profile)` /
> `gate.release(profile)` (RAII). The gate holds a total + per-model slot for the duration
> of each `execute()` call. Sessions from different tasks interleave through the shared
> gate; there are no fixed lanes.

> **Batch atomicity.** A batch (one `yield` from the generator) is atomic: the scheduler
> does not call `gen.next(results)` until every spec in the held batch has settled. This is
> how `reviewRunner` sequences its execute→review rounds.

### `SessionSchedulerOptions` reference

| Field               | Required | Description                                                                                                                                |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `graph`             | **Yes**  | The `TaskGraph` DAG with status tracking + blocking-pressure ranking.                                                                      |
| `gate`              | **Yes**  | Two-level `SessionGate` (total + per-model). Construct it yourself: `new SessionGate({ total, perModel })`.                                |
| `profiles`          | **Yes**  | Resolved agent profiles keyed by profile id. Load with `loadProfilesFromDirs(dirs)` → `Map<string, AgentProfile>`.                         |
| `sessionBaseDir`    | **Yes**  | Base directory for persisted sessions.                                                                                                     |
| `cwd`               | **Yes**  | Working directory for agent operations.                                                                                                    |
| `phaseId`           | **Yes**  | The phase this scheduler serves. Propagated to every callback.                                                                             |
| `activeSessions`    | **Yes**  | Mutable `Set<{ abort() }>` of in-flight sessions for cooperative abort.                                                                    |
| `onStatus?`         | No       | Status callbacks.                                                                                                                          |
| `apiKeys?`          | No       | Provider → API key overrides.                                                                                                              |
| `auditLog?`         | No       | Audit log for events.                                                                                                                      |
| `stepTimeoutMs?`    | No       | Per-session execute watchdog timeout (ms). Defaults to `300_000` (5 min).                                                                  |
| `signal?`           | No       | Abort signal. Aborts active sessions + cancels remaining tasks.                                                                            |
| `rendererRegistry?` | No       | Optional per-profile output renderers.                                                                                                     |
| `hookRegistry?`     | No       | Registry of workflow hooks. Forward `options.hookRegistry` to activate `beforeTask` / observe hooks.                                       |
| `worktreeManager?`  | No       | Per-run worktree manager. When set, each task with `worktree: 'code'` gets its own worktree (squash-merged on success, culled on failure). |

`scheduler.run()` returns `{ completedTasks: number; failedTasks: number }`.

> **When there is nothing to do.** If the graph has no tasks, `scheduler.run()` returns
> `{ completedTasks: 0, failedTasks: 0 }` **without loading profiles or starting the drain
> loop**.

> **Concurrency is on the gate, not the scheduler.** The scheduler takes no
> `maxConcurrentTasks` or `modelConcurrency` options — those live on the `SessionGate`
> you construct and pass in. Map `options.maxConcurrentTasks ??
config.defaultMaxConcurrentTasks` into `gate.total`, and use `gate.perModel` for
> per-model caps. See [Task pool & execution](../reference/task-pool.md) for the full
> `SessionGate` / `TaskGraph` / `SessionPlanRunner` reference.

---

## 7. Structured output with Zod

Both `runSession` and the session primitive accept a `schema` (on `SessionSpec` or
`SessionSpec`). When provided:

- The schema is turned into a human-readable description and appended to the prompt
  (`schemaToString`), so the model knows the exact shape to produce.
- The response is parsed with `extractJsonFromText` (fenced ```json blocks first, then bracket
counting with string/escape awareness), repaired with `parseJsonWithRepair`, and validated
with `schema.safeParse`.
- On failure, the prompt is rebuilt from scratch with the latest error and retried. The default
  is **3 attempts** for `runSession` and for a session's first try.

Define your schemas with `.describe()` on each field — those descriptions become part of the
prompt and materially improve output quality:

```typescript
const PlanSchema = z.object({
  pages: z.array(
    z.object({
      id: z.string().describe('Stable kebab-case id, e.g. "create-user"'),
      title: z.string().describe('Human-readable page title'),
      sourceFile: z.string().describe('Path to the source file this page documents'),
      outline: z.array(z.string()).describe('Section headings to cover'),
    }),
  );
});
```

For reviewer sessions, include an `approved: boolean` and a `feedback: string` field —
these are the defaults `reviewRunner` looks for when deciding whether to re-run the execute
session. The runner feeds `feedback` back into the execute prompt on the next round.

---

## 8. The complete worked example: `apidoc`

We now have every primitive. Let's assemble the full workflow. `apidoc` generates API reference
documentation in four phases:

1. **Scout** (single agent) — read the codebase, produce a summary and a list of public files.
2. **Outline** (single agent) — turn the scout result into a list of doc pages to write.
3. **Write** (`SessionScheduler`, multi-session) — for each page, draft it then have a reviewer approve it.
4. **Summarise** (single agent) — produce a top-level index from the drafted pages.

### 8.1 The profiles

Create four profiles under `~/.config/engin/workflows/apidoc/profiles/`:

```markdown
## <!-- scout.md -->

name: Scout
provider: your-provider
model: your-model
thinkingLevel: medium
excludeTools:

- write
- edit

---

You are a Scout. Read the codebase and identify the public entry points worth
documenting. Respond with JSON: { "summary": string, "files": string[] }.
Be precise about file paths.
```

```markdown
## <!-- outliner.md -->

name: Outliner
provider: your-provider
model: your-model
thinkingLevel: high
excludeTools:

- write
- edit

---

You are a documentation Outliner. Given a codebase summary and a list of files,
decide which documentation pages to produce. Group related exports; one page per
coherent concept. Respond with JSON matching the provided schema.
```

```markdown
## <!-- writer.md -->

name: Writer
provider: your-provider
model: your-model
thinkingLevel: medium

---

You are a documentation Writer. Produce clear, accurate reference docs for the
assigned source file. Use the project's existing doc style. Write the page to
the path given in the task. Include runnable examples where helpful.
```

```markdown
## <!-- reviewer.md -->

name: Reviewer
provider: your-provider
model: your-model
thinkingLevel: high
excludeTools:

- write
- edit

---

You are a documentation Reviewer. Check the drafted page for accuracy,
completeness, and clarity. Verify code examples are correct. Respond with JSON:
{ "approved": boolean, "feedback": string, "severity": "critical"|"high"|"medium"|"low" }.
Set approved=true only if the page is ready to ship.
```

### 8.2 The full `main.ts`

```typescript
// ~/.config/engin/workflows/apidoc/main.ts
import {
  SessionScheduler,
  SessionGate,
  TaskGraph,
  loadProfilesFromDirs,
  resolveProfilesDirs,
  runSession,
  reviewRunner,
  type SessionPlanFactory,
  type SessionSpec,
  type SessionResult,
  type WorkflowModule,
  type WorkflowRunOptions,
} from '@harms-haus/engin-engine';
import { z } from 'zod';

// ── Schemas ────────────────────────────────────────────────────────────────

const ScoutSchema = z.object({
  summary: z.string().describe('One-paragraph codebase summary'),
  files: z.array(z.string()).describe('Public entry-point files worth documenting'),
});

const OutlineSchema = z.object({
  pages: z.array(
    z.object({
      id: z.string().describe('Stable kebab-case id'),
      title: z.string().describe('Human-readable page title'),
      sourceFile: z.string().describe('Path to the source file this page documents'),
      outputFile: z.string().describe('Path to write the doc page to, e.g. docs/api/create-user.md'),
      outline: z.array(z.string()).describe('Section headings to cover'),
    }),
  );
});

const ReviewSchema = z.object({
  approved: z.boolean().describe('True only if the page is ready to ship'),
  feedback: z.string().describe('Concrete, actionable feedback if not approved'),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});

const IndexSchema = z.object({
  indexPath: z.string().describe('Path where the index was written'),
  pageCount: z.number(),
});

// ── The workflow ───────────────────────────────────────────────────────────

export async function run(taskPrompt: string, options: WorkflowRunOptions) {
  const { cwd, workDir, onStatus } = options;
  const profilesDirs = resolveProfilesDirs(cwd, 'apidoc');

  // Register every phase up front so the UI can render the phase bar.
  onStatus?.onPhaseRegister?.({ id: 'scouting', label: 'Scout', icon: '🔍' });
  onStatus?.onPhaseRegister?.({ id: 'outlining', label: 'Outline', icon: '🗂️' });
  onStatus?.onPhaseRegister?.({ id: 'writing', label: 'Write', icon: '✍️' });
  onStatus?.onPhaseRegister?.({ id: 'indexing', label: 'Index', icon: '📚' });

  // Load profiles once and reuse across all phases.
  const profiles = await loadProfilesFromDirs(profilesDirs);
  const activeSessions = new Set<{ abort(): Promise<void> }>();

  // ── Phase 1: Scout ──────────────────────────────────────────────────────
  onStatus?.onPhaseStart?.({ phase: 'scouting', round: 0 });

  const scoutSpec: SessionSpec = {
    id: 'scout',
    profile: 'scout',
    prompt: `${taskPrompt}\n\nIdentify the public entry points worth documenting.`,
    schema: ScoutSchema,
    outputMode: 'structured',
    isReadOnly: true,
    runnerRole: 'scout',
    attempt: 1,
  };

  const scoutResult: SessionResult = await runSession({
    spec: scoutSpec,
    sessionBaseDir: `${workDir}/sessions`,
    cwd,
    profiles,
    phaseId: 'scouting',
    agentId: 'scout',
    taskId: 'scout',
    onStatus,
    activeSessions,
  });

  if (scoutResult.mode !== 'structured') throw new Error('Scout phase failed');
  const scout = scoutResult.data as z.infer<typeof ScoutSchema>;
  onStatus?.onPhaseComplete?.({ phase: 'scouting', durationMs: 0 });

  // ── Phase 2: Outline ────────────────────────────────────────────────────
  onStatus?.onPhaseStart?.({ phase: 'outlining', round: 0 });

  const outlineSpec: SessionSpec = {
    id: 'outliner',
    profile: 'outliner',
    prompt: [
      'Codebase summary:',
      scout.summary,
      '',
      'Files:',
      scout.files.map((f) => `- ${f}`).join('\n'),
      '',
      'Decide which documentation pages to produce.',
    ].join('\n'),
    schema: OutlineSchema,
    outputMode: 'structured',
    isReadOnly: true,
    runnerRole: 'outliner',
    attempt: 1,
  };

  const outlineResult: SessionResult = await runSession({
    spec: outlineSpec,
    sessionBaseDir: `${workDir}/sessions`,
    cwd,
    profiles,
    phaseId: 'outlining',
    agentId: 'outliner',
    taskId: 'outliner',
    onStatus,
    activeSessions,
  });

  if (outlineResult.mode !== 'structured') throw new Error('Outline phase failed');
  const outline = outlineResult.data as z.infer<typeof OutlineSchema>;
  onStatus?.onPhaseComplete?.({ phase: 'outlining', durationMs: 0 });

  if (outline.pages.length === 0) {
    console.log('Nothing to document.');
    return;
  }

  // ── Phase 3: Write (SessionScheduler, draft → review per page) ─────────
  onStatus?.onPhaseStart?.({ phase: 'writing', round: 0 });

  // A SessionRoleSpec is a SessionSpec minus the deterministic id/attempt/runnerRole,
  // plus a `role` label that drives session-id derivation.
  type SessionRoleSpec = Omit<SessionSpec, 'id' | 'attempt' | 'runnerRole'> & {
    role: string;
  };

  // Shared review spec (read-only, structured verdict).
  const reviewSpec: SessionRoleSpec = {
    role: 'review',
    profile: 'reviewer',
    prompt: 'Review the drafted documentation page for accuracy and clarity.',
    schema: ReviewSchema,
    outputMode: 'structured',
    isReadOnly: true,
  };

  // 1. Build the task graph — each page gets its own runner factory.
  const graph = new TaskGraph();
  for (const page of outline.pages) {
    const pagePrompt = [
      `Write the documentation page "${page.title}".`,
      `Source file: ${page.sourceFile}`,
      `Write the page to: ${page.outputFile}`,
      '',
      'Cover these sections:',
      page.outline.map((s) => `- ${s}`).join('\n'),
    ].join('\n');

    const draftSpec: SessionRoleSpec = {
      role: 'draft',
      profile: 'writer',
      prompt: pagePrompt,
      outputMode: 'filesystem',
      isReadOnly: false,
    };

    // Each page uses a draft → review loop (up to 5 rounds).
    const runnerFactory: SessionPlanFactory = reviewRunner(draftSpec, reviewSpec, {
      maxRounds: 5,
    });
    graph.addTask(
      {
        id: page.id,
        phaseId: 'writing',
        title: page.title,
        profile: 'writer',
        files: [page.sourceFile],
        dependencies: [],
        prompt: pagePrompt,
        status: 'ready',
      },
      runnerFactory,
    );
  }

  // 2. Load profiles and construct the gate.
  const gate = new SessionGate({
    total: options.maxConcurrentTasks ?? 5,
    perModel: {},
  });

  // 3. Construct and run the scheduler.
  const scheduler = new SessionScheduler({
    graph,
    gate,
    profiles,
    sessionBaseDir: `${workDir}/sessions`,
    cwd,
    phaseId: 'writing',
    onStatus,
    hookRegistry: options.hookRegistry,
    activeSessions,
    ...(options.worktreeManager !== undefined
      ? { worktreeManager: options.worktreeManager }
      : {}),
  });

  const result = await scheduler.run();
  onStatus?.onPhaseComplete?.({ phase: 'writing', durationMs: 0 });
  console.log(`Pages drafted: ${result.completedTasks}, failed: ${result.failedTasks}`);

  // ── Phase 4: Index ──────────────────────────────────────────────────────
  onStatus?.onPhaseStart?.({ phase: 'indexing', round: 0 });

  const indexSpec: SessionSpec = {
    id: 'indexer',
    profile: 'writer',
    prompt: [
      'Generate a top-level index page for the following documentation pages.',
      'Write it to docs/api/README.md.',
      '',
      ...outline.pages.map((p, i) => `${i + 1}. ${p.title} → ${p.outputFile}`),
    ].join('\n'),
    schema: IndexSchema,
    outputMode: 'structured',
    isReadOnly: true,
    runnerRole: 'indexer',
    attempt: 1,
  };

  await runSession({
    spec: indexSpec,
    sessionBaseDir: `${workDir}/sessions`,
    cwd,
    profiles,
    phaseId: 'indexing',
    agentId: 'indexer',
    taskId: 'indexer',
    onStatus,
    activeSessions,
  });

  onStatus?.onPhaseComplete?.({ phase: 'indexing', durationMs: 0 });
}

const module: WorkflowModule = {
  run,
  name: 'apidoc',
  description: 'Generate API reference documentation for a codebase',
};
export default module;
```

### 8.3 Run it

```bash
engin apidoc "Document the public API of this library"
```

In a TTY you will get the live dashboard: a phase bar (Scout → Outline → Write → Index), a task
list for the current phase, and an agent log with a session tab bar. Open the printed URL on your
phone to watch the same view in a browser.

### 8.4 What you can observe

- During **Scout** and **Outline**, a single task appears with one session. The agent log shows
  its turns, tool calls (reads of source files), and token usage.
- During **Write**, a task appears per page (up to `gate.total` at once, sorted
  descending by blocking pressure). Each task runs a draft → review loop. When a reviewer rejects,
  you will see an `onDecision` line in the log and the `draft` session re-run with the feedback
  appended. The session tab bar at the bottom of the agent log lets you cycle between the draft
  and review sessions (Tab / Shift+Tab in the TUI).
- After `maxRounds` rejections, the page fails. (The scheduler does not retry tasks itself —
  if you want retries, re-queue failed tasks into a new scheduler run.)

---

## 9. Worktrees

When the run's `cwd` is a git repository, engin runs the workflow inside a tree of git
worktrees — there is no opt-in flag. This is transparent to most workflows, but a few
things are worth knowing. See the [Worktrees reference](../reference/worktrees.md) for the
full system.

### `options.cwd` is the worktree path

For git-repo runs, the engine sets `options.cwd` to the **main worktree path**
(`.engin/work/{run-id}/worktree`), not the original cwd. Everything your workflow does
relative to `cwd` — reading source, writing output, the agents' `write`/`edit` tools —
lands inside the worktree, so concurrent runs and concurrent tasks never collide on the
real working tree. You do not need to change anything: code that resolves paths relative
to `options.cwd` keeps working unchanged.

For non-git runs, `options.cwd` is the original cwd and no worktrees are created.

### Forward `options.worktreeManager` for per-task isolation

The main worktree hosts the accumulated result; each task gets its **own** worktree on
`engin/{mainSlug}--{taskId}` so concurrent tasks never trip over each other. To opt a task
into per-task isolation, forward `options.worktreeManager` to the `SessionScheduler`:

```typescript
const scheduler = new SessionScheduler({
  graph,
  gate,
  profiles,
  sessionBaseDir: `${workDir}/sessions`,
  cwd,
  phaseId: 'writing',
  onStatus,
  hookRegistry: options.hookRegistry,
  activeSessions,
  worktreeManager: options.worktreeManager, // ← enables per-task worktrees
});
```

> **Note on `SessionScheduler`.** When you forward `options.worktreeManager` to a
> `SessionScheduler`, each task whose `task.worktree === 'code'` gets its own worktree
> (created via `worktreeManager.createTaskWorktree`, squash-merged on success, culled on
> failure). Tasks that are read-only or non-code run against the main worktree `cwd` directly.

When `worktreeManager` is present, the primitive:

1. Creates a per-task worktree off the main-wt branch (so the task inherits
   already-merged sibling work).
2. Runs the agent with `cwd` pointed at the task worktree.
3. On success, commits and **squash-merges** the task branch into the main-wt branch
   (serialized across all concurrent tasks), then culls the task worktree + branch.
4. On failure, force-culls the task worktree.

Results a task returns are also automatically **relativized** against the worktree roots
(the task worktree path and the main worktree path), so any absolute worktree paths the
agent emits in its output — for example a `file` field in a structured result — become
repo-relative before the result reaches downstream phases. No action needed on your part.

When `worktreeManager` is absent (the non-git fallback, or a workflow that does not
forward it), tasks run against `cwd` directly with no per-task isolation.

### `.worktreecopy` — populating worktrees with ignored files

A worktree is a fresh checkout — it does **not** inherit `.gitignore`d files like `.env`,
`.npmrc`, or `node_modules`. Put a `.worktreecopy` file at the repo root to tell engin
which ignored files each worktree needs. It uses `.gitignore`-like syntax with two modes:

```
# .worktreecopy
.env
.env.local
!.env.example            # negation: re-include a path
.npmrc
.vscode/settings.json
@symlink node_modules    # symlink large shared dirs instead of copying them
```

| Prefix     | Mode      | Meaning                                                |
| ---------- | --------- | ------------------------------------------------------ |
| (none)     | `copy`    | Copy the matched file/dir into the worktree.           |
| `@symlink` | `symlink` | Replace the matched path with a symlink to the source. |
| `!`        | negation  | Re-include a path an earlier pattern excluded.         |
| `#`        | comment   | Ignored.                                               |

**Symlink `node_modules`** — copying it is hundreds of MB per task. Symlinking shares
the main checkout's install; transient lock races are absorbed by a bounded retry.

**Do not** copy build outputs (`dist/`, `*.tsbuildinfo`, `coverage/`, `.turbo/`) — let
them be empty and let the task's validation step regenerate them.

### `createLintValidationGate` — the primary lint defence

When a task writes code that will be committed inside a worktree, wire
`createLintValidationGate(worktreePath)` into the step's `validateOutput` option so the
implementing agent fixes its own lint errors _before_ commit time.

> **Legacy note.** `createLintValidationGate` was designed for the legacy `oneStepTask`
> `validateOutput` option. The current session primitive (`runSession` / `SessionScheduler`)
> does NOT have a `validateOutput` field — tasks use composable runners that manage their
> own session lifecycle. For lint validation in a `SessionScheduler`, use `singleSession`
> with a dedicated validation step, or wire a `createLintValidationGate`-style callback into
> a `runSession` called from within a custom runner.

```typescript
import {
  createLintValidationGate,
  resolveProfilesDirs,
  type WorkflowModule,
  type WorkflowRunOptions,
} from '@harms-haus/engin-engine';

// createLintValidationGate returns a () => Promise<{ error?: string } | undefined>
// suitable for use with the legacy oneStepTask's validateOutput option.
const gate = createLintValidationGate(cwd);
```

> **Tip.** The gate runs `eslint --fix` + `prettier --write` (fire-and-forget), then a final
> `eslint` check; if errors remain it returns `{ error }`, which triggers the validation
> retry loop so the agent corrects them in its existing tool loop. A commit-failure safety
> net (a tooled, self-verifying fix-up agent) catches anything the gate misses.

The gate runs `eslint --fix` + `prettier --write` (fire-and-forget), then a final
`eslint` check; if errors remain it returns `{ error }`, which triggers the validation
retry loop so the agent corrects them in its existing tool loop. A commit-failure safety
net (a tooled, self-verifying fix-up agent) catches anything the gate misses.

---

## 10. Patterns and tips

### Use the `files` field to pre-load context

Every task in a `TaskGraph` accepts a `files: string[]`. Paths are resolved relative to `cwd`;
their contents are injected into the prompt as fenced code blocks (with language detection)
before the prompt body. Binary files are skipped; files over 10 KB are truncated. This is far
cheaper and more reliable than asking the agent to find and read the right files itself.

> **Session-first note.** `files` are inlined by the `beforeSessionPrompt` / `collectContext`
> default when running through the legacy `runSession` path. In a `SessionScheduler`, the file
> context is injected via `buildPrompt`-equivalent logic in the session primitive — include
> the file contents directly in your session `prompt` if you need deterministic control.

### Thread intermediate results through prompts

Phases are independent — the scheduler does not know what the scout produced. Thread results
yourself by capturing the return value of `runSession` and interpolating it into the next
phase's prompt (as we did with `scout.summary` and `outline.pages`). For larger payloads,
write them to a file in `workDir` and reference the path.

### Model the dependency graph

Tasks declare `dependencies: string[]`. The `TaskGraph` resolves the graph, serves ready
tasks first (sorted descending by blocking pressure), and throws on cycles at `addTask` time.
Use this when some units must finish before others (for example, a "shared types" page that
other pages reference). For independent units, use an empty array.

### Choose read-only sessions deliberately

A session with `isReadOnly: true` cannot modify files. Use it for reviewers and for any analysis
session. The scheduler enforces it by adding `write` and `edit` to the profile's exclude list.

### Keep task IDs and session roles filesystem-safe

Session directories are built from `{taskId}/{role}`. Task IDs are validated
against `^[a-zA-Z0-9_-]+$`. Use kebab-case IDs and simple role names (e.g. `execute`, `review`).

### Respect the abort signal at phase boundaries

`runSession` checks `signal.aborted` once at the start. Between phases, check
`options.signal?.aborted` yourself and return early if the user cancelled. Inside a
`SessionScheduler`, abort is handled by the scheduler (it aborts in-flight sessions + cancels
remaining tasks).

### Don't create your own status tracker

`WorkflowRunOptions.tracker` may carry a pre-created `WorkflowStatusTracker`. Reuse it if
present; the engine wires its persistence. Most workflows do not need to touch it directly —
the event store is the source of truth for the UI.

---

## 11. Authoring hooks

A workflow can influence and observe the engine without forking it by exporting a `hooks`
field on the module. The engine composes those hooks with its status callbacks via
`composeHooks` and exposes the assembled registry as `options.hookRegistry`. The full catalog
(29 hooks), the four composition rules (`observe` / `pipeline` / `first-wins` / `all-run`), and
the known wiring gaps are in [Hooks](../reference/hooks.md) — this section shows the authoring
mechanics with two worked examples.

`WorkflowModule.hooks` accepts a single `WorkflowHooks` object **or** an array of them
(registered in array order). Each field may itself be a single function or an array:

```typescript
import type { WorkflowModule } from '@harms-haus/engin-engine';

const module: WorkflowModule = {
  run,
  name: 'apidoc',
  // Declare hooks on the module. The engine composes them via composeHooks
  // and exposes the assembled registry as options.hookRegistry.
  hooks: {
    // …individual hook subscribers go here…
  },
};
export default module;
```

**Forward the registry to your primitives.** The engine assembles `options.hookRegistry` for
you, but scheduler/session hooks only fire if you forward it into the `SessionScheduler` / `runSession` you
construct. A workflow with no `hooks` field (or an empty registry) is byte-for-byte unchanged —
every seam is gated on `hasSubscribers(name)` and falls back to the legacy path.

> **NOTE.** In the session-first engine, the `SessionScheduler` resolves runners from the
> factory registered via `graph.addTask(task, factory)` (or the `beforeTask` hook returning
> `{ runner }`). The task registration event (`onTaskRegister`) carries no step definitions. The
> TUI/web agent log shows sessions (with their `runnerRole`) dynamically as they start.

### Example (a) — `beforeSessionPrompt` (pipeline): inject custom context

`beforeSessionPrompt` is a **pipeline** hook: each subscriber receives the current prompt string
and returns the next (seeded with `task.prompt`). It fires inside `runStep` (the legacy
step-execution path used by `runSession`) and fully replaces `buildPrompt` when it has a
subscriber. Add it to the `apidoc` writer pool so every drafted page follows the repo's style:

> **Session-first note.** `beforeSessionPrompt` is currently wired in the legacy
> step-execution path (`runSession`, `linearStepsRunner`, `reflectionRunner`, `fixLoop`).
> The new session primitive (`runSession` / `SessionScheduler`) does **not** yet consult
> `beforeSessionPrompt` — it builds the prompt from the `SessionSpec` directly. For scheduler
> prompt customization, append to the `prompt` field of your `SessionSpec`.

```typescript
const scheduler = new SessionScheduler({
  graph,
  gate,
  profiles,
  sessionBaseDir: `${workDir}/sessions`,
  cwd,
  phaseId: 'writing',
  onStatus,
  hookRegistry: options.hookRegistry, // ← activates beforeSessionPrompt for legacy paths
  activeSessions,
});

const module: WorkflowModule = {
  run,
  name: 'apidoc',
  hooks: {
    beforeSessionPrompt: async (value, args) => {
      // `args` carries { task, step, prompt, cwd, worktreeCwd? }. Files resolve
      // against worktreeCwd ?? cwd (the per-task worktree when one is in use).
      return `${value}\n\nNote: this repo uses tabs, not spaces. Match the surrounding style exactly.`;
    },
  },
};
```

### Example (b) — `onPhaseSettled` (all-run): collect results

`onPhaseSettled` is an **all-run** hook: every subscriber runs once a phase's tasks have all
reached a terminal state, and subscribers typically collect results into the shared
workflow-state bag. It fires from `PhaseRunner`, the engine's phase-orchestration primitive
(used by bundled workflows like `spir`) — if your workflow drives phases through `PhaseRunner`,
forward `options.hookRegistry` there too (same as the `SessionScheduler` example above):

```typescript
hooks: {
  // Fires from PhaseRunner when every task in the phase has settled.
  onPhaseSettled: async (args) => {
    // args.tasks = the phase's settled tasks; args.state = the shared mutable bag.
    for (const task of args.tasks) {
      if (task.status === 'complete' && task.result !== undefined) {
        const results = (args.state.results as Record<string, unknown> | undefined) ?? {};
        results[task.id] = task.result;
        args.state.results = results;
      }
    }
  },
},
```

> The default `onPhaseSettled` (which writes `{ [taskId]: result }` under
> `state[`${phaseId}Results`]`) is a **reference implementation**, not engine-auto-registered —
> the workflow owns the collection logic when it opts in. See [Hooks §5](../reference/hooks.md#5-default-implementations).

---

## 12. Testing your workflow

You have a few options:

- **Run it for real** with `engin apidoc "..."` against a small target repo. Use `--verbose`
  to see turn-level output, or watch the TUI.
- **Resume after interruption.** Each run writes state to
  `.engin/work/<timestamp>-apidoc/`. Run `engin resume` and pick the run to continue.
- **Unit-test the building blocks.** `runSession`, the `TaskGraph`, and the `evolve`
  reducer are all plain functions/classes you can import and exercise in isolation. See the
  existing tests under `tests/` for patterns (e.g. `tests/core/phase-tasks.test.ts`).
- **Mock the agent seam.** The agent plugin's `createSession` (and the `AgentRuntime` it
  returns) is the seam; for tests you can construct a `PromptableHarness`-shaped mock
  (`{ prompt, getLastAssistantText }`) and feed it to `promptForStructured` directly.

---

## 13. Other example shapes

The `apidoc` workflow uses every primitive. Other natural shapes, all built from the same
pieces:

- **`migrate`** — Scout the migration surface → plan migration units → `SessionScheduler` where each
  task is `migrate → review` → final verification pass. Tasks can declare dependencies when
  some modules must migrate before others.
- **`triage`** — A single-agent scout over a backlog → a single-agent planner producing
  prioritised tasks → a `SessionScheduler` of `investigate → summarise` (read-only) steps that never
  reject, only annotate.
- **`release-notes`** — Scout recent commits (single agent) → draft notes per area
  (`SessionScheduler`, `draft → review`) → assemble the final changelog (single agent).
- **`audit-deps`** — Scout dependencies → plan per-package audits → `SessionScheduler` of
  `investigate (read-only) → recommend` where the recommend step writes a report file.

Each is just a different arrangement of `runSession`/`runSession` and `SessionScheduler` with
composable runner trees, different schemas, and profiles. Once you internalise the two
primitives and the phase/task/session hierarchy, you can model almost any multi-agent
pipeline.

---

## Reference

- [Programmatic API](../reference/api.md) — every function and class.
- [Task pool & execution](../reference/task-pool.md) — the `SessionScheduler`, `SessionGate`, `TaskGraph`,
  and composable runners in full.
- [Worktrees reference](../reference/worktrees.md) — the per-task worktree system, `.worktreecopy`,
  branch naming, merge serialization, and the final-merge UX.
- [Event store & status](../reference/event-store.md) — what every callback becomes.
- [Hooks](../reference/hooks.md) — the full hook catalog, composition rules, defaults, and wiring.
- [Authoring profiles](profiles.md) — the Markdown profile format.
- [Types reference](../reference/types.md) — `StatusCallbacks`, `StepDefinition`, `WorktreeManager`, etc.
