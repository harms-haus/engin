import type { StatusCallbacks, TaskStatus } from '../core/types.js';
import type { Dashboard } from './components/dashboard.js';
import type { EventLog } from './components/event-log.js';
import type { TaskLane } from './components/lane-pool-widget.js';
import { formatToolCall } from './format-tool-call.js';
import { stripAnsi } from './theme.js';

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createTuiStatusCallbacks(deps: {
  eventLog: EventLog;
  dashboard: Dashboard;
  requestRender: () => void;
}): StatusCallbacks {
  const { eventLog, dashboard, requestRender } = deps;

  const lanes = new Map<string, TaskLane>();
  // Lanes accumulate for the lifetime of the workflow; completed lanes remain visible.
  const completedPhases: string[] = [];
  // Reverse map for task → agent lookups
  const taskToAgent = new Map<string, string>();

  return {
    onWorkflowStart(info) {
      eventLog.addLine('🚀 Workflow started: "' + info.taskPrompt + '" (resumed: ' + info.resumed + ')');
      requestRender();
    },

    onWorkflowComplete(info) {
      eventLog.addLine(
        '🎉 Complete in ' + (info.totalDurationMs / 1000).toFixed(1) + 's (' + info.agentCount + ' agents)',
      );
      requestRender();
    },

    onWorkflowFailed(info) {
      eventLog.addLine('💥 Failed at ' + info.phase + ': ' + info.error.message);
      requestRender();
    },

    onPhaseStart(info) {
      eventLog.addLine('📦 Phase: ' + info.phase + ' (round ' + info.round + ')');
      dashboard.phaseBar.setCurrentPhase(info.phase);
      requestRender();
    },

    onPhaseComplete(info) {
      eventLog.addLine('✅ Phase ' + info.phase + ' done (' + (info.durationMs / 1000).toFixed(1) + 's)');
      completedPhases.push(info.phase);
      dashboard.phaseBar.setCompletedPhases(completedPhases);
      requestRender();
    },

    onAgentSpawn(info) {
      eventLog.addLine('⏳ Agent ' + info.agentId + ' spawned (' + info.profile + ')');
      dashboard.agentLog.selectAgent(info.agentId, info.profile);
      dashboard.agentLog.updateStats(info.agentId, { profile: info.profile });
      if (info.taskId) {
        taskToAgent.set(info.taskId, info.agentId);
      }
      requestRender();
    },

    onAgentComplete(info) {
      eventLog.addLine('✅ Agent ' + info.agentId + ' complete');
      dashboard.agentLog.addEntry({ type: 'text', content: 'Agent session ended' }, info.agentId);
      requestRender();
    },

    onTaskStart(info) {
      const safeTitle = stripAnsi(info.title);
      eventLog.addLine('📋 Task ' + info.taskId + ': "' + safeTitle + '"');
      lanes.set(info.taskId, {
        id: info.taskId,
        title: safeTitle,
        status: 'implementing' as TaskStatus,
        agentId: info.agentId,
      });
      dashboard.lanePool.updateLanes(Array.from(lanes.values()));
      // Update task title on the associated agent
      const agentId = taskToAgent.get(info.taskId) ?? info.agentId;
      dashboard.agentLog.updateStats(agentId, { taskTitle: safeTitle });
      requestRender();
    },

    onTaskComplete(info) {
      eventLog.addLine('✅ Task ' + info.taskId + ' complete');
      const lane = lanes.get(info.taskId);
      if (lane) {
        lane.status = 'done';
        dashboard.lanePool.updateLanes(Array.from(lanes.values()));
      }
      requestRender();
    },

    onTaskRejected(info) {
      eventLog.addLine('❌ Task ' + info.taskId + ' rejected: ' + info.reason);
      const lane = lanes.get(info.taskId);
      if (lane) {
        lane.status = 'failed';
        dashboard.lanePool.updateLanes(Array.from(lanes.values()));
      }
      requestRender();
    },

    onDecision(_info) {
      requestRender();
    },

    onError(info) {
      const safeError = stripAnsi(info.error);
      eventLog.addLine('⚠️ Error in ' + info.agentId + ': ' + safeError + ' (' + info.phase + ')');
      dashboard.agentLog.addEntry({ type: 'error', content: safeError }, info.agentId);
      requestRender();
    },

    onTurnEnd(info) {
      if (info.contentBlocks) {
        for (const block of info.contentBlocks) {
          if (block.type === 'text' && block.text.length > 0) {
            const safeText = stripAnsi(block.text);
            dashboard.agentLog.addEntry({ type: 'text', content: safeText }, info.agentId);
          } else if (block.type === 'thinking') {
            dashboard.agentLog.addEntry({ type: 'thinking', content: stripAnsi(block.thinking) }, info.agentId);
          }
        }
      }
      if (info.tokens) {
        dashboard.agentLog.updateStats(info.agentId, {
          inputTokens: info.tokens.input,
          outputTokens: info.tokens.output,
        });
      }
      requestRender();
    },

    onToolCallStart(info) {
      dashboard.agentLog.addEntry(
        { type: 'tool_call_start', content: formatToolCall(info.toolName, info.arguments ?? {}) },
        info.agentId,
      );
      dashboard.agentLog.updateStats(info.agentId, { toolCallCount: 1 });
      requestRender();
    },

    onToolCallEnd(info) {
      const formatted = formatToolCall(info.toolName, {});
      dashboard.agentLog.addEntry(
        {
          type: 'tool_call_end',
          content: formatted + (info.isError ? ' ❌' : ' ✅'),
        },
        info.agentId,
      );
      requestRender();
    },

    onSidebarUpdate(info) {
      if (info.phases) {
        dashboard.phaseBar.setPhases(info.phases);
      }
      if (info.indicator) {
        dashboard.phaseBar.setIndicator(info.indicator);
      }
      if (info.title) {
        eventLog.addLine('📌 ' + info.title);
      }
      requestRender();
    },
  };
}
