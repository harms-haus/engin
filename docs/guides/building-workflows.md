# Building a new workflow

This is the primary authoring guide. By the end you will have built a complete, runnable
workflow that uses every core primitive: phase registration, single-agent tasks, a concurrent
multi-step task pool, structured output, and reviewer feedback loops.

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

| Field                 | Type                     | Meaning                                                                                                                                 |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                 | `string`                 | Working directory. For git-repo runs this is the **main worktree path**, not the original cwd.                                          |
| `workDir`             | `string`                 | Directory for workflow state persistence.                                                                                               |
| `maxConcurrentTasks?` | `number`                 | Max parallel agents (default `5`).                                                                                                      |
| `apiKeys?`            | `Record<string, string>` | Provider → API key overrides.                                                                                                           |
| `onStatus?`           | `StatusCallbacks`        | The engine's wired-up status callbacks. **Use this.**                                                                                   |
| `verbose?`            | `boolean`                | True when running with verbose console output.                                                                                          |
| `signal?`             | `AbortSignal`            | Cooperative cancellation signal.                                                                                                        |
| `tracker?`            | `unknown`                | A pre-created `WorkflowStatusTracker`, if any.                                                                                          |
| `worktree?`           | `WorktreeInfo`           | Main worktree info (git-repo runs only).                                                                                                |
| `worktreeManager?`    | `WorktreeManager`        | Per-run worktree manager. Forward to `runStepTask` / `runMultiStepTask` / `LanePool` for per-task worktrees.                            |
| `rendererRegistry?`   | `RendererRegistry`       | Optional registry of per-profile output renderers.                                                                                      |
| `hookRegistry?`       | `HookRegistry`           | The engine-assembled hook registry. Forward to `LanePool` / `runStepTask` to activate pool/step hooks (see [§11](#11-authoring-hooks)). |

That's the whole contract. Everything else — phases, tasks, steps, agents — is your workflow's
internal structure, communicated to the engine purely through `options.onStatus`.

---

## 2. The mental model: phases → tasks → steps → agents

engin enforces a rigid hierarchy (see [Overview → The rigid hierarchy](../concepts/overview.md)):

- A **workflow** owns ordered **phases**. Phases run one at a time; each must finish before the
  next starts.
- A **phase** owns **tasks**. Within a phase, tasks can run one at a time or concurrently.
- A **task** owns a linear sequence of **steps**. Steps run in order.
- A **step** is fulfilled by exactly one **agent**. Every agent in the system is a
  step-of-a-task.

You orchestrate this hierarchy with two primitives:

1. **`runStepTask`** — runs one agent as a single-step task. Best for phases that need a single
   agent (a scout, a planner, a summariser).
2. **`LanePool`** — runs many tasks concurrently, each through its own ordered list of steps
   (e.g. implement → review). Best for phases that fan out across independent units of work.

Both fire the full lifecycle (`onTaskRegister` → `onTaskStart` → `onAgentSpawn` →
`onStepStart` → run → `onAgentComplete` → `onTaskComplete`) for you. You never emit those
events manually.

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
`runStepTask` and the `LanePool`. You generally do not call them directly.

> Always guard with `?.`: `options.onStatus?.onPhaseRegister?.(...)`. The field is optional and
> individual methods are optional.

For the complete callback surface, see
[Types reference → `StatusCallbacks`](../reference/types.md#statuscallbacks).

---

## 5. Primitive 1 — single-agent tasks with `runStepTask`

`runStepTask` runs one agent as a one-step task. It is the simplest way to execute an agent
that participates in the hierarchy. Pass a Zod `schema` and it returns validated structured
output; omit it and it returns the raw assistant text.

Here is a complete, runnable workflow that scouts a codebase and prints the result:

```typescript
// ~/.config/engin/workflows/apidoc/main.ts
import {
  resolveProfilesDirs,
  runStepTask,
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

  const result = await runStepTask({
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

### `RunStepTaskOptions` reference

| Field           | Required       | Description                                                                                                                                                                                                                                                                   |
| --------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profilesDirs`  | **Yes**        | Directories to load `.md` profiles from.                                                                                                                                                                                                                                      |
| `phaseId`       | **Yes**        | Phase identifier for status callbacks.                                                                                                                                                                                                                                        |
| `taskId`        | **Yes**        | Unique task identifier. Also used as the agent ID.                                                                                                                                                                                                                            |
| `title`         | **Yes**        | Human-readable task title.                                                                                                                                                                                                                                                    |
| `stepName`      | **Yes**        | Name of the step (shown in the UI).                                                                                                                                                                                                                                           |
| `profileId`     | **Yes**        | Profile ID to load.                                                                                                                                                                                                                                                           |
| `cwd`           | **Yes**        | Working directory for the agent.                                                                                                                                                                                                                                              |
| `prompt`        | **Yes**        | Prompt to send to the agent.                                                                                                                                                                                                                                                  |
| `onStatus?`     | No             | Status callbacks.                                                                                                                                                                                                                                                             |
| `schema?`       | No             | Zod schema for structured output.                                                                                                                                                                                                                                             |
| `isReadOnly?`   | No             | When true, `write`/`edit` are stripped (default `false`).                                                                                                                                                                                                                     |
| `apiKeys?`      | No             | Provider → API key overrides.                                                                                                                                                                                                                                                 |
| `signal?`       | No             | Abort signal. Checked once at the start.                                                                                                                                                                                                                                      |
| `hookRegistry?` | `HookRegistry` | Optional registry of workflow hooks. When provided AND it has subscribers for `beforeStepPrompt`, the step prompt is passed through the pipeline hook and the pipeline's return value replaces the prompt sent to the agent. Absent or no subscribers → zero behavior change. |

Lifecycle: abort check → `onTaskRegister` (single-step definition) → `onTaskStart` → load and
adjust profile → `createHarness` → `onAgentSpawn` (`stepIndex: 0`) → `onStepStart` → run
prompt → `onAgentComplete` (always, in `finally`) → on success `onTaskComplete`, on error
`onTaskRejected` then re-throw.

> **Abort semantics.** `runStepTask` checks `signal.aborted` exactly once, before any callbacks
> fire. It does not register an abort listener or forward the signal downstream. Use it for
> "should we even start?" checks; for mid-run cancellation rely on the surrounding
> `LanePool`/CLI flow.

---

## 6. Primitive 2 — concurrent multi-step tasks with `LanePool`

A `LanePool` runs N independent workers ("lanes") that each claim tasks from a shared
`TaskTracker` and process them through a configurable sequence of steps. Every step is one
agent. This is what you reach for when a phase fans out across many independent units of work.

Each task carries a `phaseId` and a list of `dependencies` (other task IDs that must complete
first). The tracker serves ready tasks in a deterministic order (fewest dependencies first,
then by ID), and rejects cycles at insert time.

Here is the shape you will use. We will fill it in as we build the `apidoc` writing phase.

```typescript
import { LanePool, TaskTracker, resolveProfilesDirs } from '@harms-haus/engin-engine';
import { z } from 'zod';

const ReviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});

// ...inside run(), for the 'writing' phase:
onStatus?.onPhaseStart?.({ phase: 'writing', round: 0 });

const tracker = new TaskTracker();
// addTask() for each documentation unit, with dependencies as needed

const pool = new LanePool({
  maxConcurrentLanes: options.maxConcurrentTasks ?? 5,
  profilesDirs,
  sessionBaseDir: `${options.workDir}/sessions`,
  cwd: options.cwd,
  phaseId: 'writing', // REQUIRED — the phase this pool serves
  taskTracker: tracker,
  onStatus: options.onStatus,
  maxStepRetries: 5,
  getStepsForTask: (task) => [
    { name: 'draft', profileId: 'writer', isReadOnly: false },
    { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: ReviewSchema },
  ],
});

const result = await pool.run();
onStatus?.onPhaseComplete?.({ phase: 'writing', durationMs: 0 });
console.log(`Drafted ${result.completedTasks} pages; ${result.failedTasks} failed.`);
```

### How a lane processes a task

For each claimed task, the lane walks the steps returned by `getStepsForTask` in order:

1. Load the profile (read-only steps strip `write`/`edit`). Create a persisted harness session
   at `{sessionBaseDir}/{taskId}/{execCount}-{stepIndex}-{stepName}/`.
2. Inside `runStep`, fire `onAgentSpawn` and then `onStepStart` (in that order, so the step's
   `agentKey` is populated before `step_started` is recorded).
3. Build the prompt — including any pre-loaded file contents from `task.files` and the task's
   accumulated `reviewFeedback`.
4. Run the prompt. If the step has a `schema`, the response is parsed and validated (3 attempts
   on the first try, 1 attempt on retries); otherwise the raw text is used.
5. Decide approval. If the step has no `schema`, it is always "approved" and the lane advances.
   With a `schema`, `isApproved(result)` (default: `result.approved === true`) decides.
6. On **approval**, advance to the next step. When the last step is approved, the task is
   marked complete and the lane claims the next one.
7. On **rejection**, append `getFeedback(result)` (default: `result.feedback ?? 'No feedback
provided'`) to the task's `reviewFeedback`, fire an `onDecision` event, and **back up exactly
   one step** (clamped at 0) so the previous step re-runs with the feedback in its prompt.
8. After `maxStepRetries` (default `5`) rejections on a step, the task is finished. If the
   reviewer's `severity` is `critical` or `high`, the task fails; otherwise (medium/low/missing)
   the pool submits it as complete with the feedback attached.

> There is **no exponential backoff** in the pool. Lanes that find no work poll again after a
> fixed `laneWaitTimeoutMs` (default `60000` ms). A lane warns once if it stalls for many
> consecutive timeouts.

### `LanePoolOptions` reference

| Field                | Required          | Description                                                                                                                                                                                                                      |
| -------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrentLanes` | **Yes**           | Number of concurrent lanes (workers).                                                                                                                                                                                            |
| `profilesDirs`       | **Yes**           | Directories to load profiles from.                                                                                                                                                                                               |
| `sessionBaseDir`     | **Yes**           | Base directory for persisted sessions.                                                                                                                                                                                           |
| `cwd`                | **Yes**           | Working directory for agent operations.                                                                                                                                                                                          |
| `taskTracker`        | **Yes**           | Shared `TaskTracker` lanes claim from.                                                                                                                                                                                           |
| `getStepsForTask`    | No                | `(task) => StepDefinition[]` returning the ordered steps. The pool wraps these in linearStepsRunner.                                                                                                                             |
| `getRunnerForTask`   | No                | `(task) => TaskRunner`. Custom runner; takes precedence over `getStepsForTask`.                                                                                                                                                  |
| `phaseId`            | **Yes**           | The phase this pool serves. Propagated to every callback.                                                                                                                                                                        |
| `onStatus?`          | No                | Status callbacks.                                                                                                                                                                                                                |
| `apiKeys?`           | No                | Provider → API key overrides.                                                                                                                                                                                                    |
| `auditLog?`          | No                | Audit log for events.                                                                                                                                                                                                            |
| `maxStepRetries?`    | No                | Max retries per step on rejection (default `5`).                                                                                                                                                                                 |
| `laneWaitTimeoutMs?` | No                | Lane idle poll interval (default `60000`).                                                                                                                                                                                       |
| `signal?`            | No                | Abort signal.                                                                                                                                                                                                                    |
| `hookRegistry?`      | `HookRegistry`    | Optional registry of workflow hooks. Forward `options.hookRegistry` (engine-assembled via `composeHooks`) to activate the pool/step/scheduler hooks. When absent, `runStep` calls `buildPrompt` directly — zero behavior change. |
| `worktreeManager?`   | `WorktreeManager` | Per-run worktree manager. When set, each claimed task gets its own worktree (branched off the main worktree) that is squash-merged on success and culled on failure/retry.                                                       |

`pool.run()` returns `{ completedTasks: number; failedTasks: number }`.

> **When there is nothing to do.** If the tracker has no tasks, `pool.run()` returns
> `{ completedTasks: 0, failedTasks: 0 }` **without loading profiles or spawning lanes**.

---

## 7. Structured output with Zod

Both `runStepTask` and `LanePool` steps accept a `schema`. When provided:

- The schema is turned into a human-readable description and appended to the prompt
  (`schemaToString`), so the model knows the exact shape to produce.
- The response is parsed with `extractJsonFromText` (fenced ```json blocks first, then bracket
counting with string/escape awareness), repaired with `parseJsonWithRepair`, and validated
with `schema.safeParse`.
- On failure, the prompt is rebuilt from scratch with the latest error and retried. The default
  is **3 attempts** for `runStepTask` and for a step's first try, **1 attempt** for retries.

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

For reviewer steps, include an `approved: boolean` and a `feedback: string` field — these are
the defaults the pool looks for. You can override the approval/feedback extraction per step with
`isApproved` and `getFeedback`.

---

## 8. The complete worked example: `apidoc`

We now have every primitive. Let's assemble the full workflow. `apidoc` generates API reference
documentation in four phases:

1. **Scout** (single agent) — read the codebase, produce a summary and a list of public files.
2. **Outline** (single agent) — turn the scout result into a list of doc pages to write.
3. **Write** (`LanePool`, multi-step) — for each page, draft it then have a reviewer approve it.
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
  LanePool,
  resolveProfilesDirs,
  runStepTask,
  TaskTracker,
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
  const scout = await runStepTask({
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
  const outline = await runStepTask({
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

  // ── Phase 3: Write (LanePool, draft → review per page) ──────────────────
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

  const pool = new LanePool({
    maxConcurrentLanes: options.maxConcurrentTasks ?? 5,
    profilesDirs,
    sessionBaseDir: `${workDir}/sessions`,
    cwd,
    phaseId: 'writing',
    taskTracker: tracker,
    onStatus,
    maxStepRetries: 5,
    getStepsForTask: (task) => [
      { name: 'draft', profileId: 'writer', isReadOnly: false },
      { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: ReviewSchema },
    ],
  });

  const result = await pool.run();
  onStatus?.onPhaseComplete?.({ phase: 'writing', durationMs: 0 });
  console.log(`Pages drafted: ${result.completedTasks}, failed: ${result.failedTasks}`);

  // ── Phase 4: Index ──────────────────────────────────────────────────────
  onStatus?.onPhaseStart?.({ phase: 'indexing', round: 0 });
  await runStepTask({
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
list for the current phase, and an agent log with a step tab bar. Open the printed URL on your
phone to watch the same view in a browser.

### 8.4 What you can observe

- During **Scout** and **Outline**, a single task appears with one step. The agent log shows
  its turns, tool calls (reads of source files), and token usage.
- During **Write**, a task appears per page (up to `maxConcurrent` at once, sorted fewest
  dependencies first). Each task has two steps — `draft` and `review`. When a reviewer rejects,
  you will see an `onDecision` line in the log and the `draft` step re-run with the feedback
  appended. The tab bar at the bottom of the agent log lets you switch between the draft and
  review agents.
- After `maxStepRetries` rejections, a page either fails (severity critical/high) or is
  submitted as complete with feedback attached (medium/low/missing).

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
into per-task isolation, forward `options.worktreeManager` to `runStepTask`,
`runMultiStepTask`, or `LanePool`:

```typescript
await runStepTask({
  // …
  cwd: options.cwd,
  worktreeManager: options.worktreeManager, // ← enables per-task worktree
});
```

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

```typescript
import {
  createLintValidationGate,
  resolveProfilesDirs,
  runStepTask,
  type WorkflowModule,
  type WorkflowRunOptions,
} from '@harms-haus/engin-engine';

export async function run(taskPrompt: string, options: WorkflowRunOptions) {
  const { cwd, onStatus } = options;
  const profilesDirs = resolveProfilesDirs(cwd, 'my-workflow');

  await runStepTask({
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

Note: when you forward `options.worktreeManager` to `runStepTask` / `runMultiStepTask`, the primitive creates a per-task worktree dynamically and runs the agent inside it; `createLintValidationGate` cannot be pre-bound to that path (its callback takes no arguments), so in per-task-worktree mode the commit-time fix-up safety net is the primary lint check. Use `createLintValidationGate(cwd)` only when the task runs directly against `cwd` (no forwarded `worktreeManager`).

The gate runs `eslint --fix` + `prettier --write` (fire-and-forget), then a final
`eslint` check; if errors remain it returns `{ error }`, which triggers the validation
retry loop so the agent corrects them in its existing tool loop. A commit-failure safety
net (a tooled, self-verifying fix-up agent) catches anything the gate misses.

---

## 10. Patterns and tips

### Use the `files` field to pre-load context

Every task in a `LanePool` accepts a `files: string[]`. Paths are resolved relative to `cwd`;
their contents are injected into the prompt as fenced code blocks (with language detection)
before the prompt body. Binary files are skipped; files over 10 KB are truncated. This is far
cheaper and more reliable than asking the agent to find and read the right files itself.

### Thread intermediate results through prompts

Phases are independent — the pool does not know what the scout produced. Thread results
yourself by capturing the return value of `runStepTask` and interpolating it into the next
phase's prompt (as we did with `scout.summary` and `outline.pages`). For larger payloads,
write them to a file in `workDir` and reference the path.

### Model the dependency graph

Tasks declare `dependencies: string[]`. The `TaskTracker` resolves the graph, serves ready
tasks first, and throws on cycles at `addTask` time. Use this when some units must finish
before others (for example, a "shared types" page that other pages reference). For independent
units, use an empty array.

### Choose read-only steps deliberately

A step with `isReadOnly: true` cannot modify files. Use it for reviewers and for any analysis
step. The pool enforces it by adding `write` and `edit` to the profile's exclude list.

### Keep task IDs and step names filesystem-safe

Session directories are built from `{taskId}/{execCount}-{stepIndex}-{stepName}`. Both are
validated against `^[a-zA-Z0-9_-]+$`. Use kebab-case IDs.

### Respect the abort signal at phase boundaries

`runStepTask` checks `signal.aborted` once at the start. Between phases, check
`options.signal?.aborted` yourself and return early if the user cancelled. Inside a `LanePool`,
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
you, but pool/step hooks only fire if you forward it into the `LanePool` / `runStepTask` you
construct. A workflow with no `hooks` field (or an empty registry) is byte-for-byte unchanged —
every seam is gated on `hasSubscribers(name)` and falls back to the legacy path.

> **NOTE — Step definitions shown at task registration** (`onTaskRegister`, used by the TUI/web AgentLog + step-progress) come from `getStepsForTask`. A `beforeTask` hook resolves steps at CLAIM time (later) and its result does **NOT** retroactively populate the registration-time step list — so for visible step/agent layout, also provide `getStepsForTask` as the synchronous seed.

### Example (a) — `beforeStepPrompt` (pipeline): inject custom context

`beforeStepPrompt` is a **pipeline** hook: each subscriber receives the current prompt string
and returns the next (seeded with `task.prompt`). It fires inside `runStep` and fully replaces
`buildPrompt` when it has a subscriber. Add it to the `apidoc` writer pool so every drafted
page follows the repo's style:

```typescript
const pool = new LanePool({
  maxConcurrentLanes: options.maxConcurrentTasks ?? 5,
  profilesDirs,
  sessionBaseDir: `${workDir}/sessions`,
  cwd,
  phaseId: 'writing',
  taskTracker: tracker,
  onStatus,
  hookRegistry: options.hookRegistry, // ← activates beforeStepPrompt for this pool
  getStepsForTask: (task) => [
    { name: 'draft', profileId: 'writer', isReadOnly: false },
    { name: 'review', profileId: 'reviewer', isReadOnly: true, schema: ReviewSchema },
  ],
});

const module: WorkflowModule = {
  run,
  name: 'apidoc',
  hooks: {
    beforeStepPrompt: async (value, args) => {
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
forward `options.hookRegistry` there too (same as the `LanePool` example above):

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
- **Unit-test the building blocks.** `runStepTask`, the `TaskTracker`, and the `evolve`
  reducer are all plain functions/classes you can import and exercise in isolation. See the
  existing tests under `tests/` for patterns (e.g. `tests/core/phase-tasks.test.ts`).
- **Mock the harness.** `createHarness` accepts an `onAgentStatus` callback; for tests you can
  construct a `PromptableHarness`-shaped mock (`{ prompt, getLastAssistantText }`) and feed it
  to `promptForStructured` directly.

---

## 13. Other example shapes

The `apidoc` workflow uses every primitive. Other natural shapes, all built from the same
pieces:

- **`migrate`** — Scout the migration surface → plan migration units → `LanePool` where each
  task is `migrate → review` → final verification pass. Tasks can declare dependencies when
  some modules must migrate before others.
- **`triage`** — A single-agent scout over a backlog → a single-agent planner producing
  prioritised tasks → a `LanePool` of `investigate → summarise` (read-only) steps that never
  reject, only annotate.
- **`release-notes`** — Scout recent commits (single agent) → draft notes per area
  (`LanePool`, `draft → review`) → assemble the final changelog (single agent).
- **`audit-deps`** — Scout dependencies → plan per-package audits → `LanePool` of
  `investigate (read-only) → recommend` where the recommend step writes a report file.

Each is just a different arrangement of `runStepTask` and `LanePool` with different schemas and
profiles. Once you internalise the two primitives and the phase/task/step hierarchy, you can
model almost any multi-agent pipeline.

---

## Reference

- [Programmatic API](../reference/api.md) — every function and class.
- [Task pool & execution](../reference/task-pool.md) — the `LanePool` and `TaskTracker` in full.
- [Worktrees reference](../reference/worktrees.md) — the per-task worktree system, `.worktreecopy`,
  branch naming, merge serialization, and the final-merge UX.
- [Event store & status](../reference/event-store.md) — what every callback becomes.
- [Hooks](../reference/hooks.md) — the full hook catalog, composition rules, defaults, and wiring.
- [Authoring profiles](profiles.md) — the Markdown profile format.
- [Types reference](../reference/types.md) — `StatusCallbacks`, `StepDefinition`, `WorktreeManager`, etc.
