import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnAgent } from '../core/agent-lifecycle.js';
import { invokeRenderer } from '../core/renderer-invocation.js';
import type { RendererRegistry } from '../core/renderer-registry.js';
import { promptForStructured } from '../core/structured-output.js';
import type { AgentProfile, Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import type { WorktreeManager } from '../core/worktree-manager.js';
import { buildPrompt } from './prompt-builder.js';
import type { LanePoolOptions, StepDefinition, StepResult, TrackedSession } from './types.js';
import { assertSafeName } from './validation.js';

// ─── Types ────────────────────────────────────────────────────────────────

interface RunStepContext {
  stepIndex: number;
  attempt: number;
  execCount: number;
}

/** Context passed from LanePool to decouple runStep from class internals. */
export interface StepExecutionContext {
  sessionBaseDir: string;
  cwd: string;
  apiKeys?: Record<string, string>;
  onStatus: LanePoolOptions['onStatus'];
  activeSessions: Set<{ abort(): Promise<void> }>;
  /** Phase identifier propagated from the LanePool options. */
  phaseId: string;
  /** Optional registry of custom output renderers keyed by profile name. */
  rendererRegistry?: RendererRegistry;
  /** Abort signal for cooperative cancellation. Checked before `session.prompt()`
   *  so an abort that fires during the [session-created, prompt-started] TOCTOU
   *  window still cancels the session instead of launching an LLM turn. */
  signal?: AbortSignal;
  /** WorktreeManager for isolated git worktree execution */
  worktreeManager?: WorktreeManager;
}

/**
 * Recursively delete every persisted session for a task.
 *
 * A task's sessions live at `{sessionBaseDir}/{taskId}/` (one subdirectory
 * per step execution: `{exec}-{stepIndex}-{stepName}`). Clearing the whole
 * task directory guarantees a retry / resume restarts from step 1 with a
 * clean slate instead of resuming stale or half-written session state.
 *
 * No-op (does not throw) when the directory does not exist.
 */
export function clearTaskSessions(sessionBaseDir: string, taskId: string): void {
  assertSafeName(taskId, 'task id');
  rmSync(join(sessionBaseDir, taskId), { recursive: true, force: true });
}

/**
 * Run a single step: load the profile, create a harness session, prompt
 * the agent, and determine approval.
 */
export async function runStep(
  task: Task,
  step: StepDefinition,
  agentId: string,
  ctx: RunStepContext,
  profiles: Map<string, AgentProfile>,
  execCtx: StepExecutionContext,
  existingSessionPath?: string,
): Promise<{ result: StepResult; trackedSession: TrackedSession }> {
  // Validate task id and step name against path traversal
  assertSafeName(task.id, 'task id');
  assertSafeName(step.name, 'step name');

  // Compute session directory
  const sessionDirPath = join(execCtx.sessionBaseDir, task.id, `${ctx.execCount}-${ctx.stepIndex}-${step.name}`);

  // Pre-check the profile so the error message can reference the session base
  // dir (runStep-specific debugging context that spawnAgent doesn't have).
  // spawnAgent re-validates the lookup as a defensive guard; this check simply
  // fails fast with the richer message callers rely on.
  if (!profiles.has(step.profileId)) {
    throw new Error(`Profile "${step.profileId}" not found in directories: ${execCtx.sessionBaseDir}`);
  }

  // Spawn the agent: profile lookup + read-only adjustment + harness creation +
  // activeSessions tracking + onAgentSpawn + onStepStart. spawnAgent tracks the
  // session BEFORE firing any callback (TOCTOU safety) and computes the
  // resolved sessionPath (sessionFile ?? resumeSessionPath ?? sessionDir).
  const handle = await spawnAgent(
    {
      profileId: step.profileId,
      agentId,
      cwd: execCtx.cwd,
      phaseId: execCtx.phaseId,
      taskId: task.id,
      stepIndex: ctx.stepIndex,
      stepName: step.name,
      isReadOnly: step.isReadOnly,
      apiKeys: execCtx.apiKeys,
      sessionDir: sessionDirPath,
      resumeSessionPath: existingSessionPath,
      onStatus: execCtx.onStatus,
      activeSessions: execCtx.activeSessions,
    },
    profiles,
  );
  const { session } = handle;

  // Store the concrete .jsonl session FILE path — not the session DIRECTORY.
  // sessionDirPath is a directory; passing it as resumeSessionPath on the next
  // attempt makes SessionManager.open() -> readSync() throw EISDIR (on Linux a
  // directory can be open()'d read-only but not read()). handle.sessionPath is
  // resolved by spawnAgent (sessionFile ?? resumeSessionPath ?? sessionDir) at
  // harness construction, so it is correct on both first run and resume.
  const trackedSession: TrackedSession = {
    session,
    dispose: handle.dispose,
    sessionPath: handle.sessionPath,
  };

  try {
    // Build prompt
    const promptText = await buildPrompt(task, step, execCtx.cwd, { skipFiles: !!existingSessionPath });

    if (step.schema) {
      // Structured output step (review)
      let structuredResult: unknown;
      try {
        const { result } = await promptForStructured(session, promptText, step.schema, {
          maxRetries: ctx.attempt === 0 ? 3 : 1,
        });
        structuredResult = result;
      } catch (err) {
        const errorMsg = safeErrorMessage(err);
        // Treat as critical — the reviewer never produced valid output, so fail-safe.
        // The error is observable via the rejection feedback and reportError() → onError → store.
        return { result: { type: 'rejected', feedback: errorMsg, output: { severity: 'critical' } }, trackedSession };
      }

      const approved = step.isApproved
        ? step.isApproved(structuredResult)
        : (structuredResult as Record<string, unknown>)?.approved === true;

      if (approved) {
        return { result: { type: 'approved', output: structuredResult }, trackedSession };
      }

      const feedback = step.getFeedback
        ? step.getFeedback(structuredResult)
        : (((structuredResult as Record<string, unknown>)?.feedback as string) ?? 'No feedback provided');

      return { result: { type: 'rejected', feedback, output: structuredResult }, trackedSession };
    }

    // Non-structured step — always approved
    // Guard the TOCTOU window: activeSessions.add() ran before this point, so
    // an abort that fired during [session-tracked, prompt-started] was already
    // delivered to session.abort(). But AgentSession.prompt() does NOT re-check
    // the abort state, and abort() on an idle (not-yet-streaming) agent is a
    // no-op — without this explicit check the prompt would still launch its
    // LLM turn after an abort. Throw AbortError so the runner fails the task
    // and the lane loop exits promptly.
    if (execCtx.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    await session.prompt(promptText);
    const output = session.getLastAssistantText();
    return { result: { type: 'approved', output }, trackedSession };
  } catch (err) {
    // Exception path: dispose the session since processTask won't track it
    try {
      handle.dispose();
    } catch (disposeErr) {
      console.error(`[step-execution] Error disposing session for task ${task.id}:`, safeErrorMessage(disposeErr));
    }
    throw err;
  } finally {
    // Invoke registered renderer (if any) before firing the completion callback.
    // This lets UI consumers display a custom rendering of the agent's final output.
    // getLastAssistantText() is fetched lazily (only when a renderer is registered
    // for this profile) to mirror the original inline guard ordering.
    if (execCtx.rendererRegistry?.get(step.profileId)) {
      invokeRenderer(
        execCtx.rendererRegistry,
        step.profileId,
        session.getLastAssistantText(),
        agentId,
        task.id,
        execCtx.onStatus?.onAgentRender,
      );
    }

    // Fire completion callback + remove the session from activeSessions.
    // handle.complete() fires onAgentComplete (always runs even if dispose
    // failed) and untracks the session so it can't be re-aborted. Disposal of
    // the underlying harness is separate (handled above on the error path, or
    // deferred to the caller via trackedSession.dispose on the success path).
    handle.complete();
  }
}
