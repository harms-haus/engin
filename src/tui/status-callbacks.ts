import type { StatusCallbacks, TaskStatus } from '../core/types.js';
import type { Dashboard } from './components/dashboard.js';
import type { EventLog } from './components/event-log.js';
import type { TaskLane } from './components/lane-pool-widget.js';
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
      requestRender();
    },

    onAgentComplete(info) {
      eventLog.addLine('✅ Agent ' + info.agentId + ' complete');
      dashboard.agentLog.addEntry({ type: 'text', content: 'Agent session ended' });
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

    onDecision(info) {
      eventLog.addLine('🤝 ' + info.agentId + ': ' + stripAnsi(info.decision));
      requestRender();
    },

    onError(info) {
      const safeError = stripAnsi(info.error);
      eventLog.addLine('⚠️ Error in ' + info.agentId + ': ' + safeError + ' (' + info.phase + ')');
      dashboard.agentLog.addEntry({ type: 'error', content: safeError });
      requestRender();
    },

    onTurnEnd(info) {
      if (info.contentBlocks) {
        for (const block of info.contentBlocks) {
          if (block.type === 'text' && block.text.length > 0) {
            const safeText = stripAnsi(block.text);
            dashboard.agentLog.addEntry({ type: 'text', content: safeText });
            eventLog.addLine('💬 ' + safeText);
          } else if (block.type === 'thinking') {
            dashboard.agentLog.addEntry({ type: 'thinking', content: stripAnsi(block.thinking) });
          } else if (block.type === 'toolCall') {
            dashboard.agentLog.addEntry({
              type: 'tool_call_start',
              content: stripAnsi(block.name),
            });
          }
        }
      }
      requestRender();
    },

    onToolCallStart(info) {
      const safeName = stripAnsi(info.toolName);
      eventLog.addLine('🔧 ' + safeName + '(...)');
      dashboard.agentLog.addEntry({ type: 'tool_call_start', content: safeName });
      requestRender();
    },

    onToolCallEnd(info) {
      dashboard.agentLog.addEntry({
        type: 'tool_call_end',
        content: stripAnsi(info.toolName) + (info.isError ? ' ❌' : ' ✅'),
      });
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
