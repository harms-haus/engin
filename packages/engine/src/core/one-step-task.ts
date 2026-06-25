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
import type { StatusCallbacks, StepDefinition, Task } from './types.js';
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
