import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnAgent } from '../core/agent-lifecycle.js';
import { classify } from '../core/error-classifier.js';
import { invokeRenderer } from '../core/renderer-invocation.js';
import type { RendererRegistry } from '../core/renderer-registry.js';
import { promptForStructured } from '../core/structured-output.js';
import type { AgentProfile, Task } from '../core/types.js';
import { safeErrorMessage } from '../core/utils.js';
import type { WorktreeManager } from '../core/worktree-manager.js';
import type { HookRegistry } from '../hooks/types.js';
import type { AuditLog } from '../tracking/audit-log.js';
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
  /** Optional registry of workflow hooks. When present AND has subscribers for
   *  `beforeStepPrompt`, `runStep` invokes the pipeline hook (seeded with
   *  `task.prompt`) instead of calling `buildPrompt` directly. When absent,
   *  `buildPrompt` runs unchanged — zero behavior change. When present AND
   *  has subscribers for `onStructuredOutput` / `onDecision`, those observe
   *  hooks fire after a structured result resolves / a review rejection,
   *  respectively. */
  hookRegistry?: HookRegistry;
  /** Audit log for recording events. Forwarded from {@link TaskRunnerContext}
   *  for symmetry; the default auditor is registered against `hookRegistry`
   *  by `LanePool.run()`, so this field is primarily informational here
   *  (the auditor reads the log through its captured reference, not via
   *  this field). */
  auditLog?: AuditLog;
  /** Per-task worktree path (distinct from `cwd`, the run/pool cwd). Set by
   *  LanePool when a per-task worktree is created so the `beforeStepPrompt`
   *  hook can resolve files against the isolated worktree. `undefined` when
   *  no worktree is in use. */
  worktreeCwd?: string;
  /** Abort signal for cooperative cancellation. Checked before `session.prompt()`
   *  so an abort that fires during the [session-created, prompt-started] TOCTOU
   *  window still cancels the session instead of launching an LLM turn. */
  signal?: AbortSignal;
  /** WorktreeManager for isolated git worktree execution */
  worktreeManager?: WorktreeManager;
  /** Optional per-prompt timeout in milliseconds. When a positive finite number,
   *  each `session.prompt()` call is raced against a timeout. On expiry the
   *  session is aborted and an error is thrown. Unset/0/NaN/negative → no
   *  timeout (zero behavior change). */
  stepTimeoutMs?: number;
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

/** Parameters for {@link runStep}. */
export interface RunStepParams {
  task: Task;
  step: StepDefinition;
  agentId: string;
  ctx: RunStepContext;
  profiles: Map<string, AgentProfile>;
  execCtx: StepExecutionContext;
  existingSessionPath?: string;
}

/**
 * Run a single step: load the profile, create a harness session, prompt
 * the agent, and determine approval.
 */
export async function runStep(params: RunStepParams): Promise<{ result: StepResult; trackedSession: TrackedSession }> {
  const { task, step, agentId, ctx, profiles, execCtx, existingSessionPath } = params;

  // Validate task id against path traversal BEFORE any property access on step
  // (the guard below interpolates task.id into Error messages, so we must
  // ensure its charset is safe first).
  assertSafeName(task.id, 'task id');

  // ── Defensive guard: validate `step` BEFORE any property access so a
  // malformed/missing step produces a descriptive Error (including the task
  // id) instead of an opaque TypeError from `step.name` / `step.profileId`.
  // Fires before spawnAgent (no agent lifecycle call is made for bad input).
  const describeStep = (): string => {
    try {
      const s = JSON.stringify({ name: step?.name, profileId: step?.profileId, isReadOnly: step?.isReadOnly });
      return s.length > 500 ? s.slice(0, 500) + '…' : s;
    } catch {
      return String(step);
    }
  };
  if (typeof step !== 'object' || step === null) {
    throw new Error(
      `runStep received an invalid step for task "${task.id}": step is ${step === null ? 'null' : typeof step} (expected a non-null object). Full step value: ${describeStep()}`,
    );
  }
  if (typeof step.name !== 'string' || step.name.length === 0) {
    throw new Error(
      `runStep received an invalid step for task "${task.id}": step.name is ${step.name === undefined ? 'undefined' : JSON.stringify(step.name)} (expected a non-empty string). Full step value: ${describeStep()}`,
    );
  }
  if (typeof step.profileId !== 'string' || step.profileId.length === 0) {
    throw new Error(
      `runStep received an invalid step for task "${task.id}": step.profileId is ${step.profileId === undefined ? 'undefined' : JSON.stringify(step.profileId)} (expected a non-empty string). Full step value: ${describeStep()}`,
    );
  }

  // Validate step name against path traversal (task id validated above)
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
    // Build prompt.
    //
    // `beforeStepPrompt` hook seam: when a `hookRegistry` is threaded through
    // LanePoolOptions → TaskRunnerContext → StepExecutionContext AND it has at
    // least one subscriber for `beforeStepPrompt`, the prompt is produced by
    // invoking the pipeline hook (seeded with `task.prompt`) instead of calling
    // `buildPrompt` directly. The pipeline's return value replaces the prompt
    // sent to the agent.
    //
    // This seam ONLY ACTIVATES when BOTH (a) the engine constructs a
    // hookRegistry (via `composeHooks` in run-executor) AND (b) the workflow
    // forwards it to LanePool via `hookRegistry: options.hookRegistry`. If
    // either condition is unmet, `buildPrompt` is called directly — zero
    // behavior change. `hasSubscribers` is the gate so an empty/no-subscriber
    // registry still falls through to `buildPrompt` (avoiding a pointless
    // `invokePipeline` round-trip that would just return the seed unchanged).
    const promptText = execCtx.hookRegistry?.hasSubscribers('beforeStepPrompt')
      ? ((await execCtx.hookRegistry.invokePipeline(
          'beforeStepPrompt',
          task.prompt,
          { task, step, prompt: task.prompt, cwd: execCtx.cwd, worktreeCwd: execCtx.worktreeCwd },
          {
            registry: execCtx.hookRegistry,
            cwd: execCtx.worktreeCwd ?? execCtx.cwd,
            workDir: execCtx.cwd,
            signal: execCtx.signal,
          },
        )) as string)
      : await buildPrompt(task, step, execCtx.cwd, { skipFiles: !!existingSessionPath });

    if (step.schema) {
      // Structured output step (review)
      let structuredResult: unknown;
      try {
        const { result } = await promptForStructured(session, promptText, step.schema, {
          maxRetries: ctx.attempt === 0 ? 3 : 1,
          ...(execCtx.stepTimeoutMs != null ? { stepTimeoutMs: execCtx.stepTimeoutMs } : {}),
        });
        structuredResult = result;
      } catch (err) {
        const errorMsg = safeErrorMessage(err);
        // Treat as critical — the reviewer never produced valid output, so fail-safe.
        // The error is observable via the rejection feedback and reportError() → onError → store.
        return { result: { type: 'rejected', feedback: errorMsg, output: { severity: 'critical' } }, trackedSession };
      }

      // `onStructuredOutput` observe hook seam: fire AFTER the structured
      // result resolves but BEFORE the approval gate, so EVERY structured
      // result is observed (whether it ends up approved or rejected). The
      // default implementation (registered by LanePool.run() when an
      // `auditLog` is available, see hooks/defaults/auditor.ts) appends a
      // `structured_output` event to the durable AuditLog — WITHOUT any
      // manual `auditLog.append` call in workflow code. Zero behavior change
      // when no `hookRegistry` or no subscribers: the `hasSubscribers` gate
      // skips the `invokeObserve` round-trip entirely. The hook context
      // mirrors the `beforeStepPrompt` seam (same cwd / workDir / signal).
      if (execCtx.hookRegistry?.hasSubscribers('onStructuredOutput')) {
        await execCtx.hookRegistry.invokeObserve(
          'onStructuredOutput',
          { agentId, output: structuredResult, taskId: task.id, phaseId: execCtx.phaseId, stepIndex: ctx.stepIndex },
          {
            registry: execCtx.hookRegistry,
            cwd: execCtx.worktreeCwd ?? execCtx.cwd,
            workDir: execCtx.cwd,
            signal: execCtx.signal,
          },
        );
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
    // delivered to session.abort(). But AgentRuntime.prompt() does NOT re-check
    // the abort state, and abort() on an idle (not-yet-streaming) agent is a
    // no-op — without this explicit check the prompt would still launch its
    // LLM turn after an abort. Throw AbortError so the runner fails the task
    // and the lane loop exits promptly.
    if (execCtx.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Per-prompt timeout: only when stepTimeoutMs is a positive finite number.
    // Raced via Promise.race so a hung prompt is rejected and the session is
    // aborted. On normal completion the timer is cleared in the finally block.
    // When stepTimeoutMs is unset / 0 / NaN / negative: identical to today.
    const promptPromise = session.prompt(promptText);
    if (execCtx.stepTimeoutMs != null && Number.isFinite(execCtx.stepTimeoutMs) && execCtx.stepTimeoutMs > 0) {
      const timeoutMs = execCtx.stepTimeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(async () => {
          await session.abort().catch(() => {
            /* swallow abort-triggered rejection */
          });
          reject(new Error(`Step timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      try {
        await Promise.race([promptPromise, timeoutPromise]);
      } catch (err) {
        // Timeout: suppress the prompt's eventual rejection (abort-triggered)
        // so it does not become an unhandled rejection.
        if (err instanceof Error && /timed out/.test(err.message)) {
          promptPromise.catch(() => {
            /* swallow abort-triggered rejection */
          });
        }
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } else {
      await promptPromise;
    }
    const output = session.getLastAssistantText();

    // Fail-fast: if the agent produced no usable text or the provider reported
    // an error, throw so the runner fails the task instead of silently approving.
    // classify() inspects the last assistant message metadata; when stopReason
    // is 'error' OR classify kind is 'empty' (no text content blocks), the step
    // is rejected immediately. The throw flows through the existing catch block
    // (which disposes the session) and up to the runner → handleRunnerError.
    const lastAssistant = session.getLastAssistantMessage();
    const classification = classify(undefined, { lastAssistantMessage: lastAssistant });
    if (lastAssistant?.stopReason === 'error' || classification.kind === 'empty') {
      const detail = lastAssistant?.errorMessage ? `: ${lastAssistant.errorMessage}` : '';
      throw new Error(
        `Step produced no usable output (stopReason: ${lastAssistant?.stopReason ?? 'unknown'})${detail}`,
      );
    }

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
