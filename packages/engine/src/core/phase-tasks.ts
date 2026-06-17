// ─── One-Step Task Primitive ──────────────────────────────────────────────────

import { join } from 'node:path';
import type { ZodType } from 'zod';
import { assertSafeName } from '../pool/validation.js';
import { createHarness } from './harness-factory.js';
import { loadProfilesFromDirs } from './profile.js';
import type { RendererRegistry } from './renderer-registry.js';
import { extractJsonFromText, promptForStructured } from './structured-output.js';
import type { AgentProfile, StatusCallbacks } from './types.js';
import { forwardAgentStatus, safeErrorMessage } from './utils.js';

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
  /** Prompt to send to the agent */
  prompt: string;
  /** Abort signal for cooperative cancellation */
  signal?: AbortSignal;
}

// ─── runStepTask ────────────────────────────────────────────────────────────

/**
 * Run one agent as a one-step task.
 *
 * Implements the full lifecycle:
 * 1. Check abort signal (throws without callbacks if aborted)
 * 2. Fire `onTaskRegister` with the single-step definition
 * 3. Fire `onTaskStart`
 * 4. Load and adjust profile (strip write/edit if isReadOnly)
 * 5. Create harness via `createHarness`
 * 6. Fire `onAgentSpawn`
 * 7. Fire `onStepStart`
 * 8. Run the prompt (structured or free-form)
 * 9. In finally: fire `onAgentComplete`, dispose harness
 * 10. On error: fire `onTaskRejected` before re-throwing
 * 11. On success: fire `onTaskComplete` and return result
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
    schema,
    validateOutput,
    rendererRegistry,
    prompt,
    signal,
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

  let result: T;
  let harness:
    | {
        session: {
          prompt(text: string): Promise<void>;
          getLastAssistantText(): string | undefined;
          sessionId: string;
          dispose(): void;
        };
        dispose: () => void;
        sessionId: string;
      }
    | undefined;

  try {
    // 4. Load and adjust profile
    const profiles = await loadProfilesFromDirs(profilesDirs);
    const profile = profiles.get(profileId);
    if (!profile) {
      throw new Error(`Profile "${profileId}" not found in directories: ${profilesDirs.join(', ')}`);
    }

    let adjustedProfile: AgentProfile = profile;
    if (isReadOnly) {
      adjustedProfile = {
        ...profile,
        excludeTools: [...new Set([...profile.excludeTools, 'write', 'edit'])],
      };
    }

    // 5. Create harness
    harness = await createHarness({
      profile: adjustedProfile,
      cwd,
      apiKeys,
      agentId: taskId,
      onAgentStatus: forwardAgentStatus(onStatus),
      allowedWriteDirs,
    });

    // 6. Fire agent spawn
    onStatus?.onAgentSpawn?.({
      agentId: taskId,
      profile: profileId,
      phaseId,
      taskId,
      stepIndex: 0,
      sessionId: harness.sessionId,
      sessionPath: harness.sessionId,
    });

    // 7. Fire step start
    onStatus?.onStepStart?.({ taskId, stepIndex: 0, stepName, agentId: taskId });

    // 8. Run the prompt
    if (schema) {
      const structuredResult = await promptForStructured(harness.session, prompt, schema, { maxRetries: 3 });
      result = structuredResult.result as T;
    } else if (validateOutput) {
      // File-based output: validate after each turn and retry within the same
      // session (mirrors promptForStructured's retry, but reads from disk).
      const maxAttempts = 3;
      let validationError: string | undefined;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const turnPrompt =
          attempt === 0 || validationError === undefined ? prompt : buildValidationRetryPrompt(prompt, validationError);
        await harness.session.prompt(turnPrompt);
        const gate = await validateOutput();
        validationError = gate?.error;
        if (!validationError) break;
      }
      if (validationError) {
        throw new Error(`Agent output failed validation after ${maxAttempts} attempts: ${validationError}`);
      }
      result = harness.session.getLastAssistantText() as T;
    } else {
      await harness.session.prompt(prompt);
      result = harness.session.getLastAssistantText() as T;
    }

    // 8b. Renderer invocation — transform agent output into human-readable form
    if (rendererRegistry) {
      const renderer = rendererRegistry.get(profileId);
      if (renderer) {
        const rawText = harness.session.getLastAssistantText();
        if (rawText) {
          const jsonStr = extractJsonFromText(rawText);
          let data: unknown = rawText;
          if (jsonStr) {
            try {
              data = JSON.parse(jsonStr);
            } catch {
              data = rawText;
            }
          }
          const rendered = renderer(data);
          if (rendered) {
            onStatus?.onAgentRender?.({ agentId: taskId, profile: profileId, taskId, rendered });
          }
        }
      }
    }
  } catch (err) {
    // 10. Error handling — fire onTaskRejected before re-throwing
    const errorMessage = safeErrorMessage(err);
    onStatus?.onTaskRejected?.({ taskId, title, reason: errorMessage });
    throw err;
  } finally {
    // 9. Fire agent complete and dispose harness
    if (harness) {
      try {
        onStatus?.onAgentComplete?.({ agentId: taskId, profile: profileId, phaseId, taskId, stepIndex: 0 });
      } finally {
        harness.dispose();
      }
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
 * Rebuild a prompt to ask the agent to fix a validation failure on retry.
 * Appends a delimited error block to the original prompt.
 */
function buildValidationRetryPrompt(originalPrompt: string, error: string): string {
  return [
    originalPrompt,
    '',
    '--- Previous attempt failed validation ---',
    `Error: ${error}`,
    'Please correct the output and try again.',
  ].join('\n');
}

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
    sessionBaseDir,
    signal,
    maxStepRetries = 3,
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

      // 4a. Resolve & adjust profile
      const profile = profiles.get(step.profileId);
      if (!profile) {
        throw new Error(`Profile "${step.profileId}" not found in directories: ${profilesDirs.join(', ')}`);
      }
      let adjustedProfile: AgentProfile = profile;
      if (step.isReadOnly) {
        adjustedProfile = {
          ...profile,
          excludeTools: [...new Set([...profile.excludeTools, 'write', 'edit'])],
        };
      }

      // 4b. Resolve prompt (may be lazy) and append accumulated feedback.
      //     Pass a snapshot copy so a lazy prompt can't observe later mutations
      //     to the shared results array. The context carries the per-step
      //     execution count (attempt) so a lazy prompt can branch on retries.
      const basePrompt =
        typeof step.prompt === 'function' ? await step.prompt([...results], { attempt: execCount }) : step.prompt;
      const promptText = appendFeedbackHistory(basePrompt, feedbackHistory);

      // 4c. Create harness (own session for this step).
      //     - If a session for this step was persisted on a prior execution →
      //       resume it (so context — including inlined file contents — is
      //       retained across retries).
      //     - Else if sessionBaseDir is set → start a new persisted session in
      //       `{sessionBaseDir}/{taskId}/{execCount}-{stepIndex}-{stepName}`.
      //     - Else → in-memory (historical behavior; no resume).
      const existingSessionPath = sessionPaths.get(stepIndex);
      // Validate task id and step name against path traversal before building
      // the session directory (mirrors step-execution.ts:77-78). Only needed
      // when sessionBaseDir is set — path interpolation happens only then.
      if (sessionBaseDir) {
        assertSafeName(taskId, 'task id');
        assertSafeName(step.stepName, 'step name');
      }
      const sessionDir = sessionBaseDir
        ? join(sessionBaseDir, taskId, `${execCount}-${stepIndex}-${step.stepName}`)
        : undefined;
      const harness = await createHarness({
        profile: adjustedProfile,
        cwd,
        apiKeys,
        agentId: taskId,
        onAgentStatus: forwardAgentStatus(onStatus),
        allowedWriteDirs: step.allowedWriteDirs,
        ...(existingSessionPath ? { resumeSessionPath: existingSessionPath } : sessionDir ? { sessionDir } : {}),
      });

      // Capture the persisted session file path BEFORE the finally block
      // disposes the harness. session.sessionFile is resolved at harness
      // construction (before the first turn is flushed), so it is correct on
      // both first run and resume, and survives dispose (proven by
      // step-execution.ts + linear-steps-runner.ts). For in-memory sessions
      // sessionFile is undefined, so nothing is captured and the next
      // execution stays in-memory (historical behavior).
      if (harness.session.sessionFile) {
        sessionPaths.set(stepIndex, harness.session.sessionFile);
      }

      // 4d. Fire agent spawn + step start
      onStatus?.onAgentSpawn?.({
        agentId: taskId,
        profile: step.profileId,
        phaseId,
        taskId,
        stepIndex,
        sessionId: harness.sessionId,
        sessionPath: harness.session.sessionFile ?? existingSessionPath ?? sessionDir ?? harness.sessionId,
      });
      onStatus?.onStepStart?.({ taskId, stepIndex, stepName: step.stepName, agentId: taskId });

      let result: unknown;
      try {
        // 4e. Run the prompt
        if (step.schema) {
          const structured = await promptForStructured(harness.session, promptText, step.schema, { maxRetries: 3 });
          result = structured.result;
        } else if (step.validateOutput) {
          // File-based output: validate after each turn and retry within the same session.
          let validationError: string | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            const turnPrompt =
              attempt === 0 || validationError === undefined
                ? promptText
                : buildValidationRetryPrompt(promptText, validationError);
            await harness.session.prompt(turnPrompt);
            const gate = await step.validateOutput();
            validationError = gate?.error;
            if (!validationError) break;
          }
          if (validationError) {
            throw new Error(`Agent output failed validation after 3 attempts: ${validationError}`);
          }
          result = harness.session.getLastAssistantText();
        } else {
          await harness.session.prompt(promptText);
          result = harness.session.getLastAssistantText();
        }

        // 4f. Renderer invocation
        if (rendererRegistry) {
          const renderer = rendererRegistry.get(step.profileId);
          if (renderer) {
            const rawText = harness.session.getLastAssistantText();
            if (rawText) {
              const jsonStr = extractJsonFromText(rawText);
              let data: unknown = rawText;
              if (jsonStr) {
                try {
                  data = JSON.parse(jsonStr);
                } catch {
                  data = rawText;
                }
              }
              const rendered = renderer(data);
              if (rendered) {
                onStatus?.onAgentRender?.({ agentId: taskId, profile: step.profileId, taskId, rendered });
              }
            }
          }
        }
      } finally {
        // 4g. Fire agent complete + dispose (always, even on error)
        try {
          onStatus?.onAgentComplete?.({ agentId: taskId, profile: step.profileId, phaseId, taskId, stepIndex });
        } finally {
          harness.dispose();
        }
      }

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

      if (attempt >= maxStepRetries) {
        // Exhausted — best-effort: return what we have, marked not approved.
        onStatus?.onTaskRejected?.({ taskId, title, reason: feedback });
        return { results, approved: false };
      }

      stepIndex = Math.max(0, stepIndex - 1);
    }

    // 5. All steps approved
    onStatus?.onTaskComplete?.({ taskId, title });
    return { results, approved: true };
  } catch (err) {
    const errorMessage = safeErrorMessage(err);
    onStatus?.onTaskRejected?.({ taskId, title, reason: errorMessage });
    throw err;
  }
}
