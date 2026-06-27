# Worktrees reference

engin runs **every git-repository workflow inside a tree of git worktrees**. There is no
opt-in flag, no parallel "no-worktree" execution path for git repos, and no per-run
branch that every task shares. Instead:

- The server creates one **main worktree** for the run, on a dedicated
  `engin/{mainSlug}` branch.
- Each **task** gets its own worktree on `engin/{mainSlug}--{taskId}`, branched off the
  main-wt branch so it inherits already-merged sibling work.
- On success the task branch is **squash-merged** into the main-wt branch (serialized),
  and the task worktree + branch are **culled**.
- On failure or retry the task worktree is **force-removed** and recreated fresh on the
  next attempt.
- When the run ends, the user is asked a **two yes/No prompt** whether to squash-merge the
  main-wt branch into real `main`, and — if conflicts arose — whether engin should resolve
  them.

The `--worktree` CLI flag is **discontinued**. Worktrees are the default execution model
for git repos; the only way to run without worktrees is the **non-git fallback**, which
warns and prompts the user to continue in-place.

Source:

- Per-run orchestrator: `packages/engine/src/core/worktree-manager.ts`.
- Git primitives + `.worktreecopy` matcher: `packages/engine/src/core/git.ts`.
- Merge / PR / commit operations + lint gate: `packages/engine/src/core/worktree-operations.ts`.
- Hardened conflict resolver: `packages/engine/src/core/worktree-lifecycle.ts`.
- Tooled, self-verifying fix-up primitive: `packages/engine/src/core/worktree-fixup.ts`.
- Per-task hook points: `packages/engine/src/core/phase-tasks.ts`,
  `packages/engine/src/pool/lane-pool.ts`.
- Run wiring: `packages/engine/src/server/run-manager.ts`,
  `packages/engine/src/server/run-executor.ts`.
- Client UX: `packages/cli/src/cli/post-worktree.ts`, `packages/cli/src/cli/commands.ts`.

---

## Overview

| Property                      | Behaviour                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default execution model       | Worktrees, for **every** git-repo run. No flag.                                                                                                       |
| Main worktree                 | One per run, at `{run-id}/worktree`, on branch `engin/{mainSlug}`.                                                                                    |
| Per-task worktree             | One per concurrent task, at `{run-id}/task-worktrees/{taskId}/`, on branch `engin/{mainSlug}--{taskId}`.                                              |
| Branch separator              | **Flat `--`** (never `/`). Avoids git's ref/file duality collision between `engin/{mainSlug}` and a per-task subdirectory.                            |
| Task merge                    | `--squash` into the main-wt branch, **serialized** via a merge chain. Task execution stays parallel.                                                  |
| Cull on success               | The task worktree + branch are force-removed after the merge commits.                                                                                 |
| Cull on failure/retry         | The task worktree + branch are force-removed before the retry recreates a fresh one.                                                                  |
| Final merge into real `main`  | User-driven, two yes/No prompts. **Squash** — one commit on `main` for the whole run.                                                                 |
| Cleanup on decline            | **None.** A "No" to either prompt means "the user will handle it manually" — every worktree and branch is preserved, with paths surfaced.             |
| Non-git cwd                   | Warn + prompt "Continue without git and worktrees? Yes/no". **Yes** → in-place run, no worktrees, no final merge. **No** → abort. No auto `git init`. |
| `.engin/` pollution           | All worktrees live under `.engin/work/{run-id}/` (gitignored). Sibling worktrees never appear in each other's `git status`.                           |
| Session / audit / event paths | Absolute and point at the original run dir (`{run-id}/…`). Nothing resolves a run-artifact path relative to the worktree `cwd`.                       |

---

## Layout

All worktrees are **filesystem siblings** under the run dir — never nested inside each
other's checked-out trees (nesting triggers git's "embedded repository" warning and makes
`git add -A` try to stage the child as a submodule).

```
.engin/work/{run-id}/                       ← gitignored; existing run artifacts live here
├── events.jsonl
├── audit/
├── worktree/                               ← MAIN worktree, branch = engin/{mainSlug}
│                                             (checked out from real main / HEAD)
├── task-worktrees/
│   ├── {taskId-A}/                         ← TASK worktree, branch = engin/{mainSlug}--{taskId-A}
│   │   │                                     (created off the MAIN worktree's branch)
│   │   └── …
│   └── {taskId-B}/
└── sessions/
    └── {taskId}/
        └── {execCount}-{stepIndex}-{stepName}/   ← existing persisted session files (unchanged)
```

Verified properties (git 2.54):

- Creating a worktree inside an already-populated run dir (with `events.jsonl`, `audit/`,
  `sessions/`) leaves the worktree's `git status` clean — run artifacts are never swept in.
- Sibling worktrees do not see each other as untracked.
- The squash chain produces **one** commit per run on real `main`.

---

## Branch naming

| Branch              | Format                       | Example                           |
| ------------------- | ---------------------------- | --------------------------------- |
| Main worktree (run) | `engin/{mainSlug}`           | `engin/add-api-docs`              |
| Task worktree       | `engin/{mainSlug}--{taskId}` | `engin/add-api-docs--create-user` |

`{mainSlug}` is an LLM-generated slug from the task prompt, produced by the same
`generateTitleAndBranch` call that derives the workflow title (so there is no second
LLM round-trip). The slug is sanitised by `sanitizeBranchSlug`:

- Lowercase.
- Every non-`[a-z0-9-]` character → `-`.
- Consecutive dashes collapsed.
- Leading/trailing dashes trimmed.
- Falls back to `engin-worktree-{Date.now()}` when the result would be empty.

The per-task branch uses a **flat `--` separator**, never `/`. Git represents the ref
`engin/foo` both as a ref and as the file `.git/refs/heads/engin/foo`; a deeper path like
`engin/foo/tasks` would collide with that file-vs-directory invariant. The flat separator
sidesteps it entirely.

---

## `.worktreecopy`

There is no existing standard for populating a worktree with ignored files. Git has no such
step, and the ecosystem has not converged. engin authors this convention.

A file at the repo root named `.worktreecopy` is parsed with `.gitignore`-like semantics
(using the [`ignore`](https://www.npmjs.com/package/ignore) package, which supports
anchoring, `!` negation, trailing-`/` directory rules, and `**`). The list is **read once
from the original `cwd`** and applied to **every** worktree (main + each task). It is not
per-worktree.

### Syntax

| Prefix     | Mode      | Meaning                                                                                  |
| ---------- | --------- | ---------------------------------------------------------------------------------------- |
| (none)     | `copy`    | Matched files/dirs are copied (files via `copyFileSync`, dirs recursively via `cpSync`). |
| `@symlink` | `symlink` | Matched paths are replaced with a symlink to the source. Use for large shared dirs.      |
| `!`        | negation  | Re-include a path that an earlier pattern excluded.                                      |
| `#`        | comment   | Ignored (line must start with `#`). Blank lines are also ignored.                        |

A line may combine `@symlink` with `!` (e.g. `@symlink !node_modules/.cache`); the markers
are stripped left-to-right before matching.

`.git` and `.engin` are **always skipped** — they are never copied or symlinked.

Only the **top-level** entries of `sourceCwd` are considered for matching; there is no
recursive descent.

### Example

```
# .worktreecopy
.env
.env.local
!.env.example
.npmrc
.vscode/settings.json
@symlink node_modules
@symlink packages/*/node_modules      # workspace symlinks if not hoisted
```

### `node_modules`: symlink, not copy

Do **not** copy `node_modules` (hundreds of MB × N tasks = disk explosion + seconds-per-task
copy). Symlink it from the main checkout. Per the project's decision, symlink/lock races are
absorbed by a bounded retry rather than copy-on-write: every file operation (symlink
creation, copy, removal) is wrapped in `try/catch` with up to **3 attempts** and ~75 ms
backoff (`createSymlinkWithRetry`). Agent tasks are overwhelmingly read-mostly over
`node_modules`; true write contention is rare and a retry absorbs the common transient.

> **Do not** copy build outputs (`dist/`, `*.tsbuildinfo`, `coverage/`, `.turbo/`). Let
> them be empty and let the task's validation step regenerate them. Copying stale
> `.tsbuildinfo` causes the "tsc thinks nothing changed" bug.

### Reference functions

| Function                                                            | Behaviour                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `readWorktreeCopyEntries(cwd)`                                      | Parses `.worktreecopy` into `WorktreeCopyEntry[]` (pattern / mode / negated). `[]` when absent.             |
| `populateWorktree(sourceCwd, worktreePath, entries?)`               | Applies the entries to `worktreePath` (copy + symlink). Reads entries from `sourceCwd` when not supplied.   |
| `createSymlinkWithRetry(target, linkPath, maxRetries?, backoffMs?)` | Creates a symlink with bounded retry. No-op when the existing symlink already points to the correct target. |

---

## Lifecycle

### Run start (`RunExecutor.execute`)

The `--worktree` gate is gone. The executor probes `isGitRepo(handle.cwd)`:

- **Git available** — derive the main-wt branch via `generateTitleAndBranch` +
  `sanitizeBranchSlug` (prefixed `engin/`); construct a `WorktreeManager`; call
  `setupMainWorktree()` (which `worktreePrune`s orphans, creates the main worktree at
  `{run-id}/worktree`, populates it from `.worktreecopy`); wire the manager + worktree info
  onto the handle and `WorkflowRunOptions`. The workflow's `options.cwd` becomes the **main
  worktree path** — the transparency mechanism by which the workflow sees the worktree as
  its cwd without changing its own code.
- **Non-git cwd** — `console.warn` and run in-place (`options.cwd = handle.cwd`, no manager,
  no worktrees). The client's non-git confirm prompt (see below) runs before this point.

### Per task (`RunnerPool` session path)

Before `spawnAgent`, when a `WorktreeManager` is present:

1. `createTaskWorktree(taskId, taskPrompt?)` — creates the per-task worktree at
   `{run-id}/task-worktrees/{taskId}/` on `engin/{mainSlug}--{taskId}`, branched off the
   **main worktree** (so the task inherits already-merged sibling work), then populates it
   from `.worktreecopy`.
2. The agent's `cwd` becomes the task worktree path (not `options.cwd`).

### Task succeeds

`mergeTaskBranch(taskId)` (serialized — see [Merge serialization](#merge-serialization)):

1. **Outside the serialized section** — commit pending changes in the task worktree
   (`commitWorktreeChanges`, with the commit-failure fix-up safety net — see
   [Tooled fix-up](#the-tooled-fix-up-primitive)).
2. **Inside the serialized section** — `squashMergeBranch` the task branch into the main-wt
   branch.
   - Clean → `commitChanges` and return success.
   - Conflict → `resolveConflictsWithAgent` attempts resolution. On success, stage only the
     conflict files and commit. On failure, preserve the task worktree for manual
     intervention.
3. On a successful merge, `cullTaskWorktree(taskId)` force-removes the worktree and
   force-deletes the branch.

Returns `{ success, conflictsResolved }`.

Before a successful task's result crosses a task boundary, the engine **relativizes**
absolute worktree paths inside it to repo-relative tails. A task that ran in its own
per-task worktree may emit absolute worktree paths in its structured output (e.g. an
`issues[].file` from a code review); once that worktree is culled after the merge, those
paths would be dead for any downstream task. The engine strips them at its result-capture
seams — `RunnerPool` task processing and the `runSession` session primitive — via
`relativizePathsIn(result, [taskWorktreePath, mainWorktreePath])` (source:
`core/path-relativizer.ts`). The transform recurses over strings/objects/arrays
(longest-root-first, start-of-string boundary match, exact-root → `.`), is idempotent and
non-mutating, and leaves non-string leaves untouched. The consume side
(`pool/file-context.ts::resolveFilePath`) already resolves relative paths against the
downstream task's worktree cwd, so a relativized path resolves correctly there. This is
purely internal — not part of the public engine API.

### Task fails / retries (`RunnerPool` retry valve)

`cullTaskWorktree(taskId)` (force) runs before `resetTaskForRetry`, so the next attempt
creates a fresh worktree. Cull is idempotent and best-effort — removal errors are swallowed
and logged via `console.warn`, so cull never breaks the calling flow.

### Run end — final merge UX

Driven by the user through two yes/No prompts (see [Final merge UX](#final-merge-ux)).

---

## Merge serialization

Task **execution** is parallel; the task→main-wt **merge** is serialized. N tasks merging
`--squash` into one branch in parallel would race on the index/HEAD.

`WorktreeManager.mergeTaskBranch` chains each merge onto a single `mergeChain` promise. The
chain is reassigned **before** the await, so a concurrent caller observes the in-flight merge
and waits for it rather than racing ahead. Rejections are swallowed by the chain wrapper so a
failed merge does not break it for subsequent queued merges.

The commit step in each task worktree happens **outside** the serialized section — different
task worktrees do not contend with each other; only the squash-merge into the shared main-wt
branch does.

---

## Final merge UX

When a run reaches a terminal state and the client has captured the run's worktree
identity, the CLI runs the two-prompt final merge client-side. That identity is **not**
carried on the initial `run_started` message — the run executor populates `summary.worktree`
asynchronously (after LLM branch-slug generation + `setupMainWorktree`), and it surfaces in
subsequent `runs` list broadcasts once setup completes (see [CLI reference](cli.md) and
[Server reference](server.md)). Every action is sent to the server as a `worktree_action`
ClientMessage; the server performs the git operations and replies with a
`worktree_merge_result` ServerMessage. The client performs **no** local git operations.

### Prompt 1 — "Merge into main? yes/No"

- **yes** → `worktree_action { action: 'merge' }`. The server runs `finalMergeToMain`:
  - **Clean merge** → `cleanup` (remove main worktree, delete main-wt branch, sweep leftover
    task worktrees) → outcome `clean` (with optional `cleanupError`).
  - **Conflicts** → outcome `conflicts` (worktree/branch paths surfaced). The merge is left
    in-progress for the follow-up `resolve` / `decline`. The conflict list is stashed on the
    handle. → **Prompt 2**.
  - **Non-conflict failure** → outcome `failed` (preserve everything; do **not** clean up).
- **No** → `worktree_action { action: 'decline' }`. **Nothing is cleaned up.** This means
  "the user will handle the merge manually," not "we don't want the changes." The main
  worktree, `mainBranch`, and any remaining task worktrees/branches are preserved and their
  paths surfaced.

### Prompt 2 — "Conflicts exist on the merge. Should engin handle it? yes/No"

(Only asked after a `conflicts` outcome.)

- **yes** → `worktree_action { action: 'resolve' }`. The server runs
  `resolveFinalMergeConflicts` with the stashed conflicts + the task prompt, using the
  hardened conflict resolver.
  - **Resolved** → `cleanup` → outcome `resolved` (with optional `cleanupError`).
  - **Failed** → outcome `failed` (preserve everything).
- **No** → `worktree_action { action: 'decline' }`. The server runs `abortFinalMerge`
  (`git merge --abort`) and broadcasts outcome `declined` with the worktree/branch paths.
  Nothing is cleaned up.

### SIGINT

At either prompt, `SIGINT` preserves the worktree and resolves the prompt (the user can
finish manually).

### The `worktree_merge_result` message

| Field           | Type                                                                     | Description                                                                         |
| --------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `runId`         | `string`                                                                 | The run the result applies to.                                                      |
| `outcome`       | `'clean'` \| `'conflicts'` \| `'resolved'` \| `'failed'` \| `'declined'` | The terminal outcome of the action.                                                 |
| `cleanupError?` | `string`                                                                 | Best-effort cleanup failure message (e.g. worktree directory could not be removed). |
| `worktreePath?` | `string`                                                                 | The preserved worktree path, surfaced on `conflicts` / `failed` / `declined`.       |
| `branchName?`   | `string`                                                                 | The preserved branch name, surfaced on `conflicts` / `failed` / `declined`.         |

Cleanup runs **only** after a successful merge (Prompt 1 yes + clean, or Prompt 2 yes +
resolved). Every other path preserves everything for manual intervention.

---

## Non-git fallback

When `cwd` is not inside a git repository, engin does **not** hard-fail. The CLI warns and
prompts before submitting the run:

```
Warning: '/path/to/cwd' is not a git repository. Continue without git and worktrees? [y/N]
```

- **Yes** → the run is submitted. The server detects non-git in `RunExecutor.execute`,
  `console.warn`s, and runs in-place (`options.cwd = handle.cwd`, no worktree, no manager,
  no final merge prompt). This is why the no-worktree execution path is **retained** — it is
  the non-git fallback, reached only through this confirm prompt, not via a re-introduced
  flag.
- **No** → the CLI aborts with a pointer to `git init`.

engin never auto-runs `git init` (that would be surprising and destructive to a user's
untracked directory).

---

## The tooled fix-up primitive

Both the hardened conflict resolver and the commit/lint-failure safety net are built on the
**same** shared primitive: `runTooledFixup` (`packages/engine/src/core/worktree-fixup.ts`).

`runTooledFixup` spawns its **own** tool-using agent session (`write`/`edit`/`bash` enabled,
sandboxed to the worktree) and drives it with free-form `session.prompt()` — not
`promptForStructured` — so the agent can edit files and run shell commands to repair the
error. After each turn the worktree is **self-verified** by running `tsc --noEmit` then
`eslint` directly in the worktree (`bun test` is intentionally skipped — too slow and noisy
for a fix-up turn). On verification failure, the previous error is appended to the next
retry prompt. Bounded to `maxAttempts` (default `3`); on exhaustion, falls back to the
caller's failure path.

| Consumer                  | Error context fed to the agent                                  | On exhaustion                                               |
| ------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| Conflict resolver         | `git diff merge-base...HEAD` per conflicted path + both prompts | Abort the merge, preserve everything for manual resolution. |
| Commit-failure safety net | `lint-staged` / `eslint` stderr (the actual rule violations)    | Fall back to the task-failure path (fresh worktree retry).  |

### Primary lint defence: `createLintValidationGate`

The safety net catches what slips through; the **primary** defence is the
`createLintValidationGate(worktreePath)` helper
(`packages/engine/src/core/worktree-operations.ts`). It returns a `validateOutput` callback
was designed for the removed `runStepTask` / `runMultiStepTask` primitives
(the session-first engine validates output via runner specs instead). The helper
still works for custom `validateOutput` callbacks, but `runStepTask` no longer
exists — wire it into your own agent tool loop when you need lint verification
before committing:

```typescript
import { createLintValidationGate } from '@harms-haus/engin-engine';

const gate = createLintValidationGate(taskWorktreePath);
const result = await gate();
if (result?.error) {
  console.warn('Lint errors remain:', result.error);
}
```

### Hardened conflict resolver

`resolveConflictsWithAgent` (in `worktree-lifecycle.ts`) is built on `runTooledFixup` and
fixes the weaknesses of the prior single-shot resolver:

- **Context-rich** — fed `git diff merge-base...HEAD` per conflicted path **plus both task
  prompts**, so it sees what each side intended.
- **Multi-file aware** — resolves the entire conflict set together (renaming a symbol in
  file A may break callers in file B).
- **Self-verifying** — runs `tsc` + `eslint` after each turn, not just `stageAll`.
- **Stages only conflicts** — `git add <conflicts>`, not `git add -A`, so the agent's
  scratch/untracked files are never committed.
- **No silent write-failure swallowing** — a write failure surfaces as a failure rather
  than reporting success with conflict markers still present.
- **Capped input size** — file content fed to the model is capped (mirrors
  `generateCommitMessage`'s 8000-char cap).
- **Bounded retry** — exhaustion falls back to abort + preserve for manual resolution.

---

## What workflows see

A workflow that only reads `options.cwd` and `options.onStatus` is **unchanged** — the
worktree is transparent. When git is available:

- `options.cwd` is the **main worktree path** (not the original cwd).
- `options.worktree` carries the main worktree info.
- `options.worktreeManager` is available for workflows that opt into per-task worktree
  support (forward it to `RunnerPool` / composable runners).

See [Building a new workflow → Worktrees](../guides/building-workflows.md#worktrees) for
the authoring surface and the `.worktreecopy` convention.

---

## Where to go next

- [CLI reference](cli.md) — `run` / `resume`, the discontinued `--worktree` flag, and the
  non-git fallback prompt.
- [Server reference](server.md) — `RunManager.handleWorktreeAction`, the `worktree_action`
  / `worktree_merge_result` protocol, and the `worktreeManager?` field on `RunHandle`.
- [Types reference](types.md) — `WorktreeManager`, `WorktreeManagerOptions`,
  `TaskWorktreeInfo`, `WorktreeCopyEntry`, and the `worktree_merge_result` ServerMessage.
- [Building a new workflow](../guides/building-workflows.md) — `.worktreecopy` for authors,
  the `worktreeManager` option, and `createLintValidationGate`.
- [Task pool & execution](task-pool.md) — the per-task worktree hook points in `RunnerPool`.
