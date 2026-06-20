// ─── One-Step Task Primitive ──────────────────────────────────────────────────

import { join } from 'node:path';
import type { ZodType } from 'zod';
import type { HookRegistry } from '../hooks/types.js';
import { assertSafeName } from '../pool/validation.js';
import type { AgentLifecycleHandle } from './agent-lifecycle.js';
import { spawnAgent } from './agent-lifecycle.js';
import { relativizePathsIn } from './path-relativizer.js';
import { loadProfilesFromDirs } from './profile.js';
import { invokeRenderer } from './renderer-invocation.js';
import type { RendererRegistry } from './renderer-registry.js';
import { promptForStructured } from './structured-output.js';
import type { AgentProfile, StatusCallbacks, StepDefinition, Task } from './types.js';
import { safeErrorMessage } from './utils.js';
import { runWithValidationRetry } from './validation-retry.js';
import type { WorktreeManager } from './worktree-manager.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RunStepTaskOptions {
  /** Directories to search for agent profile .md files */
  profilesDirs: string[];
  /** Phase identifier for status callbacks */
  phaseId: string;
  /** Unique task identifier */
  taskId: string;
  /** Human-readable task title */
  title: string;
  /** Name of the step (displayed in status callbacks) */
  stepName: string;
  /** Profile ID to load */
  profileId: string;
  /** Working directory for the agent */
  cwd: string;
  /** Optional API key overrides by provider */
  apiKeys?: Record<string, string>;
  /** Status callback handlers */
  onStatus?: StatusCallbacks;
  /** When true, write/edit tools are stripped from the agent's toolset */
  isReadOnly?: boolean;
  /**
   * Optional write sandbox: when set, `write`/`edit` calls whose target path
   * resolves outside these directories are blocked. Paths resolve against `cwd`.
   * Ignored when `isReadOnly` is true (write/edit are already removed).
   */
  allowedWriteDirs?: string[];
  /**
   * Base directory for a persisted session. When set, the agent's session is
   * written to `{sessionBaseDir}/{taskId}/{stepName}` on disk (so a failed
   * structured-output attempt — e.g. a reviewer that produced no JSON —
   * leaves a debuggable/resumable trace instead of vanishing with the
   * in-memory session). When absent, an in-memory session is used.
   */
  sessionBaseDir?: string;
  /** Zod schema for structured output. When absent, raw assistant text is returned. */
  schema?: ZodType<unknown>;
  /**
   * Optional validation gate for file-based agent output (used when `schema` is
   * absent). Called after each agent turn: return `{ error: string }` to
   * re-prompt the agent within the SAME session with that error appended, or
   * `undefined` / `{}` to accept. Retries up to 3 attempts total, then throws.
   *
   * Use this when an agent writes its output to a file instead of returning
   * structured text (e.g. a planner writing `plan.json`), and you want
   * schema-like validation with retries — mirroring the structured-output path
   * but reading from the filesystem instead of the response text.
   */
  validateOutput?: () => Promise<{ error?: string } | undefined> | ({ error?: string } | undefined);
  /** Optional registry of per-profile renderers that transform agent output into human-readable markdown */
  rendererRegistry?: RendererRegistry;
  /**
   * Optional registry of workflow hooks. When provided AND it has subscribers
   * for `beforeStepPrompt`, the step prompt is passed through the pipeline
   * hook (seeded with the original prompt) and the pipeline's return value
   * replaces the prompt sent to the agent. Absent or no subscribers → zero
   * behavior change.
   */
  hookRegistry?: HookRegistry;
  /**
   * Files to inline into the prompt via the engine's default `beforeStepPrompt` /
   * `collectContext` hook (seeded onto the synthesized `task.files`). Absent or
   * empty → no file context (unless a subscriber contributes it another way).
   */
  files?: string[];
  /** Prompt to send to the agent */
  prompt: string;
  /** Abort signal for cooperative cancellation */
  signal?: AbortSignal;
  /** WorktreeManager for isolated git worktree execution */
  worktreeManager?: WorktreeManager;
}

// ─── runStepTask ────────────────────────────────────────────────────────────

/**
 * Run one agent as a one-step task.
 *
 * Implements the full lifecycle:
 * 1. Check abort signal (throws without callbacks if aborted)
 * 2. Fire `onTaskRegister` with the single-step definition
 * 3. Fire `onTaskStart`
 * 4. Load profiles, then spawn the agent via `spawnAgent`
 *    (profile lookup + read-only adjustment + harness creation +
 *     onAgentSpawn + onStepStart)
 * 5. Run the prompt (structured or free-form)
 * 6. In finally: fire `onAgentComplete`, dispose harness
 * 7. On error: fire `onTaskRejected` before re-throwing
 * 8. On success: fire `onTaskComplete` and return result
 */
export async function runStepTask<T = unknown>(opts: RunStepTaskOptions): Promise<T> {
  const {
    profilesDirs,
    phaseId,
    taskId,
    title,
    stepName,
    profileId,
    cwd,
    apiKeys,
    onStatus,
    isReadOnly = false,
    allowedWriteDirs,
    sessionBaseDir,
    schema,
    validateOutput,
    rendererRegistry,
    hookRegistry,
    files,
    prompt,
    signal,
    worktreeManager,
  } = opts;

  // 1. Early abort check — fired before any callbacks
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // 2. Register the task
  onStatus?.onTaskRegister?.({
    taskId,
    phaseId,
    title,
    dependencies: [],
    steps: [{ name: stepName, profileId, isReadOnly }],
  });

  // 3. Signal start
  onStatus?.onTaskStart?.({ taskId, title, agentId: taskId, phaseId, startedAt: Date.now() });

  // 3b. Create a per-task worktree BEFORE the main try block (so a creation
  //     failure propagates without engaging the merge/cull/reject path).
  //     The worktree path replaces the agent cwd and write sandbox; the
  //     persisted sessionDir stays derived from sessionBaseDir (NOT the
  //     worktree path) so session traces remain in the run dir.
  let effectiveCwd = cwd;
  let effectiveAllowedWriteDirs = allowedWriteDirs;
  if (worktreeManager) {
    const taskWorktreePath = await worktreeManager.createTaskWorktree(taskId, prompt);
    effectiveCwd = taskWorktreePath;
    effectiveAllowedWriteDirs = [taskWorktreePath];
  }

  let result: T;
  let handle: AgentLifecycleHandle | undefined;

  try {
    // 4. Load profiles and spawn the agent (read-only adjustment + harness
    //    creation + activeSessions-less tracking + onAgentSpawn + onStepStart).
    //    When `sessionBaseDir` is provided the session is persisted to
    //    `{sessionBaseDir}/{taskId}/{stepName}`; otherwise spawnAgent falls
    //    back to an in-memory session and resolves sessionPath to the sessionId.
    const profiles = await loadProfilesFromDirs(profilesDirs);
    // Pre-check so the error message can reference the profiles directories
    // (runStepTask-specific debugging context spawnAgent doesn't have).
    if (!profiles.has(profileId)) {
      throw new Error(`Profile "${profileId}" not found in directories: ${profilesDirs.join(', ')}`);
    }

    // Resolve an optional persisted-session directory (mirrors runMultiStepTask).
    // Validate against path traversal only when we actually interpolate paths.
    if (sessionBaseDir) {
      assertSafeName(taskId, 'task id');
      assertSafeName(stepName, 'step name');
    }
    const sessionDir = sessionBaseDir ? join(sessionBaseDir, taskId, stepName) : undefined;

    handle = await spawnAgent(
      {
        profileId,
        agentId: taskId,
        cwd: effectiveCwd,
        phaseId,
        taskId,
        stepIndex: 0,
        stepName,
        isReadOnly,
        apiKeys,
        allowedWriteDirs: effectiveAllowedWriteDirs,
        sessionDir,
        onStatus,
      },
      profiles,
    );

    // 7b. `beforeStepPrompt` hook seam: when a hookRegistry with subscribers
    //     is threaded in, the pipeline transforms the prompt (seeded with the
    //     original prompt) and its return value replaces the prompt sent to
    //     the agent. Mirrors step-execution.ts's hook seam. Zero behavior
    //     change when no hookRegistry or no subscribers: the original prompt
    //     is used verbatim. effectiveCwd (the worktree path, or the original
    //     cwd when no worktree is in use) is forwarded as both `cwd` and
    //     `worktreeCwd` so subscribers see where the agent will actually run.
    const task: Task = {
      id: taskId,
      title,
      prompt,
      profile: profileId,
      files: files ?? [],
      dependencies: [],
      status: 'ready',
      phaseId,
    };
    const step: StepDefinition = {
      name: stepName,
      profileId,
      isReadOnly,
    };
    const effectivePrompt = hookRegistry?.hasSubscribers('beforeStepPrompt')
      ? ((await hookRegistry.invokePipeline(
          'beforeStepPrompt',
          prompt,
          { task, step, prompt, cwd: effectiveCwd, worktreeCwd: effectiveCwd },
          { registry: hookRegistry, cwd: effectiveCwd, workDir: cwd, signal },
        )) as string)
      : prompt;

    // 8. Run the prompt
    if (schema) {
      const structuredResult = await promptForStructured(handle.session, effectivePrompt, schema, { maxRetries: 3 });
      result = structuredResult.result as T;

      // 8a. `onStructuredOutput` observe hook seam: fire AFTER the structured
      //     result resolves. Mirrors step-execution.ts. The default
      //     implementation (registered by LanePool.run() when an `auditLog`
      //     is available, or by the workflow directly for the runStepTask
      //     path) appends a `structured_output` event to the durable AuditLog.
      //     Zero behavior change when no `hookRegistry` or no subscribers.
      if (hookRegistry?.hasSubscribers('onStructuredOutput')) {
        await hookRegistry.invokeObserve(
          'onStructuredOutput',
          { agentId: taskId, output: structuredResult.result, taskId, phaseId, stepIndex: 0 },
          { registry: hookRegistry, cwd: effectiveCwd, workDir: cwd, signal },
        );
      }
    } else if (validateOutput) {
      // File-based output: validate after each turn and retry within the same
      // session (mirrors promptForStructured's retry, but reads from disk).
      result = (await runWithValidationRetry(handle.session, effectivePrompt, validateOutput)) as T;
    } else {
      await handle.session.prompt(effectivePrompt);
      result = handle.session.getLastAssistantText() as T;
    }

    // Relativize absolute worktree paths emitted into the result so downstream
    // tasks (possibly in a fresh worktree) resolve them correctly. Idempotent;
    // a no-op when no worktreeManager is in play (roots then resolve to just
    // [effectiveCwd], which only matches result strings that literally
    // contain the agent's own cwd). The renderer below reads
    // handle.session.getLastAssistantText() directly (NOT `result`), so
    // reassigning `result` here is safe.
    const roots = [effectiveCwd, worktreeManager?.mainWorktreePath].filter(Boolean) as string[];
    result = relativizePathsIn(result, roots) as T;

    // 8b. Renderer invocation — transform agent output into human-readable form.
    // getLastAssistantText() is fetched lazily (only when a renderer is
    // registered for this profile) to mirror the original inline guard
    // ordering and avoid an unnecessary retrieval when no renderer applies.
    if (rendererRegistry?.get(profileId)) {
      invokeRenderer(
        rendererRegistry,
        profileId,
        handle.session.getLastAssistantText(),
        taskId,
        taskId,
        onStatus?.onAgentRender,
      );
    }

    // 8c. Worktree merge — runs AFTER the agent produces its result but BEFORE
    //     onTaskComplete. A failed merge (success=false or thrown error) falls
    //     through to the catch block, which OWNS the onTaskRejected callback
    //     (firing it exactly once via safeErrorMessage) and culls the worktree.
    //     onTaskRejected must NOT be called here — the surrounding catch block
    //     already handles it, so a redundant call here would emit a second
    //     rejection event for the same logical failure. The sessionDir is
    //     intentionally left pointing at sessionBaseDir (not the worktree path)
    //     so session traces persist in the run dir regardless of the merge
    //     outcome.
    if (worktreeManager) {
      const mergeResult = await worktreeManager.mergeTaskBranch(taskId);
      if (!mergeResult.success) {
        const errorMessage = 'Task merge failed: conflicts could not be resolved automatically';
        throw new Error(errorMessage);
      }
    }
  } catch (err) {
    // 10. Error handling — best-effort cull the worktree (force-removes the
    //     failed task's worktree + branch), then fire onTaskRejected before
    //     re-throwing. Cull failures are swallowed so a cleanup error never
    //     masks the original failure.
    if (worktreeManager) {
      try {
        await worktreeManager.cullTaskWorktree(taskId);
      } catch {
        /* best-effort — never let cull mask the original error */
      }
    }
    const errorMessage = safeErrorMessage(err);
    onStatus?.onTaskRejected?.({ taskId, title, reason: errorMessage });
    throw err;
  } finally {
    // 9. Fire agent complete and dispose harness. handle.complete() fires
    //    onAgentComplete (mirrors the original try/finally ordering where the
    //    callback runs before dispose); handle.dispose() tears down the harness.
    if (handle) {
      handle.complete();
      handle.dispose();
    }
  }

  // 11. On success — fire task complete and return result
  onStatus?.onTaskComplete?.({ taskId, title });
  return result;
}

// ─── Multi-Step Task Primitive ──────────────────────────────────────────────

/**
 * One step within a {@link runMultiStepTask}.
 *
 * Each step runs in its OWN agent session (its own profile, system prompt, and
 * context window) — exactly like the implementation phase's per-step agents.
 * Steps run sequentially within a single registered task.
 */
export interface MultiStepDefinition {
  /** Name of the step (displayed in status callbacks). */
  stepName: string;
  /** Profile ID to load for this step's agent. */
  profileId: string;
  /**
   * Prompt to send to the agent. May be a function evaluated at step-run time
   * and receiving the results of previously-completed steps (in order), so a
   * later step can read artifacts an earlier step produced (e.g. a file written
   * to disk) without that data being available up front. The function also
   * receives a context object whose `attempt` field is the per-step execution
   * count (0 = first execution of this step; incremented on each
   * back-up-and-retry re-execution), so a prompt can branch on retries.
   *
   * NOTE on `ctx.attempt`: this is the per-step EXECUTION count, sourced from
   * the `stepExecutions` map (incremented every time the step is entered).
   * It is NOT the same as `RunStepContext.attempt` (in
   * `pool/step-execution.ts`), which is the per-step REJECTION counter
   * (populated from `stepAttempts`) used internally by the LanePool's `runStep`
   * — a different type in a different module with the same field name. The two
   * diverge: a step that is entered but never rejected has
   * `ctx.attempt` advance per execution while `RunStepContext.attempt` would
   * stay 0. We deliberately expose the execution count here (via
   * `stepExecutions`) rather than `stepAttempts`, because `stepAttempts` only
   * increments on rejection and would remain 0 forever for ungated steps,
   * making it useless for eliding inlined context on re-runs. When writing a
   * lazy prompt that needs `ctx.attempt`, guard defensively (`ctx?.attempt ??
   * 0`) since some external callers/mocks may invoke the function with only
   * one argument.
   */
  prompt: string | ((priorResults: unknown[], ctx: { attempt: number }) => Promise<string> | string);
  /** When true, write/edit tools are stripped from this step's agent. */
  isReadOnly?: boolean;
  /** Write sandbox dirs for this step (ignored when `isReadOnly` is true). */
  allowedWriteDirs?: string[];
  /** Zod schema for structured output. When absent, raw assistant text is returned. */
  schema?: ZodType<unknown>;
  /**
   * File-output validation gate (used when `schema` is absent). Called after
   * each agent turn: return `{ error }` to re-prompt within the SAME session,
   * or `undefined`/`{}` to accept. Mirrors {@link RunStepTaskOptions.validateOutput}.
   */
  validateOutput?: () => Promise<{ error?: string } | undefined> | ({ error?: string } | undefined);
  /**
   * Approval gate over the step's result. Return `true` to advance to the next
   * step; return `false` to reject, back up one step, and retry (up to
   * `maxStepRetries`). Defaults to always-approved.
   */
  isApproved?: (result: unknown) => boolean;
  /** Feedback text produced when this step is rejected (default: generic message). */
  getFeedback?: (result: unknown) => string;
}

export interface RunMultiStepTaskOptions {
  /** Directories to search for agent profile .md files */
  profilesDirs: string[];
  /** Phase identifier for status callbacks */
  phaseId: string;
  /** Unique task identifier */
  taskId: string;
  /** Human-readable task title */
  title: string;
  /** Ordered steps to run sequentially within this task. */
  steps: MultiStepDefinition[];
  /** Working directory for the agents */
  cwd: string;
  /** Optional API key overrides by provider */
  apiKeys?: Record<string, string>;
  /** Status callback handlers */
  onStatus?: StatusCallbacks;
  /** Optional registry of per-profile renderers that transform agent output into human-readable markdown */
  rendererRegistry?: RendererRegistry;
  /**
   * Optional registry of workflow hooks. When provided AND it has subscribers
   * for `beforeStepPrompt`, each step's resolved prompt is passed through the
   * pipeline hook (seeded with the step prompt) and the pipeline's return
   * value replaces the prompt sent to the agent. Absent or no subscribers →
   * zero behavior change.
   */
  hookRegistry?: HookRegistry;
  /**
   * Files to inline into each step's prompt via the engine's default
   * `beforeStepPrompt` / `collectContext` hook (seeded onto the synthesized
   * `task.files` shared by every step). Absent or empty → no file context
   * (unless a subscriber contributes it another way).
   */
  files?: string[];
  /**
   * Base directory for persisted session storage. When set, step sessions are
   * persisted to disk and resumed across retries (so context — including
   * inlined file contents — is retained). When absent, sessions are in-memory
   * (historical behavior; no resume).
   *
   * Caveat: resume re-sends the full prompt text (prompt + accumulated feedback
   * history) into the resumed session. Stripping already-inlined file contents
   * on retry is the CALLER's responsibility via the `{ attempt }` signal on a
   * lazy prompt — runMultiStepTask itself does not elide them.
   */
  sessionBaseDir?: string;
  /** Abort signal for cooperative cancellation */
  signal?: AbortSignal;
  /** WorktreeManager for isolated git worktree execution */
  worktreeManager?: WorktreeManager;
  /**
   * Max total attempts per step before a rejection exhausts and fails the task
   * (default 3). Each back-up-and-retry of a step counts as one attempt.
   */
  maxStepRetries?: number;
}

/** Outcome of {@link runMultiStepTask}. */
export interface MultiStepTaskResult {
  /** Result of each step, indexed by step order. */
  results: unknown[];
  /** `true` when every step approved; `false` when a gate exhausted its retries. */
  approved: boolean;
}

// ─── Internal: prompt builders ──────────────────────────────────────────────

/**
 * Append the accumulated cross-step review feedback to a step's prompt. Mirrors
 * the implementation phase's `buildPrompt` feedback-history section so a
 * producing step sees every prior rejection it must address.
 */
function appendFeedbackHistory(prompt: string, history: string[]): string {
  if (history.length === 0) return prompt;
  const lines = ['', '## Review Feedback History (please address all items)'];
  history.forEach((fb, i) => {
    lines.push(`Attempt ${i + 1}: ${fb}`);
  });
  return prompt + '\n' + lines.join('\n');
}

// ─── runMultiStepTask ───────────────────────────────────────────────────────

/**
 * Run ONE task composed of N sequential steps, each in its own agent session.
 *
 * This is the multi-step sibling of {@link runStepTask}: it registers a single
 * task (with all its steps) once, then runs each step through a fresh harness —
 * a distinct profile, system prompt, and context window per step, matching the
 * implementation phase's per-step-agent model.
 *
 * A step may gate its successor via `isApproved`. When a step is rejected, the
 * runner backs up ONE step, appends the rejection feedback to that step's
 * prompt, and retries — up to `maxStepRetries` total attempts per step. This
 * lets a review step drive rework of its producer (e.g. plan → review-plan:
 * a rejected review re-runs the planner with the feedback).
 *
 * Lifecycle (status callbacks):
 * 1. `onTaskRegister` once, with every step.
 * 2. `onTaskStart` once.
 * 3. Per step: `onAgentSpawn` → `onStepStart` → (run) → `onAgentRender`? → `onAgentComplete`.
 * 4. On rejection: `onDecision` per attempt.
 * 5. On success: `onTaskComplete`. On failure/exhaustion: `onTaskRejected`.
 *
 * Returns `{ results, approved }`. `approved === false` means a gate exhausted
 * its retries without passing (the task did NOT complete cleanly); callers that
 * want best-effort behavior can still inspect `results`.
 */
export async function runMultiStepTask(opts: RunMultiStepTaskOptions): Promise<MultiStepTaskResult> {
  const {
    profilesDirs,
    phaseId,
    taskId,
    title,
    steps,
    cwd,
    apiKeys,
    onStatus,
    rendererRegistry,
    hookRegistry,
    files,
    sessionBaseDir,
    signal,
    maxStepRetries = 3,
    worktreeManager,
  } = opts;

  // 1. Early abort — fired before any callbacks
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // 2. Validate steps
  if (steps.length === 0) {
    throw new Error(`Task "${taskId}" has no steps`);
  }

  // 3. Register the task (all steps) and signal start
  onStatus?.onTaskRegister?.({
    taskId,
    phaseId,
    title,
    dependencies: [],
    steps: steps.map((s) => ({ name: s.stepName, profileId: s.profileId, isReadOnly: s.isReadOnly ?? false })),
  });

  onStatus?.onTaskStart?.({ taskId, title, agentId: taskId, phaseId, startedAt: Date.now() });

  // 3b. Create ONE per-task worktree for the whole task BEFORE the first
  //     step (so a creation failure propagates without engaging the
  //     merge/cull/reject path). Every step's agent then runs with cwd =
  //     the worktree path. The task title is passed as the taskPrompt so
  //     the WorkTreeManager's commit/conflict-resolution agent has a
  //     meaningful description (there is no single canonical prompt for a
  //     multi-step task).
  let effectiveCwd = cwd;
  if (worktreeManager) {
    const taskWorktreePath = await worktreeManager.createTaskWorktree(taskId, title);
    effectiveCwd = taskWorktreePath;
  }

  const results: unknown[] = [];
  const feedbackHistory: string[] = [];
  const stepAttempts = new Map<number, number>();
  // Per-step execution count (0-indexed); incremented at the TOP of each
  // iteration. Used as the `attempt` context for lazy prompts and to build
  // persisted session directory names. NOTE: stepAttempts only increments on
  // rejection, so it CANNOT be used here (it stays 0 for ungated steps).
  const stepExecutions = new Map<number, number>();
  // Per-step persisted session file path (captured before dispose) so a
  // re-executed step can resume its prior session.
  const sessionPaths = new Map<number, string>();

  // 4. Load profiles once (shared across all steps)
  let profiles: Map<string, AgentProfile>;
  try {
    profiles = await loadProfilesFromDirs(profilesDirs);
  } catch (err) {
    const errorMessage = safeErrorMessage(err);
    onStatus?.onTaskRejected?.({ taskId, title, reason: errorMessage });
    throw err;
  }

  try {
    // Synthesize a minimal Task for the hook args. runMultiStepTask has no
    // single canonical prompt/profile (those are per-step), so `prompt` and
    // `profile` are left empty — the meaningful per-step prompt is carried in
    // the `step` and `prompt` fields of the hook args.
    const task: Task = {
      id: taskId,
      title,
      prompt: '',
      profile: '',
      files: files ?? [],
      dependencies: [],
      status: 'ready',
      phaseId,
    };

    let stepIndex = 0;

    while (stepIndex < steps.length) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const step = steps[stepIndex];

      // Track per-step execution count (mirrors linear-steps-runner's
      // stepExecutions). Increment at the TOP of each iteration so the first
      // execution is attempt 0 and each back-up-and-retry increments it.
      const execCount = stepExecutions.get(stepIndex) ?? 0;
      stepExecutions.set(stepIndex, execCount + 1);

      // 4a. Profile existence check (preserves the richer error message that
      //     references the profiles directories; spawnAgent re-validates the
      //     lookup as a defensive guard and owns the read-only adjustment).
      if (!profiles.has(step.profileId)) {
        throw new Error(`Profile "${step.profileId}" not found in directories: ${profilesDirs.join(', ')}`);
      }

      // 4b. Resolve prompt (may be lazy) and append accumulated feedback.
      //     Pass a snapshot copy so a lazy prompt can't observe later mutations
      //     to the shared results array. The context carries the per-step
      //     execution count (attempt) so a lazy prompt can branch on retries.
      const basePrompt =
        typeof step.prompt === 'function' ? await step.prompt([...results], { attempt: execCount }) : step.prompt;
      const promptText = appendFeedbackHistory(basePrompt, feedbackHistory);

      // 4b-2. `beforeStepPrompt` hook seam: when a hookRegistry with
      //       subscribers is threaded in, the pipeline transforms the resolved
      //       step prompt (seeded with `promptText`) and its return value
      //       replaces the prompt sent to the agent. Mirrors runStepTask /
      //       step-execution.ts. Zero behavior change when no hookRegistry or
      //       no subscribers.
      const stepDefinition: StepDefinition = {
        name: step.stepName,
        profileId: step.profileId,
        isReadOnly: step.isReadOnly ?? false,
      };
      const effectivePrompt = hookRegistry?.hasSubscribers('beforeStepPrompt')
        ? ((await hookRegistry.invokePipeline(
            'beforeStepPrompt',
            promptText,
            { task, step: stepDefinition, prompt: promptText, cwd: effectiveCwd, worktreeCwd: effectiveCwd },
            { registry: hookRegistry, cwd: effectiveCwd, workDir: cwd, signal },
          )) as string)
        : promptText;

      // 4c. Resolve session dir / resume path (own session for this step).
      //     - If a session for this step was persisted on a prior execution →
      //       resume it (so context — including inlined file contents — is
      //       retained across retries).
      //     - Else if sessionBaseDir is set → start a new persisted session in
      //       `{sessionBaseDir}/{taskId}/{execCount}-{stepIndex}-{stepName}`.
      //     - Else → in-memory (historical behavior; no resume).
      const existingSessionPath = sessionPaths.get(stepIndex);
      // Validate task id and step name against path traversal before building
      // the session directory (mirrors step-execution.ts). Only needed
      // when sessionBaseDir is set — path interpolation happens only then.
      if (sessionBaseDir) {
        assertSafeName(taskId, 'task id');
        assertSafeName(step.stepName, 'step name');
      }
      const sessionDir = sessionBaseDir
        ? join(sessionBaseDir, taskId, `${execCount}-${stepIndex}-${step.stepName}`)
        : undefined;

      // 4d. Spawn the agent (profile lookup + read-only adjustment + harness
      //     creation + onAgentSpawn + onStepStart). runMultiStepTask does not
      //     track activeSessions (there is no abort listener here), so none is
      //     passed; spawnAgent resolves sessionPath (sessionFile ??
      //     resumeSessionPath ?? sessionDir ?? sessionId) identically to the
      //     previous inline computation.
      const handle = await spawnAgent(
        {
          profileId: step.profileId,
          agentId: taskId,
          cwd: effectiveCwd,
          phaseId,
          taskId,
          stepIndex,
          stepName: step.stepName,
          isReadOnly: step.isReadOnly,
          apiKeys,
          allowedWriteDirs: step.allowedWriteDirs,
          sessionDir,
          resumeSessionPath: existingSessionPath,
          onStatus,
        },
        profiles,
      );

      // Capture the persisted session file path BEFORE the finally block
      // disposes the harness. session.sessionFile is resolved at harness
      // construction (before the first turn is flushed), so it is correct on
      // both first run and resume, and survives dispose (proven by
      // step-execution.ts + linear-steps-runner.ts). For in-memory sessions
      // sessionFile is undefined, so nothing is captured and the next
      // execution stays in-memory (historical behavior).
      if (handle.session.sessionFile) {
        sessionPaths.set(stepIndex, handle.session.sessionFile);
      }

      let result: unknown;
      try {
        // 4e. Run the prompt
        if (step.schema) {
          const structured = await promptForStructured(handle.session, effectivePrompt, step.schema, { maxRetries: 3 });
          result = structured.result;

          // 4e-2. `onStructuredOutput` observe hook seam: fire AFTER the
          //        structured result resolves. Mirrors step-execution.ts /
          //        runStepTask. The default implementation (registered by
          //        LanePool.run() when an `auditLog` is available, or by the
          //        workflow directly for the runMultiStepTask path) appends a
          //        `structured_output` event to the durable AuditLog. Zero
          //        behavior change when no `hookRegistry` or no subscribers.
          if (hookRegistry?.hasSubscribers('onStructuredOutput')) {
            await hookRegistry.invokeObserve(
              'onStructuredOutput',
              { agentId: taskId, output: structured.result, taskId, phaseId, stepIndex },
              { registry: hookRegistry, cwd: effectiveCwd, workDir: cwd, signal },
            );
          }
        } else if (step.validateOutput) {
          // File-based output: validate after each turn and retry within the same session.
          result = await runWithValidationRetry(handle.session, effectivePrompt, step.validateOutput);
        } else {
          await handle.session.prompt(effectivePrompt);
          result = handle.session.getLastAssistantText();
        }

        // 4f. Renderer invocation. getLastAssistantText() is fetched lazily
        //     (only when a renderer is registered for this profile) to mirror
        //     the original inline guard ordering.
        if (rendererRegistry?.get(step.profileId)) {
          invokeRenderer(
            rendererRegistry,
            step.profileId,
            handle.session.getLastAssistantText(),
            taskId,
            taskId,
            onStatus?.onAgentRender,
          );
        }
      } finally {
        // 4g. Fire agent complete + dispose (always, even on error).
        //     handle.complete() fires onAgentComplete; handle.dispose() tears
        //     down the harness (mirrors the original try/finally ordering where
        //     the callback runs before dispose).
        handle.complete();
        handle.dispose();
      }

      // Relativize absolute worktree paths emitted into the step result so
      // subsequent steps (possibly in a fresh worktree) and downstream tasks
      // resolve them correctly. Idempotent; a no-op when no worktreeManager
      // is in play. Applied BEFORE storing into `results` so relativized
      // paths flow into `priorResults` for later steps' lazy prompts (the
      // final `results` array returned by runMultiStepTask is therefore
      // already fully relativized — no separate final-return pass needed).
      const roots = [effectiveCwd, worktreeManager?.mainWorktreePath].filter(Boolean) as string[];
      result = relativizePathsIn(result, roots);
      results[stepIndex] = result;

      // 4h. Approval gate
      const approved = step.isApproved ? step.isApproved(result) : true;
      if (approved) {
        stepIndex++;
        continue;
      }

      // 4i. Rejected — record feedback, back up one step, retry
      const feedback = step.getFeedback ? step.getFeedback(result) : 'Step rejected without feedback';
      feedbackHistory.push(feedback);
      const attempt = (stepAttempts.get(stepIndex) ?? 0) + 1;
      stepAttempts.set(stepIndex, attempt);

      onStatus?.onDecision?.({
        agentId: taskId,
        decision: `Step "${step.stepName}" rejected (attempt ${attempt}/${maxStepRetries})`,
        reasoning: feedback,
        taskId,
      });

      // 4i-2. `onDecision` observe hook seam: fire ALONGSIDE the existing
      //       `onStatus?.onDecision?.(...)` store callback — BOTH fire into
      //       different sinks (event store vs. audit log). Mirrors
      //       linear-steps-runner.ts / reflection-runner.ts. The default
      //       auditor (registered by LanePool.run() when an `auditLog` is
      //       available) appends a `decision` event to the durable AuditLog.
      //       Zero behavior change when no `hookRegistry` or no subscribers.
      if (hookRegistry?.hasSubscribers('onDecision')) {
        await hookRegistry.invokeObserve(
          'onDecision',
          {
            agentId: taskId,
            decision: `Step "${step.stepName}" rejected (attempt ${attempt}/${maxStepRetries})`,
            reasoning: feedback,
            taskId,
            phaseId,
          },
          { registry: hookRegistry, cwd: effectiveCwd, workDir: cwd, signal },
        );
      }

      if (attempt >= maxStepRetries) {
        // Exhausted — best-effort: return what we have, marked not approved.
        onStatus?.onTaskRejected?.({ taskId, title, reason: feedback });
        return { results, approved: false };
      }

      stepIndex = Math.max(0, stepIndex - 1);
    }

    // 5. All steps approved — merge the worktree (if any) BEFORE firing
    //    onTaskComplete. A failed merge (success=false or thrown error)
    //    falls through to the catch block, which OWNS the onTaskRejected
    //    callback (firing it exactly once via safeErrorMessage) and culls the
    //    worktree. onTaskRejected must NOT be called here — the surrounding
    //    catch block already handles it, so a redundant call here would emit
    //    a second rejection event for the same logical failure.
    if (worktreeManager) {
      const mergeResult = await worktreeManager.mergeTaskBranch(taskId);
      if (!mergeResult.success) {
        const errorMessage = 'Task merge failed: conflicts could not be resolved automatically';
        throw new Error(errorMessage);
      }
    }

    onStatus?.onTaskComplete?.({ taskId, title });
    return { results, approved: true };
  } catch (err) {
    // Best-effort cull the worktree (force-removes the failed task's worktree
    // + branch) before firing onTaskRejected. Cull failures are swallowed so
    // a cleanup error never masks the original failure.
    if (worktreeManager) {
      try {
        await worktreeManager.cullTaskWorktree(taskId);
      } catch {
        /* best-effort — never let cull mask the original error */
      }
    }
    const errorMessage = safeErrorMessage(err);
    onStatus?.onTaskRejected?.({ taskId, title, reason: errorMessage });
    throw err;
  }
}
