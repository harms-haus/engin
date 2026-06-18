import type { EventType } from '@engin/shared/event-types';
import type { StatusCallbacks } from '../core/types.js';

interface StoreLike {
  append(
    type: EventType,
    data: Record<string, unknown>,
    metadata?: { agentId?: string; taskId?: string; phaseId?: string; stepIndex?: number },
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
          steps: info.steps,
        },
        { taskId: info.taskId, phaseId: info.phaseId },
      );
    },

    onAgentSpawn(info) {
      store.append(
        'agent_spawned',
        {
          agentId: info.agentId,
          profile: info.profile,
          sessionId: info.sessionId,
          sessionPath: info.sessionPath,
        },
        {
          agentId: info.agentId,
          taskId: info.taskId,
          phaseId: info.phaseId,
          stepIndex: info.stepIndex,
        },
      );
    },

    onAgentComplete(info) {
      store.append(
        'agent_completed',
        { agentId: info.agentId, profile: info.profile, sessionId: info.sessionId },
        { agentId: info.agentId, taskId: info.taskId, phaseId: info.phaseId, stepIndex: info.stepIndex },
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

    onStepStart(info) {
      store.append(
        'step_started',
        {
          taskId: info.taskId,
          stepIndex: info.stepIndex,
          stepName: info.stepName,
          agentId: info.agentId,
        },
        { taskId: info.taskId, agentId: info.agentId, stepIndex: info.stepIndex },
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
        errorStack: info.error.stack,
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
  };
}
