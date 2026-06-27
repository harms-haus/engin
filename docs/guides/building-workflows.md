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

| Field                    | Type                     | Meaning                                                                                                                                     |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                    | `string`                 | Working directory. For git-repo runs this is the **main worktree path**, not the original cwd.                                              |
| `workDir`                | `string`                 | Directory for workflow state persistence.                                                                                                   |
| `maxConcurrentSessions?` | `number`                 | Max concurrent agent sessions (default `5`).                                                                                                |
| `apiKeys?`               | `Record<string, string>` | Provider → API key overrides.                                                                                                               |
| `onStatus?`              | `StatusCallbacks`        | The engine's wired-up status callbacks. **Use this.**                                                                                       |
| `verbose?`               | `boolean`                | True when running with verbose console output.                                                                                              |
| `signal?`                | `AbortSignal`            | Cooperative cancellation signal.                                                                                                            |
| `tracker?`               | `unknown`                | A pre-created `WorkflowStatusTracker`, if any.                                                                                              |
| `worktree?`              | `WorktreeInfo`           | Main worktree info (git-repo runs only).                                                                                                    |
| `worktreeManager?`       | `WorktreeManager`        | Per-run worktree manager. Forward to `runSession` / `RunnerPool` for per-task worktrees.                                                    |
| `rendererRegistry?`      | `RendererRegistry`       | Optional registry of per-profile output renderers.                                                                                          |
| `hookRegistry?`          | `HookRegistry`           | The engine-assembled hook registry. Forward to `RunnerPool` / `runSession` to activate pool/session hooks (see [§11](#11-authoring-hooks)). |

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
2. **`RunnerPool`** — runs many tasks concurrently, each through its own runner tree built
   from composable runners (`singleSession`, `reviewRunner`, `linearRunner`, etc.). Best
   for phases that fan out across independent units of work.

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
`runSession` and the `RunnerPool`. You generally do not call them directly.

> Always guard with `?.`: `options.onStatus?.onPhaseRegister?.(...)`. The field is optional and
> individual methods are optional.

For the complete callback surface, see
[Types reference → `StatusCallbacks`](../reference/types.md#statuscallbacks).

---

## 5. Primitive 1 — single-session tasks with `runSession`

`runSession` runs one agent session as a one-step task. It is the simplest way to execute
an agent that participates in the hierarchy. Pass a Zod `schema` and it returns validated
structured output; omit it and it returns the raw assistant text.

Here is a complete, runnable workflow that scouts a codebase and prints the result:

```typescript
// ~/.config/engin/workflows/apidoc/main.ts
import {
  resolveProfilesDirs,
  runSession,
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

  const result = await runSession({
    profilesDirs,
    phaseId: 'scouting',
    taskId: 'scout',
    title: 'Scout the codebase',
    stepName: 'scout',
    profileId: 'scout',
    cwd,
    onStatus,
    prompt: `${taskPrompt}\n\nIdentify the public entry points worth documenting.`,
    schema: ScoutSchema,
  });

  onStatus?.onPhaseComplete?.({ phase: 'scouting', durationMs: 0 });
  console.log('Scout summary:', result.summary);
  console.log('Files:', result.files);
}

const module: WorkflowModule = { run, name: 'apidoc', description: 'Generate API docs' };
export default module;
```

### `RunSessionOptions` reference

| Field           | Required       | Description                                                                                                                                                                                                                                                                 |
| --------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profilesDirs`  | **Yes**        | Directories to load `.md` profiles from.                                                                                                                                                                                                                                    |
| `phaseId`       | **Yes**        | Phase identifier for status callbacks.                                                                                                                                                                                                                                      |
| `taskId`        | **Yes**        | Unique task identifier. Also used as the agent ID.                                                                                                                                                                                                                          |
| `title`         | **Yes**        | Human-readable task title.                                                                                                                                                                                                                                                  |
| `stepName`      | **Yes**        | Name of the step (shown in the UI).                                                                                                                                                                                                                                         |
| `profileId`     | **Yes**        | Profile ID to load.                                                                                                                                                                                                                                                         |
| `cwd`           | **Yes**        | Working directory for the agent.                                                                                                                                                                                                                                            |
| `prompt`        | **Yes**        | Prompt to send to the agent.                                                                                                                                                                                                                                                |
| `onStatus?`     | No             | Status callbacks.                                                                                                                                                                                                                                                           |
| `schema?`       | No             | Zod schema for structured output.                                                                                                                                                                                                                                           |
| `isReadOnly?`   | No             | When true, `write`/`edit` are stripped (default `false`).                                                                                                                                                                                                                   |
| `apiKeys?`      | No             | Provider → API key overrides.                                                                                                                                                                                                                                               |
| `signal?`       | No             | Abort signal. Checked once at the start.                                                                                                                                                                                                                                    |
| `hookRegistry?` | `HookRegistry` | Optional registry of workflow hooks. When provided AND it has subscribers for `beforeSessionPrompt`, the prompt is passed through the pipeline hook and the pipeline's return value replaces the prompt sent to the agent. Absent or no subscribers → zero behavior change. |

Lifecycle: abort check → `onTaskRegister` (single-step definition) → `onTaskStart` → load and
adjust profile → resolve the profile agent plugin and call `createSession` (via
`spawnAgent`) → `onSessionStart` (session id derived from `taskId`) → run prompt →
`onSessionComplete` (always, in `finally`) → on success `onTaskComplete`, on error
`onTaskRejected` then re-throw.

> **Abort semantics.** `runSession` checks `signal.aborted` exactly once, before any callbacks
> fire. It does not register an abort listener or forward the signal downstream. Use it for
> "should we even start?" checks; for mid-run cancellation rely on the surrounding
> `RunnerPool`/CLI flow.

---

## 6. Primitive 2 — concurrent tasks with `RunnerPool`

A `RunnerPool` runs N independent workers that claim tasks from a shared `TaskTracker` and
process each through a **runner** — a composable function that orchestrates one or more
agent sessions. Concurrency is governed by a `SessionGate` (two-level: total + per-model
caps) rather than a fixed lane count. This is what you reach for when a phase fans out
across many independent units of work.

Each task carries a `phaseId` and a list of `dependencies` (other task IDs that must
complete first). The tracker serves ready tasks (fewest dependencies first, then by ID),
and rejects cycles at insert time. All ready tasks are claimed and their runner coroutines
started immediately; the `SessionGate` is the sole concurrency cap — runners gate
themselves via `ctx.gate.run()`.

### Composable runners

Runners are built by composing factory functions from
`@harms-haus/engin-engine`. Each returns a `Runner` (a function that takes a
`RunnerContext` and returns `Promise<TaskOutcome>`):

| Runner              | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `singleSession`     | Run exactly one session. The basic building block.                  |
| `linearRunner`      | Run children sequentially; short-circuit on first failure.          |
| `reviewRunner`      | Execute→review loop with approve/reject feedback (up to N rounds).  |
| `councilRunner`     | Run workers in parallel, then synthesise their outputs.             |
| `parallelRunner`    | Run arbitrary child runners in parallel.                            |
| `mapRunner`         | Fan out over a collection, one session per item.                    |
| `branchRunner`      | Select one child runner based on task conditions.                   |
| `coordinatorRunner` | Run a coordinator session, then delegate to children via a factory. |
| `coalescingRunner`  | Coordinator → children → coordinator loop (dynamic rounds).         |

A **session spec** (`SessionSpec`) defines one session: `profile`, `prompt`, optional
`schema` (Zod), `outputMode` (`'text'` | `'structured'` | `'filesystem'`), `isReadOnly`,
`runnerRole`, and `attempt`. The session `id` is assigned deterministically at run time
from the task id and role (e.g. `${taskId}/execute#${round}`).

Here is the shape you will use for the `apidoc` writing phase:

```typescript
import {
  RunnerPool,
  resolveProfilesDirs,
  TaskTracker,
  singleSession,
  reviewRunner,
  type Runner,
  type SessionSpec,
} from '@harms-haus/engin-engine';
import { z } from 'zod';

const ReviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});

// A SessionRoleSpec is a SessionSpec minus the deterministic `id`, plus a `role` label.
type SessionRoleSpec = Omit<SessionSpec, 'id'> & { role: string };

// ...inside run(), for the 'writing' phase:
onStatus?.onPhaseStart?.({ phase: 'writing', round: 0 });

const tracker = new TaskTracker();
// addTask() for each documentation unit, with dependencies as needed

// Build the runner tree: execute → review loop per task.
function getRunnerForTask(task: Task): Runner {
  const writeSpec: SessionRoleSpec = {
    role: 'draft',
    runnerRole: 'draft',
    profile: 'writer',
    prompt: task.prompt,
    outputMode: 'filesystem',
    isReadOnly: false,
    attempt: 1,
  };
  const reviewSpec: SessionRoleSpec = {
    role: 'review',
    runnerRole: 'review',
    profile: 'reviewer',
    prompt: 'Review the drafted documentation page for accuracy and clarity.',
    schema: ReviewSchema,
    outputMode: 'structured',
    isReadOnly: true,
    attempt: 1,
  };
  return reviewRunner(writeSpec, reviewSpec, { maxRounds: 5 });
}

const pool = new RunnerPool({
  maxConcurrentSessions: options.maxConcurrentSessions ?? 5,
  modelConcurrency: {},
  profilesDirs,
  sessionBaseDir: `${options.workDir}/sessions`,
  cwd: options.cwd,
  phaseId: 'writing',
  taskTracker: tracker,
  onStatus: options.onStatus,
  hookRegistry: options.hookRegistry,
  getRunnerForTask,
});

const result = await pool.run();
onStatus?.onPhaseComplete?.({ phase: 'writing', durationMs: 0 });
console.log(`Drafted ${result.completedTasks} pages; ${result.failedTasks} failed.`);
```

### Runner trees

Runners compose into trees. A task's runner is typically built from multiple factories
chained together. For example, the bundled `spir` implementation phase builds this tree for
code tasks:

```typescript
import { linearRunner, reviewRunner, singleSession } from '@harms-haus/engin-engine';

// Code task: write tests first, then run implement→review loop.
const runner = linearRunner([
  singleSession(testSpec), // write tests
  reviewRunner(implSpec, reviewSpec), // implement → review loop
]);
```

For non-code tasks, the test-writer step is omitted:

```typescript
const runner = reviewRunner(implSpec, reviewSpec);
```

The `getRunnerForTask` callback returns the appropriate tree for each task. You can also
use the `beforeTask` hook to provide a runner dynamically at claim time (see
[§11](#11-authoring-hooks)).

### How `RunnerPool` processes a task

For each claimed task, the pool:

1. Fires `onTaskStart`.
2. Resolves the runner via `getRunnerForTask` (or the `beforeTask` hook if it returns
   `{ runner }`).
3. Optionally creates a per-task worktree (when `worktreeManager` is forwarded).
4. Invokes the runner, which calls `ctx.runSession(...)` — each session acquires a
   concurrency slot from `ctx.gate.run()` before prompting the agent.
5. On `{ status: 'completed' }` (and worktree mode): squash-merges the task branch into the
   main worktree branch, then fires `onTaskComplete`.
6. On `{ status: 'failed' }`: fires `onTaskRejected`, then the retry valve classifies the
   error — permanent/abort errors are not retried; transient errors are retried up to
   `maxTaskRetries` (with exponential backoff).

> **SessionGate.** The pool internally constructs `new SessionGate({ total:
maxConcurrentSessions, perModel: modelConcurrency })`. Runners call
> `ctx.gate.run(profile, fn)` — the gate holds a total + per-model slot for the duration of
> `fn`, then releases automatically (RAII). This replaces the old lane model — there are no
> fixed lanes; sessions from different tasks interleave through the shared gate.

### `RunnerPoolOptions` reference

| Field                   | Required | Description                                                                                                                      |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrentSessions` | **Yes**  | Hard cap on concurrent in-flight sessions across all models.                                                                     |
| `modelConcurrency`      | **Yes**  | Per-model concurrency caps keyed by `${provider}:${model}`. Pass `{}` for unbounded per-model.                                   |
| `profilesDirs`          | **Yes**  | Directories to load profiles from.                                                                                               |
| `sessionBaseDir`        | **Yes**  | Base directory for persisted sessions.                                                                                           |
| `cwd`                   | **Yes**  | Working directory for agent operations.                                                                                          |
| `taskTracker`           | **Yes**  | Shared `TaskTracker` the pool claims from.                                                                                       |
| `phaseId`               | **Yes**  | The phase this pool serves. Propagated to every callback.                                                                        |
| `getRunnerForTask?`     | No       | `(task) => Runner` returning the runner tree.                                                                                    |
| `onStatus?`             | No       | Status callbacks.                                                                                                                |
| `apiKeys?`              | No       | Provider → API key overrides.                                                                                                    |
| `auditLog?`             | No       | Audit log for events.                                                                                                            |
| `maxTaskRetries?`       | No       | Max same-run retries for failed tasks (default `0`). Total attempts = `1 + maxTaskRetries`.                                      |
| `stepTimeoutMs?`        | No       | Per-prompt watchdog timeout (ms).                                                                                                |
| `signal?`               | No       | Abort signal.                                                                                                                    |
| `rendererRegistry?`     | No       | Optional per-profile output renderers.                                                                                           |
| `hookRegistry?`         | No       | Registry of workflow hooks. Forward `options.hookRegistry` to activate `beforeTask` / `beforeSessionPrompt` / observe hooks.     |
| `worktreeManager?`      | No       | Per-run worktree manager. When set, each claimed task gets its own worktree (squash-merged on success, culled on failure/retry). |
| `gate?`                 | No       | Pre-created `SessionGate` (defaults to a new gate from `maxConcurrentSessions` + `modelConcurrency`).                            |

`pool.run()` returns `{ completedTasks: number; failedTasks: number }`.

> **When there is nothing to do.** If the tracker has no tasks, `pool.run()` returns
> `{ completedTasks: 0, failedTasks: 0 }` **without loading profiles or starting coroutines**.

> **`WorkflowRunOptions.maxConcurrentSessions` is deprecated.** The new config field is
> `maxConcurrentSessions` (on `WorkflowConfig` or passed directly to `RunnerPool`).
> Workflows like `spir.ts` map `options.maxConcurrentSessions ?? config.defaultMaxConcurrentSessions`
> into the pool's `maxConcurrentSessions`. Use `defaultMaxConcurrentSessions` in your
> workflow config and `modelConcurrency` for per-model caps.

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
3. **Write** (`RunnerPool`, multi-session) — for each page, draft it then have a reviewer approve it.
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
  RunnerPool,
  resolveProfilesDirs,
  runSession,
  TaskTracker,
  reviewRunner,
  type Runner,
  type SessionSpec,
  type Task,
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

  // ── Phase 1: Scout ──────────────────────────────────────────────────────
  onStatus?.onPhaseStart?.({ phase: 'scouting', round: 0 });
  const scout = await runSession({
    profilesDirs,
    phaseId: 'scouting',
    taskId: 'scout',
    title: 'Scout the codebase',
    stepName: 'scout',
    profileId: 'scout',
    cwd,
    onStatus,
    prompt: `${taskPrompt}\n\nIdentify the public entry points worth documenting.`,
    schema: ScoutSchema,
  });
  onStatus?.onPhaseComplete?.({ phase: 'scouting', durationMs: 0 });

  // ── Phase 2: Outline ────────────────────────────────────────────────────
  onStatus?.onPhaseStart?.({ phase: 'outlining', round: 0 });
  const outline = await runSession({
    profilesDirs,
    phaseId: 'outlining',
    taskId: 'outliner',
    title: 'Plan documentation pages',
    stepName: 'outline',
    profileId: 'outliner',
    cwd,
    onStatus,
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
  });
  onStatus?.onPhaseComplete?.({ phase: 'outlining', durationMs: 0 });

  if (outline.pages.length === 0) {
    console.log('Nothing to document.');
    return;
  }

  // ── Phase 3: Write (RunnerPool, draft → review per page) ───────────────
  onStatus?.onPhaseStart?.({ phase: 'writing', round: 0 });

  const tracker = new TaskTracker();
  for (const page of outline.pages) {
    const task: Omit<Task, 'status'> = {
      id: page.id,
      phaseId: 'writing',
      title: page.title,
      profile: 'writer',
      files: [page.sourceFile],
      dependencies: [],
      prompt: [
        `Write the documentation page "${page.title}".`,
        `Source file: ${page.sourceFile}`,
        `Write the page to: ${page.outputFile}`,
        '',
        'Cover these sections:',
        page.outline.map((s) => `- ${s}`).join('\n'),
      ].join('\n'),
    };
    tracker.addTask(task);
  }

  // A SessionRoleSpec is a SessionSpec minus the deterministic `id`, plus a `role` label.
  type SessionRoleSpec = Omit<SessionSpec, 'id'> & { role: string };

  // Build the runner tree for each page: draft → review loop.
  const draftSpec: SessionRoleSpec = {
    role: 'draft',
    runnerRole: 'draft',
    profile: 'writer',
    prompt: '', // set per-task below
    outputMode: 'filesystem',
    isReadOnly: false,
    attempt: 1,
  };
  const reviewSpec: SessionRoleSpec = {
    role: 'review',
    runnerRole: 'review',
    profile: 'reviewer',
    prompt: 'Review the drafted documentation page for accuracy and clarity.',
    schema: ReviewSchema,
    outputMode: 'structured',
    isReadOnly: true,
    attempt: 1,
  };

  function getRunnerForTask(task: Task): Runner {
    // Each page uses a draft → review loop (up to 5 rounds).
    return reviewRunner(
      { ...draftSpec, prompt: task.prompt },
      reviewSpec,
      { maxRounds: 5 },
    );
  }

  const pool = new RunnerPool({
    maxConcurrentSessions: options.maxConcurrentSessions ?? 5,
    modelConcurrency: {},
    profilesDirs,
    sessionBaseDir: `${workDir}/sessions`,
    cwd,
    phaseId: 'writing',
    taskTracker: tracker,
    onStatus,
    hookRegistry: options.hookRegistry,
    getRunnerForTask,
  });

  const result = await pool.run();
  onStatus?.onPhaseComplete?.({ phase: 'writing', durationMs: 0 });
  console.log(`Pages drafted: ${result.completedTasks}, failed: ${result.failedTasks}`);

  // ── Phase 4: Index ──────────────────────────────────────────────────────
  onStatus?.onPhaseStart?.({ phase: 'indexing', round: 0 });
  await runSession({
    profilesDirs,
    phaseId: 'indexing',
    taskId: 'indexer',
    title: 'Generate the API index',
    stepName: 'index',
    profileId: 'writer',
    cwd,
    onStatus,
    prompt: [
      'Generate a top-level index page for the following documentation pages.',
      'Write it to docs/api/README.md.',
      '',
      ...outline.pages.map((p, i) => `${i + 1}. ${p.title} → ${p.outputFile}`),
    ].join('\n'),
    schema: IndexSchema,
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
- During **Write**, a task appears per page (up to `maxConcurrentSessions` at once, sorted fewest
  dependencies first). Each task runs a draft → review loop. When a reviewer rejects,
  you will see an `onDecision` line in the log and the `draft` session re-run with the feedback
  appended. The session tab bar at the bottom of the agent log lets you cycle between the draft
  and review sessions (Tab / Shift+Tab in the TUI).
- After `maxRounds` rejections, the page fails and (when retriable) is retried up to
  `maxTaskRetries` times.

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
into per-task isolation, forward `options.worktreeManager` to `runSession`,
`runSession`, or `RunnerPool`:

```typescript
await runSession({
  // …
  cwd: options.cwd,
  worktreeManager: options.worktreeManager, // ← enables per-task worktree
});
```

> **Note on `RunnerPool`.** When you forward `options.worktreeManager` to `RunnerPool`,
> each claimed task whose `task.worktree === 'code'` gets its own worktree (created via
> `worktreeManager.createTaskWorktree`, squash-merged on success, culled on failure/retry).
> Tasks that are read-only or non-code run against the main worktree `cwd` directly.

When `worktreeManager` is present, the primitive:

1. Creates a per-task worktree off the main-wt branch (so the task inherits
   already-merged sibling work).
2. Runs the agent with `cwd` pointed at the task worktree.
3. On success, commits and **squash-merges** the task branch into the main-wt branch
   (serialized across all concurrent tasks), then culls the task worktree + branch.
4. On failure / retry, force-culls the task worktree and recreates a fresh one on the
   next attempt.

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
implementing agent fixes its own lint errors _before_ commit time:

> **Note on `RunnerPool`.** `createLintValidationGate` is designed for the `runSession` /
> `runSession` `validateOutput` option. `RunnerPool` tasks use composable runners that
> manage their own session lifecycle; for lint validation in a runner pool, use
> `singleSession` with a dedicated validation step, or wire `createLintValidationGate` into
> a `runSession` called from within your runner.

```typescript
import {
  createLintValidationGate,
  resolveProfilesDirs,
  runSession,
  type WorkflowModule,
  type WorkflowRunOptions,
} from '@harms-haus/engin-engine';

export async function run(taskPrompt: string, options: WorkflowRunOptions) {
  const { cwd, onStatus } = options;
  const profilesDirs = resolveProfilesDirs(cwd, 'my-workflow');

  await runSession({
    profilesDirs,
    phaseId: 'implementing',
    taskId: 'implement',
    title: 'Implement the feature',
    stepName: 'implement',
    profileId: 'implementer',
    cwd,
    onStatus,
    prompt: taskPrompt,
    validateOutput: createLintValidationGate(cwd),
  });
}
```

Note: when you forward `options.worktreeManager` to `runSession` / `runSession`, the primitive creates a per-task worktree dynamically and runs the agent inside it; `createLintValidationGate` cannot be pre-bound to that path (its callback takes no arguments), so in per-task-worktree mode the commit-time fix-up safety net is the primary lint check. Use `createLintValidationGate(cwd)` only when the task runs directly against `cwd` (no forwarded `worktreeManager`).

The gate runs `eslint --fix` + `prettier --write` (fire-and-forget), then a final
`eslint` check; if errors remain it returns `{ error }`, which triggers the validation
retry loop so the agent corrects them in its existing tool loop. A commit-failure safety
net (a tooled, self-verifying fix-up agent) catches anything the gate misses.

---

## 10. Patterns and tips

### Use the `files` field to pre-load context

Every task in a `RunnerPool` accepts a `files: string[]`. Paths are resolved relative to `cwd`;
their contents are injected into the prompt as fenced code blocks (with language detection)
before the prompt body. Binary files are skipped; files over 10 KB are truncated. This is far
cheaper and more reliable than asking the agent to find and read the right files itself.

> **Session-first note.** `files` are inlined by the `beforeSessionPrompt` / `collectContext`
> default when running through the legacy `runSession` path. In a `RunnerPool`, the file
> context is injected via `buildPrompt`-equivalent logic in the session primitive — include
> the file contents directly in your session `prompt` if you need deterministic control.

### Thread intermediate results through prompts

Phases are independent — the pool does not know what the scout produced. Thread results
yourself by capturing the return value of `runSession` and interpolating it into the next
phase's prompt (as we did with `scout.summary` and `outline.pages`). For larger payloads,
write them to a file in `workDir` and reference the path.

### Model the dependency graph

Tasks declare `dependencies: string[]`. The `TaskTracker` resolves the graph, serves ready
tasks first, and throws on cycles at `addTask` time. Use this when some units must finish
before others (for example, a "shared types" page that other pages reference). For independent
units, use an empty array.

### Choose read-only sessions deliberately

A session with `isReadOnly: true` cannot modify files. Use it for reviewers and for any analysis
session. The pool enforces it by adding `write` and `edit` to the profile's exclude list.

### Keep task IDs and session roles filesystem-safe

Session directories are built from `{taskId}/{role}#{attempt}`. Task IDs are validated
against `^[a-zA-Z0-9_-]+$`. Use kebab-case IDs and simple role names (e.g. `execute`, `review`).

### Respect the abort signal at phase boundaries

`runSession` checks `signal.aborted` once at the start. Between phases, check
`options.signal?.aborted` yourself and return early if the user cancelled. Inside a `RunnerPool`,
abort is handled by the pool (it aborts in-flight sessions).

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
you, but pool/session hooks only fire if you forward it into the `RunnerPool` / `runSession` you
construct. A workflow with no `hooks` field (or an empty registry) is byte-for-byte unchanged —
every seam is gated on `hasSubscribers(name)` and falls back to the legacy path.

> **NOTE.** In the session-first engine, `RunnerPool` has no `getRunnerForTask` — tasks are
> resolved via `getRunnerForTask` (or the `beforeTask` hook returning `{ runner }`). The task
> registration event (`onTaskRegister`) carries no step definitions. The TUI/web agent log
> shows sessions (with their `runnerRole`) dynamically as they start.

### Example (a) — `beforeSessionPrompt` (pipeline): inject custom context

`beforeSessionPrompt` is a **pipeline** hook: each subscriber receives the current prompt string
and returns the next (seeded with `task.prompt`). It fires inside `runStep` (the legacy
step-execution path used by `runSession`) and fully replaces `buildPrompt` when it has a
subscriber. Add it to the `apidoc` writer pool so every drafted page follows the repo's style:

> **Session-first note.** `beforeSessionPrompt` is currently wired in the legacy
> step-execution path (`runSession`, `linearStepsRunner`, `reflectionRunner`, `fixLoop`).
> The new session primitive (`runSession` / `RunnerPool`) does **not** yet consult
> `beforeSessionPrompt` — it builds the prompt from the `SessionSpec` directly. For runner-pool
> prompt customization, append to the `prompt` field of your `SessionSpec`.

```typescript
const pool = new RunnerPool({
  maxConcurrentSessions: options.maxConcurrentSessions ?? 5,
  modelConcurrency: {},
  profilesDirs,
  sessionBaseDir: `${workDir}/sessions`,
  cwd,
  phaseId: 'writing',
  taskTracker: tracker,
  onStatus,
  hookRegistry: options.hookRegistry, // ← activates beforeSessionPrompt for legacy paths
  getRunnerForTask,
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
forward `options.hookRegistry` there too (same as the `RunnerPool` example above):

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
- **Unit-test the building blocks.** `runSession`, the `TaskTracker`, and the `evolve`
  reducer are all plain functions/classes you can import and exercise in isolation. See the
  existing tests under `tests/` for patterns (e.g. `tests/core/phase-tasks.test.ts`).
- **Mock the agent seam.** The agent plugin's `createSession` (and the `AgentRuntime` it
  returns) is the seam; for tests you can construct a `PromptableHarness`-shaped mock
  (`{ prompt, getLastAssistantText }`) and feed it to `promptForStructured` directly.

---

## 13. Other example shapes

The `apidoc` workflow uses every primitive. Other natural shapes, all built from the same
pieces:

- **`migrate`** — Scout the migration surface → plan migration units → `RunnerPool` where each
  task is `migrate → review` → final verification pass. Tasks can declare dependencies when
  some modules must migrate before others.
- **`triage`** — A single-agent scout over a backlog → a single-agent planner producing
  prioritised tasks → a `RunnerPool` of `investigate → summarise` (read-only) steps that never
  reject, only annotate.
- **`release-notes`** — Scout recent commits (single agent) → draft notes per area
  (`RunnerPool`, `draft → review`) → assemble the final changelog (single agent).
- **`audit-deps`** — Scout dependencies → plan per-package audits → `RunnerPool` of
  `investigate (read-only) → recommend` where the recommend step writes a report file.

Each is just a different arrangement of `runSession`/`runSession` and `RunnerPool` with
composable runner trees, different schemas, and profiles. Once you internalise the two
primitives and the phase/task/session hierarchy, you can model almost any multi-agent
pipeline.

---

## Reference

- [Programmatic API](../reference/api.md) — every function and class.
- [Task pool & execution](../reference/task-pool.md) — the `RunnerPool`, `TaskTracker`, and
  composable runners in full.
- [Worktrees reference](../reference/worktrees.md) — the per-task worktree system, `.worktreecopy`,
  branch naming, merge serialization, and the final-merge UX.
- [Event store & status](../reference/event-store.md) — what every callback becomes.
- [Hooks](../reference/hooks.md) — the full hook catalog, composition rules, defaults, and wiring.
- [Authoring profiles](profiles.md) — the Markdown profile format.
- [Types reference](../reference/types.md) — `StatusCallbacks`, `StepDefinition`, `WorktreeManager`, etc.
