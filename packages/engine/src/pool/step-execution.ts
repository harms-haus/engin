import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness } from '../core/harness-factory.js';
import type { RendererRegistry } from '../core/renderer-registry.js';
import { extractJsonFromText, promptForStructured } from '../core/structured-output.js';
import type { AgentProfile, Task } from '../core/types.js';
import { forwardAgentStatus, safeErrorMessage } from '../core/utils.js';
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
  // Use pre-loaded profile
  const profile = profiles.get(step.profileId);
  if (!profile) {
    throw new Error(`Profile "${step.profileId}" not found in directories: ${execCtx.sessionBaseDir}`);
  }

  // Adjust profile for read-only steps — strip write and edit tools
  let adjustedProfile: AgentProfile = profile;
  if (step.isReadOnly) {
    adjustedProfile = {
      ...profile,
      excludeTools: [...new Set([...profile.excludeTools, 'write', 'edit'])],
    };
  }

  // Validate task id and step name against path traversal
  assertSafeName(task.id, 'task id');
  assertSafeName(step.name, 'step name');

  // Compute session directory
  const sessionDirPath = join(execCtx.sessionBaseDir, task.id, `${ctx.execCount}-${ctx.stepIndex}-${step.name}`);

  // Build harness options
  const harnessOpts = {
    profile: adjustedProfile,
    cwd: execCtx.cwd,
    apiKeys: execCtx.apiKeys,
    ...(existingSessionPath ? { resumeSessionPath: existingSessionPath } : { sessionDir: sessionDirPath }),
    agentId,
    onAgentStatus: forwardAgentStatus(execCtx.onStatus),
  };

  // Create harness
  const { session, dispose } = await createHarness(harnessOpts);

  // Store the concrete .jsonl session FILE path — not the session DIRECTORY.
  // sessionDirPath is a directory; passing it as resumeSessionPath on the next
  // attempt makes SessionManager.open() -> readSync() throw EISDIR (on Linux a
  // directory can be open()'d read-only but not read()). session.sessionFile is
  // the real file path, resolved at harness construction (before the first turn
  // is flushed), so it is correct on both first run and resume. The fallbacks
  // preserve behavior for any edge case where sessionFile is unavailable.
  const trackedSession: TrackedSession = {
    session,
    dispose,
    sessionPath: session.sessionFile ?? existingSessionPath ?? sessionDirPath,
  };

  // Track the session so the abort listener can cancel in-progress prompts
  execCtx.activeSessions.add(session);

  // NOTE: onAgentSpawn is fired AFTER activeSessions.add to provide sessionId/sessionPath.
  // Edge case: if an abort signal fires between activeSessions.add and this callback,
  // the finally block will fire onAgentComplete without a matching onAgentSpawn for this
  // agent. Consumers should treat onAgentComplete for an unregistered agent as a no-op.
  execCtx.onStatus?.onAgentSpawn?.({
    agentId,
    profile: step.profileId,
    phaseId: execCtx.phaseId,
    taskId: task.id,
    stepIndex: ctx.stepIndex,
    sessionId: session.sessionId,
    sessionPath: trackedSession.sessionPath,
  });

  // Fire onStepStart AFTER onAgentSpawn so the step always has an agentKey linkage.
  // This ensures the event order in the EventStore is: agent_spawned → step_started.
  execCtx.onStatus?.onStepStart?.({
    taskId: task.id,
    stepIndex: ctx.stepIndex,
    stepName: step.name,
    agentId,
  });

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
    await session.prompt(promptText);
    const output = session.getLastAssistantText();
    return { result: { type: 'approved', output }, trackedSession };
  } catch (err) {
    // Exception path: dispose the session since processTask won't track it
    try {
      dispose();
    } catch (disposeErr) {
      console.error(`[step-execution] Error disposing session for task ${task.id}:`, safeErrorMessage(disposeErr));
    }
    throw err;
  } finally {
    execCtx.activeSessions.delete(session);

    // Invoke registered renderer (if any) before firing the completion callback.
    // This lets UI consumers display a custom rendering of the agent's final output.
    if (execCtx.rendererRegistry) {
      const renderFn = execCtx.rendererRegistry.get(step.profileId);
      if (renderFn) {
        const rawText = session.getLastAssistantText();
        if (rawText) {
          let data: unknown = rawText;
          try {
            const jsonStr = extractJsonFromText(rawText);
            if (jsonStr) {
              data = JSON.parse(jsonStr);
            }
          } catch {
            // JSON.parse failed — fall back to raw text
          }
          const rendered = renderFn(data);
          if (rendered) {
            execCtx.onStatus?.onAgentRender?.({
              agentId,
              profile: step.profileId,
              taskId: task.id,
              rendered,
            });
          }
        }
      }
    }

    // Fire completion callback — always runs even if dispose failed
    execCtx.onStatus?.onAgentComplete?.({
      agentId,
      profile: step.profileId,
      phaseId: execCtx.phaseId,
      taskId: task.id,
      stepIndex: ctx.stepIndex,
      sessionId: session.sessionId,
    });
  }
}
