import type { EventType } from '@engin/shared/event-types';
import type { StatusCallbacks } from '../core/types.js';

interface StoreLike {
  append(
    type: EventType,
    data: Record<string, unknown>,
    metadata?: { agentId?: string; taskId?: string; phaseId?: string; runnerRole?: string; attempt?: number },
  ): unknown;
}

/**
 * Creates a full {@link StatusCallbacks} object that fans every callback into
 * {@link EventStore.append} with the appropriate {@link EventType} and argument
 * mapping.
 */
export function createStoreCallbacks(store: StoreLike): StatusCallbacks {
  return {
    onWorkflowStart(info) {
      store.append('workflow_started', {
        taskPrompt: info.taskPrompt,
        resumed: info.resumed,
        workDir: info.workDir,
      });
    },

    onPhaseRegister(info) {
      store.append('phase_registered', { id: info.id, label: info.label, icon: info.icon }, { phaseId: info.id });
    },

    onPhaseStart(info) {
      store.append('phase_started', { phase: info.phase, round: info.round }, { phaseId: info.phase });
    },

    onPhaseComplete(info) {
      store.append('phase_completed', { phase: info.phase, durationMs: info.durationMs }, { phaseId: info.phase });
    },

    onTaskRegister(info) {
      store.append(
        'task_registered',
        {
          taskId: info.taskId,
          phaseId: info.phaseId,
          title: info.title,
          dependencies: info.dependencies,
        },
        { taskId: info.taskId, phaseId: info.phaseId },
      );
    },

    onSessionStart(info) {
      store.append(
        'session_started',
        {
          agentId: info.agentId,
          profile: info.profile,
          sessionId: info.sessionId,
          sessionPath: info.sessionPath,
          contextWindow: info.contextWindow,
        },
        {
          agentId: info.agentId,
          taskId: info.taskId,
          phaseId: info.phaseId,
          // runnerRole + attempt are REQUIRED to disambiguate sessions that
          // share an agent+task (e.g. a reviewRunner's execute vs review
          // sessions, or multiple attempts). Without them the projection
          // keys sessions by agentId::taskId only and collapses distinct
          // sessions into one. extractSessionIdentity reads these from
          // metadata first.
          ...(info.runnerRole !== undefined ? { runnerRole: info.runnerRole } : {}),
          ...(info.attempt !== undefined ? { attempt: info.attempt } : {}),
        },
      );
    },

    onSessionComplete(info) {
      store.append(
        'session_completed',
        { agentId: info.agentId, profile: info.profile, sessionId: info.sessionId },
        {
          agentId: info.agentId,
          taskId: info.taskId,
          phaseId: info.phaseId,
          ...(info.runnerRole !== undefined ? { runnerRole: info.runnerRole } : {}),
          ...(info.attempt !== undefined ? { attempt: info.attempt } : {}),
        },
      );
    },

    onTaskStart(info) {
      store.append(
        'task_started',
        {
          taskId: info.taskId,
          title: info.title,
          agentId: info.agentId,
          startedAt: info.startedAt,
        },
        { agentId: info.agentId, taskId: info.taskId, phaseId: info.phaseId },
      );
    },

    onTaskComplete(info) {
      store.append('task_completed', { taskId: info.taskId, title: info.title }, { taskId: info.taskId });
    },

    onTaskRejected(info) {
      store.append(
        'task_rejected',
        { taskId: info.taskId, title: info.title, reason: info.reason },
        { taskId: info.taskId },
      );
    },

    onDecision(info) {
      store.append(
        'decision',
        { decision: info.decision, reasoning: info.reasoning },
        { agentId: info.agentId, taskId: info.taskId },
      );
    },

    onError(info) {
      store.append(
        'error',
        { error: info.error },
        { agentId: info.agentId, taskId: info.taskId, phaseId: info.phaseId },
      );
    },

    onWorkflowComplete(info) {
      store.append('workflow_completed', {
        totalDurationMs: info.totalDurationMs,
        agentCount: info.agentCount,
      });
    },

    onWorkflowFailed(info) {
      // Store the error message string in data.error so evolve.ts sets
      // projection.error correctly (WorkflowProjection.error is string).
      // Structured fields are also preserved for consumers that need them.
      store.append('workflow_failed', {
        error: info.error.message,
        errorName: info.error.name,
        phase: info.phaseId,
      });
    },

    onSidebarUpdate(info) {
      store.append('sidebar_updated', { title: info.title, indicator: info.indicator });
    },

    onTurnStart(info) {
      store.append('turn_started', { turn: info.turn }, { agentId: info.agentId });
    },

    onTurnEnd(info) {
      store.append(
        'turn_ended',
        { turn: info.turn, tokens: info.tokens, contentBlocks: info.contentBlocks },
        { agentId: info.agentId },
      );
    },

    onToolCallStart(info) {
      store.append(
        'tool_call_started',
        { toolName: info.toolName, toolCallId: info.toolCallId, arguments: info.arguments },
        { agentId: info.agentId },
      );
    },

    onToolCallEnd(info) {
      store.append(
        'tool_call_ended',
        { toolName: info.toolName, toolCallId: info.toolCallId, isError: info.isError },
        { agentId: info.agentId },
      );
    },

    onAutoRetryStart(info) {
      store.append(
        'auto_retry_started',
        {
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          delayMs: info.delayMs,
          errorMessage: info.errorMessage,
        },
        { agentId: info.agentId },
      );
    },

    onAutoRetryCompleted(info) {
      store.append(
        'auto_retry_completed',
        { success: info.success, attempt: info.attempt, finalError: info.finalError },
        { agentId: info.agentId },
      );
    },
  };
}
