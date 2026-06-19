# Task: Add a built-in per-task git worktree system to engin

You are working on **engin**, an AI workflow orchestrator for software development built on top of
[pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). engin enforces a
rigid four-level hierarchy — **workflow → phases → tasks → steps** — where every agent is a
step-of-a-task, and runs as a long-lived server daemon over an event-sourced status model. A run
materializes on disk under `.engin/work/{run-id}/` (gitignored at `.gitignore:6`), which already
holds `events.jsonl`, `audit/`, and `sessions/{taskId}/…`.

This task introduces a **built-in worktree system** so that every task executes in an isolated git
working tree off a run-level "main" worktree, with automatic per-task merge/cull on success, fresh
worktree-on-failure, and a final user-driven squash-merge of the whole run back to real `main`. It
also formalizes the `.worktreecopy` convention (gitignore-like matching, copy **and** symlink modes)
to populate each worktree with the `.gitignore`d files the task needs to build and test.

You are expected to **research** as needed and **validate/refine** the direction below against the
codebase before writing code. The git behaviors in §6 were verified empirically against git 2.54 —
re-verify anything you doubt before relying on it. Read every file listed in §4 before designing
anything.

---

## 1. Mission

engin already ships a **single, opt-in, run-level** worktree (`--worktree` flag → `msg.worktree` →
`setupWorktree` in `worktree-lifecycle.ts`). It creates one worktree outside the repo
(`{repoRoot}/../.engin-worktree-{slug}`), copies a hand-written list from `.worktreecopy` into it,
runs the _entire_ workflow with the agent `cwd` pointed at it, and at the end offers the user
keep/discard/merge/PR. The git primitives (`git.ts`) and the merge/PR orchestrations
(`worktree-operations.ts`) are clean and reusable.

But today there is **one** worktree per run, shared by every task. Concurrent tasks mutate the same
working tree; there is no per-task isolation, no per-task branch, and no per-task merge. The
`.worktreecopy` mechanism is exact-path-only (no globs, no dirs, no symlinks).

**Your job:** make worktrees **per-task and the default**. One "main" worktree per run hosts the
accumulated result; each task gets its own worktree off the main-wt branch, is auto-squash-merged
into it on success (serialized), is culled (worktree + branch) on success or failure, and when the
run ends the user is asked whether to squash-merge the main-wt branch back into real `main`. Along
the way, formalize `.worktreecopy` into a real gitignore-like spec with copy and symlink modes so
each fresh worktree can run the project's build/test/lint without re-downloading `node_modules`.

Preserve the rigid hierarchy and the observability contract. **The `--worktree` flag is
discontinued**: this is not an opt-in layer bolted onto the existing path — worktree isolation
_becomes_ the run path for **every** run (see §2 constraint #10). The existing single-worktree code
(`setupWorktree`, `handleWorktreeAction`) is the starting point to evolve into that single path,
not a parallel path to preserve.

---

## 2. Non-negotiable constraints (firm)

1. **The workflow-author contract must not break.** Existing workflows that import from
   `@harms-haus/engin` / `@harms-haus/engin-engine` and export
   `{ run(taskPrompt, options): Promise<void> }` must compile and run unchanged. Worktrees must be
   transparent to a workflow that only reads `options.cwd` and `options.onStatus`. New capabilities
   are **additive**.

2. **Branch names must never collide via git's ref/file duality.** You **cannot** have both
   `engin/add-validation` and `engin/add-validation/t-01` as branches — git stores refs as files, so
   a ref path cannot be both a file and a directory (reproduced: `fatal: cannot lock ref
'refs/heads/engin/r1/tasks': 'refs/heads/engin/r1' exists`). **Therefore the per-task branch
   name must use a flat separator**, e.g. `engin/{mainSlug}--{taskId}`. Validate every generated
   branch name against this before creating the worktree.

3. **Per-task merges into the shared main-wt branch must be serialized.** N tasks merging
   `--squash` into one branch in parallel will race on the index/HEAD. Task _execution_ stays
   parallel; only the task→main-wt merge step goes through a mutex/queue. The merge step is the
   only place concurrency is restricted.

4. **The main→real-main merge is a squash.** The final user-driven merge of the main-wt branch into
   real `main` must produce **one** commit for the whole run (no commit-per-task pollution on
   `main`). Verified: `git -C mainWt merge --squash {runBranch} && git commit` chains cleanly and
   yields a single commit on real `main`.

5. **Session/audit/event paths are absolute and point at the original run dir.** `sessionBaseDir`
   is already passed absolute (`.engin/work/{run-id}/sessions/…`). When the harness `cwd` becomes
   the worktree, **nothing** may resolve a run-artifact path relative to the worktree `cwd`. Audit
   this before merging: every path that should land under `{run-id}/` must stay absolute.

6. **`.engin/` stays gitignored; worktrees never pollute `git status`.** All worktrees live under
   `.engin/work/{run-id}/` (verified clean: a sibling worktree does not appear as untracked in
   another worktree's `git status`, and `events.jsonl`/`audit/` are not swept in). Do **not** nest a
   worktree physically inside another worktree's checked-out tree — that triggers git's "embedded
   repository" warning and `git add -A` will try to stage the child as a submodule. Use the sibling
   layout in §5 exclusively.

7. **Failed worktrees are force-removed and recreated on retry.** `git worktree remove --force` is
   the only correct removal (agents leave trees dirty). The failed-task path must force-remove the
   worktree **and** delete its branch before `resetTaskForRetry` re-runs the task into a fresh
   worktree. Run `git worktree prune` on run start to sweep orphans from a crashed previous run.

8. **`evolve.ts` stays pure** (only `import type`). Worktree state is an execution concern. Do not
   add worktree fields to the event schema or the reducer beyond what already exists
   (`WorktreeInfo` on `WorkflowState`, added under T33). New per-task worktree bookkeeping lives in
   the engine/handle, not the event store.

9. **Cleanup is a consequence of a successful merge, never of a declined one.** Remove the main
   worktree, delete the main-wt branch, and sweep leftover task worktrees **only** after a
   successful run-end merge (clean or conflict-resolved). If the user declines the merge — or
   declines conflict resolution — **preserve everything**. A "No" means "the user will handle it
   manually," **not** "we don't want the changes": never cull, never delete branches, and surface
   the worktree/branch paths so the user can find them.
10. **Worktrees are mandatory; the `--worktree` flag is discontinued.** Every run uses worktrees —
    the per-task system is the run path, not an opt-in feature. Remove the `--worktree` / `msg.worktree`
    gate so `startRun` **always** creates the main worktree, and delete the now-dead no-worktree branch
    rather than leaving it as an escape hatch.

    **Consequence that must be handled:** a run now requires `cwd` to be inside a git repository.
    Today a non-git repo worked by simply skipping worktree creation; with worktrees mandatory that is
    no longer possible (`setupWorktree` already throws when `!isGitRepo(cwd)`). Fail fast with a clear,
    actionable message (e.g. "engin runs require a git repository for worktree isolation — run `git
init` first") when `isGitRepo(cwd)` is false. **Do not** auto-`git init` (surprising and
    destructive to a user's untracked directory). Surface this operator-facing change in the CLI help
    and the run/start docs.

This deliberately removes the migration bridge (gate → measure → flip) as a final step: build the
new single path directly, since there is no old path to preserve.

---

## 3. Background — what already exists (do not rebuild)

engin's worktree support is roughly half-built. A per-task system **extends** these, it does not
replace them:

| Existing piece              | Where                                                         | Notes                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.ts` primitives         | `packages/engine/src/core/git.ts`                             | Clean `execGit` shell wrapper. `createWorktree`/`removeWorktree` (uses `--force`)/`mergeBranch`/`stageAll`/`getDiff`/`getMainBranch`/`copyFilesToWorktree`/`readWorktreeCopyList`. **Reuse; extend with `worktreePrune`, symlink mode, and glob matching.**                         |
| `setupWorktree` (run-level) | `worktree-lifecycle.ts`                                       | Spawns a **separate `worker` harness** just to LLM-generate a branch name from the prompt, sanitizes it (lowercase, collapse dashes), creates the worktree, applies `.worktreecopy`. Created at `{repoRoot}/../.engin-worktree-{slug}` (wrong location for the new model — see §5). |
| `generateWorkflowTitle`     | `core/title-generator.ts`                                     | Already spawns a `scout` harness to LLM-generate a title from the prompt. **Fold branch-name generation into this same call** to avoid a second LLM round-trip.                                                                                                                     |
| Merge / PR orchestrations   | `worktree-operations.ts`                                      | `mergeWorktreeToMain`, `pushWorktreeAndCreatePR`, `commitWorktreeChanges`, `cleanupWorktree`. Best-effort removal surfaced via `cleanupError`. **Reuse for the main→real-main merge; add a per-task squash-merge variant.**                                                         |
| `resolveConflictsWithAgent` | `worktree-lifecycle.ts`                                       | Uses the `worker` profile. **Weak — see §7.** In the per-task model it becomes load-bearing and must be hardened.                                                                                                                                                                   |
| Post-run UX                 | `packages/cli/src/cli/post-worktree.ts`                       | `promptPostWorktreeAction` asks keep/merge/PR (1/2/3) with a server-decision callback. **Reuse the readline primitive, but replace the 3-option menu with the two yes/No prompts** (merge? → conflicts?) specified in §8 flow step 5.                                               |
| `WorktreeInfo`              | `core/types.ts`                                               | `{ worktreePath, branchName, originalCwd }`. Single object on the run handle. **Becomes a per-task map** (see §8).                                                                                                                                                                  |
| Run wiring                  | `server/run-manager.ts` (`startRun` ~L172), `run-executor.ts` | Today: `msg.worktree` → `setupWorktree` → stored on `RunHandle` → `WorkflowRunOptions.worktree`. **The `msg.worktree` gate is being removed** (§2 constraint #10); this becomes unconditional. The main worktree is created here and the final merge hooks in after completion.     |
| `.worktreecopy`             | consumed by `readWorktreeCopyList`                            | Exact-path-only, no globs, no dirs, no symlinks, copy-only. **Formalize — see §6.**                                                                                                                                                                                                 |

**Not your job to rebuild:** the `git.ts` wrapper style (sync `Bun.spawnSync`), the `cleanupError`
best-effort-removal pattern, or the server-vs-client decision split in `post-worktree.ts`.

---

## 4. Current architecture you must understand first

Read these before designing anything:

### Engine (`packages/engine/src/`)

- `core/git.ts` — every git primitive you will call or extend. Note `readWorktreeCopyList` (exact
  paths only) and `copyFilesToWorktree` (file-by-file `copyFileSync`).
- `core/worktree-lifecycle.ts` — `setupWorktree` (the branch-name agent call + sanitize + create +
  populate), `generateCommitMessage`, `resolveConflictsWithAgent` (the weak resolver), `pushAndCreatePR`.
- `core/worktree-operations.ts` — `mergeWorktreeToMain` (commit → checkout main → merge →
  conflict-resolve-or-abort → restore branch → best-effort remove), `pushWorktreeAndCreatePR`,
  `commitWorktreeChanges`, `cleanupWorktree`.
- `core/title-generator.ts` — `generateWorkflowTitle` + `TitleSchema`. The call site to extend with
  branch-name generation.
- `core/types.ts` — `WorktreeInfo`, `WorkflowRunOptions.worktree`, `HarnessCreationOptions.cwd`,
  `WorkflowState.worktree`.
- `core/harness-factory.ts` — `createHarness({ cwd, … })`. `cwd` is already arbitrary; the per-task
  worktree is just a different `cwd`. Note `allowedWriteDirs` resolves against `cwd`.
- `core/phase-tasks.ts` — `runStepTask` (~L130) and `runMultiStepTask` (~L440): **the hook points**
  where `cwd` is resolved and passed to `spawnAgent`. Per-task worktree creation hooks in where
  `sessionDir` is computed (`join(sessionBaseDir, taskId, stepName)`).
- `core/config.ts` — `getDefaultWorkDir` (`join(getLocalConfigDir(cwd), 'work', …)`),
  `getLocalConfigDir`, `resolveProfilesDirs`.
- `pool/lane-pool.ts` — `maybeRetryFailedTask` (~L147), `resetTaskForRetry` call (~L170): the
  failed-task path that must force-remove + recreate the worktree.
- `pool/runner-utils.ts`, `pool/step-execution.ts` — where `spawnAgent` is invoked and where
  `sessionPath` resolution happens.
- `server/run-manager.ts` — `startRun` (~L100–L210): `getDefaultWorkDir`, the `msg.worktree` branch,
  `RunHandle.worktree`, `handleWorktreeAction` (~L257).
- `server/run-executor.ts` — `execute()`: builds `WorkflowRunOptions`, runs the workflow, emits
  `run_complete`/`run_failed`. Where the main worktree is created before launch and where the final
  merge hooks in after completion.

### Workflows, docs, config

- `package.json` — note `simple-git-hooks` → `pre-commit: bunx lint-staged`. Hooks resolve through
  git's **shared common dir**, so they fire inside worktrees too (verified) — which means an
  unfixable lint error makes the worktree commit **throw**, not silently skip. See §7 item 1.
- `.gitignore` — `.engin/` at line 6 (the foundation of the no-pollution guarantee).
- `docs/reference/task-pool.md`, `docs/guides/building-workflows.md` — update for the worktree
  authoring surface (the `.worktreecopy` spec).

---

## 5. The layout (verified)

All worktrees are **filesystem siblings** under the run dir, not nested inside each other's
checked-out trees. This is the design decision that makes the whole thing work:

```
.engin/work/{run-id}/                       ← gitignored; existing run artifacts live here
├─ events.jsonl
├─ audit/
├─ worktree/                                ← MAIN worktree, branch = engin/{mainSlug}
│                                            (checked out from real main, or from HEAD)
└─ sessions/
   └─ {taskId}/
      ├─ 0-0-{stepName}/…                   ← existing persisted session files (unchanged)
      └─ worktree/                          ← TASK worktree, branch = engin/{mainSlug}--{taskId}
                                               (created off the MAIN worktree's branch)
```

Verified behaviors (git 2.54):

- Creating a worktree inside an already-populated run dir (with `events.jsonl`, `audit/`, `sessions/`)
  works and leaves the worktree's `git status` clean — the run artifacts are not swept in.
- Sibling worktrees do **not** see each other as untracked. (`git -C {task-wt} status` is empty.)
- Nesting a worktree _inside another worktree's checked-out tree_ triggers git's "embedded
  repository" warning and makes `git add -A` try to stage the child as a submodule. **Do not do
  this.** The sibling layout above avoids it entirely.
- The squash chain works: `git -C {task-wt} commit …` → `git -C {main-wt} merge --squash {taskBranch}`
  → `git -C {main-wt} commit` → (run end) `git -C {repoRoot} merge --squash {runBranch}` →
  `git -C {repoRoot} commit`. Real `main` gets **one** commit per run.

**Branch naming:** the run's main branch is `engin/{mainSlug}` where `{mainSlug}` is the
LLM-generated, sanitized slug (reuse `setupWorktree`'s sanitize logic, or better, fold generation
into `generateWorkflowTitle`). Each task branch is `engin/{mainSlug}--{taskId}` (flat `--`, never
`/`). Task worktrees are created off the main-wt branch, not off real `main`, so they inherit
already-merged sibling work.

---

## 6. `.worktreecopy` — the convention to formalize

There is **no existing standard** for populating a worktree with ignored files. Git deliberately
has no such step, and the ecosystem has not converged (every tool — `copy-configs`,
`git-worktree.nvim`, the VS Code worktree manager, blog recipes — rolls its own format). engin is
authoring this convention, so keep the semantics minimal and document them.

### Spec

A file at the repo root (or the run's `cwd`) named `.worktreecopy`, parsed with `.gitignore`-like
semantics:

- **Use the [`ignore`](https://www.npmjs.com/package/ignore) package** (~15 KB, zero deps, parses
  real `.gitignore` syntax) rather than `Bun.Glob`. `Bun.Glob` does not support `!` negation, so it
  cannot express "`.env*` except `.env.example`". `ignore` handles anchoring, `!`, trailing-`/`
  directory rules, and `**` correctly. (Add `ignore` to `packages/engine`.)
- **Two modes per entry**, selected by a leading marker:
  - `copy` (default): `copyFileSync`/`cp -r` the matched file/dir into the worktree. For files like
    `.env`, `.env.local`, `.npmrc`, IDE configs.
  - `symlink`: create a symlink from the worktree path → the source path. For large shared dirs
    like `node_modules`. Syntax: a leading `@symlink` token on the line, e.g.
    `@symlink node_modules`.
- Comments (`#`) and blank lines ignored (preserve current behavior).
- The list is **read once from the original `cwd`** and applied to _every_ worktree (main + each
  task). Do not make it per-worktree.

Example:

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

### `node_modules`: symlink, with retry — not copy, not lock-aware

Do **not** copy `node_modules` (hundreds of MB × N tasks = disk explosion + seconds-per-task copy).
Symlink it from the main checkout. Per the owner's decision: **ignore symlink/lock races entirely**
and instead wrap every file operation (symlink creation, copy, removal) in `try/catch` with a short
bounded retry (e.g. 3 attempts, ~50–100 ms backoff). Rationale: agent tasks are overwhelmingly
read-mostly over `node_modules`; true write contention is rare and a retry absorbs the common
transient (a file briefly held by another process). If a write-heavy task ever corrupts a shared
install, that is an acceptable known limitation for v1 — do not build copy-on-write.

> Do **not** copy build outputs (`dist/`, `*.tsbuildinfo`, `coverage/`, `.turbo/`). Let them be
> empty and let the task's validation step regenerate them. Copying stale `.tsbuildinfo` causes the
> "tsc thinks nothing changed" bug.

---

## 7. Caveats — what not to do / what to fix

1. **🔥 A commit that fails the `lint-staged`/`eslint --fix` gate must not abort the task — the
   `worker` fixes it.** `package.json` runs `simple-git-hooks` → `pre-commit: bunx lint-staged`.
   Those hooks resolve through git's **shared common dir**, so they fire inside worktrees too
   (verified empirically: committing in a worktree with a failing hook exits non-zero and leaves
   HEAD unchanged — it is _not_ silently skipped). `commitChanges` is a plain `git commit -m` with
   no `--no-verify`, and `execGit` throws on non-zero exit, so an `eslint`-unfixable error (e.g.
   `no-unused-vars`, `no-explicit-any`, complexity) makes `commitWorktreeChanges` throw. Today that
   throw propagates to `handleWorktreeAction`, which logs `⚠️ … failed` and preserves the worktree —
   tolerable for the single run-end merge, **unacceptable per-task** (every lint error would fail
   the task merge and either discard otherwise-good work or surface to the user).

   **Primary defense:** run `eslint --fix && prettier --write` as part of the task's
   `validateOutput` step, so the _implement_ agent — which has full task context — fixes its own
   lint errors in its existing tool loop, and the code is already clean by commit time.

   **Safety net:** when the commit still fails, spawn the `worker` profile **with tools** in the
   worktree, hand it the `lint-staged`/`eslint` stderr (the actual rule violations + file:line), let
   it edit + re-stage, and retry, bounded (3 attempts — mirror `promptForStructured`). On exhaustion
   fall back to the task-failure path (fresh worktree retry) or preserve for manual intervention.
   This is the **same tooled-and-self-verifying primitive** as the conflict resolver (§7 item 2) —
   factor it once and reuse for both. Do **not** `--no-verify`; that hides real problems.

2. **Do not weaken the conflict resolver — harden it.** `resolveConflictsWithAgent`
   (`worktree-lifecycle.ts`) is too weak to be load-bearing, and in the per-task model it runs on
   every task-merge (task-2 reconciling against task-1's just-merged code), not just once at run
   end. Current weaknesses to fix:
   - **Context-starved:** it gets only `taskPrompt` + the conflicted file's current blob. Feed it
     `git diff merge-base...HEAD` per conflicted path **plus both task prompts** so it sees what
     each side intended.
   - **One file at a time, blind to multi-file conflicts:** renaming a symbol in file A breaks
     callers in file B; resolving each independently produces inconsistency. Resolve the conflict
     set together.
   - **No verification:** it `stageAll`s and reports success without ever building. Let the resolver
     operate **with tools in the worktree** (edit/bash via the `worker` profile, not pure
     structured-output rewrite) so it can make multi-file fixes and **self-verify by running
     `tsc`/`bun test`**.
   - **`stageAll` sweeps in everything:** stage only the conflict files (`git add <conflicts>`),
     not `git add -A` — the agent's scratch/untracked files must not be committed.
   - **Silent `catch {}` on `writeFileSync`:** a write failure is skipped and the merge reports
     success with conflict markers still present. **This is a latent bug; fix it** — surface the
     failure.
   - **No size cap** on the file content fed to the model (unlike `generateCommitMessage`'s 8000-char
     cap). Cap it.
   - **Single-shot:** give it a retry budget (mirror `promptForStructured`'s 3-retry /
     `runWithValidationRetry` loop), and on exhaustion fall back to today's behavior (abort,
     preserve the worktree for manual intervention).

3. **Do not entangle worktree state with the DAG / event store.** `TaskTracker` and `evolve.ts`
   stay clean. Per-task worktree bookkeeping (path, branch, status) lives on the run handle / a
   per-run `WorktreeManager`, not on `Task` or in events.

4. **Do not make the per-task merge parallel.** Constraint #3. Serialize task→main-wt merges; keep
   task execution parallel.

5. **Do not copy `node_modules`.** §6. Symlink + retry.

6. **Do remove the `--worktree` flag and the no-worktree code path.** §2 constraint #10. Worktrees
   are mandatory; the gate and the dead branch go away. The one thing to add (not preserve) is the
   fast-fail when `cwd` is not a git repo.

7. **Beware `cwd`-relative path resolution after the swap.** Once the harness `cwd` is the worktree,
   any code that resolves a run-artifact path relative to `cwd` will write into the worktree instead
   of `{run-id}/`. Audit `phase-tasks.ts`, `runner-utils.ts`, `prompt-builder.ts`, and the audit-log
   appenders. `sessionBaseDir` and `workDir` are already absolute — keep them that way.

8. **`core.symlinks`** must be true (Linux default; add a one-line guard for clarity, not because
   it's likely to be false on the supported platform).

---

## 8. How the pieces compose

The run-level handle gains a per-run worktree manager and a per-task map:

```
RunHandle (server/run-manager.ts)
├─ worktree?: WorktreeInfo                 ← MAIN worktree (engin/{mainSlug}), unchanged shape
├─ worktreeManager?: WorktreeManager       ← NEW: owns main-wt + the per-task map + merge mutex
│   ├─ mainBranch: string                  ← engin/{mainSlug}
│   ├─ mainWorktreePath: string            ← {run-id}/worktree
│   ├─ taskWorktrees: Map<taskId, {path, branch, status}>
│   ├─ mergeQueue / mutex                  ← serializes task→main-wt squash merges
│   ├─ createTaskWorktree(taskId)          ← off mainBranch, branch engin/{mainSlug}--{taskId}
│   ├─ mergeTaskBranch(taskId)             ← commit-in-wt (worker fix-up on lint fail) → squash-merge into mainBranch → cull
│   ├─ cullTaskWorktree(taskId)            ← worktree remove --force + branch -D (success or fail)
│   └─ prune()                             ← git worktree prune (run-start orphan sweep)
└─ (final merge: mergeWorktreeToMain with mainBranch as source; cleanup sweeps main + leftover
    task worktrees/branches ONLY on a successful merge — never on a declined merge)
```

Flow:

1. **Run start** (`startRun`): **always** (the flag is gone) — fail fast if `!isGitRepo(cwd)` — call
   `generateWorkflowTitle` extended to also return `branchName` → sanitize → create the **main**
   worktree at `{run-id}/worktree` on branch `engin/{mainSlug}` → populate from `.worktreecopy` →
   `worktreeManager.prune()`.
2. **Per task** (`phase-tasks.ts` hook, both `runStepTask` and `runMultiStepTask`): before
   `spawnAgent`, `worktreeManager.createTaskWorktree(taskId)` → populate from `.worktreecopy` →
   pass `{taskWorktreePath}` as the harness `cwd` instead of `options.cwd`.
3. **Task succeeds:** `worktreeManager.mergeTaskBranch(taskId)` (serialized) →
   `worktreeManager.cullTaskWorktree(taskId)`.
4. **Task fails / retries:** `worktreeManager.cullTaskWorktree(taskId)` (force) →
   `resetTaskForRetry` → next attempt creates a fresh worktree.
5. **Run ends — a two-prompt, human-in-the-loop final merge:**
   - **Prompt 1:** "Merge into main? yes/No".
     - **yes** → squash-merge `mainBranch` into real `main` via `mergeWorktreeToMain`. If the merge
       is clean → go to cleanup. If conflicts arise → go to Prompt 2.
     - **No** → **do NOT clean up anything.** This means "the user will handle the merge manually,"
       _not_ "we don't want the changes." Preserve the main worktree, `mainBranch`, and any
       remaining task worktrees/branches, and tell the user where they live.
   - **Prompt 2** (only on conflict): "Conflicts exist on the merge. Should engin handle it? yes/No".
     - **yes** → run the hardened conflict resolver (§7 item 2). On success → cleanup. On
       exhaustion → abort, preserve everything for manual resolution.
     - **No** → abort the merge (`merge --abort`), preserve everything for manual resolution.
   - **Cleanup** (only after a successful merge — Prompt 1 yes + clean or resolved): remove the
     **main** worktree, delete `mainBranch`, and sweep any leftover **task** worktrees/branches
     (most are already culled at task completion; this reaps stragglers). Best-effort, surfaced via
     `cleanupError`. **Never** clean up on a declined merge or declined conflict resolution.

   This replaces the existing three-option `promptPostWorktreeAction` (keep/merge/PR) at the run
   end — the PR option is dropped. If a PR flow is still wanted, add it as an explicit third path
   rather than re-broadening the merge prompt. The `post-worktree.ts` readline UX is still the right
   primitive to reuse for the two yes/No questions.

---

## 9. Suggested ordering (lowest risk → highest payoff)

1. **Extend `git.ts`.** Add `worktreePrune`, a force-aware remove wrapper that reports `prunable`
   state, symlink creation + the bounded-retry `try/catch` helper, and the `ignore`-based
   `.worktreecopy` matcher (copy + symlink modes). Pure, unit-testable, no behavior change yet.
2. **Fold branch-name generation into `generateWorkflowTitle`.** One LLM call returns
   `{ title, branchName }`. Delete the separate `worker`-harness call in `setupWorktree`.
3. **Relocate the main worktree into `{run-id}/worktree`.** Change the path in `setupWorktree`;
   update `run-manager.ts` to create it unconditionally (the `msg.worktree` gate is gone) and to
   fast-fail on non-git `cwd`. Verify clean `git status` and that `.worktreecopy` populates.
4. **Add `WorktreeManager` + per-task worktrees in `phase-tasks.ts`.** Gated on the run having a
   main worktree. Wire the failed-task cull into `lane-pool.ts::maybeRetryFailedTask`. This is the
   core change.
5. **Serialize task→main-wt merges.** Add the mutex/queue around `mergeTaskBranch`.
6. **Build the shared tooled-and-self-verifying agent fix-up primitive + the validation gate.**
   This is the shared engine for both the hardened conflict resolver (§7 item 2) and the
   commit/lint-failure safety net (§7 item 1): `worker` profile with tools in the worktree, fed the
   error context (conflict diffs or `eslint` stderr), edits + re-stages + self-verifies
   (`tsc`/`bun test`/`eslint`), bounded retry, exhaustion → fall back. Factor once, reuse twice.
   Wire `eslint --fix && prettier --write` into `validateOutput` as the primary lint defense.
7. **Harden `resolveConflictsWithAgent`** on top of the primitive from step 6: real conflict
   context, multi-file, stage-only-conflicts, cap input size, fix the silent-write-failure bug.
8. **Wire the commit-failure worker fix-up** into `commitWorktreeChanges` (and therefore
   `mergeTaskBranch`), so an unfixable-on-first-pass lint error is auto-corrected instead of a
   thrown task failure.
9. **Wire the two-prompt run-end final merge** (§8 flow step 5): the yes/No merge prompt and the
   yes/No conflict prompt, with cleanup **only** on a successful merge and full preservation on any
   decline. Reuse `post-worktree.ts`'s readline primitive.
10. **Remove the `--worktree` flag and the no-worktree code path entirely.** Delete the gate in
    `run-manager.ts` and any CLI flag plumbing; the worktree path from step 3 is now the only path.
    Add the non-git fast-fail message. Update CLI help + docs to reflect that every run uses
    worktrees and requires a git repo.

---

## 10. You are expected to research more

The above is a design evaluation, not an implementation spec. Before implementing each tier, read
the authoritative sources and decide how they adapt to engin's event model and rigid hierarchy.
Useful starting points:

- **pnpm + git worktrees** ([pnpm.io/git-worktrees](https://pnpm.io/git-worktrees)) — the closest
  thing to a "standard" for the `node_modules` sub-problem (global virtual store + per-worktree
  symlinked `node_modules`). Confirms the symlink direction; decide how engin's bun-workspace
  layout differs.
- **The `ignore` package** API and edge cases (anchoring, `!`, trailing `/`, `**`) — for the
  `.worktreecopy` matcher. Confirm it covers every gitignore idiom you want to support.
- **git worktree internals**: `gitdir` files, the `.git/worktrees/` metadata dir, `prune` semantics,
  and exactly when `post-checkout` fires on `worktree add` (verified: it fires with third arg `1`).
  Decide whether engin relies on hooks or calls populate directly.
- **Merge serialization patterns**: a simple async mutex/queue is almost certainly enough — confirm
  there is no subtler requirement (e.g. ordering tasks by dependency for fewer conflicts) before
  over-engineering.
- **Conflict-resolution-with-tools agent patterns**: how other agent harnesses (including
  pi-coding-agent's own tool loop) let an agent edit files and run a build inside a loop. Mirror
  engin's existing `runWithValidationRetry` / `promptForStructured` retry shapes.

If you find a pattern that fits better than the recommended direction, say so and explain why. If
the direction contradicts something in the codebase, surface it rather than forcing the design.

---

## 11. Deliver

- Working code under `packages/engine/src/` (extend `core/git.ts`, `core/worktree-lifecycle.ts`,
  `core/worktree-operations.ts`, `core/title-generator.ts`; add a `WorktreeManager` — likely a new
  `core/worktree-manager.ts`; wire per-task creation into `core/phase-tasks.ts` and the failed-task
  cull into `pool/lane-pool.ts`; thread the main worktree through `server/run-manager.ts` /
  `server/run-executor.ts`).
- Default implementations behind every new seam so existing workflows are unchanged. (Workflows are
  untouched — they still see `options.cwd`, now the worktree path. The change is _operator-facing_:
  every run now requires a git repo and uses a worktree unconditionally.)
- The `.worktreecopy` spec implemented (copy + symlink modes, `ignore`-based matching, bounded-retry
  file operations) and the `ignore` dependency added to `packages/engine`.
- The shared tooled-and-self-verifying agent fix-up primitive, reused for both the hardened conflict
  resolver (real context, multi-file, stage-only-conflicts, no silent write-failure swallowing, cap
  input size) and the commit/lint-failure safety net (worker fix-up on a thrown commit); plus the
  `validateOutput` lint gate (`eslint --fix && prettier --write`) as the primary defense.
- The two-prompt run-end final merge: yes/No "Merge into main?" → on conflict, yes/No "Should engin
  handle it?", with worktree/branch cleanup **only** on a successful merge and full preservation on
  any decline (decline = "the user will handle it," not "discard the changes").
- Tests mirroring the repo's existing style (`packages/engine/src/**/*.test.ts`, `tests/`) covering:
  `.worktreecopy` parsing (copy/symlink/negation/anchoring), bounded-retry behavior, branch-name
  sanitize + the ref-duality guard, per-task worktree create/merge/cull lifecycle, serialized
  merges (no index race), failed-task force-cull + fresh-recreate, the commit-failure worker fix-up
  (lint error → corrected commit, exhaustion → task failure), the two-prompt run-end merge
  (yes-merge-cleans-up, no-merge-preserves, conflict-resolve-cleans-up, conflict-decline-preserves),
  conflict-decline-preserves), and the non-git fast-fail (`isGitRepo(cwd)` → clear error, no auto-init).
- Docs updates: `docs/reference/task-pool.md` (per-task worktree lifecycle),
  `docs/guides/building-workflows.md` and a new `docs/reference/worktrees.md` describing the
  `.worktreecopy` spec, the branch-naming scheme, the merge/cull model, and the final-merge UX.
