import { join } from 'node:path';
import { createHarness } from '../core/harness-factory.js';
import { promptForStructured } from '../core/structured-output.js';
import type { AgentProfile, AuditEvent, Task } from '../core/types.js';
import { forwardAgentStatus, safeErrorMessage } from '../core/utils.js';
import { buildPrompt } from './prompt-builder.js';
import type { LanePoolOptions, StepDefinition, StepResult } from './types.js';
import { assertSafeName } from './validation.js';

// ─── Types ────────────────────────────────────────────────────────────────

/** Distributive Omit that preserves discriminated union structure. */
type WithoutTimestamp<T> = T extends infer U ? (U extends T ? Omit<U, 'timestamp'> : never) : never;

interface RunStepContext {
  stepIndex: number;
  attempt: number;
  execCount: number;
}

interface TrackedSession {
  session: {
    abort(): Promise<void>;
    dispose(): void;
    subscribe(cb: (event: unknown) => void): () => void;
    prompt(text: string): Promise<void>;
    getLastAssistantText(): string | undefined;
    sessionId: string;
  };
  dispose: () => void;
  sessionPath: string;
}

/** Context passed from LanePool to decouple runStep from class internals. */
export interface StepExecutionContext {
  sessionBaseDir: string;
  cwd: string;
  apiKeys?: Record<string, string>;
  onStatus: LanePoolOptions['onStatus'];
  activeSessions: Set<{ abort(): Promise<void> }>;
  appendAuditEvent: (event: WithoutTimestamp<AuditEvent>) => void;
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

  // Fire status callbacks
  execCtx.onStatus?.onAgentSpawn?.({
    agentId,
    profile: step.profileId,
    phase: 'implementing',
    taskId: task.id,
  });

  // Audit log
  execCtx.appendAuditEvent({
    type: 'agent_start',
    agentId: step.profileId,
    profile: adjustedProfile,
    phase: 'implementing',
    taskId: task.id,
  });

  // Create harness
  const { session, dispose } = await createHarness(harnessOpts);

  const trackedSession: TrackedSession = {
    session,
    dispose,
    sessionPath: existingSessionPath ?? sessionDirPath,
  };

  // Track the session so the abort listener can cancel in-progress prompts
  execCtx.activeSessions.add(session);

  try {
    // Build prompt
    const promptText = buildPrompt(task, step);

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
        // Log the structured output failure for observability
        execCtx.appendAuditEvent({
          type: 'error',
          agentId,
          error: `promptForStructured failed: ${errorMsg}`,
          taskId: task.id,
        });
        // Treat as critical — the reviewer never produced valid output, so fail-safe
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
    } catch {
      /* swallow */
    }
    throw err;
  } finally {
    execCtx.activeSessions.delete(session);

    // Fire completion callback — always runs even if dispose failed
    execCtx.onStatus?.onAgentComplete?.({
      agentId,
      profile: step.profileId,
      phase: 'implementing',
      taskId: task.id,
    });

    // Audit log — agent_end event
    execCtx.appendAuditEvent({
      type: 'agent_end',
      agentId: step.profileId,
      result: {},
      phase: 'implementing',
      taskId: task.id,
    });
  }
}
