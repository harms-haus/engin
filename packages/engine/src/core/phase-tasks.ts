// ─── One-Step Task Primitive ──────────────────────────────────────────────────

import type { ZodType } from 'zod';
import { createHarness } from './harness-factory.js';
import { loadProfilesFromDirs } from './profile.js';
import { promptForStructured } from './structured-output.js';
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
  /** Zod schema for structured output. When absent, raw assistant text is returned. */
  schema?: ZodType<unknown>;
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
    schema,
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
    } else {
      await harness.session.prompt(prompt);
      result = harness.session.getLastAssistantText() as T;
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
        onStatus?.onAgentComplete?.({ agentId: taskId, profile: profileId, phaseId, taskId });
      } finally {
        harness.dispose();
      }
    }
  }

  // 11. On success — fire task complete and return result
  onStatus?.onTaskComplete?.({ taskId, title });
  return result;
}
